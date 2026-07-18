/**
 * 供应商库存管理 API
 *
 * 路径: /api/supplier/stock/*
 * 角色: 仅供应商角色 (SUPPLIER_OWNER / SUPPLIER_STAFF) 可访问自家库存
 *
 * 设计原则:
 *  - StockMovement 表 append-only, 每次变动必有审计记录
 *  - Product.stock 字段 = 当前余额 (累加 movement 计算得出, 但为查询效率冗余存)
 *  - 入库/出库/盘点 都通过 transaction 同时更新 Product.stock 和 SupplierStockMovement
 */
import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { Prisma, prisma } from '@dianjie/db'
import { requireSupplierCapability, SupplierCapability } from '../lib/supplier-access'
import { getSupplierReservedStock, stockAvailability } from '../services/supplierStockReservation'
import {
  applySupplierStockBatchDelta,
  consumeSupplierStockBatches,
  createSupplierStockBatchIncrease,
} from '../services/supplierStockBatch'
import { calendarDateSchema } from '../lib/calendar-date'

const auth = (app: any) => ({ preHandler: [app.authenticate] })

function ensureSupplier(
  req: any,
  reply: any,
  capability: SupplierCapability,
): { tenantId: string; userId: string; supplierId: string } | null {
  const { tenantId, role, userId, supplierId } = req.user
  try {
    const scopedSupplierId = requireSupplierCapability(role, supplierId, capability)
    return { tenantId, userId, supplierId: scopedSupplierId }
  } catch (error: any) {
    reply.status(error?.statusCode || 403).send({ error: error?.message || '无权限' })
    return null
  }
}

const dateSchema = calendarDateSchema.optional().nullable()
const stockQtySchema = z.number()
  .nonnegative('数量不能为负')
  .max(99_999_999.99, '数量超过库存字段上限')
  .refine(value => Math.abs(value * 100 - Math.round(value * 100)) < 1e-8, '数量最多保留 2 位小数')

const inboundItemSchema = z.object({
  productId:       z.string(),
  qty:             stockQtySchema.refine(value => value > 0, '数量必须 > 0'),
  reason:          z.string().trim().max(120).optional(),
  batchNo:         z.string().trim().min(1).max(80).optional(),
  manufactureDate: dateSchema,   // 生产日期 YYYY-MM-DD (可空)
  expiryDate:      dateSchema,   // 到期日期 (前端按 生产日期+保质期天数 自动算或手动改)
}).superRefine((item, ctx) => {
  if (item.manufactureDate && item.expiryDate && item.expiryDate < item.manufactureDate) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['expiryDate'], message: '到期日期不能早于生产日期' })
  }
})

const inboundSchema = z.object({
  items:     z.array(inboundItemSchema).min(1).max(500),
  source:    z.enum(['MANUAL', 'EXCEL']).default('MANUAL'),
  reason:    z.string().trim().max(120).optional(),  // 整批理由
}).superRefine((value, ctx) => {
  const customBatchKeys = value.items
    .filter(item => item.batchNo)
    .map(item => `${item.productId}\u0000${item.batchNo}`)
  if (new Set(customBatchKeys).size !== customBatchKeys.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['items'], message: '同一商品不能重复提交相同批次号' })
  }
})

const adjustSchema = z.object({
  productId: z.string(),
  newQty:    stockQtySchema,
  reason:    z.string().trim().min(1, '请说明盘点/调整原因').max(120),
})

const lossSchema = z.object({
  productId: z.string(),
  qty:       stockQtySchema.refine(value => value > 0, '报损数量必须 > 0'),
  reason:    z.string().trim().min(1, '请说明报损原因').max(120),
})

type SupplierContext = { tenantId: string; userId: string; supplierId: string }

/**
 * Lock supplier product rows in a stable order before any read-modify-write.
 *
 * PostgreSQL row locks coordinate these manual inventory mutations with the
 * atomic stock decrement used by delivery shipment. Stable ordering prevents
 * inverse-order batch requests from deadlocking each other.
 */
