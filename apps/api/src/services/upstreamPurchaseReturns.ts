import { createHash } from 'node:crypto'
import { Prisma, prisma } from '@dianjie/db'
import { nextUpstreamDocumentNo } from './upstreamDocumentNo'
import { postUpstreamPurchaseReturnInTransaction } from './warehouseLedger'

const QTY_DP = 6
const VALUE_DP = 4
const RESERVING_STATUSES = ['PENDING_APPROVAL', 'APPROVED', 'RECEIVED'] as const

type Decimalish = Prisma.Decimal | string | number

function businessError(message: string, statusCode = 409) {
  return Object.assign(new Error(message), { statusCode })
}

function positiveQuantity(value: Decimalish, field: string) {
  try {
    const result = new Prisma.Decimal(value).toDecimalPlaces(QTY_DP)
    if (result.isFinite() && result.gt(0)) return result
  } catch {
    // Normalized below.
  }
  throw businessError(`${field}必须大于0`, 400)
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonicalize(child)]),
    )
  }
  return value
}

function fingerprint(value: unknown) {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')
}

async function serializableWithRetry<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      return await prisma.$transaction(work, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 20_000,
      })
    } catch (error: any) {
      const retryableRawSerialization = error?.code === 'P2010' && error?.meta?.code === '40001'
      if ((!['P2034', 'P2002'].includes(error?.code) && !retryableRawSerialization) || attempt === 8) throw error
      // Let the transaction that currently owns the document lock commit before
      // retrying. The stagger also prevents a burst of approval retries from
      // colliding in the same serializable snapshot again.
      await new Promise(resolve => setTimeout(resolve, attempt * 10))
    }
  }
  throw new Error('采购退货事务重试失败')
}

function returnInclude() {
  return {
    supplier: { select: { id: true, no: true, name: true } },
    warehouse: { select: { id: true, code: true, name: true } },
    lines: {
      orderBy: { createdAt: 'asc' as const },
      include: {
        product: { select: { id: true, code: true, name: true, spec: true } },
        receiptLine: { select: { id: true, receiptId: true, acceptedQty: true, unitPrice: true, receipt: { select: { no: true } } } },
        ledgerMovement: { select: { id: true, physicalDelta: true, valueDelta: true, effectiveAt: true } },
      },
    },
    events: { orderBy: { createdAt: 'asc' as const } },
  }
}

export type CreateUpstreamPurchaseReturnInput = {
  tenantId: string
  userId: string
  supplierId: string
  warehouseId: string
  reason: string
  note?: string | null
  idempotencyKey: string
  lines: Array<{
    receiptLineId: string
    purchaseQuantity: Decimalish
    note?: string | null
  }>
}

