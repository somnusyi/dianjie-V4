import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { prisma } from '@dianjie/db'
import { cached, invalidatePattern } from '../lib/cache'
import { isSupplierRole } from '../lib/auth-scope'

const auth = (app: any) => ({ preHandler: [app.authenticate] })

// CLAUDE.md 规约：所有写入用 zod 校验
// preprocess: 把 null/空字符串/NaN 统一转成 undefined, 让 .optional().default() 生效.
// 用户报价 Excel 里数字列经常出现 "—"/"无"/空格, 前端 Number() 转 NaN, JSON 序列化为 null.
// 不加这层 zod 直接 reject "Expected number, received null".
const numNullable = (def: number) =>
  z.preprocess(v => (v === null || v === '' || (typeof v === 'number' && !Number.isFinite(v))) ? undefined : v,
               z.number().nonnegative().optional().default(def))

const productCreateSchema = z.object({
  // code 可选: 上传时若缺失, 后端用 "<supplierId 前缀>-<五位序号>" 自动生成
  code:      z.string().trim().max(40).optional(),
  name:      z.string().trim().min(1, '品项名称必填').max(80),
  spec:      z.string().trim().max(80).optional().nullable(),
  category:  z.string().trim().max(40).optional(),
  // unit 必须是干净计量单位 (kg/件/瓶...), 不能含数字 ("5kg" / "2包起订" 是数据脏的常见来源)
  unit:      z.string().trim().max(10)
                .refine(v => !/^\d/.test(v), { message: '单位不能以数字开头, 数字应记到 spec / 起订量字段' })
                .optional().default('件'),
  // 价格可选, 缺省 0. 仓库库存初始化场景常常没价格 (供应商内部物品), 先建 SKU 后续单条改价
  price:     z.preprocess(v => (v === null || v === '' || (typeof v === 'number' && !Number.isFinite(v))) ? 0 : v,
                          z.number().nonnegative('金额不能为负').optional().default(0)),
  stock:     numNullable(0),
  minStock:  numNullable(0),
  // 起订量 (默认 1, 最小 0.01)
  minOrderQty: z.preprocess(v => (v === null || v === '' || (typeof v === 'number' && !Number.isFinite(v))) ? undefined : v,
                            z.number().positive('起订量必须大于 0').optional().default(1)),
  // 订量步长 (默认 1, 0/缺省视作 1)
  stepQty:   z.preprocess(v => (v === null || v === '' || (typeof v === 'number' && !Number.isFinite(v)) || v === 0) ? undefined : v,
                          z.number().positive('步长必须大于 0').optional().default(1)),
  shelfDays: z.preprocess(v => (v === null || v === '' || (typeof v === 'number' && !Number.isFinite(v))) ? undefined : v,
                          z.number().int().min(0).max(3650).optional().default(7)),
  supplierId: z.string().optional(),
  status:    z.string().optional(),
}).strict()

/** 自动生成商品 code: 取 supplierId 末 4 位 + 6 位时间戳 */
function autoCode(supplierId: string | undefined): string {
  const sup = supplierId ? supplierId.slice(-4).toUpperCase() : 'TEN0'
  const ts = Date.now().toString(36).slice(-6).toUpperCase()
  return `${sup}-${ts}`
}

