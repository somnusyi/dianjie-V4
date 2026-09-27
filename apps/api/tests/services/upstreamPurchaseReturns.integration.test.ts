import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '@dianjie/db'
import {
  approveUpstreamPurchaseReturn,
  cancelUpstreamPurchaseReturn,
  createUpstreamPurchaseReturn,
  getUpstreamPurchaseReturn,
  receiveUpstreamPurchaseReturn,
  submitUpstreamPurchaseReturn,
} from '../../src/services/upstreamPurchaseReturns'
import { postUpstreamReceiptInTransaction } from '../../src/services/warehouseLedger'
import { loadInventoryManagement, managementQuerySchema } from '../../src/services/inventoryManagement'
import { businessDateKey, businessDateRangeInclusive } from '../../src/lib/businessTime'

const suffix = `purchase-return-${Date.now()}-${randomUUID().slice(0, 8)}`
let tenantId = ''
let otherTenantId = ''
let warehouseId = ''
let supplierId = ''
let userId = ''
let productId = ''
let receiptLineId = ''
let receiptId = ''

const managementQuery = (overrides: Record<string, unknown> = {}) => managementQuerySchema.parse({
  start: '', end: '', dateField: 'date', filters: '{}', page: 1, pageSize: 20, ...overrides,
})

async function cleanup(id: string) {
  if (!id) return
  await prisma.upstreamPurchaseReturnEvent.deleteMany({ where: { tenantId: id } })
  await prisma.upstreamPurchaseReturnLine.deleteMany({ where: { tenantId: id } })
  await prisma.upstreamPurchaseReturn.deleteMany({ where: { tenantId: id } })
  await prisma.warehouseLedgerLotAllocation.deleteMany({ where: { tenantId: id } })
  await prisma.warehouseLedgerLot.deleteMany({ where: { tenantId: id } })
  await prisma.upstreamReceiptLine.deleteMany({ where: { tenantId: id } })
  await prisma.upstreamReceipt.deleteMany({ where: { tenantId: id } })
  await prisma.warehouseLedgerMovement.deleteMany({ where: { tenantId: id } })
  await prisma.warehouseLedgerBalance.deleteMany({ where: { tenantId: id } })
  await prisma.upstreamPurchaseOrderLine.deleteMany({ where: { tenantId: id } })
  await prisma.upstreamPurchaseOrder.deleteMany({ where: { tenantId: id } })
  await prisma.businessSequence.deleteMany({ where: { tenantId: id } })
  await prisma.opLog.deleteMany({ where: { tenantId: id } })
  await prisma.product.deleteMany({ where: { tenantId: id } })
  await prisma.user.deleteMany({ where: { tenantId: id } })
  await prisma.supplier.deleteMany({ where: { tenantId: id } })
  await prisma.warehouse.deleteMany({ where: { tenantId: id } })
  await prisma.tenant.deleteMany({ where: { id } })
}