export async function createUpstreamPurchaseReturn(input: CreateUpstreamPurchaseReturnInput) {
  const reason = String(input.reason || '').trim()
  const note = String(input.note || '').trim() || null
  const idempotencyKey = String(input.idempotencyKey || '').trim()
  if (reason.length < 2 || reason.length > 240) throw businessError('退货原因需为2至240个字符', 400)
  if (note && note.length > 500) throw businessError('退货备注不能超过500个字符', 400)
  if (idempotencyKey.length < 8 || idempotencyKey.length > 160) throw businessError('采购退货幂等键无效', 400)
  if (!Array.isArray(input.lines) || input.lines.length === 0 || input.lines.length > 500) {
    throw businessError('采购退货必须包含 1–500 行商品', 400)
  }
  const normalizedLines = input.lines.map(line => ({
    receiptLineId: String(line.receiptLineId || '').trim(),
    purchaseQuantity: positiveQuantity(line.purchaseQuantity, '退货数量'),
    note: String(line.note || '').trim() || null,
  }))
  if (normalizedLines.some(line => !line.receiptLineId)
    || new Set(normalizedLines.map(line => line.receiptLineId)).size !== normalizedLines.length) {
    throw businessError('收货明细不能为空或重复', 400)
  }
  const requestFingerprint = fingerprint({
    supplierId: input.supplierId,
    warehouseId: input.warehouseId,
    reason,
    note,
    lines: [...normalizedLines]
      .sort((a, b) => a.receiptLineId.localeCompare(b.receiptLineId))
      .map(line => ({
        receiptLineId: line.receiptLineId,
        purchaseQuantity: line.purchaseQuantity.toFixed(QTY_DP),
        note: line.note,
      })),
  })

  return serializableWithRetry(async tx => {
    const replay = await tx.upstreamPurchaseReturn.findUnique({
      where: { tenantId_idempotencyKey: { tenantId: input.tenantId, idempotencyKey } },
      include: returnInclude(),
    })
    if (replay) {
      if (replay.requestFingerprint !== requestFingerprint) {
        throw businessError('同一幂等键不能用于不同的采购退货内容', 409)
      }
      return { replayed: true, purchaseReturn: replay }
    }

    const [supplier, warehouse, receiptLines] = await Promise.all([
      tx.supplier.findFirst({
        where: {
          id: input.supplierId,
          tenantId: input.tenantId,
          status: 'ENABLED',
          businessScopes: { has: 'WAREHOUSE_UPSTREAM' },
        },
        select: { id: true },
      }),
      tx.warehouse.findFirst({
        where: { id: input.warehouseId, tenantId: input.tenantId, isActive: true },
        select: { id: true },
      }),
      tx.upstreamReceiptLine.findMany({
        where: { tenantId: input.tenantId, id: { in: normalizedLines.map(line => line.receiptLineId) } },
        include: {
          receipt: { select: { supplierId: true, warehouseId: true, status: true, reversedAt: true } },
          product: { select: { id: true, name: true } },
        },
      }),
    ])
    if (!supplier) throw businessError('上游供应商不存在、已停用或未开通总仓供货范围', 404)
    if (!warehouse) throw businessError('总仓不存在或已停用', 404)
    if (receiptLines.length !== normalizedLines.length) throw businessError('采购退货包含不存在的收货明细', 404)
    const receiptLineById = new Map(receiptLines.map(line => [line.id, line]))
    for (const requested of normalizedLines) {
      const source = receiptLineById.get(requested.receiptLineId)!
      if (source.receipt.supplierId !== input.supplierId || source.receipt.warehouseId !== input.warehouseId) {
        throw businessError(`${source.product.name}不属于所选供应商和总仓`, 409)
      }
      if (source.receipt.status !== 'POSTED' || source.receipt.reversedAt) {
        throw businessError(`${source.product.name}的原收货单尚未入账或已冲销，不能退货`, 409)
      }
      if (requested.purchaseQuantity.gt(source.acceptedQty)) {
        throw businessError(`${source.product.name}退货数量不能超过原合格收货数量`, 409)
      }
    }

    const no = await nextUpstreamDocumentNo(tx, input.tenantId, 'purchaseReturn')
    const settlementAmount = normalizedLines.reduce((sum, requested) => {
      const source = receiptLineById.get(requested.receiptLineId)!
      return sum.plus(requested.purchaseQuantity.mul(source.unitPrice))
    }, new Prisma.Decimal(0)).toDecimalPlaces(VALUE_DP)
    const created = await tx.upstreamPurchaseReturn.create({
      data: {
        tenantId: input.tenantId,
        no,
        supplierId: input.supplierId,
        warehouseId: input.warehouseId,
        reason,
        note,
        settlementAmount,
        idempotencyKey,
        requestFingerprint,
        createdById: input.userId,
      },
      include: returnInclude(),
    })
    await tx.upstreamPurchaseReturnLine.createMany({
      data: normalizedLines.map(requested => {
        const source = receiptLineById.get(requested.receiptLineId)!
        const inventoryQuantity = requested.purchaseQuantity
          .mul(source.inventoryUnitsPerPurchaseUnit)
          .toDecimalPlaces(QTY_DP)
        return {
          tenantId: input.tenantId,
          returnId: created.id,
          receiptLineId: source.id,
          productId: source.productId,
          purchaseQuantity: requested.purchaseQuantity,
          purchaseUnit: source.purchaseUnit,
          inventoryUnitsPerPurchaseUnit: source.inventoryUnitsPerPurchaseUnit,
          inventoryQuantity,
          inventoryUnit: source.inventoryUnit,
          settlementUnitPrice: source.unitPrice,
          settlementAmount: requested.purchaseQuantity.mul(source.unitPrice).toDecimalPlaces(VALUE_DP),
          note: requested.note,
        }
      }),
    })
    await tx.upstreamPurchaseReturnEvent.create({
      data: {
        tenantId: input.tenantId,
        returnId: created.id,
        type: 'CREATED',
        toStatus: 'DRAFT',
        actorId: input.userId,
        note: reason,
      },
    })
    await tx.opLog.create({
      data: {
        tenantId: input.tenantId,
        userId: input.userId,
        action: '创建采购退货单',
        entityType: 'UpstreamPurchaseReturn',
        target: no,
        targetId: created.id,
        metadata: { supplierId: input.supplierId, warehouseId: input.warehouseId, settlementAmount: settlementAmount.toFixed(2) },
      },
    })
    return {
      replayed: false,
      purchaseReturn: await tx.upstreamPurchaseReturn.findUniqueOrThrow({ where: { id: created.id }, include: returnInclude() }),
    }
  })
}

