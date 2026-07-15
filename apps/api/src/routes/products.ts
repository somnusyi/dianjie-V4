import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { prisma } from '@dianjie/db'
import { cached, invalidatePattern } from '../lib/cache'
import { isSupplierRole } from '../lib/auth-scope'
import { signOssKey } from './upload'
import { nextDocumentNo } from '../services/documentNo'
import { createId } from '@paralleldrive/cuid2'

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
  imageKey:  z.string().trim().max(500).optional().nullable(),
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
  status:    z.enum(['PENDING_APPROVAL', 'PENDING_DISABLE', 'ENABLED', 'DISABLED']).optional(),
}).strict()

/** 自动生成商品 code: 供应商短码 + 随机短 ID，避免同毫秒批量导入互撞。 */
function autoCode(supplierId: string | undefined): string {
  const sup = supplierId ? supplierId.slice(-4).toUpperCase() : 'TEN0'
  return `${sup}-${createId().slice(-10).toUpperCase()}`
}

function jsonSafe(value: unknown): any {
  return JSON.parse(JSON.stringify(value))
}

const categoryNameSchema = z.string().trim().min(1, '分类名称必填').max(40)

async function ensureActiveSupplierCategory(tenantId: string, supplierId: string, rawName: string) {
  const name = categoryNameSchema.parse(rawName)
  const existing = await prisma.supplierProductCategory.findUnique({
    where: { tenantId_supplierId_name: { tenantId, supplierId, name } },
  })
  if (existing) {
    if (!existing.isActive) throw new Error(`分类「${name}」已停用，请先恢复后再使用`)
    return existing
  }
  const max = await prisma.supplierProductCategory.aggregate({
    where: { tenantId, supplierId }, _max: { sortOrder: true },
  })
  try {
    return await prisma.supplierProductCategory.create({
      data: {
        tenantId, supplierId, name,
        sortOrder: (max._max.sortOrder ?? -1) + 1,
        isSystem: name === '其他',
      },
    })
  } catch (error: any) {
    if (error?.code === 'P2002') {
      const concurrent = await prisma.supplierProductCategory.findUnique({
        where: { tenantId_supplierId_name: { tenantId, supplierId, name } },
      })
      if (concurrent?.isActive) return concurrent
    }
    throw error
  }
}

