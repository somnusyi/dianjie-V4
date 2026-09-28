import { Prisma, prisma } from '@dianjie/db'
import {
  adjustWarehouseMovementValue,
  recordBatchManualWarehouseInbound,
  reverseManualWarehouseInbound,
} from './warehouseLedger'

function docError(message: string, statusCode = 409) {
  const error: any = new Error(message)
  error.statusCode = statusCode
  return error
}

export type WarehouseDocAttachmentInput = {
  key: string
  name: string
  mime: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' | 'application/pdf'
  size: number
}

const warehouseDocAttachmentMimes = new Set<WarehouseDocAttachmentInput['mime']>([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf',
])

/**
 * Supplier delivery documents are stored as durable OSS object keys, never as
 * expiring signed URLs. The key prefix is tenant-owned and purpose-specific so
 * another module's loss evidence cannot be attached by reference.
 */
export function normalizeWarehouseDocAttachments(tenantId: string, value: unknown): WarehouseDocAttachmentInput[] {
  if (value == null) return []
  if (!Array.isArray(value)) throw docError('随货单据格式无效', 400)
  if (value.length > 9) throw docError('随货单据最多上传9份', 400)
  const prefix = `warehouse-docs/${tenantId}/`
  const seen = new Set<string>()
  return value.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw docError(`第${index + 1}份随货单据格式无效`, 400)
    }
    const raw = candidate as Record<string, unknown>
    const key = typeof raw.key === 'string' ? raw.key.trim() : ''
    const name = typeof raw.name === 'string' ? raw.name.trim() : ''
    const mime = typeof raw.mime === 'string' ? raw.mime : ''
    const size = Number(raw.size)
    if (!key.startsWith(prefix) || key.length > 1024 || key.slice(prefix.length).length === 0 || key.includes('..')) {
      throw docError(`第${index + 1}份随货单据不属于当前租户`, 403)
    }
    if (seen.has(key)) throw docError('随货单据不能重复', 400)
    if (!name || name.length > 160) throw docError(`第${index + 1}份随货单据名称无效`, 400)
    if (!warehouseDocAttachmentMimes.has(mime as WarehouseDocAttachmentInput['mime'])) {
      throw docError(`第${index + 1}份随货单据类型无效`, 400)
    }
    if (!Number.isInteger(size) || size <= 0 || size > 10 * 1024 * 1024) {
      throw docError(`第${index + 1}份随货单据大小无效`, 400)
    }
    seen.add(key)
    return { key, name, mime: mime as WarehouseDocAttachmentInput['mime'], size }
  })
}

/**
 * 生成单据编号：RK/CK + yyyymmdd（按单据日期，北京时间）+ 当日序号。
 * BusinessSequence 的 upsert+increment 由数据库串行分配，避免在事务内
 * 捕获 P2002 后继续查询（PostgreSQL 唯一冲突后事务已 aborted）。
 */