async function lockSupplierProducts(
  tx: Prisma.TransactionClient,
  ctx: SupplierContext,
  productIds: string[],
  notFound: { statusCode: number; message: string } = {
    statusCode: 400,
    message: '商品不属于本供应商或不存在',
  },
) {
  const ids = [...new Set(productIds)].sort()
  if (ids.length === 0) return new Map<string, Prisma.Decimal>()

  const rows = await tx.$queryRaw<Array<{ id: string; stock: Prisma.Decimal }>>(Prisma.sql`
    SELECT "id", "stock"
    FROM "products"
    WHERE "tenantId" = ${ctx.tenantId}
      AND "supplierId" = ${ctx.supplierId}
      AND "id" IN (${Prisma.join(ids)})
    ORDER BY "id"
    FOR UPDATE
  `)
  if (rows.length !== ids.length) {
    throw Object.assign(new Error(notFound.message), { statusCode: notFound.statusCode })
  }
  return new Map(rows.map(row => [row.id, row.stock]))
}

async function activeReservedForProduct(
  tx: Prisma.TransactionClient,
  ctx: SupplierContext,
  productId: string,
) {
  const aggregate = await tx.supplierStockReservation.aggregate({
    where: {
      tenantId: ctx.tenantId,
      supplierId: ctx.supplierId,
      productId,
      status: 'ACTIVE',
    },
    _sum: { quantity: true },
  })
  return aggregate._sum.quantity || new Prisma.Decimal(0)
}