async function lockReceiptLines(tx: Prisma.TransactionClient, tenantId: string, receiptLineIds: string[]) {
  const ids = [...new Set(receiptLineIds)].sort()
  if (ids.length === 0) throw businessError('采购退货明细为空', 409)
  await tx.$queryRaw(Prisma.sql`
    SELECT "id"
    FROM "upstream_receipt_lines"
    WHERE "tenantId" = ${tenantId}
      AND "id" IN (${Prisma.join(ids)})
    ORDER BY "id"
    FOR UPDATE
  `)
}

async function assertReturnableQuantities(
  tx: Prisma.TransactionClient,
  tenantId: string,
  currentReturnId: string,
  lines: Array<{
    receiptLineId: string
    purchaseQuantity: Prisma.Decimal
    receiptLine: {
      acceptedQty: Prisma.Decimal
      receipt: { status: string; reversedAt: Date | null }
    }
    product: { name: string }
  }>,
) {
  for (const line of lines) {
    if (line.receiptLine.receipt.status !== 'POSTED' || line.receiptLine.receipt.reversedAt) {
      throw businessError(`${line.product.name}的原收货单尚未入账或已冲销，不能退货`, 409)
    }
  }
  const existing = await tx.upstreamPurchaseReturnLine.findMany({
    where: {
      tenantId,
      receiptLineId: { in: lines.map(line => line.receiptLineId) },
      returnId: { not: currentReturnId },
      purchaseReturn: { status: { in: [...RESERVING_STATUSES] } },
    },
    select: { receiptLineId: true, purchaseQuantity: true },
  })
  const reserved = new Map<string, Prisma.Decimal>()
  for (const line of existing) {
    reserved.set(line.receiptLineId, (reserved.get(line.receiptLineId) || new Prisma.Decimal(0)).plus(line.purchaseQuantity))
  }
  for (const line of lines) {
    const total = (reserved.get(line.receiptLineId) || new Prisma.Decimal(0)).plus(line.purchaseQuantity)
    if (total.gt(line.receiptLine.acceptedQty)) {
      throw businessError(`${line.product.name}累计退货数量超过原合格收货数量`, 409)
    }
  }
}