async function generateDocNo(db: Prisma.TransactionClient | typeof prisma, tenantId: string, type: 'MANUAL_INBOUND' | 'MANUAL_OUTBOUND', effectiveAt: Date) {
  const prefix = type === 'MANUAL_INBOUND' ? 'RK' : 'CK'
  const beijing = new Date(effectiveAt.getTime() + 8 * 3_600_000)
  const yyyy = beijing.getUTCFullYear()
  const mm = String(beijing.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(beijing.getUTCDate()).padStart(2, '0')
  const day = `${yyyy}${mm}${dd}`
  const numberPrefix = `${prefix}${day}-`
  const last = await db.warehouseDoc.findFirst({
    where: { tenantId, type, docNo: { startsWith: numberPrefix } },
    orderBy: { docNo: 'desc' },
    select: { docNo: true },
  })
  const parsedFloor = Number(last?.docNo.slice(numberPrefix.length) || 0)
  const floor = Number.isSafeInteger(parsedFloor) && parsedFloor >= 0 ? parsedFloor : 0
  const scope = type === 'MANUAL_INBOUND' ? 'WHDOC_IN' : 'WHDOC_OUT'
  if (floor > 0) {
    await db.businessSequence.updateMany({
      where: { tenantId, scope, period: day, value: { lt: floor } },
      data: { value: floor },
    })
  }
  const sequence = await db.businessSequence.upsert({
    where: { tenantId_scope_period: { tenantId, scope, period: day } },
    create: { tenantId, scope, period: day, value: Math.max(1, floor + 1) },
    update: { value: { increment: 1 } },
    select: { value: true },
  })
  return `${numberPrefix}${String(sequence.value).padStart(3, '0')}`
}

async function resolveActorName(db: Prisma.TransactionClient | typeof prisma, tenantId: string, userId: string | null | undefined) {
  if (!userId) return null
  const user = await db.user.findFirst({ where: { id: userId, tenantId }, select: { name: true } })
  return user?.name || null
}

export type WarehouseDocLineInput = {
  productId: string
  productName: string
  /** 录入数量：入库=采购单位，出库=库存单位 */
  quantity: Prisma.Decimal | number | string
  unit: string
  unitPrice?: Prisma.Decimal | number | string | null
  amount: Prisma.Decimal | number | string
  inventoryQuantity: Prisma.Decimal | number | string
  inventoryUnit: string
  note?: string | null
  batchNo?: string | null
  manufactureDate?: Date | null
  expiryDate?: Date | null
  movementId?: string | null
}

/**
 * 建单（find-or-create）：手工入库/出库过账后调用，把台账批次登记为一张单据。
 * 幂等：同一 (type, idempotencyKey) 重复调用直接返回已有单据。
 */
export type EnsureWarehouseDocInput = {
  tenantId: string
  userId: string
  type: 'MANUAL_INBOUND' | 'MANUAL_OUTBOUND'
  warehouseId: string
  effectiveAt: Date
  idempotencyKey: string
  supplierId?: string | null
  supplierName?: string | null
  attachments?: WarehouseDocAttachmentInput[]
  reason?: string | null
  note?: string | null
  lines: WarehouseDocLineInput[]
}

export async function ensureWarehouseDocInTransaction(tx: Prisma.TransactionClient, input: EnsureWarehouseDocInput) {
  // 同租户/单据类型/业务日的取号串行化。ReadCommitted 独立建单路径在等待后
  // 能看到前一事务已提交的幂等单据和 BusinessSequence；台账内嵌路径仍由
  // 外层 Serializable 整笔重试保证扣库+建单原子性。
  const lockDay = new Date(input.effectiveAt.getTime() + 8 * 3_600_000).toISOString().slice(0, 10)
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`warehouse-doc:${input.tenantId}:${input.type}:${lockDay}`}, 0))::text AS locked`
  const idempotencyWhere = {
    tenantId_type_idempotencyKey: {
      tenantId: input.tenantId,
      type: input.type,
      idempotencyKey: input.idempotencyKey,
    },
  } as const
  const existing = await tx.warehouseDoc.findUnique({
    where: idempotencyWhere,
    include: { lines: true },
  })
  if (existing) return { doc: existing, created: false }
  const totalAmount = input.lines.reduce((sum, line) => sum.plus(line.amount), new Prisma.Decimal(0)).toDecimalPlaces(4)
  const docNo = await generateDocNo(tx, input.tenantId, input.type, input.effectiveAt)
  const doc = await tx.warehouseDoc.create({
        data: {
          tenantId: input.tenantId,
          docNo,
          type: input.type,
          warehouseId: input.warehouseId,
          supplierId: input.supplierId || null,
          supplierName: input.supplierName || null,
          attachments: input.attachments?.length ? input.attachments : Prisma.DbNull,
          reason: input.reason || null,
          note: input.note || null,
          effectiveAt: input.effectiveAt,
          status: 'POSTED',
          lineCount: input.lines.length,
          totalAmount,
          idempotencyKey: input.idempotencyKey,
          createdById: input.userId,
          lines: {
            create: input.lines.map((line, index) => ({
              tenantId: input.tenantId,
              lineNo: index + 1,
              productId: line.productId,
              productName: line.productName,
              quantity: new Prisma.Decimal(line.quantity),
              unit: line.unit,
              unitPrice: line.unitPrice === null || line.unitPrice === undefined ? null : new Prisma.Decimal(line.unitPrice),
              amount: new Prisma.Decimal(line.amount),
              inventoryQuantity: new Prisma.Decimal(line.inventoryQuantity),
              inventoryUnit: line.inventoryUnit,
              note: line.note || null,
              batchNo: line.batchNo || null,
              manufactureDate: line.manufactureDate || null,
              expiryDate: line.expiryDate || null,
              movementId: line.movementId || null,
            })),
          },
        },
        include: { lines: true },
      })
  await tx.warehouseDocLog.create({
    data: {
      tenantId: input.tenantId,
      docId: doc.id,
      action: 'CREATE',
      actorId: input.userId,
      actorName: await resolveActorName(tx, input.tenantId, input.userId),
      detail: { lineCount: input.lines.length, totalAmount: totalAmount.toFixed(2) },
    },
  })
  return { doc, created: true }
}

export async function ensureWarehouseDoc(input: EnsureWarehouseDocInput) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      return await prisma.$transaction(tx => ensureWarehouseDocInTransaction(tx, input), {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      })
    } catch (error: any) {
      const rawSerializationConflict = error?.code === 'P2010'
        && (String(error?.meta?.code || '') === '40001'
          || /could not serialize|serialization failure|SQLSTATE\s*40001/i.test(String(error?.meta?.message || error?.message || '')))
      // 整笔事务重试：绝不在已 aborted 的 PostgreSQL 事务内继续查询。
      // P2002 可能来自同幂等请求的并发首写，重试后会命中已存在单据。
      if ((!['P2034', 'P2002'].includes(error?.code) && !rawSerializationConflict) || attempt === 4) throw error
    }
  }
  throw docError('仓库单据登记失败，请使用同一请求标识重试', 409)
}

/** 会计审核：POSTED → CONFIRMED，锁定单据。 */
export async function confirmWarehouseDoc(input: { tenantId: string; userId: string; docId: string }) {
  const doc = await prisma.warehouseDoc.findFirst({ where: { id: input.docId, tenantId: input.tenantId } })
  if (!doc) throw docError('单据不存在', 404)
  if (doc.status === 'CONFIRMED') return { doc, changed: false }
  const updated = await prisma.warehouseDoc.update({
    where: { id: doc.id },
    data: { status: 'CONFIRMED', confirmedById: input.userId, confirmedAt: new Date() },
  })
  await prisma.warehouseDocLog.create({
    data: {
      tenantId: input.tenantId,
      docId: doc.id,
      action: 'CONFIRM',
      actorId: input.userId,
      actorName: await resolveActorName(prisma, input.tenantId, input.userId),
    },
  })
  return { doc: updated, changed: true }
}

/** 会计反审核：CONFIRMED → POSTED，必填退回原因；已复审的单据不能反审核。 */
export async function unconfirmWarehouseDoc(input: { tenantId: string; userId: string; docId: string; reason: string }) {
  const reason = String(input.reason || '').trim()
  if (reason.length < 2 || reason.length > 240) throw docError('请填写退回原因（2至240个字符）', 400)
  const doc = await prisma.warehouseDoc.findFirst({ where: { id: input.docId, tenantId: input.tenantId } })
  if (!doc) throw docError('单据不存在', 404)
  if (doc.status !== 'CONFIRMED') throw docError('只有已审核的单据才能反审核', 409)
  if (doc.reviewStatus === 'REVIEWED') throw docError('该单据已复审，需先由财务反复审', 409)
  const updated = await prisma.warehouseDoc.update({
    where: { id: doc.id },
    data: {
      status: 'POSTED',
      unauditedById: input.userId,
      unauditedAt: new Date(),
      unauditReason: reason,
    },
  })
  await prisma.warehouseDocLog.create({
    data: {
      tenantId: input.tenantId,
      docId: doc.id,
      action: 'UNCONFIRM',
      actorId: input.userId,
      actorName: await resolveActorName(prisma, input.tenantId, input.userId),
      reason,
    },
  })
  return { doc: updated }
}

export type WarehouseDocEditLine = {
  lineId: string
  /** 新行金额（入库=价税合计；出库=成本额）；不传表示不改 */
  amount?: number | null
  /** 新数量（仅入库行且批次未被消耗时可改）；不传表示不改 */
  quantity?: number | null
  note?: string | null
  batchNo?: string | null
  manufactureDate?: string | null // YYYY-MM-DD
  expiryDate?: string | null
}

/**
 * 反审核后的单据编辑。
 * - 金额/单价变化 → ADJUSTMENT 差额流水（数量不动）
 * - 入库行数量变化且批次未被消耗 → 冲销重记；批次已消耗则拒绝
 * - 出库行数量不可改（数量差错走实盘/报损）
 * - 表头：供应商（仅入库单）、备注、出库原因
 */
export async function editWarehouseDoc(input: {
  tenantId: string
  userId: string
  docId: string
  editReason: string
  supplierId?: string
  note?: string | null
  reason?: string | null
  lines: WarehouseDocEditLine[]
}) {
  const editReason = String(input.editReason || '').trim()
  if (editReason.length < 2 || editReason.length > 240) throw docError('请填写修改原因（2至240个字符）', 400)
  const doc = await prisma.warehouseDoc.findFirst({
    where: { id: input.docId, tenantId: input.tenantId },
    include: { lines: { orderBy: { lineNo: 'asc' }, include: { movement: true } } },
  })
  if (!doc) throw docError('单据不存在', 404)
  if (doc.status !== 'POSTED') throw docError('只有未审核的单据才能修改，请先联系会计反审核', 409)

  const lineById = new Map(doc.lines.map(line => [line.id, line]))
  const diffDetail: any = { header: {}, lines: [] }
  const editSeq = await prisma.warehouseLedgerMovement.count({
    where: { tenantId: input.tenantId, sourceType: 'WarehouseDocValueAdjust', sourceId: doc.id },
  })

  // ── 表头修改 ──
  const headerData: any = {}
  if (input.supplierId !== undefined && doc.type === 'MANUAL_INBOUND') {
    const supplier = await prisma.supplier.findFirst({
      where: { id: input.supplierId, tenantId: input.tenantId, businessScopes: { has: 'WAREHOUSE_UPSTREAM' }, status: 'ENABLED' },
      select: { id: true, name: true },
    })
    if (!supplier) throw docError('供应商不存在或未启用', 404)
    if (supplier.id !== doc.supplierId) {
      headerData.supplierId = supplier.id
      headerData.supplierName = supplier.name
      diffDetail.header.supplier = { from: doc.supplierName, to: supplier.name }
    }
  }
  if (input.note !== undefined && input.note !== doc.note) {
    headerData.note = input.note
    diffDetail.header.note = { from: doc.note, to: input.note }
  }
  if (input.reason !== undefined && doc.type === 'MANUAL_OUTBOUND' && input.reason !== doc.reason) {
    headerData.reason = input.reason
    diffDetail.header.reason = { from: doc.reason, to: input.reason }
  }

  let totalAmount = doc.totalAmount
  let lineAdjustSeq = 0

  for (const change of input.lines || []) {
    const line = lineById.get(change.lineId)
    if (!line) throw docError('单据行不存在', 404)
    const movement = line.movement
    const lineDiff: any = { lineNo: line.lineNo, productName: line.productName }
    let changed = false

    const newAmount = change.amount === null || change.amount === undefined ? null : Number(change.amount)
    if (newAmount !== null) {
      if (!Number.isFinite(newAmount) || newAmount <= 0 || newAmount > 999_999_999.99) throw docError(`第${line.lineNo}行金额无效`, 400)
      const oldAmount = Number(line.amount)
      if (Math.abs(newAmount - oldAmount) > 0.0001) {
        if (!movement) throw docError(`第${line.lineNo}行缺少台账流水，不能改金额`, 409)
        lineAdjustSeq += 1
        await adjustWarehouseMovementValue({
          tenantId: input.tenantId,
          userId: input.userId,
          movementId: movement.id,
          newAmount,
          reason: editReason,
          idempotencyKey: `${doc.id}:${line.id}:${editSeq + lineAdjustSeq}`,
          docId: doc.id,
          docNo: doc.docNo,
        })
        lineDiff.amount = { from: oldAmount, to: newAmount }
        changed = true
        totalAmount = totalAmount.minus(oldAmount).plus(newAmount)
      }
    }

    const newQuantity = change.quantity === null || change.quantity === undefined ? null : Number(change.quantity)
    if (newQuantity !== null) {
      if (!Number.isFinite(newQuantity) || newQuantity <= 0 || newQuantity > 99_999_999) throw docError(`第${line.lineNo}行数量无效`, 400)
      const oldQuantity = Number(line.quantity)
      if (Math.abs(newQuantity - oldQuantity) > 0.000001) {
        if (doc.type !== 'MANUAL_INBOUND') {
          throw docError('出库单数量不能直接修改；数量差错请用实盘或报损处理', 409)
        }
        if (!movement) throw docError(`第${line.lineNo}行缺少台账流水，不能改数量`, 409)
        // 冲销重记：数量 × 当前行单价（若本行同时改了金额，单价按新金额/新数量推算）
        const basisAmount = newAmount !== null ? newAmount : Number(line.amount)
        const newUnitPrice = basisAmount / newQuantity
        const reversalKey = `docedit-${doc.id.slice(-12)}-${line.lineNo}-r${editSeq + lineAdjustSeq}`
        await reverseManualWarehouseInbound({
          tenantId: input.tenantId,
          userId: input.userId,
          movementId: movement.id,
          reason: `单据 ${doc.docNo} 改数量：${editReason}`,
          idempotencyKey: reversalKey,
        })
        const repost = await recordBatchManualWarehouseInbound({
          tenantId: input.tenantId,
          userId: input.userId,
          items: [{
            productId: line.productId,
            purchaseQuantity: newQuantity,
            unitPrice: newUnitPrice,
            batchNo: change.batchNo !== undefined ? change.batchNo : line.batchNo,
            manufactureDate: change.manufactureDate !== undefined
              ? (change.manufactureDate ? new Date(`${change.manufactureDate}T00:00:00+08:00`) : null)
              : line.manufactureDate,
            expiryDate: change.expiryDate !== undefined
              ? (change.expiryDate ? new Date(`${change.expiryDate}T00:00:00+08:00`) : null)
              : line.expiryDate,
          }],
          effectiveAt: doc.effectiveAt,
          idempotencyKey: `docedit-${doc.id.slice(-12)}-${line.lineNo}-p${editSeq + lineAdjustSeq}`,
          supplierId: (headerData.supplierId as string | undefined) || doc.supplierId || '',
          sourceName: (headerData.supplierName as string | undefined) || doc.supplierName,
          note: `单据 ${doc.docNo} 改数量重记：${editReason}`.slice(0, 240),
        })
        const newMovement = repost.movements[0]
        if (!newMovement) throw docError(`第${line.lineNo}行重记失败，请联系管理员`, 500)
        await prisma.warehouseDocLine.update({
          where: { id: line.id },
          data: {
            quantity: new Prisma.Decimal(newQuantity),
            amount: new Prisma.Decimal(basisAmount.toFixed(4)),
            unitPrice: new Prisma.Decimal(newUnitPrice.toFixed(6)),
            inventoryQuantity: new Prisma.Decimal(Math.abs(Number(newMovement.physicalDelta))),
            movementId: newMovement.id,
          },
        })
        lineDiff.quantity = { from: oldQuantity, to: newQuantity }
        lineDiff.reposted = { fromMovement: movement.id, toMovement: newMovement.id }
        changed = true
        totalAmount = totalAmount.minus(line.amount).plus(basisAmount.toFixed(4))
        // 数量修改已含金额口径，跳过上面的差额调整标记
        if (lineDiff.amount) delete lineDiff.amount
      }
    }

    const lineData: any = {}
    if (change.note !== undefined && change.note !== line.note) {
      lineData.note = change.note
      lineDiff.note = { from: line.note, to: change.note }
      changed = true
    }
    if (doc.type === 'MANUAL_INBOUND') {
      if (change.batchNo !== undefined && change.batchNo !== line.batchNo) {
        lineData.batchNo = change.batchNo
        lineDiff.batchNo = { from: line.batchNo, to: change.batchNo }
        changed = true
      }
      if (change.manufactureDate !== undefined) {
        const value = change.manufactureDate ? new Date(`${change.manufactureDate}T00:00:00+08:00`) : null
        lineData.manufactureDate = value
        changed = true
      }
      if (change.expiryDate !== undefined) {
        const value = change.expiryDate ? new Date(`${change.expiryDate}T00:00:00+08:00`) : null
        lineData.expiryDate = value
        changed = true
      }
    }
    // 纯金额修改（未走冲销重记）时同步单据行金额与单价
    if (lineDiff.amount && !lineDiff.quantity) {
      lineData.amount = new Prisma.Decimal(newAmount!.toFixed(4))
      lineData.unitPrice = new Prisma.Decimal((newAmount! / Number(line.quantity)).toFixed(6))
    }
    if (Object.keys(lineData).length > 0) {
      await prisma.warehouseDocLine.update({ where: { id: line.id }, data: lineData })
    }
    if (changed) diffDetail.lines.push(lineDiff)
  }

  // 供应商变更同步到该单所有入库流水的归属（台账数量/金额不变，仅供应商归属）
  if (headerData.supplierId) {
    const movementIds = doc.lines.map(line => line.movementId).filter(Boolean) as string[]
    await prisma.warehouseLedgerMovement.updateMany({
      where: { tenantId: input.tenantId, id: { in: movementIds }, type: 'MANUAL_INBOUND' },
      data: { supplierId: headerData.supplierId, sourceName: headerData.supplierName },
    })
  }

  const hasChanges = diffDetail.lines.length > 0 || Object.keys(diffDetail.header).length > 0
  const updated = await prisma.warehouseDoc.update({
    where: { id: doc.id },
    data: { ...headerData, totalAmount: totalAmount.toDecimalPlaces(4) },
    include: { lines: { orderBy: { lineNo: 'asc' } } },
  })
  if (hasChanges) {
    await prisma.warehouseDocLog.create({
      data: {
        tenantId: input.tenantId,
        docId: doc.id,
        action: 'EDIT',
        actorId: input.userId,
        actorName: await resolveActorName(prisma, input.tenantId, input.userId),
        reason: editReason,
        detail: diffDetail,
      },
    })
  }
  return { doc: updated, changed: hasChanges }
}