export const productRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', auth(app), async (req: any, reply: any) => {
    const { category, status, q, page, pageSize = '20' } = req.query as any
    const { tenantId, role, supplierId } = req.user
    const where: any = { tenantId }
    if (category) where.category = category
    if (status) where.status = status
    if (q?.trim()) {
      const keyword = String(q).trim()
      where.OR = [
        { name: { contains: keyword, mode: 'insensitive' } },
        { code: { contains: keyword, mode: 'insensitive' } },
        { spec: { contains: keyword, mode: 'insensitive' } },
      ]
    }
    // 供应商账号只能看自己的商品
    if (isSupplierRole(role)) {
      if (!supplierId) return reply.status(403).send({ error: '账号未绑定供应商' })
      where.supplierId = supplierId
    }

    // 不传 page 时返回全量（兼容下拉框），缓存 10 分钟
    // 注意 cache key 加上 supplier scope，避免供应商之间互相污染
    //
    // 设计决策 (2026-05-28): API 返回所有 status (含 DISABLED), 让前端透明展示「已停售」
    // 而不是把 DISABLED 商品悄悄藏掉. chef 下单选品页负责显示 chip + 禁用加入按钮,
    // orders.ts:298 做 server-side 兜底拦截.
    if (!page && !q) {
      const scopeKey = isSupplierRole(role) ? `sup:${supplierId}` : 'all'
      const rows = await cached(`products:full:${tenantId}:${scopeKey}:${category || 'all'}:${status || 'all'}`, 600, () =>
        prisma.product.findMany({
          where,
          include: { supplier: { select: { id: true, name: true } } },
          orderBy: { createdAt: 'asc' },
        })
      )
      return rows.map((product: any) => ({ ...product, imageUrl: signOssKey(product.imageKey) }))
    }
    if (!page) {
      const rows = await prisma.product.findMany({
        where,
        include: { supplier: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'asc' },
      })
      return rows.map(product => ({ ...product, imageUrl: signOssKey(product.imageKey) }))
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
    return {
      items: items.map(product => ({ ...product, imageUrl: signOssKey(product.imageKey) })),
      total, page: p, pageSize: ps,
    }
  })

  // 建/改商品仅限总部管理员
  // 集团方写权限 + 供应商所有角色都可改/建自己 SKU
  const PRODUCT_WRITE_ROLES = new Set([
    'ADMIN', 'SUPER_ADMIN', 'PURCHASER',
    'CHEF_DIRECTOR',                       // BUG#10: 总厨是 SKU 主管理人
    'SUPPLIER_OWNER', 'SUPPLIER_STAFF', 'SUPPLIER_SUB',
  ])

  /** 当前租户/供应商实际使用的分类主数据，供筛选和下拉选择。 */
  app.get('/categories', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, supplierId } = req.user
    const where: any = { tenantId }
    if (isSupplierRole(role)) {
      if (!supplierId) return reply.status(403).send({ error: '账号未绑定供应商' })
      where.supplierId = supplierId
    }
    const rows = await prisma.product.groupBy({
      by: ['category'],
      where,
      _count: { _all: true },
      orderBy: { category: 'asc' },
    })
    if (!isSupplierRole(role)) {
      return rows.map(row => ({ name: row.category || '其他', count: row._count._all }))
    }

    const masters = await prisma.supplierProductCategory.findMany({
      where: { tenantId, supplierId },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    })
    const counts = new Map(rows.map(row => [row.category || '其他', row._count._all]))
    const result = masters.map(category => ({
      id: category.id,
      name: category.name,
      count: counts.get(category.name) || 0,
      sortOrder: category.sortOrder,
      isActive: category.isActive,
      isSystem: category.isSystem,
    }))
    // 兼容尚未执行迁移、或历史脏数据形成的孤立分类；管理页可见但不丢数据。
    for (const row of rows) {
      const name = row.category || '其他'
      if (!masters.some(category => category.name === name)) {
        result.push({
          id: null as any, name, count: row._count._all,
          sortOrder: result.length, isActive: true, isSystem: name === '其他',
        })
      }
    }
    return result
  })

  /** 新增供应商商品/库存分类。 */
  app.post('/categories', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId, supplierId } = req.user
    if (!isSupplierRole(role) || !supplierId) return reply.status(403).send({ error: '仅供应商账号可管理分类' })
    const parsed = z.object({ name: categoryNameSchema }).safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const duplicate = await prisma.supplierProductCategory.findUnique({
      where: { tenantId_supplierId_name: { tenantId, supplierId, name: parsed.data.name } },
    })
    if (duplicate) return reply.status(409).send({ error: '分类名称已存在' })
    const max = await prisma.supplierProductCategory.aggregate({
      where: { tenantId, supplierId }, _max: { sortOrder: true },
    })
    const category = await prisma.$transaction(async tx => {
      const created = await tx.supplierProductCategory.create({
        data: {
          tenantId, supplierId, name: parsed.data.name,
          sortOrder: (max._max.sortOrder ?? -1) + 1,
          isSystem: parsed.data.name === '其他',
        },
      })
      await tx.opLog.create({
        data: {
          tenantId, userId, role,
          action: `新增商品分类「${created.name}」`,
          entityType: 'ProductCategory', target: created.name, targetId: created.id,
          metadata: { supplierId, after: { name: created.name, sortOrder: created.sortOrder, isActive: true } },
        },
      })
      return created
    })
    return reply.status(201).send({ ...category, count: 0 })
  })

  /** 改名、停用或恢复分类。改名会同步更新该分类下全部商品，库存自动联动。 */
  app.patch('/categories/:id', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId, supplierId } = req.user
    if (!isSupplierRole(role) || !supplierId) return reply.status(403).send({ error: '仅供应商账号可管理分类' })
    const parsed = z.object({
      name: categoryNameSchema.optional(),
      isActive: z.boolean().optional(),
    }).refine(value => value.name !== undefined || value.isActive !== undefined, '没有需要修改的字段').safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const current = await prisma.supplierProductCategory.findFirst({
      where: { id: req.params.id, tenantId, supplierId },
    })
    if (!current) return reply.status(404).send({ error: '分类不存在' })
    if (current.isSystem && parsed.data.name && parsed.data.name !== current.name) {
      return reply.status(400).send({ error: '系统兜底分类不能改名' })
    }
    if (current.isSystem && parsed.data.isActive === false) {
      return reply.status(400).send({ error: '系统兜底分类不能停用' })
    }
    const nextName = parsed.data.name || current.name
    if (nextName !== current.name) {
      const duplicate = await prisma.supplierProductCategory.findUnique({
        where: { tenantId_supplierId_name: { tenantId, supplierId, name: nextName } },
      })
      if (duplicate) return reply.status(409).send({ error: '分类名称已存在' })
    }
    const nextActive = parsed.data.isActive ?? current.isActive
    const productCount = await prisma.$transaction(async tx => {
      const updatedProducts = nextName === current.name
        ? { count: 0 }
        : await tx.product.updateMany({
            where: { tenantId, supplierId, category: current.name },
            data: { category: nextName },
          })
      await tx.supplierProductCategory.update({
        where: { id: current.id },
        data: { name: nextName, isActive: nextActive },
      })
      await tx.opLog.create({
        data: {
          tenantId, userId, role,
          action: nextName !== current.name
            ? `商品分类改名「${current.name}」→「${nextName}」，同步 ${updatedProducts.count} 个 SKU`
            : `${nextActive ? '恢复' : '停用'}商品分类「${current.name}」`,
          entityType: 'ProductCategory', target: nextName, targetId: current.id,
          metadata: {
            supplierId,
            before: { name: current.name, isActive: current.isActive },
            after: { name: nextName, isActive: nextActive },
            productCount: updatedProducts.count,
          },
        },
      })
      return updatedProducts.count
    })
    void invalidatePattern(`products:full:${tenantId}:*`)
    return { ok: true, id: current.id, name: nextName, isActive: nextActive, productCount }
  })

  /** 保存分类顺序；必须一次提交当前供应商全部分类，防止越权/遗漏。 */
  app.patch('/categories-order', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId, supplierId } = req.user
    if (!isSupplierRole(role) || !supplierId) return reply.status(403).send({ error: '仅供应商账号可管理分类' })
    const parsed = z.object({ ids: z.array(z.string()).min(1).max(200) }).safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const ids = [...new Set(parsed.data.ids)]
    const existing = await prisma.supplierProductCategory.findMany({
      where: { tenantId, supplierId }, select: { id: true },
    })
    if (ids.length !== existing.length || existing.some(row => !ids.includes(row.id))) {
      return reply.status(400).send({ error: '分类顺序必须包含当前全部分类' })
    }
    await prisma.$transaction(async tx => {
      for (let i = 0; i < ids.length; i++) {
        await tx.supplierProductCategory.update({ where: { id: ids[i] }, data: { sortOrder: i } })
      }
      await tx.opLog.create({
        data: {
          tenantId, userId, role,
          action: `调整商品分类顺序：${ids.length} 类`,
          entityType: 'ProductCategory', targetId: supplierId,
          metadata: { supplierId, categoryIds: ids },
        },
      })
    })
    return { ok: true, count: ids.length }
  })

  /** 商品关键操作记录；供应商只能查看自家商品相关日志。 */
  app.get('/history', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, supplierId } = req.user
    const limit = Math.min(200, Math.max(1, Number((req.query as any)?.limit || 50)))
    let productIds: string[] | undefined
    if (isSupplierRole(role)) {
      if (!supplierId) return reply.status(403).send({ error: '账号未绑定供应商' })
      productIds = (await prisma.product.findMany({
        where: { tenantId, supplierId }, select: { id: true },
      })).map(product => product.id)
    }
    const rows = await prisma.opLog.findMany({
      where: {
        tenantId,
        entityType: { in: ['Product', 'ProductBatch', 'ProductCategory'] },
        ...(productIds ? {
          OR: [
            { targetId: { in: productIds } },
            { metadata: { path: ['supplierId'], equals: supplierId } },
          ],
        } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { user: { select: { name: true } } },
    })
    return rows.map(row => ({
      id: row.id,
      action: row.action,
      target: row.target,
      targetId: row.targetId,
      entityType: row.entityType,
      metadata: row.metadata,
      operator: row.user?.name || '系统',
      createdAt: row.createdAt,
    }))
  })

  const bulkIdsSchema = z.object({
    ids: z.array(z.string()).min(1).max(200),
  })

  app.patch('/batch-category', auth(app), async (req: any, reply: any) => {
    const { role, tenantId, userId, supplierId } = req.user
    if (!PRODUCT_WRITE_ROLES.has(role)) return reply.status(403).send({ error: '无权批量修改商品' })
    const parsed = bulkIdsSchema.extend({ category: z.string().trim().min(1).max(40) }).safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const where: any = { id: { in: parsed.data.ids }, tenantId }
    if (isSupplierRole(role)) {
      if (!supplierId) return reply.status(403).send({ error: '账号未绑定供应商' })
      where.supplierId = supplierId
      const category = await prisma.supplierProductCategory.findUnique({
        where: { tenantId_supplierId_name: { tenantId, supplierId, name: parsed.data.category } },
      })
      if (!category?.isActive) return reply.status(400).send({ error: '请选择一个启用中的分类' })
    }
    const matched = await prisma.product.findMany({ where, select: { id: true, category: true, code: true } })
    if (matched.length !== new Set(parsed.data.ids).size) return reply.status(400).send({ error: '包含不存在或无权限的商品' })
    await prisma.$transaction(async tx => {
      await tx.product.updateMany({ where, data: { category: parsed.data.category } })
      await tx.opLog.create({
        data: {
          tenantId, userId, role,
          action: `批量修改商品分类：${matched.length} 项 → ${parsed.data.category}`,
          entityType: 'ProductBatch', targetId: supplierId || null,
          metadata: {
            supplierId: supplierId || null,
            productIds: matched.map(item => item.id),
            before: matched.map(item => ({ id: item.id, code: item.code, category: item.category })),
            afterCategory: parsed.data.category,
          },
        },
      })
    })
    void invalidatePattern(`products:full:${tenantId}:*`)
    return { ok: true, count: matched.length, category: parsed.data.category }
  })

  app.patch('/batch-status', auth(app), async (req: any, reply: any) => {
    const { role, tenantId, userId, supplierId } = req.user
    if (!PRODUCT_WRITE_ROLES.has(role)) return reply.status(403).send({ error: '无权批量修改商品' })
    const parsed = bulkIdsSchema.extend({ status: z.enum(['ENABLED', 'DISABLED']) }).safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const where: any = { id: { in: parsed.data.ids }, tenantId }
    if (isSupplierRole(role)) {
      if (!supplierId) return reply.status(403).send({ error: '账号未绑定供应商' })
      where.supplierId = supplierId
    }
    const matched = await prisma.product.findMany({ where, select: { id: true, code: true, name: true, status: true } })
    if (matched.length !== new Set(parsed.data.ids).size) return reply.status(400).send({ error: '包含不存在或无权限的商品' })

    if (isSupplierRole(role) && parsed.data.status === 'DISABLED') {
      const eligible = matched.filter(item => item.status === 'ENABLED')
      if (eligible.length === 0) return reply.status(400).send({ error: '所选商品没有可提交停售的启用项' })
      const supplierName = supplierId
        ? (await prisma.supplier.findUnique({ where: { id: supplierId }, select: { name: true } }))?.name
        : null
      const documentNo = await prisma.$transaction(async tx => {
        const claimed = await tx.product.updateMany({
          where: { ...where, id: { in: eligible.map(item => item.id) }, status: 'ENABLED' },
          data: { status: 'PENDING_DISABLE' },
        })
        if (claimed.count !== eligible.length) {
          throw Object.assign(new Error('商品状态已变化，请刷新后重试'), { statusCode: 409 })
        }
        const no = await nextDocumentNo(tx, tenantId)
        await tx.document.create({
          data: {
            tenantId, no, type: 'NEW_DISH',
            title: `批量停售：${supplierName || '供应商'} ${eligible.length} 个 SKU`,
            amount: null, isOverThreshold: false, thresholdRule: '批量 SKU 停售 直送总厨',
            payload: {
              action: 'BATCH_DISABLE', productIds: eligible.map(item => item.id),
              count: eligible.length, supplierName: supplierName || null,
            },
            initiatorId: userId, status: 'PENDING',
            steps: { create: [{ seq: 1, approverRole: 'CHEF_DIRECTOR', status: 'PENDING' }] },
          },
        })
        await tx.opLog.create({
          data: {
            tenantId, userId, role,
            action: `批量停售申请：${eligible.length} 项，审批单 ${no}`,
            entityType: 'ProductBatch', target: no, targetId: supplierId || null,
            metadata: { supplierId: supplierId || null, productIds: eligible.map(item => item.id) },
          },
        })
        return no
      })
      void invalidatePattern(`products:full:${tenantId}:*`)
      return { ok: true, count: eligible.length, statusChange: 'PENDING_APPROVAL', documentNo }
    }

    const targetStatus = parsed.data.status
    await prisma.$transaction(async tx => {
      await tx.product.updateMany({ where, data: { status: targetStatus } })
      await tx.opLog.create({
        data: {
          tenantId, userId, role,
          action: `批量${targetStatus === 'ENABLED' ? '恢复供应' : '停售'}：${matched.length} 项`,
          entityType: 'ProductBatch', targetId: supplierId || null,
          metadata: { supplierId: supplierId || null, productIds: matched.map(item => item.id), status: targetStatus },
        },
      })
    })
    void invalidatePattern(`products:full:${tenantId}:*`)
    return { ok: true, count: matched.length, status: targetStatus }
  })

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
      const scopedSupplier = await prisma.supplier.findFirst({
        where: { id: userSupplierId, tenantId }, select: { id: true },
      })
      if (!scopedSupplier) return reply.status(403).send({ error: '账号绑定的供应商不属于当前租户' })
      // 供应商新建 SKU 默认进入"待总厨审批"状态, 通过后才上架
      data.status = 'PENDING_APPROVAL'
      // 商品报价与供应商库存解耦；库存只能通过库存入库/调整接口形成流水。
      delete data.stock
      delete data.minStock
    } else if (data.supplierId) {
      const scopedSupplier = await prisma.supplier.findFirst({
        where: { id: data.supplierId, tenantId }, select: { id: true },
      })
      if (!scopedSupplier) return reply.status(400).send({ error: '供应商不存在或不属于当前租户' })
    }
    if (data.imageKey && !String(data.imageKey).startsWith(`products/${tenantId}/`)) {
      return reply.status(400).send({ error: '商品图片不属于当前租户' })
    }
    if (!data.code) data.code = autoCode(data.supplierId)
    if (!data.category) data.category = '其他'
    if (isSupplierRole(role)) {
      try {
        await ensureActiveSupplierCategory(tenantId, userSupplierId!, data.category)
      } catch (error: any) {
        return reply.status(400).send({ error: error?.message || '商品分类不可用' })
      }
    }
    try {
      const supplierName = isSupplierRole(role)
        ? (await prisma.supplier.findFirst({ where: { id: userSupplierId!, tenantId }, select: { name: true } }))?.name || null
        : null
      if (isSupplierRole(role) && !supplierName) {
        return reply.status(403).send({ error: '账号绑定的供应商不属于当前租户' })
      }
      const product = await prisma.$transaction(async tx => {
        const created = await tx.product.create({
          data: { tenantId, ...data } as any,
        })
        // 供应商创建 → 商品、审批单和操作日志原子提交。
        if (isSupplierRole(role)) {
          const no = await nextDocumentNo(tx, tenantId)
          await tx.document.create({
            data: {
              tenantId, no, type: 'NEW_DISH',
              title: `新品上架: ${created.name}${created.spec ? ' (' + created.spec + ')' : ''} ¥${Number(created.price)}`,
              amount: Number(created.price), isOverThreshold: false,
              thresholdRule: '新供应商商品 直送总厨',
              payload: {
                action: 'CREATE',
                productId: created.id, productName: created.name,
                productCode: created.code, spec: created.spec, unit: created.unit,
                price: Number(created.price), category: created.category,
                supplierName,
              },
              initiatorId: userId, status: 'PENDING',
              steps: { create: [{ seq: 1, approverRole: 'CHEF_DIRECTOR', status: 'PENDING' }] },
            },
          })
        }
        await tx.opLog.create({
          data: {
            tenantId, userId, role,
            action: `新建商品 ${created.name} (#${created.code})`,
            entityType: 'Product', target: created.code, targetId: created.id,
            metadata: {
              supplierId: created.supplierId,
              after: {
                code: created.code, name: created.name, spec: created.spec,
                category: created.category, unit: created.unit, price: Number(created.price),
                status: created.status, imageKey: created.imageKey,
              },
            },
          },
        })
        return created
      })
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

    const failed: { row: number; code?: string; error: string }[] = []
    let candidates: { row: number; id: string; data: any }[] = []

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
      candidates.push({ row: i + 1, id: createId(), data })
    }

    if (isSupplierRole(role) && userSupplierId) {
      const categoryNames = [...new Set(candidates.map(candidate => candidate.data.category))]
      const categories = await prisma.supplierProductCategory.findMany({
        where: { tenantId, supplierId: userSupplierId, name: { in: categoryNames } },
        select: { name: true, isActive: true },
      })
      const inactive = new Set(categories.filter(category => !category.isActive).map(category => category.name))
      candidates = candidates.filter(candidate => {
        if (!inactive.has(candidate.data.category)) return true
        failed.push({ row: candidate.row, code: candidate.data.code, error: `分类「${candidate.data.category}」已停用，请先恢复后再使用` })
        return false
      })
    } else if (!isSupplierRole(role)) {
      // 总部账号可为商品指定供应商，但只能引用本租户供应商。
      const requestedSupplierIds = [...new Set(candidates.map(candidate => candidate.data.supplierId).filter(Boolean))] as string[]
      const allowedSuppliers = requestedSupplierIds.length > 0
        ? await prisma.supplier.findMany({
          where: { tenantId, id: { in: requestedSupplierIds } }, select: { id: true },
        })
        : []
      const allowedSupplierIds = new Set(allowedSuppliers.map(supplier => supplier.id))
      candidates = candidates.filter(candidate => {
        const candidateSupplierId = candidate.data.supplierId
        if (!candidateSupplierId || allowedSupplierIds.has(candidateSupplierId)) return true
        failed.push({ row: candidate.row, code: candidate.data.code, error: '供应商不存在或不属于当前租户' })
        return false
      })
    }

    const supplier = isSupplierRole(role) && userSupplierId
      ? await prisma.supplier.findFirst({ where: { id: userSupplierId, tenantId }, select: { name: true } })
      : null
    if (isSupplierRole(role) && userSupplierId && !supplier) {
      return reply.status(403).send({ error: '账号绑定的供应商不属于当前租户' })
    }

    try {
      const result = await prisma.$transaction(async tx => {
        const batch = await tx.productBatch.create({
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

        if (isSupplierRole(role) && userSupplierId && candidates.length > 0) {
          const categoryNames = [...new Set(candidates.map(candidate => candidate.data.category))]
          const existingCategories = await tx.supplierProductCategory.findMany({
            where: { tenantId, supplierId: userSupplierId, name: { in: categoryNames } },
            select: { name: true },
          })
          const existingNames = new Set(existingCategories.map(category => category.name))
          const missingNames = categoryNames.filter(name => !existingNames.has(name))
          if (missingNames.length > 0) {
            const max = await tx.supplierProductCategory.aggregate({
              where: { tenantId, supplierId: userSupplierId }, _max: { sortOrder: true },
            })
            await tx.supplierProductCategory.createMany({
              data: missingNames.map((name, index) => ({
                tenantId, supplierId: userSupplierId, name,
                sortOrder: (max._max.sortOrder ?? -1) + index + 1,
                isSystem: name === '其他',
              })),
              skipDuplicates: true,
            })
          }
          const activeCategoryCount = await tx.supplierProductCategory.count({
            where: { tenantId, supplierId: userSupplierId, name: { in: categoryNames }, isActive: true },
          })
          if (activeCategoryCount !== categoryNames.length) {
            throw new Error('商品分类状态已变化，请刷新后重试')
          }
        }

        if (candidates.length > 0) {
          await tx.product.createMany({
            data: candidates.map(candidate => ({
              id: candidate.id, tenantId, batchId: batch.id, ...candidate.data,
            })) as any,
            skipDuplicates: true,
          })
        }
        const insertedProducts = candidates.length > 0
          ? await tx.product.findMany({
            where: { tenantId, id: { in: candidates.map(candidate => candidate.id) } },
            select: { id: true, code: true, name: true },
          })
          : []
        const insertedById = new Map(insertedProducts.map(product => [product.id, product]))
        const created = candidates.flatMap(candidate => {
          const product = insertedById.get(candidate.id)
          if (!product) {
            failed.push({ row: candidate.row, code: candidate.data.code, error: '编码已存在' })
            return []
          }
          return [{ row: candidate.row, id: product.id, code: product.code, name: product.name }]
        })
        failed.sort((a, b) => a.row - b.row)

        await tx.productBatch.update({
          where: { id: batch.id },
          data: {
            createdCount: created.length,
            failedCount: failed.length,
            failedRows: failed as any,
          },
        })

        let approvalDocNo: string | null = null
        if (isSupplierRole(role) && created.length > 0) {
          const no = await nextDocumentNo(tx, tenantId)
          const doc = await tx.document.create({
            data: {
              tenantId, no, type: 'NEW_DISH',
              title: `批量新品: ${supplier?.name || '供应商'} 上架 ${created.length} 个 SKU${filename ? ` (${filename})` : ''}`,
              amount: null, isOverThreshold: false,
              thresholdRule: '批量新供应商商品 直送总厨',
              payload: {
                action: 'BATCH', batchId: batch.id,
                productIds: created.map(product => product.id),
                count: created.length, filename: filename || null,
                supplierName: supplier?.name || null,
              },
              initiatorId: userId, status: 'PENDING',
              steps: { create: [{ seq: 1, approverRole: 'CHEF_DIRECTOR', status: 'PENDING' }] },
            },
          })
          approvalDocNo = doc.no
        }

        if (created.length > 0) {
          await tx.opLog.create({
            data: {
              tenantId, userId, role,
              action: `批量上传商品：成功 ${created.length}，失败 ${failed.length}`,
              entityType: 'ProductBatch', target: filename || undefined, targetId: batch.id,
              metadata: {
                supplierId: isSupplierRole(role) ? userSupplierId || null : null,
                productIds: created.map(item => item.id), filename,
                createdCount: created.length, failedCount: failed.length,
              },
            },
          })
        }
        return { batchId: batch.id, created, approvalDocNo }
      })
      void invalidatePattern(`products:full:${tenantId}:*`)
      return reply.status(201).send({
        batchId: result.batchId,
        total: items.length,
        createdCount: result.created.length,
        failedCount: failed.length,
        created: result.created,
        failed,
        approvalDocNo: result.approvalDocNo,
      })
    } catch (error: any) {
      req.log.error({ err: error }, 'product batch create failed')
      return reply.status(500).send({ error: '批量创建失败，未保存任何商品' })
    }
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

  // ─── 撤回上传：只停售并留存历史，禁止物理删除商品/库存流水 ──────
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
    const products = await prisma.product.findMany({
      where: { batchId: b.id, tenantId }, select: { id: true },
    })
    await prisma.$transaction(async tx => {
      await tx.product.updateMany({
        where: { batchId: b.id, tenantId }, data: { status: 'DISABLED' },
      })
      await tx.productBatch.update({
        where: { id: b.id },
        data: { revokedAt: new Date(), revokedById: userId },
      })
      await tx.opLog.create({
        data: {
          tenantId, userId, role,
          action: `撤回批次上传 ${b.id}，停售 ${products.length} 个 SKU（历史保留）`,
          entityType: 'ProductBatch', targetId: b.id,
          metadata: { supplierId: b.supplierId, productIds: products.map(item => item.id) },
        },
      })
    })
    void invalidatePattern(`products:full:${tenantId}:*`)
    return { success: true, disabledCount: products.length }
  })

  // 历史商品、库存流水和批次禁止物理清除；保留旧接口并明确拒绝，防旧前端误调用。
  app.delete('/clear-all', auth(app), async (req: any, reply: any) => {
    return reply.status(410).send({ error: '为保护订单和库存审计，清空全部 SKU 已永久停用。请使用批量停售。' })
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
    const SUPPLIER_ALLOW = ['price', 'spec', 'category', 'imageKey', 'minOrderQty', 'stepQty', 'shelfDays', 'status', 'shipUpperPct', 'shipUpperBuffer']
    const STAFF_ALLOW = [...SUPPLIER_ALLOW, 'name', 'unit', 'category', 'code']  // 内部员工额外可改名/类
    const allow = isSupplierRole(role) ? SUPPLIER_ALLOW : STAFF_ALLOW
    const data = Object.fromEntries(Object.entries(body).filter(([k]) => allow.includes(k)))
    if (data.imageKey && !String(data.imageKey).startsWith(`products/${tenantId}/`)) {
      return reply.status(400).send({ error: '商品图片不属于当前租户' })
    }
    if (isSupplierRole(role) && data.category) {
      const category = await prisma.supplierProductCategory.findUnique({
        where: { tenantId_supplierId_name: { tenantId, supplierId: supplierId!, name: String(data.category).trim() } },
      })
      if (!category?.isActive) return reply.status(400).send({ error: '请选择一个启用中的分类' })
      data.category = category.name
    }

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
      const doc = await prisma.$transaction(async tx => {
        const claimed = await tx.product.updateMany({
          where: { ...where, status: 'ENABLED' },
          data: { status: 'PENDING_DISABLE' as any },
        })
        if (claimed.count !== 1) {
          throw Object.assign(new Error('商品状态已变化，请刷新后重试'), { statusCode: 409 })
        }
        const no = await nextDocumentNo(tx, tenantId)
        const created = await tx.document.create({
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
        await tx.opLog.create({
          data: {
            tenantId, userId, role,
            action: `申请停售商品 ${cur.name} (#${cur.code})，审批单 ${created.no}`,
            entityType: 'Product', target: cur.code, targetId: cur.id,
            metadata: { supplierId, before: { status: cur.status }, after: { status: 'PENDING_DISABLE' }, documentNo: created.no },
          },
        })
        return created
      })
      void invalidatePattern(`products:full:${tenantId}:*`)
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
        const delta = newPrice - oldPrice
        const pct = oldPrice > 0 ? (delta / oldPrice * 100).toFixed(1) : 'N/A'
        const sign = delta > 0 ? '↑' : '↓'
        const title = `调价: ${cur.name} ¥${oldPrice} → ¥${newPrice} (${sign}${Math.abs(delta).toFixed(2)} / ${pct}%)`
        // 价格字段从本次更新 data 里去除, 其他字段仍可与审批单原子提交。
        delete data.price
        const doc = await prisma.$transaction(async tx => {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`product-price:${cur.id}`}))::text AS locked`
          const concurrent = await tx.document.findFirst({
            where: {
              tenantId, type: 'PRICE_ADJUSTMENT', status: 'PENDING',
              payload: { path: ['productId'], equals: cur.id },
            },
            select: { no: true },
          })
          if (concurrent) {
            throw Object.assign(new Error(`该商品已有待审批的调价单 ${concurrent.no}`), { statusCode: 409 })
          }
          const no = await nextDocumentNo(tx, tenantId)
          const created = await tx.document.create({
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
          if (Object.keys(data).length > 0) await tx.product.updateMany({ where, data })
          await tx.opLog.create({
            data: {
              tenantId, userId, role,
              action: `申请调价 ${cur.name} (#${cur.code})：¥${oldPrice} → ¥${newPrice}`,
              entityType: 'Product', target: cur.code, targetId: cur.id,
              metadata: { supplierId, before: { price: oldPrice }, requested: { price: newPrice }, documentNo: created.no },
            },
          })
          return created
        })
        void invalidatePattern(`products:full:${tenantId}:*`)
        return { count: 1, priceChangeStatus: 'PENDING_APPROVAL', documentNo: doc.no, message: '涨价已提交总厨审批, 通过后自动生效' }
      }
      // 价格不变 → 不写; 降价 / 首次定价 → 直接落库 (data.price 已是新价, 由下面 updateMany 应用)
      if (noChange) delete data.price
    }

    if (Object.keys(data).length === 0) return { count: 0, message: '没有可修改字段' }
    const before = await prisma.product.findFirst({
      where,
      select: {
        id: true, code: true, name: true, supplierId: true, price: true, spec: true,
        category: true, imageKey: true, minOrderQty: true, stepQty: true,
        shelfDays: true, status: true, shipUpperPct: true, shipUpperBuffer: true,
      },
    })
    if (!before) return reply.status(404).send({ error: '商品不存在或无权修改' })
    const after = await prisma.$transaction(async tx => {
      const updated = await tx.product.update({ where: { id: before.id }, data })
      await tx.opLog.create({
        data: {
          tenantId, userId, role,
          action: `修改商品 ${before.name} (#${before.code})：${Object.keys(data).join('、')}`,
          entityType: 'Product', target: before.code, targetId: before.id,
          metadata: {
            supplierId: before.supplierId,
            fields: Object.keys(data),
            before: jsonSafe(before),
            after: jsonSafe(Object.fromEntries(Object.keys(data).map(key => [key, (updated as any)[key]]))),
          },
        },
      })
      return updated
    })
    void invalidatePattern(`products:full:${tenantId}:*`)
    return { count: 1, product: { ...after, imageUrl: signOssKey(after.imageKey) } }
  })
}