export async function submitUpstreamPurchaseReturn(tenantId: string, returnId: string, userId: string) {
  return serializableWithRetry(async tx => {
    const current = await tx.upstreamPurchaseReturn.findFirst({
      where: { id: returnId, tenantId },
      include: {
        lines: {
          include: {
            receiptLine: {
              select: { acceptedQty: true, receipt: { select: { status: true, reversedAt: true } } },
            },
            product: { select: { name: true } },
          },
        },
      },
    })
    if (!current) throw businessError('采购退货单不存在', 404)
    if (current.status === 'PENDING_APPROVAL') {
      return { replayed: true, purchaseReturn: await tx.upstreamPurchaseReturn.findUniqueOrThrow({ where: { id: current.id }, include: returnInclude() }) }
    }
    if (current.status !== 'DRAFT') throw businessError('只有草稿退货单可以提交审核', 409)
    await lockReceiptLines(tx, tenantId, current.lines.map(line => line.receiptLineId))
    await assertReturnableQuantities(tx, tenantId, current.id, current.lines)
    const changed = await tx.upstreamPurchaseReturn.updateMany({
      where: { id: current.id, tenantId, status: 'DRAFT', rowVersion: current.rowVersion },
      data: { status: 'PENDING_APPROVAL', submittedById: userId, submittedAt: new Date(), rowVersion: { increment: 1 } },
    })
    if (changed.count !== 1) throw businessError('退货单状态已变化，请刷新后重试', 409)
    await tx.upstreamPurchaseReturnEvent.create({
      data: { tenantId, returnId: current.id, type: 'SUBMITTED', fromStatus: 'DRAFT', toStatus: 'PENDING_APPROVAL', actorId: userId },
    })
    return {
      replayed: false,
      purchaseReturn: await tx.upstreamPurchaseReturn.findUniqueOrThrow({ where: { id: current.id }, include: returnInclude() }),
    }
  })
}

export async function approveUpstreamPurchaseReturn(tenantId: string, returnId: string, userId: string) {
  return serializableWithRetry(async tx => {
    await tx.$queryRaw(Prisma.sql`
      SELECT "id" FROM "upstream_purchase_returns"
      WHERE "tenantId" = ${tenantId} AND "id" = ${returnId}
      FOR UPDATE
    `)
    const current = await tx.upstreamPurchaseReturn.findFirst({
      where: { id: returnId, tenantId },
      include: {
        supplier: { select: { name: true } },
        lines: {
          include: {
            receiptLine: {
              select: { acceptedQty: true, receipt: { select: { status: true, reversedAt: true } } },
            },
            product: { select: { name: true } },
          },
        },
      },
    })
    if (!current) throw businessError('采购退货单不存在', 404)
    if (current.status === 'APPROVED' || current.status === 'RECEIVED') {
      return { replayed: true, purchaseReturn: await tx.upstreamPurchaseReturn.findUniqueOrThrow({ where: { id: current.id }, include: returnInclude() }) }
    }
    if (current.status !== 'PENDING_APPROVAL') throw businessError('只有待审核退货单可以审批', 409)
    await lockReceiptLines(tx, tenantId, current.lines.map(line => line.receiptLineId))
    await assertReturnableQuantities(tx, tenantId, current.id, current.lines)
    const posting = await postUpstreamPurchaseReturnInTransaction(tx, {
      tenantId,
      warehouseId: current.warehouseId,
      supplierId: current.supplierId,
      supplierName: current.supplier.name,
      purchaseReturnId: current.id,
      purchaseReturnNo: current.no,
      userId,
      effectiveAt: new Date(),
      lines: current.lines.map(line => ({
        returnLineId: line.id,
        productId: line.productId,
        productName: line.product.name,
        purchaseQuantity: line.purchaseQuantity,
        purchaseUnit: line.purchaseUnit,
        conversionFactor: line.inventoryUnitsPerPurchaseUnit,
        inventoryQuantity: line.inventoryQuantity,
        inventoryUnit: line.inventoryUnit,
      })),
    })
    const ledgerCostAmount = posting.movements.reduce(
      (sum, movement) => sum.plus(movement.valueDelta.abs()),
      new Prisma.Decimal(0),
    ).toDecimalPlaces(VALUE_DP)
    await tx.upstreamPurchaseReturn.update({
      where: { id: current.id },
      data: {
        status: 'APPROVED',
        approvedById: userId,
        approvedAt: new Date(),
        ledgerCostAmount,
        rowVersion: { increment: 1 },
      },
    })
    await tx.upstreamPurchaseReturnEvent.create({
      data: { tenantId, returnId: current.id, type: 'APPROVED', fromStatus: 'PENDING_APPROVAL', toStatus: 'APPROVED', actorId: userId },
    })
    return {
      replayed: posting.replayed,
      purchaseReturn: await tx.upstreamPurchaseReturn.findUniqueOrThrow({ where: { id: current.id }, include: returnInclude() }),
    }
  })
}