export const productRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', auth(app), async (req: any) => {
    const { category, status, page, pageSize = '20' } = req.query as any
    const { tenantId, role, supplierId } = req.user
    const where: any = { tenantId }
    if (category) where.category = category
    if (status) where.status = status
    // 供应商账号只能看自己的商品
    if (isSupplierRole(role) && supplierId) where.supplierId = supplierId

    // 不传 page 时返回全量（兼容下拉框），缓存 10 分钟
    // 注意 cache key 加上 supplier scope，避免供应商之间互相污染
    if (!page) {
      const scopeKey = isSupplierRole(role) ? `sup:${supplierId}` : 'all'
      return cached(`products:full:${tenantId}:${scopeKey}:${category || 'all'}:${status || 'all'}`, 600, () =>
        prisma.product.findMany({
          where,
          include: { supplier: { select: { id: true, name: true } } },
          orderBy: { createdAt: 'asc' },
        })
      )
    }
    const p = Math.max(1, parseInt(page))
    const ps = Math.min(100, Math.max(1, parseInt(pageSize)))
    const [items, total] = await Promise.all([
      prisma.product.findMany({
        where,
        include: { supplier: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'asc' },
        skip: (p - 1) * ps,
        take: ps,
      }),
      prisma.product.count({ where }),
    ])
    return { items, total, page: p, pageSize: ps }
  })

  // 建/改商品仅限总部管理员
  // 集团方写权限 + 供应商所有角色都可改/建自己 SKU
  const PRODUCT_WRITE_ROLES = new Set([
    'ADMIN', 'SUPER_ADMIN', 'PURCHASER',
    'SUPPLIER_OWNER', 'SUPPLIER_STAFF', 'SUPPLIER_SUB',
  ])

  app.post('/', auth(app), async (req: any, reply: any) => {
    const { role, tenantId, userId, supplierId: userSupplierId } = req.user
    if (!PRODUCT_WRITE_ROLES.has(role)) {
      return reply.status(403).send({ error: '无权创建商品' })
    }
    const parsed = productCreateSchema.safeParse(req.body)
    if (!parsed.success) {
      const first = parsed.error.errors[0]
      return reply.status(400).send({ error: `${first.path.join('.')}: ${first.message}` })
    }
    // 供应商角色：忽略 body.supplierId，强制用当前账号绑定的 supplierId
    let data: any = { ...parsed.data }
    if (isSupplierRole(role)) {
      if (!userSupplierId) return reply.status(403).send({ error: '账号未绑定供应商' })
      data.supplierId = userSupplierId
      // 供应商新建 SKU 默认进入"待总厨审批"状态, 通过后才上架
      data.status = 'PENDING_APPROVAL'
    }
    if (!data.code) data.code = autoCode(data.supplierId)
    if (!data.category) data.category = '其他'
    try {
      const product = await prisma.product.create({
        data: { tenantId, ...data } as any,
      })
      // 供应商创建 → 同时生成审批单
      if (isSupplierRole(role)) {
        const sup = await prisma.supplier.findUnique({ where: { id: userSupplierId }, select: { name: true } })
        const ym = new Date().toISOString().slice(0, 7).replace('-', '')
        const cnt = await prisma.document.count({ where: { tenantId, no: { startsWith: `DOC${ym}` } } })
        const no = `DOC${ym}${String(cnt + 1).padStart(6, '0')}`
        await prisma.document.create({
          data: {
            tenantId, no, type: 'NEW_DISH',
            title: `新品上架: ${product.name}${product.spec ? ' (' + product.spec + ')' : ''} ¥${Number(product.price)}`,
            amount: Number(product.price), isOverThreshold: false,
            thresholdRule: '新供应商商品 直送总厨',
            payload: {
              action: 'CREATE',
              productId: product.id, productName: product.name,
              productCode: product.code, spec: product.spec, unit: product.unit,
              price: Number(product.price), category: product.category,
              supplierName: sup?.name || null,
            },
            initiatorId: userId, status: 'PENDING',
            steps: { create: [{ seq: 1, approverRole: 'CHEF_DIRECTOR', status: 'PENDING' }] },
          },
        })
      }
      void invalidatePattern(`products:full:${tenantId}:*`)
      return reply.status(201).send(product)
    } catch (e: any) {
      if (e.code === 'P2002') {
        return reply.status(409).send({ error: '商品编码已存在（请换一个 code）' })
      }
      req.log.error({ err: e }, 'product create failed')
      return reply.status(500).send({ error: '创建失败（请检查日志）' })
    }
  })

  // ─── 批量创建 (Excel/CSV 上传场景) ────────────────
  app.post('/batch', auth(app), async (req: any, reply: any) => {
    const { role, tenantId, userId, supplierId: userSupplierId } = req.user
    if (!PRODUCT_WRITE_ROLES.has(role)) {
      return reply.status(403).send({ error: '无权创建商品' })
    }
    const body = req.body as any
    const items = Array.isArray(body?.items) ? body.items : null
    const filename = (body?.filename as string | undefined) || null
    if (!items || items.length === 0) {
      return reply.status(400).send({ error: 'items 必须是非空数组' })
    }
    if (items.length > 500) {
      return reply.status(400).send({ error: '单次最多 500 行' })
    }

    // 先建一个 batch 记录, 创建的 product 都挂上 batchId
    const batch = await prisma.productBatch.create({
      data: {
        tenantId,
        supplierId: isSupplierRole(role) ? userSupplierId || null : null,
        uploadedById: userId,
        filename,
        totalRows: items.length,
        createdCount: 0,
        failedCount: 0,
        failedRows: [] as any,
      },
    })
    const batchId = batch.id

    const created: any[] = []
    const failed: { row: number; code?: string; error: string }[] = []

    for (let i = 0; i < items.length; i++) {
      const raw = items[i]
      const parsed = productCreateSchema.safeParse(raw)
      if (!parsed.success) {
        const first = parsed.error.errors[0]
        failed.push({ row: i + 1, code: raw?.code, error: `${first.path.join('.')}: ${first.message}` })
        continue
      }
      let data: any = { ...parsed.data }
      if (isSupplierRole(role)) {
        if (!userSupplierId) {
          failed.push({ row: i + 1, code: data.code, error: '账号未绑定供应商' })
          continue
        }
        data.supplierId = userSupplierId
      }
      // 编码缺失自动生成
      if (!data.code) data.code = autoCode(data.supplierId || userSupplierId)
      // 类目缺失默认其他
      if (!data.category) data.category = '其他'
      // 解耦: 报价表 (products) 不再接受 stock/minStock, 库存只走库存模块
      delete data.stock
      delete data.minStock
      // 供应商批量上传 → 默认 PENDING_APPROVAL, 一会儿一并起一个审批单
      if (isSupplierRole(role)) data.status = 'PENDING_APPROVAL'
      try {
        const product = await prisma.product.create({ data: { tenantId, batchId, ...data } as any })
        created.push({ row: i + 1, id: product.id, code: product.code, name: product.name })
      } catch (e: any) {
        if (e.code === 'P2002') {
          if (data.code?.includes('-')) {
            data.code = autoCode(data.supplierId || userSupplierId)
            try {
              const p2 = await prisma.product.create({ data: { tenantId, batchId, ...data } as any })
              created.push({ row: i + 1, id: p2.id, code: p2.code, name: p2.name })
              continue
            } catch { /* fall through */ }
          }
          failed.push({ row: i + 1, code: data.code, error: '编码已存在' })
        } else {
          failed.push({ row: i + 1, code: data.code, error: e.message || 'unknown' })
        }
      }
    }
    // 更新 batch 终态 (createdCount 0 时也保留, 让用户能在历史里看到失败)
    await prisma.productBatch.update({
      where: { id: batchId },
      data: {
        createdCount: created.length,
        failedCount: failed.length,
        failedRows: failed as any,
      },
    })

    // 供应商批量上传 → 起一个 NEW_DISH(action=BATCH) 审批单, 总厨一次批准全部
    let approvalDocNo: string | null = null
    if (isSupplierRole(role) && created.length > 0) {
      const sup = await prisma.supplier.findUnique({ where: { id: userSupplierId }, select: { name: true } })
      const ym = new Date().toISOString().slice(0, 7).replace('-', '')
      const cnt = await prisma.document.count({ where: { tenantId, no: { startsWith: `DOC${ym}` } } })
      const no = `DOC${ym}${String(cnt + 1).padStart(6, '0')}`
      const doc = await prisma.document.create({
        data: {
          tenantId, no, type: 'NEW_DISH',
          title: `批量新品: ${sup?.name || '供应商'} 上架 ${created.length} 个 SKU${filename ? ` (${filename})` : ''}`,
          amount: null, isOverThreshold: false,
          thresholdRule: '批量新供应商商品 直送总厨',
          payload: {
            action: 'BATCH',
            batchId,
            productIds: created.map(c => c.id),
            count: created.length,
            filename: filename || null,
            supplierName: sup?.name || null,
          },
          initiatorId: userId, status: 'PENDING',
          steps: { create: [{ seq: 1, approverRole: 'CHEF_DIRECTOR', status: 'PENDING' }] },
        },
      })
      approvalDocNo = doc.no
    }

    void invalidatePattern(`products:full:${tenantId}:*`)
    return reply.status(201).send({
      batchId,
      total: items.length,
      createdCount: created.length,
      failedCount: failed.length,
      created, failed,
      approvalDocNo,   // 供应商批量时返回, 前端可提示"待总厨审批"
    })
  })

  // ─── 上传历史列表 ─────────────────────────────────
  app.get('/batches', auth(app), async (req: any) => {
    const { tenantId, role, supplierId } = req.user
    const where: any = { tenantId }
    if (isSupplierRole(role)) {
      if (!supplierId) return []
      where.supplierId = supplierId
    }
    const list = await prisma.productBatch.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: {
        _count: { select: { products: true } },     // 当前还存在的 product 数 (撤回 / 单删后会变少)
      },
    })
    return list
  })

  // ─── 撤回上传 (软删: 把 batch 内所有 product 删除, 标记 batch.revokedAt)
  app.patch('/batches/:id/revoke', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId, supplierId } = req.user
    const { id } = req.params as any
    const where: any = { id, tenantId }
    if (isSupplierRole(role)) {
      if (!supplierId) return reply.status(403).send({ error: '账号未绑定供应商' })
      where.supplierId = supplierId
    }
    const b = await prisma.productBatch.findFirst({ where })
    if (!b) return reply.status(404).send({ error: '批次不存在' })
    if (b.revokedAt) return reply.status(400).send({ error: '已撤回, 不可重复操作' })
    // 删除该 batch 关联的 product
    const del = await prisma.product.deleteMany({ where: { batchId: b.id, tenantId } })
    await prisma.productBatch.update({
      where: { id: b.id },
      data: { revokedAt: new Date(), revokedById: userId },
    })
    await prisma.opLog.create({
      data: {
        tenantId, userId,
        action: `撤回批次上传 ${b.id}, 删除 ${del.count} 个 SKU`,
        entityType: 'ProductBatch', targetId: b.id,
      },
    })
    void invalidatePattern(`products:full:${tenantId}:*`)
    return { success: true, deletedCount: del.count }
  })

  // ─── 危险操作: 清除当前供应商的所有 SKU ────────────────────
  // 仅供应商角色 (清自家). 一并删除关联的批次、流水. 不删订单 PO 历史 (受 FK 保护).
  app.delete('/clear-all', auth(app), async (req: any, reply: any) => {
    const { role, tenantId, userId, supplierId } = req.user
    if (!isSupplierRole(role)) return reply.status(403).send({ error: '仅供应商账号可执行' })
    if (!supplierId) return reply.status(400).send({ error: '账号未绑定供应商' })
    const { confirm } = (req.body || {}) as any
    if (confirm !== 'CLEAR_ALL') {
      return reply.status(400).send({ error: '需要 confirm=CLEAR_ALL 才能执行 (前端确认弹窗已加)' })
    }
    // 查依赖, 避免误删被订单引用的商品
    const refByPO = await prisma.purchaseOrderItem.count({ where: { product: { supplierId } } })
    if (refByPO > 0) {
      return reply.status(400).send({ error: `无法清除: 有 ${refByPO} 条订单明细引用了你的商品. 先归档订单再操作.` })
    }
    const ids = (await prisma.product.findMany({ where: { supplierId, tenantId }, select: { id: true } })).map(x => x.id)
    if (ids.length === 0) return { success: true, deletedProducts: 0, deletedMovements: 0, deletedBatches: 0 }
    // 先删流水 → 再删商品 → 再删批次记录
    const dm = await prisma.supplierStockMovement.deleteMany({ where: { productId: { in: ids } } })
    const dp = await prisma.product.deleteMany({ where: { id: { in: ids } } })
    const db = await prisma.productBatch.deleteMany({ where: { supplierId } })
    await prisma.opLog.create({
      data: {
        tenantId, userId,
        action: `[危险] 清除供应商所有 SKU: ${dp.count} 商品 + ${dm.count} 流水 + ${db.count} 批次`,
        entityType: 'Product', targetId: supplierId,
      },
    })
    void invalidatePattern(`products:full:${tenantId}:*`)
    return { success: true, deletedProducts: dp.count, deletedMovements: dm.count, deletedBatches: db.count }
  })

  app.patch('/:id', auth(app), async (req: any, reply: any) => {
    const { role, tenantId, userId, supplierId } = req.user
    if (!PRODUCT_WRITE_ROLES.has(role)) {
      return reply.status(403).send({ error: '无权修改商品' })
    }
    // 供应商只能改自己 SKU
    const where: any = { id: req.params.id, tenantId }
    if (isSupplierRole(role)) {
      if (!supplierId) return reply.status(403).send({ error: '账号未绑定供应商' })
      where.supplierId = supplierId
    }
    const body = req.body as any
    // P1: 非供应商角色也必须白名单字段, 防 mass assignment (改 tenantId / supplierId / id)
    const SUPPLIER_ALLOW = ['price', 'spec', 'stock', 'minStock', 'minOrderQty', 'stepQty', 'shelfDays', 'status']
    const STAFF_ALLOW = [...SUPPLIER_ALLOW, 'name', 'unit', 'category', 'code']  // 内部员工额外可改名/类
    const allow = isSupplierRole(role) ? SUPPLIER_ALLOW : STAFF_ALLOW
    const data = Object.fromEntries(Object.entries(body).filter(([k]) => allow.includes(k)))

    // 供应商停售 SKU → 不直接落库, 创建 NEW_DISH(action=DISABLE) 审批单
    if (isSupplierRole(role) && data.status === 'DISABLED') {
      const cur = await prisma.product.findFirst({
        where, select: { id: true, name: true, code: true, status: true, supplier: { select: { name: true } } },
      })
      if (!cur) return reply.status(404).send({ error: '商品不存在或无权修改' })
      if (cur.status !== 'ENABLED') return reply.status(400).send({ error: `商品当前状态 ${cur.status}, 不能再申请停售` })
      const pending = await prisma.document.findFirst({
        where: {
          tenantId, type: 'NEW_DISH', status: 'PENDING',
          payload: { path: ['productId'], equals: cur.id },
        },
      })
      if (pending) return reply.status(400).send({ error: `该商品已有待审批单 ${pending.no}` })
      const ym = new Date().toISOString().slice(0, 7).replace('-', '')
      const cnt = await prisma.document.count({ where: { tenantId, no: { startsWith: `DOC${ym}` } } })
      const no = `DOC${ym}${String(cnt + 1).padStart(6, '0')}`
      const doc = await prisma.document.create({
        data: {
          tenantId, no, type: 'NEW_DISH',
          title: `停售: ${cur.name} (#${cur.code})`,
          amount: null, isOverThreshold: false,
          thresholdRule: 'SKU 停售 直送总厨',
          payload: {
            action: 'DISABLE',
            productId: cur.id, productName: cur.name, productCode: cur.code,
            supplierName: cur.supplier?.name || null,
          },
          initiatorId: userId, status: 'PENDING',
          steps: { create: [{ seq: 1, approverRole: 'CHEF_DIRECTOR', status: 'PENDING' }] },
        },
      })
      // 当前商品状态改为 PENDING_DISABLE 标记审批中, 餐厅看不到 ENABLED 但流水仍清晰
      await prisma.product.updateMany({ where, data: { status: 'PENDING_DISABLE' as any } })
      return { count: 1, statusChange: 'PENDING_APPROVAL', documentNo: doc.no, message: '停售已提交总厨审批' }
    }

    // 供应商改价: 降价 / 首次定价 直接落库, 涨价才走审批
    if (isSupplierRole(role) && data.price != null) {
      const cur = await prisma.product.findFirst({
        where, select: { id: true, name: true, code: true, price: true, supplier: { select: { name: true } } },
      })
      if (!cur) return reply.status(404).send({ error: '商品不存在或无权修改' })
      const oldPrice = Number(cur.price)
      const newPrice = Number(data.price)
      const noChange = Math.abs(oldPrice - newPrice) < 0.001
      const isPriceUp = newPrice > oldPrice && oldPrice > 0  // 真涨价 (oldPrice>0 排除"首次定价")
      // 降价 / 首次定价 / 价格不变 → 直接进入下面 update; 仅涨价才走审批分支
      if (!noChange && isPriceUp) {
        // 检查是否有 PENDING 的同商品调价单, 避免重复提交
        const pending = await prisma.document.findFirst({
          where: {
            tenantId, type: 'PRICE_ADJUSTMENT', status: 'PENDING',
            payload: { path: ['productId'], equals: cur.id },
          },
        })
        if (pending) {
          return reply.status(400).send({ error: `该商品已有待审批的调价单 ${pending.no}, 请等总厨处理后再改` })
        }
        const ym = new Date().toISOString().slice(0, 7).replace('-', '')
        const count = await prisma.document.count({ where: { tenantId, no: { startsWith: `DOC${ym}` } } })
        const no = `DOC${ym}${String(count + 1).padStart(6, '0')}`
        const delta = newPrice - oldPrice
        const pct = oldPrice > 0 ? (delta / oldPrice * 100).toFixed(1) : 'N/A'
        const sign = delta > 0 ? '↑' : '↓'
        const title = `调价: ${cur.name} ¥${oldPrice} → ¥${newPrice} (${sign}${Math.abs(delta).toFixed(2)} / ${pct}%)`
        const doc = await prisma.document.create({
          data: {
            tenantId, no, type: 'PRICE_ADJUSTMENT', title,
            amount: newPrice, isOverThreshold: false,
            thresholdRule: '调价 直送总厨',
            payload: {
              productId: cur.id, productName: cur.name, productCode: cur.code,
              supplierName: cur.supplier?.name || null,
              oldPrice, newPrice, delta, pct,
            },
            initiatorId: userId, status: 'PENDING',
            steps: { create: [{ seq: 1, approverRole: 'CHEF_DIRECTOR', status: 'PENDING' }] },
          },
        })
        // 价格字段从本次更新 data 里去除, 其他字段 (stock/minStock/...) 仍直接生效
        delete data.price
        // 应用其他字段
        if (Object.keys(data).length > 0) {
          await prisma.product.updateMany({ where, data })
        }
        return { count: 1, priceChangeStatus: 'PENDING_APPROVAL', documentNo: doc.no, message: '涨价已提交总厨审批, 通过后自动生效' }
      }
      // 价格不变 → 不写; 降价 / 首次定价 → 直接落库 (data.price 已是新价, 由下面 updateMany 应用)
      if (noChange) delete data.price
    }

    const result = await prisma.product.updateMany({ where, data })
    if (result.count === 0) return reply.status(404).send({ error: '商品不存在或无权修改' })
    void invalidatePattern(`products:full:${tenantId}:*`)
    return result
  })
}