describe('upstream purchase returns (integration)', () => {
  beforeAll(async () => {
    const tenant = await prisma.tenant.create({ data: { name: `采购退货 ${suffix}`, slug: suffix } })
    const other = await prisma.tenant.create({ data: { name: `隔离租户 ${suffix}`, slug: `other-${suffix}` } })
    tenantId = tenant.id
    otherTenantId = other.id
    warehouseId = (await prisma.warehouse.findFirstOrThrow({ where: { tenantId, isDefault: true } })).id
    supplierId = (await prisma.supplier.create({
      data: {
        tenantId,
        no: `SUP-${suffix}`,
        name: '无门户账号的上游供应商',
        businessScopes: ['WAREHOUSE_UPSTREAM'],
      },
    })).id
    userId = (await prisma.user.create({
      data: {
        tenantId,
        name: '采购退货经办人',
        email: `${suffix}@local.test`,
        password: 'test-only',
        role: 'SUPPLY_CHAIN',
      },
    })).id
    productId = (await prisma.product.create({
      data: {
        tenantId,
        code: `P-${suffix}`,
        name: '采购退货土豆',
        unit: 'kg',
        purchaseUnit: '袋',
        inventoryUnit: 'kg',
        orderUnit: 'kg',
        costUnit: 'kg',
        inventoryUnitsPerPurchaseUnit: 5,
        inventoryUnitsPerOrderUnit: 1,
        inventoryUnitsPerCostUnit: 1,
        unitConversionStatus: 'VERIFIED',
        price: 1,
      },
    })).id
    const order = await prisma.upstreamPurchaseOrder.create({
      data: {
        tenantId,
        no: `PO-${suffix}`,
        supplierId,
        warehouseId,
        status: 'RECEIVED',
        createdById: userId,
        lines: {
          create: {
            lineNo: 1,
            productId,
            productCodeSnapshot: `P-${suffix}`,
            productNameSnapshot: '采购退货土豆',
            purchaseUnit: '袋',
            inventoryUnit: 'kg',
            inventoryUnitsPerPurchaseUnit: 5,
            orderedQty: 10,
            confirmedQty: 10,
            receivedQty: 10,
            unitPrice: 25,
            amountWithoutTax: 250,
            taxAmount: 0,
            totalAmount: 250,
          },
        },
      },
      include: { lines: true },
    })
    const receipt = await prisma.upstreamReceipt.create({
      data: {
        tenantId,
        no: `RC-${suffix}`,
        purchaseOrderId: order.id,
        supplierId,
        warehouseId,
        status: 'POSTED',
        postedAt: new Date(),
        payableAmount: 250,
        createdById: userId,
        lines: {
          create: {
            purchaseOrderLineId: order.lines[0].id,
            productId,
            orderedQty: 10,
            arrivedQty: 10,
            acceptedQty: 10,
            purchaseUnit: '袋',
            inventoryUnit: 'kg',
            inventoryUnitsPerPurchaseUnit: 5,
            inventoryAcceptedQty: 50,
            unitPrice: 25,
            payableAmount: 250,
          },
        },
      },
      include: { lines: true },
    })
    receiptId = receipt.id
    receiptLineId = receipt.lines[0].id
    await prisma.$transaction(tx => postUpstreamReceiptInTransaction(tx, {
      tenantId,
      warehouseId,
      supplierId,
      supplierName: '无门户账号的上游供应商',
      receiptId: receipt.id,
      receiptNo: receipt.no,
      userId,
      effectiveAt: new Date(),
      lines: [{
        receiptLineId,
        productId,
        productName: '采购退货土豆',
        purchaseQuantity: 10,
        purchaseUnit: '袋',
        conversionFactor: 5,
        inventoryQuantity: 50,
        inventoryUnit: 'kg',
        totalAmount: 250,
      }],
    }), { isolationLevel: 'Serializable' })
  })

  afterAll(async () => {
    await cleanup(otherTenantId)
    await cleanup(tenantId)
    await prisma.$disconnect()
  })

  it('creates an internal return for a supplier with no portal user and does not move stock before approval', async () => {
    expect(await prisma.user.count({ where: { supplierId } })).toBe(0)
    const before = await prisma.warehouseLedgerBalance.findUniqueOrThrow({
      where: { tenantId_warehouseId_productId: { tenantId, warehouseId, productId } },
    })
    const created = await createUpstreamPurchaseReturn({
      tenantId,
      userId,
      supplierId,
      warehouseId,
      reason: '原料质量不符合要求',
      idempotencyKey: `return-create-${suffix}`,
      lines: [{ receiptLineId, purchaseQuantity: 4 }],
    })
    expect(created.purchaseReturn.status).toBe('DRAFT')
    expect(created.purchaseReturn.settlementAmount.toString()).toBe('100')
    expect(created.purchaseReturn.lines[0].inventoryQuantity.toString()).toBe('20')
    await submitUpstreamPurchaseReturn(tenantId, created.purchaseReturn.id, userId)
    const afterSubmit = await prisma.warehouseLedgerBalance.findUniqueOrThrow({
      where: { tenantId_warehouseId_productId: { tenantId, warehouseId, productId } },
    })
    expect(afterSubmit.physicalQty.equals(before.physicalQty)).toBe(true)
    expect(await prisma.warehouseLedgerMovement.count({
      where: { tenantId, sourceType: 'UpstreamPurchaseReturn', sourceId: created.purchaseReturn.id },
    })).toBe(0)
  })

  it('approval deducts purchaser warehouse exactly once and supplier receipt changes only the status', async () => {
    const row = await prisma.upstreamPurchaseReturn.findFirstOrThrow({
      where: { tenantId, idempotencyKey: `return-create-${suffix}` },
    })
    const approved = await approveUpstreamPurchaseReturn(tenantId, row.id, userId)
    expect(approved.purchaseReturn.status).toBe('APPROVED')
    expect(approved.purchaseReturn.ledgerCostAmount.toString()).toBe('100')
    const replay = await approveUpstreamPurchaseReturn(tenantId, row.id, userId)
    expect(replay.replayed).toBe(true)
    const balance = await prisma.warehouseLedgerBalance.findUniqueOrThrow({
      where: { tenantId_warehouseId_productId: { tenantId, warehouseId, productId } },
    })
    expect(balance.physicalQty.toString()).toBe('30')
    expect(balance.inventoryValue.toString()).toBe('150')
    expect(await prisma.warehouseLedgerMovement.count({
      where: { tenantId, type: 'PURCHASE_RETURN', sourceId: row.id },
    })).toBe(1)
    await receiveUpstreamPurchaseReturn(tenantId, row.id, userId, '供应商仓库已签收')
    const receivedBalance = await prisma.warehouseLedgerBalance.findUniqueOrThrow({
      where: { tenantId_warehouseId_productId: { tenantId, warehouseId, productId } },
    })
    expect(receivedBalance.physicalQty.toString()).toBe('30')
    expect(await prisma.supplierStockMovement.count({ where: { tenantId } })).toBe(0)
  })

  it('prevents cumulative over-return and enforces tenant isolation', async () => {
    const created = await createUpstreamPurchaseReturn({
      tenantId,
      userId,
      supplierId,
      warehouseId,
      reason: '累计数量边界测试',
      idempotencyKey: `return-over-${suffix}`,
      lines: [{ receiptLineId, purchaseQuantity: 7 }],
    })
    await expect(submitUpstreamPurchaseReturn(tenantId, created.purchaseReturn.id, userId))
      .rejects.toThrow('累计退货数量超过原合格收货数量')
    await expect(getUpstreamPurchaseReturn(otherTenantId, created.purchaseReturn.id)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('serializes concurrent approvals so one return creates one outbound movement', async () => {
    const created = await createUpstreamPurchaseReturn({
      tenantId,
      userId,
      supplierId,
      warehouseId,
      reason: '并发审批验证',
      idempotencyKey: `return-concurrent-${suffix}`,
      lines: [{ receiptLineId, purchaseQuantity: 2 }],
    })
    await submitUpstreamPurchaseReturn(tenantId, created.purchaseReturn.id, userId)
    const results = await Promise.all(Array.from({ length: 8 }, () =>
      approveUpstreamPurchaseReturn(tenantId, created.purchaseReturn.id, userId)))
    expect(results.filter(result => !result.replayed)).toHaveLength(1)
    expect(await prisma.warehouseLedgerMovement.count({
      where: { tenantId, type: 'PURCHASE_RETURN', sourceId: created.purchaseReturn.id },
    })).toBe(1)
    const balance = await prisma.warehouseLedgerBalance.findUniqueOrThrow({
      where: { tenantId_warehouseId_productId: { tenantId, warehouseId, productId } },
    })
    expect(balance.physicalQty.toString()).toBe('20')
  })

  it('exposes real purchase-return documents in inventory management', async () => {
    const today = businessDateKey()
    const todayAt = new Date(businessDateRangeInclusive(today, today).start.getTime() + 12 * 60 * 60 * 1000)
    const oldAt = new Date(todayAt.getTime() - 2 * 24 * 60 * 60 * 1000)
    const [received, approved, draft] = await Promise.all([
      prisma.upstreamPurchaseReturn.findFirstOrThrow({ where: { tenantId, idempotencyKey: `return-create-${suffix}` } }),
      prisma.upstreamPurchaseReturn.findFirstOrThrow({ where: { tenantId, idempotencyKey: `return-concurrent-${suffix}` } }),
      prisma.upstreamPurchaseReturn.findFirstOrThrow({ where: { tenantId, idempotencyKey: `return-over-${suffix}` } }),
    ])
    await Promise.all([
      prisma.upstreamPurchaseReturn.update({ where: { id: received.id }, data: { createdAt: oldAt, approvedAt: todayAt } }),
      prisma.upstreamPurchaseReturn.update({ where: { id: approved.id }, data: { createdAt: todayAt, approvedAt: oldAt } }),
      prisma.upstreamPurchaseReturn.update({ where: { id: draft.id }, data: { createdAt: todayAt } }),
    ])

    const byBusinessDate = await prisma.$transaction(tx => loadInventoryManagement(
      tx,
      tenantId,
      'purchase-return',
      managementQuery({ start: today, end: today }),
    ))
    expect(byBusinessDate.sourceAvailable).toBe(true)
    expect(byBusinessDate.total).toBe(2)
    expect(byBusinessDate.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: received.id,
        no: expect.stringMatching(/^URT/),
        supplier: '无门户账号的上游供应商',
        status: '供应商已收货',
        review: '已审核',
        invoice: '待开票',
      }),
      expect.objectContaining({ id: draft.id, status: '草稿', review: null }),
    ]))
    expect(byBusinessDate.rows).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: approved.id })]))

    const byCreatedAt = await prisma.$transaction(tx => loadInventoryManagement(
      tx,
      tenantId,
      'purchase-return',
      managementQuery({ start: today, end: today, dateField: 'createdAt' }),
    ))
    expect(byCreatedAt.total).toBe(2)
    expect(byCreatedAt.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: approved.id, status: '已出库', review: '已审核' }),
      expect.objectContaining({ id: draft.id, status: '草稿', review: null }),
    ]))
    expect(byCreatedAt.rows).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: received.id })]))
  })

  it('enforces the supplier tenant boundary in the database', async () => {
    const foreignSupplier = await prisma.supplier.create({
      data: {
        tenantId: otherTenantId,
        no: `FOREIGN-${suffix}`,
        name: '其他租户上游供应商',
        businessScopes: ['WAREHOUSE_UPSTREAM'],
      },
    })
    await expect(prisma.upstreamPurchaseReturn.create({
      data: {
        tenantId,
        no: `URT-FOREIGN-${suffix}`,
        supplierId: foreignSupplier.id,
        warehouseId,
        reason: '数据库租户边界测试',
        createdById: userId,
      },
    })).rejects.toThrow()
  })

  it('does not consume stock reserved for store fulfillment and rolls approval back atomically', async () => {
    const balanceBefore = await prisma.warehouseLedgerBalance.findUniqueOrThrow({
      where: { tenantId_warehouseId_productId: { tenantId, warehouseId, productId } },
    })
    await prisma.warehouseLedgerBalance.update({
      where: { id: balanceBefore.id },
      data: { reservedQty: 15 },
    })
    const created = await createUpstreamPurchaseReturn({
      tenantId,
      userId,
      supplierId,
      warehouseId,
      reason: '不得占用门店预留库存',
      idempotencyKey: `return-reserved-${suffix}`,
      lines: [{ receiptLineId, purchaseQuantity: 4 }],
    })
    await submitUpstreamPurchaseReturn(tenantId, created.purchaseReturn.id, userId)
    await expect(approveUpstreamPurchaseReturn(tenantId, created.purchaseReturn.id, userId))
      .rejects.toThrow('可用总仓库存不足')
    const [unchanged, stored] = await Promise.all([
      prisma.warehouseLedgerBalance.findUniqueOrThrow({ where: { id: balanceBefore.id } }),
      prisma.upstreamPurchaseReturn.findUniqueOrThrow({ where: { id: created.purchaseReturn.id } }),
    ])
    expect(unchanged.physicalQty.equals(balanceBefore.physicalQty)).toBe(true)
    expect(unchanged.reservedQty.toString()).toBe('15')
    expect(stored.status).toBe('PENDING_APPROVAL')
    expect(await prisma.warehouseLedgerMovement.count({
      where: { tenantId, sourceType: 'UpstreamPurchaseReturn', sourceId: created.purchaseReturn.id },
    })).toBe(0)
    await cancelUpstreamPurchaseReturn(tenantId, created.purchaseReturn.id, userId, '测试完成释放退货占用')
    await prisma.warehouseLedgerBalance.update({ where: { id: balanceBefore.id }, data: { reservedQty: 0 } })
  })

  it('revalidates the source receipt at submit and approval time', async () => {
    const created = await createUpstreamPurchaseReturn({
      tenantId,
      userId,
      supplierId,
      warehouseId,
      reason: '原收货单状态二次校验',
      idempotencyKey: `return-source-state-${suffix}`,
      lines: [{ receiptLineId, purchaseQuantity: 1 }],
    })
    try {
      await prisma.upstreamReceipt.update({
        where: { id: receiptId },
        data: { status: 'REVERSED', reversedAt: new Date() },
      })
      await expect(submitUpstreamPurchaseReturn(tenantId, created.purchaseReturn.id, userId))
        .rejects.toThrow('原收货单尚未入账或已冲销')

      await prisma.upstreamReceipt.update({
        where: { id: receiptId },
        data: { status: 'POSTED', reversedAt: null },
      })
      await submitUpstreamPurchaseReturn(tenantId, created.purchaseReturn.id, userId)
      await prisma.upstreamReceipt.update({
        where: { id: receiptId },
        data: { status: 'REVERSED', reversedAt: new Date() },
      })
      await expect(approveUpstreamPurchaseReturn(tenantId, created.purchaseReturn.id, userId))
        .rejects.toThrow('原收货单尚未入账或已冲销')
      expect(await prisma.warehouseLedgerMovement.count({
        where: { tenantId, sourceType: 'UpstreamPurchaseReturn', sourceId: created.purchaseReturn.id },
      })).toBe(0)
      expect((await prisma.upstreamPurchaseReturn.findUniqueOrThrow({ where: { id: created.purchaseReturn.id } })).status)
        .toBe('PENDING_APPROVAL')
    } finally {
      await prisma.upstreamReceipt.update({
        where: { id: receiptId },
        data: { status: 'POSTED', reversedAt: null },
      })
      await cancelUpstreamPurchaseReturn(tenantId, created.purchaseReturn.id, userId, '测试完成取消退货单')
    }
  })
})