export async function rejectUpstreamPurchaseReturn(
  tenantId: string,
  returnId: string,
  userId: string,
  reason: string,
) {
  const rejectionReason = String(reason || '').trim()
  if (rejectionReason.length < 2 || rejectionReason.length > 240) throw businessError('驳回原因需为2至240个字符', 400)
  return serializableWithRetry(async tx => {
    const current = await tx.upstreamPurchaseReturn.findFirst({ where: { id: returnId, tenantId } })
    if (!current) throw businessError('采购退货单不存在', 404)
    if (current.status === 'REJECTED') {
      return { replayed: true, purchaseReturn: await tx.upstreamPurchaseReturn.findUniqueOrThrow({ where: { id: current.id }, include: returnInclude() }) }
    }
    if (current.status !== 'PENDING_APPROVAL') throw businessError('只有待审核退货单可以驳回', 409)
    const changed = await tx.upstreamPurchaseReturn.updateMany({
      where: { id: current.id, tenantId, status: 'PENDING_APPROVAL', rowVersion: current.rowVersion },
      data: {
        status: 'REJECTED',
        rejectedById: userId,
        rejectedAt: new Date(),
        rejectionReason,
        rowVersion: { increment: 1 },
      },
    })
    if (changed.count !== 1) throw businessError('退货单状态已变化，请刷新后重试', 409)
    await tx.upstreamPurchaseReturnEvent.create({
      data: {
        tenantId,
        returnId: current.id,
        type: 'REJECTED',
        fromStatus: 'PENDING_APPROVAL',
        toStatus: 'REJECTED',
        actorId: userId,
        note: rejectionReason,
      },
    })
    return { replayed: false, purchaseReturn: await tx.upstreamPurchaseReturn.findUniqueOrThrow({ where: { id: current.id }, include: returnInclude() }) }
  })
}

export async function cancelUpstreamPurchaseReturn(
  tenantId: string,
  returnId: string,
  userId: string,
  reason: string,
) {
  const cancellationReason = String(reason || '').trim()
  if (cancellationReason.length < 2 || cancellationReason.length > 240) throw businessError('取消原因需为2至240个字符', 400)
  return serializableWithRetry(async tx => {
    const current = await tx.upstreamPurchaseReturn.findFirst({ where: { id: returnId, tenantId } })
    if (!current) throw businessError('采购退货单不存在', 404)
    if (current.status === 'CANCELLED') {
      return { replayed: true, purchaseReturn: await tx.upstreamPurchaseReturn.findUniqueOrThrow({ where: { id: current.id }, include: returnInclude() }) }
    }
    if (!['DRAFT', 'PENDING_APPROVAL'].includes(current.status)) throw businessError('只有草稿或待审核退货单可以取消', 409)
    const fromStatus = current.status
    const changed = await tx.upstreamPurchaseReturn.updateMany({
      where: { id: current.id, tenantId, status: current.status, rowVersion: current.rowVersion },
      data: {
        status: 'CANCELLED',
        cancelledById: userId,
        cancelledAt: new Date(),
        cancellationReason,
        rowVersion: { increment: 1 },
      },
    })
    if (changed.count !== 1) throw businessError('退货单状态已变化，请刷新后重试', 409)
    await tx.upstreamPurchaseReturnEvent.create({
      data: { tenantId, returnId: current.id, type: 'CANCELLED', fromStatus, toStatus: 'CANCELLED', actorId: userId, note: cancellationReason },
    })
    return { replayed: false, purchaseReturn: await tx.upstreamPurchaseReturn.findUniqueOrThrow({ where: { id: current.id }, include: returnInclude() }) }
  })
}

