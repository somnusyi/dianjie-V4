import { prisma } from '@dianjie/db'

export type SupplyChainAuditIssue = {
  code: string
  severity: 'ERROR' | 'WARNING'
  entityType: 'Product' | 'StockReservation' | 'StockMovement' | 'StockBatch' | 'DeliveryOrder' | 'Receipt' | 'LossClaim' | 'WarehouseStock'
  entityId: string
  label: string
  detail: string
}

type AuditDb = typeof prisma

function differs(left: number, right: number, tolerance = 0.01) {
  return Math.abs(left - right) > tolerance
}

export async function auditSupplierSupplyChain(input: {
  tenantId: string
  supplierId: string
  days?: number
}, db: AuditDb = prisma) {
  const days = Math.max(7, Math.min(input.days ?? 90, 365))
  const since = new Date(Date.now() - days * 86_400_000)
  const [supplier, products, reservations, stockMovements, stockBatches, deliveries, receipts, arrivalDiscrepancies] = await Promise.all([
    db.supplier.findFirst({
      where: { id: input.supplierId, tenantId: input.tenantId },
      select: { id: true, sourceType: true, inventoryMode: true },
    }),
    db.product.findMany({
      where: { tenantId: input.tenantId, supplierId: input.supplierId },
      select: { id: true, code: true, name: true, stock: true },
    }),
    db.supplierStockReservation.findMany({
      where: { tenantId: input.tenantId, supplierId: input.supplierId, status: 'ACTIVE' },
      include: {
        product: { select: { name: true } },
        purchaseOrder: { select: { no: true, status: true } },
      },
    }),
    db.supplierStockMovement.findMany({
      where: { tenantId: input.tenantId, supplierId: input.supplierId },
      select: { id: true, productId: true, delta: true, balanceAfter: true, createdAt: true },
      orderBy: [{ productId: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      take: 20_000,
    }),
    db.supplierStockBatch.findMany({
      where: { tenantId: input.tenantId, supplierId: input.supplierId },
      select: { id: true, productId: true, batchNo: true, initialQty: true, remainingQty: true },
      orderBy: [{ productId: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      take: 20_000,
    }),
    db.deliveryOrder.findMany({
      where: {
        tenantId: input.tenantId, supplierId: input.supplierId,
        status: { not: 'CANCELLED' }, createdAt: { gte: since },
      },
      include: { items: true },
      orderBy: { createdAt: 'desc' },
      take: 1000,
    }),
    db.receipt.findMany({
      where: {
        tenantId: input.tenantId, supplierId: input.supplierId,
        status: { in: ['CONFIRMED', 'ACCOUNTED'] }, createdAt: { gte: since },
      },
      include: {
        items: true,
        paymentSchedule: { select: { amount: true, status: true } },
        lossClaims: {
          where: { isManual: false },
          select: { id: true, no: true, status: true, payableBasis: true, totalLossAmount: true, resolvedDeductAmount: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 1000,
    }),
    db.lossClaim.findMany({
      where: {
        tenantId: input.tenantId,
        supplierId: input.supplierId,
        kind: { in: ['ARRIVAL_SHORTAGE', 'ARRIVAL_DAMAGE'] },
        createdAt: { gte: since },
      },
      include: {
        deliveryOrder: { select: { purchaseOrderId: true } },
        receipt: { select: { deliveryOrderId: true, purchaseOrderId: true } },
        items: { select: { deliveryOrderItemId: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 1000,
    }),
  ])
  if (!supplier) throw Object.assign(new Error('供应商不存在或不属于当前租户'), { statusCode: 404 })

  const issues: SupplyChainAuditIssue[] = []
  const inventoryTracked = supplier.inventoryMode === 'STRICT'
  const movementsByProduct = new Map<string, typeof stockMovements>()
  for (const movement of stockMovements) {
    const rows = movementsByProduct.get(movement.productId) || []
    rows.push(movement)
    movementsByProduct.set(movement.productId, rows)
  }
  const reservedByProduct = new Map<string, number>()
  const batchBalanceByProduct = new Map<string, number>()
  for (const batch of inventoryTracked ? stockBatches : []) {
    const initial = Number(batch.initialQty)
    const remaining = Number(batch.remainingQty)
    batchBalanceByProduct.set(batch.productId, (batchBalanceByProduct.get(batch.productId) || 0) + remaining)
    if (remaining < -0.001) {
      issues.push({
        code: 'NEGATIVE_BATCH_BALANCE', severity: 'ERROR', entityType: 'StockBatch', entityId: batch.id,
        label: batch.batchNo, detail: `批次剩余数量为 ${remaining.toFixed(3)}`,
      })
    }
    if (remaining - initial > 0.001) {
      issues.push({
        code: 'BATCH_INITIAL_REMAINING_INVALID', severity: 'ERROR', entityType: 'StockBatch', entityId: batch.id,
        label: batch.batchNo, detail: `批次初始 ${initial.toFixed(3)}，剩余却为 ${remaining.toFixed(3)}`,
      })
    }
  }
  for (const reservation of inventoryTracked ? reservations : []) {
    reservedByProduct.set(
      reservation.productId,
      (reservedByProduct.get(reservation.productId) || 0) + Number(reservation.quantity),
    )
    if (reservation.purchaseOrder.status !== 'CONFIRMED') {
      issues.push({
        code: 'ACTIVE_RESERVATION_ORDER_STATE_MISMATCH', severity: 'ERROR',
        entityType: 'StockReservation', entityId: reservation.id,
        label: `${reservation.product.name} · ${reservation.purchaseOrder.no}`,
        detail: `ACTIVE 预占对应订单状态为 ${reservation.purchaseOrder.status}，应释放或核销`,
      })
    }
  }
  for (const product of inventoryTracked ? products : []) {
    const physical = Number(product.stock)
    const reserved = reservedByProduct.get(product.id) || 0
    if (physical < -0.001) {
      issues.push({
        code: 'NEGATIVE_PHYSICAL_STOCK', severity: 'ERROR', entityType: 'Product', entityId: product.id,
        label: `${product.name} · ${product.code}`, detail: `物理库存为 ${physical}`,
      })
    }
    if (reserved - physical > 0.001) {
      issues.push({
        code: 'OVER_RESERVED_STOCK', severity: 'ERROR', entityType: 'Product', entityId: product.id,
        label: `${product.name} · ${product.code}`, detail: `物理 ${physical}，已占 ${reserved}，缺口 ${(reserved - physical).toFixed(2)}`,
      })
    }
    const batchBalance = batchBalanceByProduct.get(product.id) || 0
    if (differs(batchBalance, physical, 0.001)) {
      issues.push({
        code: 'STOCK_BATCH_BALANCE_MISMATCH', severity: 'ERROR', entityType: 'Product', entityId: product.id,
        label: `${product.name} · ${product.code}`,
        detail: `商品物理库存 ${physical.toFixed(3)}，批次余额合计 ${batchBalance.toFixed(3)}`,
      })
    }
    const movements = movementsByProduct.get(product.id) || []
    if (movements.length === 0 && Math.abs(physical) > 0.001) {
      issues.push({
        code: 'STOCK_BASELINE_MOVEMENT_MISSING', severity: 'WARNING', entityType: 'Product', entityId: product.id,
        label: `${product.name} · ${product.code}`, detail: `当前库存 ${physical}，但尚无可审计期初或库存流水`,
      })
    }
    for (let index = 1; index < movements.length; index++) {
      const previous = Number(movements[index - 1].balanceAfter)
      const delta = Number(movements[index].delta)
      const actual = Number(movements[index].balanceAfter)
      if (differs(previous + delta, actual, 0.001)) {
        issues.push({
          code: 'STOCK_MOVEMENT_CHAIN_BROKEN', severity: 'ERROR', entityType: 'StockMovement', entityId: movements[index].id,
          label: `${product.name} · ${product.code}`,
          detail: `前余额 ${previous} + 变动 ${delta} 应为 ${(previous + delta).toFixed(3)}，流水记录为 ${actual.toFixed(3)}`,
        })
      }
    }
    const latest = movements.at(-1)
    if (latest && differs(Number(latest.balanceAfter), physical, 0.001)) {
      issues.push({
        code: 'STOCK_LEDGER_BALANCE_MISMATCH', severity: 'ERROR', entityType: 'Product', entityId: product.id,
        label: `${product.name} · ${product.code}`,
        detail: `商品当前库存 ${physical.toFixed(3)}，最后流水余额 ${Number(latest.balanceAfter).toFixed(3)}`,
      })
    }
  }
  for (const delivery of deliveries) {
    const lineTotal = delivery.items.reduce((sum, item) => sum + Number(item.amount), 0)
    if (differs(Number(delivery.actualTotalAmount), lineTotal)) {
      issues.push({
        code: 'DELIVERY_AMOUNT_MISMATCH', severity: 'ERROR', entityType: 'DeliveryOrder', entityId: delivery.id,
        label: delivery.no, detail: `配送单 ${Number(delivery.actualTotalAmount).toFixed(2)}，明细 ${lineTotal.toFixed(2)}`,
      })
    }
    if (delivery.items.some(item => !item.productNameSnapshot || !item.productUnitSnapshot)) {
      issues.push({
        code: 'DELIVERY_ITEM_SNAPSHOT_MISSING', severity: 'WARNING', entityType: 'DeliveryOrder', entityId: delivery.id,
        label: delivery.no, detail: '部分配送明细缺少商品名称或单位快照',
      })
    }
  }
  for (const receipt of receipts) {
    const lineTotal = receipt.items.reduce((sum, item) => sum + Number(item.amount), 0)
    if (differs(Number(receipt.totalAmount), lineTotal)) {
      issues.push({
        code: 'RECEIPT_AMOUNT_MISMATCH', severity: 'ERROR', entityType: 'Receipt', entityId: receipt.id,
        label: receipt.no, detail: `入库单 ${Number(receipt.totalAmount).toFixed(2)}，明细 ${lineTotal.toFixed(2)}`,
      })
    }
    let expectedPayable = Number(receipt.totalAmount)
    let payableCanBeDerived = true
    let hasOpenDispute = false
    for (const claim of receipt.lossClaims) {
      const full = Number(claim.totalLossAmount)
      const resolved = Number(claim.resolvedDeductAmount || 0)
      if (claim.payableBasis === 'NET_AT_RECEIPT') {
        if (claim.status === 'PENDING') {
          hasOpenDispute = true
        } else if (['REJECTED', 'NEGOTIATING'].includes(claim.status)) {
          expectedPayable += full
          hasOpenDispute = true
        } else if (claim.status === 'RESOLVED') {
          expectedPayable += full - resolved
        }
      } else if (claim.payableBasis === 'GROSS_PENDING_CLAIM') {
        if (['APPROVED', 'AUTO_APPROVED'].includes(claim.status)) expectedPayable -= full
        else if (claim.status === 'RESOLVED') expectedPayable -= resolved
        else if (['PENDING', 'REJECTED', 'NEGOTIATING'].includes(claim.status)) hasOpenDispute = true
      } else if (claim.payableBasis === 'LEGACY_UNKNOWN') {
        payableCanBeDerived = false
      }
    }
    if (receipt.paymentSchedule && payableCanBeDerived && differs(Number(receipt.paymentSchedule.amount), expectedPayable)) {
      issues.push({
        code: 'PAYABLE_RECEIPT_AMOUNT_MISMATCH', severity: 'ERROR', entityType: 'Receipt', entityId: receipt.id,
        label: receipt.no,
        detail: `应付 ${Number(receipt.paymentSchedule.amount).toFixed(2)}，按实收与已结差异应为 ${expectedPayable.toFixed(2)}`,
      })
    }
    if (receipt.paymentSchedule && hasOpenDispute && receipt.paymentSchedule.status !== 'ON_HOLD') {
      issues.push({
        code: 'PAYABLE_DISPUTE_NOT_HELD', severity: 'ERROR', entityType: 'Receipt', entityId: receipt.id,
        label: receipt.no, detail: `存在未结到货差异，但账期状态为 ${receipt.paymentSchedule.status}`,
      })
    }
    if (!receipt.paymentSchedule && supplier.sourceType !== 'HEADQ_WAREHOUSE') {
      issues.push({
        code: 'PAYABLE_MISSING', severity: 'WARNING', entityType: 'Receipt', entityId: receipt.id,
        label: receipt.no, detail: '确认入库单尚未生成应付账期，等待补偿任务或人工核查',
      })
    }
    if (receipt.items.some(item => !item.productNameSnapshot || !item.productUnitSnapshot)) {
      issues.push({
        code: 'RECEIPT_ITEM_SNAPSHOT_MISSING', severity: 'WARNING', entityType: 'Receipt', entityId: receipt.id,
        label: receipt.no, detail: '部分入库明细缺少商品名称或单位快照',
      })
    }
  }
  for (const claim of arrivalDiscrepancies) {
    if (!claim.deliveryOrderId || !claim.receiptId || claim.items.some(item => !item.deliveryOrderItemId)) {
      issues.push({
        code: 'ARRIVAL_SHORTAGE_TRACE_MISSING', severity: 'ERROR', entityType: 'LossClaim', entityId: claim.id,
        label: claim.no, detail: '到货短缺未完整关联配送单、收货单及配送明细，无法可靠追责',
      })
      continue
    }
    if (
      claim.deliveryOrder?.purchaseOrderId !== claim.purchaseOrderId
      || claim.receipt?.purchaseOrderId !== claim.purchaseOrderId
      || claim.receipt?.deliveryOrderId !== claim.deliveryOrderId
    ) {
      issues.push({
        code: 'ARRIVAL_SHORTAGE_TRACE_MISMATCH', severity: 'ERROR', entityType: 'LossClaim', entityId: claim.id,
        label: claim.no, detail: '报损关联的订货、配送与收货单据不属于同一履约链',
      })
    }
  }

  let warehouseId: string | undefined
  let warehouseStockRowsChecked = 0

  if (inventoryTracked) {
    const defaultWarehouse = await db.warehouse.findFirst({
      where: { tenantId: input.tenantId, isDefault: true, isActive: true },
      select: { id: true },
    })
    if (!defaultWarehouse) {
      throw Object.assign(new Error('当前租户不存在启用的默认仓'), { statusCode: 404 })
    }
    warehouseId = defaultWarehouse.id

    const productIds = products.map(p => p.id)
    const warehouseStocks = productIds.length > 0
      ? await db.warehouseStock.findMany({
          where: { tenantId: input.tenantId, warehouseId, productId: { in: productIds } },
        })
      : []
    warehouseStockRowsChecked = warehouseStocks.length

    const wsByProduct = new Map<string, { id: string; isActive: boolean; physicalQty: number }>()
    for (const ws of warehouseStocks) {
      wsByProduct.set(ws.productId, { id: ws.id, isActive: ws.isActive, physicalQty: Number(ws.physicalQty) })
    }

    for (const product of products) {
      const ws = wsByProduct.get(product.id)
      if (!ws) {
        issues.push({
          code: 'WAREHOUSE_STOCK_MISSING', severity: 'ERROR', entityType: 'WarehouseStock',
          entityId: product.id,
          label: `${product.name} · ${product.code}`,
          detail: `仓库 ${warehouseId} 不存在该商品的库存行`,
        })
        continue
      }
      if (!ws.isActive) {
        issues.push({
          code: 'WAREHOUSE_STOCK_INACTIVE', severity: 'ERROR', entityType: 'WarehouseStock',
          entityId: ws.id,
          label: `${product.name} · ${product.code}`,
          detail: `仓库 ${warehouseId} 库存行已停用`,
        })
        continue
      }
      const productStock = Number(product.stock)
      if (differs(ws.physicalQty, productStock, 0.001)) {
        issues.push({
          code: 'WAREHOUSE_STOCK_PRODUCT_MISMATCH', severity: 'ERROR', entityType: 'WarehouseStock',
          entityId: ws.id,
          label: `${product.name} · ${product.code}`,
          detail: `仓库 ${warehouseId} 物理库存 ${ws.physicalQty.toFixed(3)}，商品库存 ${productStock.toFixed(3)}`,
        })
      }
    }
  }

  return {
    checkedAt: new Date(),
    periodDays: days,
    inventoryMode: supplier.inventoryMode,
    summary: {
      errors: issues.filter(issue => issue.severity === 'ERROR').length,
      warnings: issues.filter(issue => issue.severity === 'WARNING').length,
      products: products.length,
      activeReservations: reservations.length,
      stockMovements: stockMovements.length,
      stockBatches: stockBatches.length,
      deliveries: deliveries.length,
      receipts: receipts.length,
      arrivalShortages: arrivalDiscrepancies.filter(claim => claim.kind === 'ARRIVAL_SHORTAGE').length,
      arrivalDiscrepancies: arrivalDiscrepancies.length,
      ...(warehouseId !== undefined && { warehouseId, warehouseStockRowsChecked }),
    },
    issues,
  }
}
