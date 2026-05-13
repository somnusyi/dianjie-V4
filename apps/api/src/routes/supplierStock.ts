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
import { prisma } from '@dianjie/db'
import { isSupplierRole } from '../lib/auth-scope'

const auth = (app: any) => ({ preHandler: [app.authenticate] })

function ensureSupplier(req: any, reply: any): { tenantId: string; userId: string; supplierId: string } | null {
  const { tenantId, role, userId, supplierId } = req.user
  if (!isSupplierRole(role)) {
    reply.status(403).send({ error: '仅供应商账号可访问' })
    return null
  }
  if (!supplierId) {
    reply.status(400).send({ error: '账号未绑定供应商' })
    return null
  }
  return { tenantId, userId, supplierId }
}

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式 YYYY-MM-DD').optional().nullable()

const inboundItemSchema = z.object({
  productId:       z.string(),
  qty:             z.number().positive('数量必须 > 0'),
  reason:          z.string().trim().max(120).optional(),
  manufactureDate: dateSchema,   // 生产日期 YYYY-MM-DD (可空)
  expiryDate:      dateSchema,   // 到期日期 (前端按 生产日期+保质期天数 自动算或手动改)
})

const inboundSchema = z.object({
  items:     z.array(inboundItemSchema).min(1).max(500),
  source:    z.enum(['MANUAL', 'EXCEL']).default('MANUAL'),
  reason:    z.string().trim().max(120).optional(),  // 整批理由
})

const adjustSchema = z.object({
  productId: z.string(),
  newQty:    z.number().nonnegative('新库存不能为负'),
  reason:    z.string().trim().min(1, '请说明盘点/调整原因').max(120),
})

const lossSchema = z.object({
  productId: z.string(),
  qty:       z.number().positive('报损数量必须 > 0'),
  reason:    z.string().trim().min(1, '请说明报损原因').max(120),
})