export async function receiveUpstreamPurchaseReturn(
  tenantId: string,
  returnId: string,
  userId: string,
  note?: string | null,
) {
  const receivedNote = String(note || '').trim() || null
  if (receivedNote && receivedNote.length > 240) throw businessError('供应商实收备注不能超过240个字符', 400)
  return serializableWithRetry(async tx => {
    const current = await tx.upstreamPurchaseReturn.findFirst({ where: { id: returnId, tenantId } })
    if (!current) throw businessError('采购退货单不存在', 404)
    if (current.status === 'RECEIVED') {
      return { replayed: true, purchaseReturn: await tx.upstreamPurchaseReturn.findUniqueOrThrow({ where: { id: current.id }, include: returnInclude() }) }
    }
    if (current.status !== 'APPROVED') throw businessError('只有已审批出库的退货单可以登记供应商实收', 409)
    const changed = await tx.upstreamPurchaseReturn.updateMany({
      where: { id: current.id, tenantId, status: 'APPROVED', rowVersion: current.rowVersion },
      data: {
        status: 'RECEIVED',
        receivedById: userId,
        receivedAt: new Date(),
        receivedNote,
        rowVersion: { increment: 1 },
      },
    })
    if (changed.count !== 1) throw businessError('退货单状态已变化，请刷新后重试', 409)
    await tx.upstreamPurchaseReturnEvent.create({
      data: { tenantId, returnId: current.id, type: 'RECEIVED', fromStatus: 'APPROVED', toStatus: 'RECEIVED', actorId: userId, note: receivedNote },
    })
    await tx.opLog.create({
      data: {
        tenantId,
        userId,
        action: '登记供应商已收到采购退货',
        entityType: 'UpstreamPurchaseReturn',
        target: current.no,
        targetId: current.id,
        metadata: { supplierId: current.supplierId, receivedNote },
      },
    })
    return { replayed: false, purchaseReturn: await tx.upstreamPurchaseReturn.findUniqueOrThrow({ where: { id: current.id }, include: returnInclude() }) }
  })
}

export async function getUpstreamPurchaseReturn(tenantId: string, returnId: string) {
  const row = await prisma.upstreamPurchaseReturn.findFirst({ where: { id: returnId, tenantId }, include: returnInclude() })
  if (!row) throw businessError('采购退货单不存在', 404)
  return row
}

export async function listUpstreamPurchaseReturns(input: {
  tenantId: string
  supplierId?: string
  warehouseId?: string
  status?: Prisma.UpstreamPurchaseReturnWhereInput['status']
  take?: number
}) {
  return prisma.upstreamPurchaseReturn.findMany({
    where: {
      tenantId: input.tenantId,
      supplierId: input.supplierId,
      warehouseId: input.warehouseId,
      status: input.status,
    },
    include: returnInclude(),
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: Math.min(Math.max(input.take || 100, 1), 500),
  })
}

export async function listReturnableUpstreamReceiptLines(input: {
  tenantId: string
  supplierId?: string
  warehouseId?: string
  take?: number
}) {
  const lines = await prisma.upstreamReceiptLine.findMany({
    where: {
      tenantId: input.tenantId,
      acceptedQty: { gt: 0 },
      receipt: {
        status: 'POSTED',
        reversedAt: null,
        supplierId: input.supplierId,
        warehouseId: input.warehouseId,
      },
    },
    include: {
      receipt: { select: { id: true, no: true, supplierId: true, warehouseId: true, postedAt: true, supplier: { select: { no: true, name: true } }, warehouse: { select: { code: true, name: true } } } },
      product: { select: { id: true, code: true, name: true, spec: true } },
      purchaseReturnLines: {
        where: { purchaseReturn: { status: { in: [...RESERVING_STATUSES] } } },
        select: { purchaseQuantity: true },
      },
    },
    orderBy: [{ receipt: { postedAt: 'desc' } }, { createdAt: 'desc' }],
    take: Math.min(Math.max(input.take || 500, 1), 1000),
  })
  return lines.map(line => {
    const returned = line.purchaseReturnLines.reduce((sum, item) => sum.plus(item.purchaseQuantity), new Prisma.Decimal(0))
    return {
      ...line,
      reservedReturnQuantity: returned,
      returnableQuantity: Prisma.Decimal.max(new Prisma.Decimal(0), line.acceptedQty.minus(returned)),
    }
  }).filter(line => line.returnableQuantity.gt(0))
}