export const supplierStockRoutes: FastifyPluginAsync = async (app) => {

  /** GET /api/supplier/stock — 列表 + 摘要 */
  app.get('/', auth(app), async (req: any, reply: any) => {
    const ctx = ensureSupplier(req, reply, 'inventory.read'); if (!ctx) return

    const products = await prisma.product.findMany({
      where: { tenantId: ctx.tenantId, supplierId: ctx.supplierId, status: 'ENABLED' },
      orderBy: [{ stock: 'asc' }, { name: 'asc' }, { id: 'asc' }],   // 库存少的排前面
      select: {
        id: true, code: true, name: true, spec: true, unit: true, category: true,
        stock: true, minStock: true, price: true, shelfDays: true,
      },
    })
    const reservedByProduct = await getSupplierReservedStock({
      tenantId: ctx.tenantId,
      supplierId: ctx.supplierId,
      productIds: products.map(product => product.id),
    })

    // 统计每个 SKU 近 7 天 / 30 天的入库/出库总量
    const since7  = new Date(Date.now() - 7  * 86400_000)
    const since30 = new Date(Date.now() - 30 * 86400_000)
    const movs = await prisma.supplierStockMovement.findMany({
      where: { tenantId: ctx.tenantId, supplierId: ctx.supplierId, createdAt: { gte: since30 } },
      select: { productId: true, delta: true, createdAt: true, type: true },
    })
    const byProd = new Map<string, { in7: number; out7: number; in30: number; out30: number }>()
    for (const m of movs) {
      const slot = byProd.get(m.productId) || { in7: 0, out7: 0, in30: 0, out30: 0 }
      const d = Number(m.delta)
      const recent7 = m.createdAt >= since7
      if (d > 0) { slot.in30 += d; if (recent7) slot.in7 += d }
      else       { slot.out30 += -d; if (recent7) slot.out7 += -d }
      byProd.set(m.productId, slot)
    }

    // 只看仍有余额的批次，避免已耗尽批次继续触发临期告警。
    const expRows = await prisma.supplierStockBatch.findMany({
      where: {
        tenantId: ctx.tenantId,
        supplierId: ctx.supplierId,
        remainingQty: { gt: 0 },
        expiryDate: { not: null },
      },
      select: { productId: true, expiryDate: true },
      orderBy: [{ expiryDate: 'asc' }, { id: 'asc' }],
    })
    const nearestExpiry = new Map<string, Date>()
    for (const r of expRows) {
      if (!nearestExpiry.has(r.productId)) nearestExpiry.set(r.productId, r.expiryDate!)
    }

    return products.map(p => {
      const stat = byProd.get(p.id) || { in7: 0, out7: 0, in30: 0, out30: 0 }
      const stock = Number(p.stock)
      const availability = stockAvailability(stock, reservedByProduct.get(p.id) || 0)
      const minStock = Number(p.minStock)
      const status = availability.availableStock <= 0 ? 'OUT' : availability.availableStock < minStock ? 'LOW' : 'OK'
      const exp = nearestExpiry.get(p.id) || null
      const daysToExpiry = exp ? Math.ceil((exp.getTime() - Date.now()) / 86400_000) : null
      return {
        ...p,
        stock,
        ...availability,
        minStock,
        price: Number(p.price),
        statusFlag: status,
        in7d: stat.in7, out7d: stat.out7,
        in30d: stat.in30, out30d: stat.out30,
        nearestExpiry: exp ? exp.toISOString().slice(0, 10) : null,  // YYYY-MM-DD
        daysToExpiry,                                                  // 距今天数 (负数=已过期)
      }
    })
  })

  /** GET /api/supplier/stock/summary — 顶部 KPI */
  app.get('/summary', auth(app), async (req: any, reply: any) => {
    const ctx = ensureSupplier(req, reply, 'inventory.read'); if (!ctx) return
    const ps = await prisma.product.findMany({
      where: { tenantId: ctx.tenantId, supplierId: ctx.supplierId, status: 'ENABLED' },
      select: { id: true, stock: true, minStock: true, price: true },
    })
    const reservedByProduct = await getSupplierReservedStock({
      tenantId: ctx.tenantId,
      supplierId: ctx.supplierId,
      productIds: ps.map(product => product.id),
    })
    let totalSku = ps.length, lowStock = 0, outOfStock = 0, totalValue = 0, availableValue = 0, reservedValue = 0
    for (const p of ps) {
      const s = Number(p.stock), m = Number(p.minStock), v = Number(p.price)
      const reserved = reservedByProduct.get(p.id) || 0
      const available = Math.max(0, s - reserved)
      if (available <= 0) outOfStock++
      else if (available < m) lowStock++
      totalValue += s * v
      availableValue += available * v
      reservedValue += reserved * v
    }
    return {
      totalSku, lowStock, outOfStock,
      totalValue: Math.round(totalValue * 100) / 100,
      availableValue: Math.round(availableValue * 100) / 100,
      reservedValue: Math.round(reservedValue * 100) / 100,
    }
  })

  /** GET /api/supplier/stock/reservations?productId= — 当前有效预占来源 */
  app.get('/reservations', auth(app), async (req: any, reply: any) => {
    const ctx = ensureSupplier(req, reply, 'inventory.read'); if (!ctx) return
    const parsed = z.object({
      productId: z.string().trim().min(1).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(100),
    }).safeParse(req.query || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const rows = await prisma.supplierStockReservation.findMany({
      where: {
        tenantId: ctx.tenantId,
        supplierId: ctx.supplierId,
        status: 'ACTIVE',
        ...(parsed.data.productId ? { productId: parsed.data.productId } : {}),
      },
      orderBy: [{ purchaseOrder: { expectedDate: 'asc' } }, { createdAt: 'asc' }, { id: 'asc' }],
      take: parsed.data.limit,
      include: {
        product: { select: { id: true, code: true, name: true, unit: true } },
        purchaseOrder: {
          select: {
            id: true, no: true, status: true, expectedDate: true, createdAt: true,
            store: { select: { id: true, name: true } },
          },
        },
      },
    })
    return rows.map(row => ({
      id: row.id,
      quantity: Number(row.quantity),
      fulfilledQty: Number(row.fulfilledQty),
      createdAt: row.createdAt,
      product: row.product,
      order: row.purchaseOrder,
    }))
  })

  /** GET /api/supplier/stock/batches — 当前批次余额与来源 */
  app.get('/batches', auth(app), async (req: any, reply: any) => {
    const ctx = ensureSupplier(req, reply, 'inventory.read'); if (!ctx) return
    const parsed = z.object({
      productId: z.string().trim().min(1).optional(),
      includeDepleted: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
      limit: z.coerce.number().int().min(1).max(500).default(200),
    }).safeParse(req.query || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })

    const rows = await prisma.supplierStockBatch.findMany({
      where: {
        tenantId: ctx.tenantId,
        supplierId: ctx.supplierId,
        ...(parsed.data.productId ? { productId: parsed.data.productId } : {}),
        ...(parsed.data.includeDepleted ? {} : { remainingQty: { gt: 0 } }),
      },
      orderBy: [
        { kind: 'asc' },
        { expiryDate: { sort: 'asc', nulls: 'last' } },
        { createdAt: 'asc' },
        { id: 'asc' },
      ],
      take: parsed.data.limit,
      include: {
        product: { select: { id: true, code: true, name: true, unit: true, spec: true } },
        sourceMovement: { select: { id: true, type: true, reason: true, sourceType: true, sourceId: true } },
      },
    })
    return rows.map(row => ({
      id: row.id,
      batchNo: row.batchNo,
      kind: row.kind,
      initialQty: Number(row.initialQty),
      remainingQty: Number(row.remainingQty),
      manufactureDate: row.manufactureDate?.toISOString().slice(0, 10) || null,
      expiryDate: row.expiryDate?.toISOString().slice(0, 10) || null,
      depletedAt: row.depletedAt,
      createdAt: row.createdAt,
      product: row.product,
      source: row.sourceMovement,
    }))
  })

  /** POST /api/supplier/stock/inbound — 单条/批量入库 */
  app.post('/inbound', auth(app), async (req: any, reply: any) => {
    const ctx = ensureSupplier(req, reply, 'inventory.manage'); if (!ctx) return
    const parsed = inboundSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const { items, source, reason: batchReason } = parsed.data

    // 校验所有 productId 都属于本 supplier
    const productIds = [...new Set(items.map(i => i.productId))]
    const products = await prisma.product.findMany({
      where: { id: { in: productIds }, supplierId: ctx.supplierId, tenantId: ctx.tenantId },
      select: { id: true, name: true, stock: true },
    })
    const prodMap = new Map(products.map(p => [p.id, p]))
    const missing = productIds.filter(id => !prodMap.has(id))
    if (missing.length > 0) {
      return reply.status(400).send({ error: `${missing.length} 个商品不属于本供应商或不存在` })
    }

    const movType = source === 'EXCEL' ? 'INBOUND_EXCEL' : 'INBOUND_MANUAL'
    const created: any[] = []

    try {
      await prisma.$transaction(async (tx) => {
        const balances = await lockSupplierProducts(tx, ctx, productIds)
        const customBatches = items.filter((item): item is typeof item & { batchNo: string } => Boolean(item.batchNo))
        if (customBatches.length > 0) {
          const existingBatch = await tx.supplierStockBatch.findFirst({
            where: {
              tenantId: ctx.tenantId,
              supplierId: ctx.supplierId,
              OR: customBatches.map(item => ({ productId: item.productId, batchNo: item.batchNo })),
            },
            select: { batchNo: true },
          })
          if (existingBatch) {
            throw Object.assign(new Error(`批次号已存在：${existingBatch.batchNo}`), { statusCode: 409 })
          }
        }
        for (const it of items) {
          const newStock = balances.get(it.productId)!.plus(it.qty)
          if (newStock.greaterThan(99_999_999.99)) {
            throw Object.assign(new Error('入库后库存超过字段上限'), { statusCode: 400 })
          }
          await tx.product.update({ where: { id: it.productId }, data: { stock: newStock } })
          balances.set(it.productId, newStock)
          const m = await tx.supplierStockMovement.create({
            data: {
              tenantId: ctx.tenantId, supplierId: ctx.supplierId, productId: it.productId,
              delta: it.qty, balanceAfter: newStock,
              type: movType as any,
              reason: it.reason || batchReason || null,
              sourceType: 'Manual', sourceId: null,
              manufactureDate: it.manufactureDate ? new Date(it.manufactureDate) : null,
              expiryDate:      it.expiryDate ? new Date(it.expiryDate) : null,
              createdById: ctx.userId,
            },
          })
          await createSupplierStockBatchIncrease(tx, {
            tenantId: ctx.tenantId,
            supplierId: ctx.supplierId,
            productId: it.productId,
            quantity: it.qty,
            movementId: m.id,
            createdById: ctx.userId,
            kind: 'INBOUND',
            batchNo: it.batchNo,
            manufactureDate: it.manufactureDate ? new Date(it.manufactureDate) : null,
            expiryDate: it.expiryDate ? new Date(it.expiryDate) : null,
          })
          created.push({ id: m.id, productId: it.productId, qty: it.qty, balanceAfter: Number(newStock) })
        }
      })
    } catch (error: any) {
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      throw error
    }
    return { ok: true, count: created.length, items: created }
  })

  /** POST /api/supplier/stock/adjust — 盘点直接设置库存 */
  app.post('/adjust', auth(app), async (req: any, reply: any) => {
    const ctx = ensureSupplier(req, reply, 'inventory.manage'); if (!ctx) return
    const parsed = adjustSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const { productId, newQty, reason } = parsed.data

    let result: { delta: number; balanceAfter: number; unchanged?: boolean }
    await prisma.$transaction(async (tx) => {
      const balances = await lockSupplierProducts(tx, ctx, [productId], { statusCode: 404, message: '商品不存在' })
      const nextStock = new Prisma.Decimal(newQty)
      const reserved = await activeReservedForProduct(tx, ctx, productId)
      if (nextStock.lessThan(reserved)) {
        throw Object.assign(new Error(`盘点库存不能低于已接订单预占 ${reserved.toFixed(2)}`), { statusCode: 409 })
      }
      const delta = nextStock.minus(balances.get(productId)!)
      if (delta.isZero()) {
        result = { delta: 0, balanceAfter: newQty, unchanged: true }
        return
      }
      await tx.product.update({ where: { id: productId }, data: { stock: nextStock } })
      const movement = await tx.supplierStockMovement.create({
        data: {
          tenantId: ctx.tenantId, supplierId: ctx.supplierId, productId,
          delta, balanceAfter: nextStock,
          type: 'ADJUSTMENT' as any,
          reason, sourceType: 'Manual', sourceId: null,
          createdById: ctx.userId,
        },
      })
      await applySupplierStockBatchDelta(tx, {
        tenantId: ctx.tenantId,
        supplierId: ctx.supplierId,
        productId,
        delta,
        movementId: movement.id,
        createdById: ctx.userId,
      })
      result = { delta: Number(delta), balanceAfter: newQty }
    })
    if (result!.unchanged) return { ok: true, message: '库存无变化', balanceAfter: newQty }
    return { ok: true, delta: result!.delta, balanceAfter: result!.balanceAfter }
  })

  /** POST /api/supplier/stock/loss — 报损 */
  app.post('/loss', auth(app), async (req: any, reply: any) => {
    const ctx = ensureSupplier(req, reply, 'inventory.manage'); if (!ctx) return
    const parsed = lossSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const { productId, qty, reason } = parsed.data

    let balanceAfter = 0
    try {
      await prisma.$transaction(async (tx) => {
        const balances = await lockSupplierProducts(tx, ctx, [productId], { statusCode: 404, message: '商品不存在' })
        const currentStock = balances.get(productId)!
        if (new Prisma.Decimal(qty).greaterThan(currentStock)) {
          throw Object.assign(new Error(`报损数量超过当前库存 ${currentStock.toFixed(2)}`), { statusCode: 409 })
        }
        const newStock = currentStock.minus(qty)
        const reserved = await activeReservedForProduct(tx, ctx, productId)
        if (newStock.lessThan(reserved)) {
          throw Object.assign(new Error(`可报损库存不足：已有 ${reserved.toFixed(2)} 被已接订单占用`), { statusCode: 409 })
        }
        const actualDelta = newStock.minus(currentStock)
        await tx.product.update({ where: { id: productId }, data: { stock: newStock } })
        const movement = await tx.supplierStockMovement.create({
          data: {
            tenantId: ctx.tenantId, supplierId: ctx.supplierId, productId,
            delta: actualDelta, balanceAfter: newStock,
            type: 'LOSS' as any,
            reason, sourceType: 'Manual', sourceId: null,
            createdById: ctx.userId,
          },
        })
        await consumeSupplierStockBatches(tx, {
          tenantId: ctx.tenantId,
          supplierId: ctx.supplierId,
          productId,
          quantity: qty,
          movementId: movement.id,
        })
        balanceAfter = Number(newStock)
      })
    } catch (error: any) {
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      throw error
    }
    return { ok: true, balanceAfter }
  })

  /** POST /api/supplier/stock/import-snapshot — 全量库存清单导入
   *
   * 场景: 首次系统化、月末盘点、第三方系统迁移. 一次性把 N 条 (品名, 数量[, 规格, 类别]) 导入.
   * - SKU 已存在 (按 name 匹配): 把 stock 调整到目标值, 写一条 ADJUSTMENT 流水 (reason=入参 reason)
   * - SKU 不存在: 整批拒绝导入并返回待建档品名，库存导入不得绕过商品审批
   * - SKU 已存在但 stock 已等于目标值: 跳过, 不写流水
   *
   * 跟 /api/supplier/stock/inbound 的区别:
   *   inbound = 增量加 (delta = +qty), 用于日常到货
   *   import-snapshot = 设置到目标值 (delta = newQty - oldStock), 用于盘点/迁移, 一次性
   */
  app.post('/import-snapshot', auth(app), async (req: any, reply: any) => {
    const ctx = ensureSupplier(req, reply, 'inventory.manage'); if (!ctx) return
    const schema = z.object({
      items: z.array(z.object({
        name:     z.string().trim().min(1).max(80),
        spec:     z.string().trim().max(80).optional(),
        category: z.string().trim().max(40).optional(),
        unit:     z.string().trim().max(10).optional().default('件'),
        qty:      stockQtySchema,
      })).min(1).max(1000),
      reason:    z.string().trim().max(120).default('全量库存导入'),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const { items, reason } = parsed.data
    const duplicateNames = items
      .map(item => item.name)
      .filter((name, index, names) => names.indexOf(name) !== index)
    if (duplicateNames.length > 0) {
      return reply.status(400).send({ error: `库存清单包含重复品名：${[...new Set(duplicateNames)].slice(0, 5).join('、')}` })
    }

    const knownProducts = await prisma.product.findMany({
      where: {
        tenantId: ctx.tenantId,
        supplierId: ctx.supplierId,
        name: { in: items.map(item => item.name) },
      },
      select: { name: true },
    })
    const knownNames = new Set(knownProducts.map(product => product.name))
    const unmatched = items
      .map((item, index) => ({ row: index + 1, name: item.name, spec: item.spec || null }))
      .filter(item => !knownNames.has(item.name))
    if (unmatched.length > 0) {
      return reply.status(409).send({
        error: `${unmatched.length} 个品名尚未建档，请先在商品档案中建立并审批 SKU，库存未写入`,
        code: 'UNMATCHED_STOCK_SKU',
        unmatched: unmatched.slice(0, 100),
        unmatchedTotal: unmatched.length,
      })
    }

    const adjusted: any[] = []
    const skipped: any[] = []
    const failed: any[] = []

    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      try {
        await prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`supplier-stock-snapshot:${ctx.tenantId}:${ctx.supplierId}:${it.name}`}))`
          const matches = await tx.product.findMany({
            where: { tenantId: ctx.tenantId, supplierId: ctx.supplierId, name: it.name },
            orderBy: { id: 'asc' },
            take: 2,
          })
          if (matches.length > 1) throw new Error('同名 SKU 不唯一，请先整理商品主数据后再导入')
          const prod = matches[0]
          if (!prod) throw new Error('商品未建档，请刷新后重新预览')
          const balances = await lockSupplierProducts(tx, ctx, [prod.id])
          const oldStock = balances.get(prod.id)!
          const reserved = await activeReservedForProduct(tx, ctx, prod.id)
          if (new Prisma.Decimal(it.qty).lessThan(reserved)) {
            throw new Error(`目标库存不能低于已接订单预占 ${reserved.toFixed(2)}`)
          }
          if (oldStock.equals(it.qty)) {
            skipped.push({ row: i + 1, name: it.name, stock: Number(oldStock) })
            return
          }
          await tx.product.update({ where: { id: prod.id }, data: { stock: it.qty } })
          const movement = await tx.supplierStockMovement.create({
            data: {
              tenantId: ctx.tenantId, supplierId: ctx.supplierId, productId: prod.id,
              delta: new Prisma.Decimal(it.qty).minus(oldStock),
              balanceAfter: it.qty,
              type: 'ADJUSTMENT' as any,
              reason,
              sourceType: 'Snapshot', sourceId: null,
              createdById: ctx.userId,
            },
          })
          await applySupplierStockBatchDelta(tx, {
            tenantId: ctx.tenantId,
            supplierId: ctx.supplierId,
            productId: prod.id,
            delta: new Prisma.Decimal(it.qty).minus(oldStock),
            movementId: movement.id,
            createdById: ctx.userId,
          })
          adjusted.push({ row: i + 1, name: it.name, oldStock: Number(oldStock), newStock: it.qty })
        })
      } catch (e: any) {
        failed.push({ row: i + 1, name: it.name, error: e.message || 'unknown' })
      }
    }

    return {
      ok: true,
      summary: {
        total: items.length,
        created: 0,
        adjusted: adjusted.length,
        skipped: skipped.length,
        failed: failed.length,
      },
      details: { created: [], adjusted, skipped, failed },
    }
  })

  /** GET /api/supplier/stock/movements?productId=&limit=&type= — 流水 */
  app.get('/movements', auth(app), async (req: any, reply: any) => {
    const ctx = ensureSupplier(req, reply, 'inventory.read'); if (!ctx) return
    const parsed = z.object({
      productId: z.string().trim().min(1).optional(),
      type: z.enum(['INITIAL', 'INBOUND_MANUAL', 'INBOUND_EXCEL', 'OUTBOUND_PO', 'ADJUSTMENT', 'LOSS']).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
    }).safeParse(req.query)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const { productId, type, limit } = parsed.data
    const where: any = { tenantId: ctx.tenantId, supplierId: ctx.supplierId }
    if (productId) where.productId = productId
    if (type) where.type = type
    const ms = await prisma.supplierStockMovement.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
      include: {
        product: { select: { name: true, code: true, unit: true, spec: true } },
        createdBy: { select: { name: true } },
      },
    })
    return ms.map(m => ({
      id: m.id, type: m.type, delta: Number(m.delta), balanceAfter: Number(m.balanceAfter),
      reason: m.reason, sourceType: m.sourceType, sourceId: m.sourceId,
      manufactureDate: m.manufactureDate ? m.manufactureDate.toISOString().slice(0, 10) : null,
      expiryDate:      m.expiryDate ? m.expiryDate.toISOString().slice(0, 10) : null,
      createdAt: m.createdAt,
      product: m.product,
      operator: m.createdBy?.name || null,
    }))
  })
}