export const supplierStockRoutes: FastifyPluginAsync = async (app) => {

  /** GET /api/supplier/stock — 列表 + 摘要 */
  app.get('/', auth(app), async (req: any, reply: any) => {
    const ctx = ensureSupplier(req, reply); if (!ctx) return

    const products = await prisma.product.findMany({
      where: { tenantId: ctx.tenantId, supplierId: ctx.supplierId, status: 'ENABLED' },
      orderBy: [{ stock: 'asc' }, { name: 'asc' }],   // 库存少的排前面
      select: {
        id: true, code: true, name: true, spec: true, unit: true, category: true,
        stock: true, minStock: true, price: true, shelfDays: true,
      },
    })

    // 统计每个 SKU 近 7 天 / 30 天的入库/出库总量
    const since7  = new Date(Date.now() - 7  * 86400_000)
    const since30 = new Date(Date.now() - 30 * 86400_000)
    const movs = await prisma.supplierStockMovement.findMany({
      where: { supplierId: ctx.supplierId, createdAt: { gte: since30 } },
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

    // 每个 SKU 取"最近到期日"= 所有正向入库流水里最早的 expiryDate
    const expRows = await prisma.supplierStockMovement.findMany({
      where: { supplierId: ctx.supplierId, delta: { gt: 0 }, expiryDate: { not: null } },
      select: { productId: true, expiryDate: true },
      orderBy: { expiryDate: 'asc' },
    })
    const nearestExpiry = new Map<string, Date>()
    for (const r of expRows) {
      if (!nearestExpiry.has(r.productId)) nearestExpiry.set(r.productId, r.expiryDate!)
    }

    return products.map(p => {
      const stat = byProd.get(p.id) || { in7: 0, out7: 0, in30: 0, out30: 0 }
      const stock = Number(p.stock)
      const minStock = Number(p.minStock)
      const status = stock <= 0 ? 'OUT' : stock < minStock ? 'LOW' : 'OK'
      const exp = nearestExpiry.get(p.id) || null
      const daysToExpiry = exp ? Math.ceil((exp.getTime() - Date.now()) / 86400_000) : null
      return {
        ...p,
        stock,
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
    const ctx = ensureSupplier(req, reply); if (!ctx) return
    const ps = await prisma.product.findMany({
      where: { tenantId: ctx.tenantId, supplierId: ctx.supplierId, status: 'ENABLED' },
      select: { stock: true, minStock: true, price: true },
    })
    let totalSku = ps.length, lowStock = 0, outOfStock = 0, totalValue = 0
    for (const p of ps) {
      const s = Number(p.stock), m = Number(p.minStock), v = Number(p.price)
      if (s <= 0) outOfStock++
      else if (s < m) lowStock++
      totalValue += s * v
    }
    return { totalSku, lowStock, outOfStock, totalValue: Math.round(totalValue * 100) / 100 }
  })

  /** POST /api/supplier/stock/inbound — 单条/批量入库 */
  app.post('/inbound', auth(app), async (req: any, reply: any) => {
    const ctx = ensureSupplier(req, reply); if (!ctx) return
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

    await prisma.$transaction(async (tx) => {
      for (const it of items) {
        const cur = await tx.product.findUnique({ where: { id: it.productId }, select: { stock: true } })
        const newStock = Number(cur!.stock) + it.qty
        await tx.product.update({ where: { id: it.productId }, data: { stock: newStock } })
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
        created.push({ id: m.id, productId: it.productId, qty: it.qty, balanceAfter: newStock })
      }
    })
    return { ok: true, count: created.length, items: created }
  })

  /** POST /api/supplier/stock/adjust — 盘点直接设置库存 */
  app.post('/adjust', auth(app), async (req: any, reply: any) => {
    const ctx = ensureSupplier(req, reply); if (!ctx) return
    const parsed = adjustSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const { productId, newQty, reason } = parsed.data

    const cur = await prisma.product.findFirst({
      where: { id: productId, supplierId: ctx.supplierId, tenantId: ctx.tenantId },
      select: { id: true, stock: true },
    })
    if (!cur) return reply.status(404).send({ error: '商品不存在' })

    const delta = newQty - Number(cur.stock)
    if (delta === 0) return { ok: true, message: '库存无变化', balanceAfter: newQty }

    await prisma.$transaction(async (tx) => {
      await tx.product.update({ where: { id: productId }, data: { stock: newQty } })
      await tx.supplierStockMovement.create({
        data: {
          tenantId: ctx.tenantId, supplierId: ctx.supplierId, productId,
          delta, balanceAfter: newQty,
          type: 'ADJUSTMENT' as any,
          reason, sourceType: 'Manual', sourceId: null,
          createdById: ctx.userId,
        },
      })
    })
    return { ok: true, delta, balanceAfter: newQty }
  })

  /** POST /api/supplier/stock/loss — 报损 */
  app.post('/loss', auth(app), async (req: any, reply: any) => {
    const ctx = ensureSupplier(req, reply); if (!ctx) return
    const parsed = lossSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const { productId, qty, reason } = parsed.data

    const cur = await prisma.product.findFirst({
      where: { id: productId, supplierId: ctx.supplierId, tenantId: ctx.tenantId },
      select: { id: true, stock: true },
    })
    if (!cur) return reply.status(404).send({ error: '商品不存在' })

    const newStock = Math.max(0, Number(cur.stock) - qty)
    const actualDelta = newStock - Number(cur.stock)   // 负数

    await prisma.$transaction(async (tx) => {
      await tx.product.update({ where: { id: productId }, data: { stock: newStock } })
      await tx.supplierStockMovement.create({
        data: {
          tenantId: ctx.tenantId, supplierId: ctx.supplierId, productId,
          delta: actualDelta, balanceAfter: newStock,
          type: 'LOSS' as any,
          reason, sourceType: 'Manual', sourceId: null,
          createdById: ctx.userId,
        },
      })
    })
    return { ok: true, balanceAfter: newStock }
  })

  /** POST /api/supplier/stock/import-snapshot — 全量库存清单导入
   *
   * 场景: 首次系统化、月末盘点、第三方系统迁移. 一次性把 N 条 (品名, 数量[, 规格, 类别]) 导入.
   * - SKU 已存在 (按 name 匹配): 把 stock 调整到目标值, 写一条 ADJUSTMENT 流水 (reason=入参 reason)
   * - SKU 不存在: 自动创建一个 (name + spec + category, price=0, supplierId 自动绑定),
   *               然后写一条 INITIAL 流水 + 设置 stock
   * - SKU 已存在但 stock 已等于目标值: 跳过, 不写流水
   *
   * 跟 /api/supplier/stock/inbound 的区别:
   *   inbound = 增量加 (delta = +qty), 用于日常到货
   *   import-snapshot = 设置到目标值 (delta = newQty - oldStock), 用于盘点/迁移, 一次性
   */
  app.post('/import-snapshot', auth(app), async (req: any, reply: any) => {
    const ctx = ensureSupplier(req, reply); if (!ctx) return
    const schema = z.object({
      items: z.array(z.object({
        name:     z.string().trim().min(1).max(80),
        spec:     z.string().trim().max(80).optional(),
        category: z.string().trim().max(40).optional(),
        unit:     z.string().trim().max(10).optional().default('件'),
        qty:      z.number().nonnegative('数量不能为负'),
      })).min(1).max(1000),
      reason:    z.string().trim().max(120).default('全量库存导入'),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const { items, reason } = parsed.data

    // 现有 SKU (按 name 索引)
    const existing = await prisma.product.findMany({
      where: { tenantId: ctx.tenantId, supplierId: ctx.supplierId },
      select: { id: true, name: true, code: true, stock: true },
    })
    const byName = new Map(existing.map(p => [p.name, p]))

    // 自动 code 生成器
    const supSuffix = ctx.supplierId.slice(-4).toUpperCase()
    function nextCode() {
      return `${supSuffix}-${Date.now().toString(36).slice(-6).toUpperCase()}-${Math.floor(Math.random()*1000).toString(36).toUpperCase()}`
    }

    const created: any[] = []
    const adjusted: any[] = []
    const skipped: any[] = []
    const failed: any[] = []

    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      try {
        await prisma.$transaction(async (tx) => {
          let prod = byName.get(it.name) ? await tx.product.findFirst({ where: { id: byName.get(it.name)!.id } }) : null
          let isNew = false
          if (!prod) {
            prod = await tx.product.create({
              data: {
                tenantId: ctx.tenantId, supplierId: ctx.supplierId,
                code: nextCode(),
                name: it.name,
                spec: it.spec || null,
                category: it.category || '其他',
                unit: it.unit || '件',
                price: 0,
                stock: it.qty,
                status: 'ENABLED',
              },
            })
            isNew = true
          } else {
            const oldStock = Number(prod.stock)
            if (Math.abs(oldStock - it.qty) < 0.001) {
              skipped.push({ row: i + 1, name: it.name, stock: oldStock })
              return
            }
            await tx.product.update({ where: { id: prod.id }, data: { stock: it.qty } })
          }
          await tx.supplierStockMovement.create({
            data: {
              tenantId: ctx.tenantId, supplierId: ctx.supplierId, productId: prod.id,
              delta: isNew ? it.qty : (it.qty - Number(prod.stock)),
              balanceAfter: it.qty,
              type: isNew ? 'INITIAL' as any : 'ADJUSTMENT' as any,
              reason,
              sourceType: 'Snapshot', sourceId: null,
              createdById: ctx.userId,
            },
          })
          if (isNew) created.push({ row: i + 1, name: it.name, qty: it.qty, code: prod.code })
          else adjusted.push({ row: i + 1, name: it.name, oldStock: Number(prod.stock), newStock: it.qty })
        })
      } catch (e: any) {
        failed.push({ row: i + 1, name: it.name, error: e.message || 'unknown' })
      }
    }

    return {
      ok: true,
      summary: {
        total: items.length,
        created: created.length,
        adjusted: adjusted.length,
        skipped: skipped.length,
        failed: failed.length,
      },
      details: { created, adjusted, skipped, failed },
    }
  })

  /** GET /api/supplier/stock/movements?productId=&limit=&type= — 流水 */
  app.get('/movements', auth(app), async (req: any, reply: any) => {
    const ctx = ensureSupplier(req, reply); if (!ctx) return
    const { productId, type, limit } = req.query as any
    const where: any = { supplierId: ctx.supplierId }
    if (productId) where.productId = productId
    if (type) where.type = type
    const ms = await prisma.supplierStockMovement.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(parseInt(limit || '100', 10), 500),
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
