import { FastifyPluginAsync } from 'fastify'
import { prisma } from '@dianjie/db'
import { z } from 'zod'
import { invalidatePattern } from '../lib/cache'

/**
 * 供应商维度的供货关系管理（对齐美团「供应商档案-供货关系」）。
 *
 * 与 /api/product-upstream-sources（商品维度整单替换）写同一张 ProductUpstreamSource，
 * 这里提供供应商视角的列表 / 批量绑定 / 行内改 / 软解绑，供供应链岗在供应商档案里
 * 批量维护"这家供应商可供哪些商品"。
 */

const READ_ROLES = new Set(['ADMIN', 'SUPER_ADMIN', 'FINANCE', 'PURCHASER', 'SUPPLY_CHAIN'])
const WRITE_ROLES = new Set(['ADMIN', 'SUPER_ADMIN', 'PURCHASER', 'SUPPLY_CHAIN'])

const supplierIdSchema = z.string().trim().min(1).max(64)
const productIdSchema = z.string().trim().min(1).max(64)

const bindItemSchema = z.object({
  productId: productIdSchema,
  purchaseUnit: z.string().trim().min(1).max(16),
  inventoryUnitsPerPurchaseUnit: z.number().positive().max(99_999_999),
  quotedUnitPrice: z.number().nonnegative().max(999_999_999.9999).optional().nullable(),
  isPrimary: z.boolean().optional().default(false),
  supplierSku: z.string().trim().max(80).optional().nullable(),
  minOrderQty: z.number().positive().max(99_999_999).optional().default(1),
  leadTimeDays: z.number().int().min(0).max(365).optional().default(0),
  note: z.string().trim().max(240).optional().nullable(),
}).strict()

export const supplierUpstreamBindBodySchema = z.object({
  items: z.array(bindItemSchema).min(1).max(200),
}).strict()

export const supplierUpstreamPatchBodySchema = z.object({
  purchaseUnit: z.string().trim().min(1).max(16).optional(),
  inventoryUnitsPerPurchaseUnit: z.number().positive().max(99_999_999).optional(),
  quotedUnitPrice: z.number().nonnegative().max(999_999_999.9999).nullable().optional(),
  isPrimary: z.boolean().optional(),
  supplierSku: z.string().trim().max(80).nullable().optional(),
  minOrderQty: z.number().positive().max(99_999_999).optional(),
  leadTimeDays: z.number().int().min(0).max(365).optional(),
  note: z.string().trim().max(240).nullable().optional(),
}).strict()

const PRODUCT_SNAPSHOT_SELECT = {
  id: true, code: true, name: true, category: true, spec: true, unit: true,
  purchaseUnit: true, inventoryUnit: true, inventoryUnitsPerPurchaseUnit: true,
  price: true, status: true,
} as const

function serializeBinding(row: any) {
  return {
    id: row.id,
    productId: row.productId,
    supplierId: row.supplierId,
    isPrimary: row.isPrimary,
    supplierSku: row.supplierSku,
    purchaseUnit: row.purchaseUnit,
    inventoryUnitsPerPurchaseUnit: Number(row.inventoryUnitsPerPurchaseUnit),
    quotedUnitPrice: row.quotedUnitPrice === null ? null : Number(row.quotedUnitPrice),
    minOrderQty: Number(row.minOrderQty),
    leadTimeDays: row.leadTimeDays,
    note: row.note,
    product: row.product
      ? {
          ...row.product,
          price: row.product.price === null ? null : Number(row.product.price),
          inventoryUnitsPerPurchaseUnit: row.product.inventoryUnitsPerPurchaseUnit === null
            ? null : Number(row.product.inventoryUnitsPerPurchaseUnit),
        }
      : null,
  }
}

/** 载入供应商并校验：本租户、启用、上游业务范围。 */
async function loadUpstreamSupplier(tenantId: string, supplierId: string) {
  return prisma.supplier.findFirst({
    where: {
      id: supplierId, tenantId, status: 'ENABLED',
      businessScopes: { has: 'WAREHOUSE_UPSTREAM' },
    },
    select: { id: true, no: true, name: true },
  })
}

/** 设某商品的主供：清掉其它供应商的主供标记（同一商品同一时刻只能一个主供）。 */
async function claimPrimary(tx: any, tenantId: string, productId: string, supplierId: string) {
  await tx.productUpstreamSource.updateMany({
    where: { tenantId, productId, supplierId: { not: supplierId }, isPrimary: true },
    data: { isPrimary: false },
  })
}

export const supplierUpstreamProductRoutes: FastifyPluginAsync = async app => {
  const auth = { preHandler: [(app as any).authenticate] }

  /** 该供应商的生效绑定列表（含商品快照）。 */
  app.get('/:id/upstream-products', auth, async (req: any, reply: any) => {
    if (!READ_ROLES.has(req.user.role)) return reply.status(403).send({ error: '无权查看供货关系' })
    const parsedId = supplierIdSchema.safeParse(req.params.id)
    if (!parsedId.success) return reply.status(400).send({ error: '供应商 ID 格式不正确' })
    const supplier = await prisma.supplier.findFirst({
      where: { id: parsedId.data, tenantId: req.user.tenantId },
      select: { id: true, no: true, name: true, status: true, businessScopes: true },
    })
    if (!supplier) return reply.status(404).send({ error: '供应商不存在' })
    const rows = await prisma.productUpstreamSource.findMany({
      where: { tenantId: req.user.tenantId, supplierId: supplier.id, isActive: true },
      include: { product: { select: PRODUCT_SNAPSHOT_SELECT } },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    })
    return { supplier, items: rows.map(serializeBinding) }
  })

  /** 批量绑定供货商品；已生效的绑定跳过并回报，软删过的行复活并更新条件。 */
  app.post('/:id/upstream-products', auth, async (req: any, reply: any) => {
    if (!WRITE_ROLES.has(req.user.role)) return reply.status(403).send({ error: '无权维护供货关系' })
    const parsedId = supplierIdSchema.safeParse(req.params.id)
    if (!parsedId.success) return reply.status(400).send({ error: '供应商 ID 格式不正确' })
    const parsed = supplierUpstreamBindBodySchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const { tenantId, userId, role } = req.user

    const supplier = await loadUpstreamSupplier(tenantId, parsedId.data)
    if (!supplier) return reply.status(400).send({ error: '供应商不存在、已停用或非上游供应商' })

    const productIds = [...new Set(parsed.data.items.map(item => item.productId))]
    const products = await prisma.product.findMany({
      where: { id: { in: productIds }, tenantId, status: 'ENABLED' },
      select: { id: true, code: true, name: true },
    })
    if (products.length !== productIds.length) {
      const found = new Set(products.map(product => product.id))
      const missing = productIds.filter(id => !found.has(id))
      return reply.status(400).send({ error: `存在不可用商品（不存在或已停用）: ${missing.join(', ')}` })
    }
    const productById = new Map(products.map(product => [product.id, product]))

    const result = await prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`supplier-upstream:${tenantId}:${supplier.id}`}))`
      const existing = await tx.productUpstreamSource.findMany({
        where: { tenantId, supplierId: supplier.id, productId: { in: productIds } },
      })
      const existingByProduct = new Map(existing.map(row => [row.productId, row]))
      const bound: string[] = []
      const reactivated: string[] = []
      const skipped: string[] = []
      for (const item of parsed.data.items) {
        const current = existingByProduct.get(item.productId)
        if (current?.isActive) {
          skipped.push(item.productId)
          continue
        }
        if (item.isPrimary) await claimPrimary(tx, tenantId, item.productId, supplier.id)
        if (current) {
          await tx.productUpstreamSource.update({
            where: { id: current.id },
            data: {
              isActive: true,
              isPrimary: item.isPrimary,
              supplierSku: item.supplierSku || null,
              purchaseUnit: item.purchaseUnit,
              inventoryUnitsPerPurchaseUnit: item.inventoryUnitsPerPurchaseUnit,
              quotedUnitPrice: item.quotedUnitPrice ?? null,
              minOrderQty: item.minOrderQty,
              leadTimeDays: item.leadTimeDays,
              note: item.note || null,
            },
          })
          reactivated.push(item.productId)
        } else {
          await tx.productUpstreamSource.create({
            data: {
              tenantId,
              productId: item.productId,
              supplierId: supplier.id,
              isPrimary: item.isPrimary,
              isActive: true,
              supplierSku: item.supplierSku || null,
              purchaseUnit: item.purchaseUnit,
              inventoryUnitsPerPurchaseUnit: item.inventoryUnitsPerPurchaseUnit,
              quotedUnitPrice: item.quotedUnitPrice ?? null,
              minOrderQty: item.minOrderQty,
              leadTimeDays: item.leadTimeDays,
              note: item.note || null,
            },
          })
          bound.push(item.productId)
        }
      }
      await tx.opLog.create({
        data: {
          tenantId, userId, role,
          action: `批量绑定供货商品 ${supplier.name}：新增 ${bound.length} 个, 复活 ${reactivated.length} 个, 跳过已存在 ${skipped.length} 个`,
          entityType: 'ProductUpstreamSource', target: supplier.name, targetId: supplier.id,
          metadata: {
            supplierId: supplier.id,
            bound: bound.map(id => productById.get(id)?.name || id),
            reactivated: reactivated.map(id => productById.get(id)?.name || id),
            skipped: skipped.map(id => productById.get(id)?.name || id),
          },
        },
      })
      return { bound, reactivated, skipped }
    })
    void invalidatePattern(`products:full:${tenantId}:*`)
    return {
      supplier,
      boundCount: result.bound.length,
      reactivatedCount: result.reactivated.length,
      skipped: result.skipped.map(id => ({ productId: id, name: productById.get(id)?.name || id })),
    }
  })

  /** 行内修改绑定条件（价/单位/换算/主供等）。 */
  app.patch('/:id/upstream-products/:productId', auth, async (req: any, reply: any) => {
    if (!WRITE_ROLES.has(req.user.role)) return reply.status(403).send({ error: '无权维护供货关系' })
    const parsedSupplierId = supplierIdSchema.safeParse(req.params.id)
    const parsedProductId = productIdSchema.safeParse(req.params.productId)
    if (!parsedSupplierId.success || !parsedProductId.success) {
      return reply.status(400).send({ error: 'ID 格式不正确' })
    }
    const parsed = supplierUpstreamPatchBodySchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    if (Object.keys(parsed.data).length === 0) return reply.status(400).send({ error: '没有要修改的字段' })
    const { tenantId, userId, role } = req.user

    const updated = await prisma.$transaction(async tx => {
      const current = await tx.productUpstreamSource.findFirst({
        where: { tenantId, supplierId: parsedSupplierId.data, productId: parsedProductId.data, isActive: true },
        include: { product: { select: { name: true, code: true } }, supplier: { select: { name: true } } },
      })
      if (!current) throw Object.assign(new Error('供货关系不存在或已解绑'), { statusCode: 404 })
      if (parsed.data.isPrimary) await claimPrimary(tx, tenantId, current.productId, current.supplierId)
      const row = await tx.productUpstreamSource.update({
        where: { id: current.id },
        data: parsed.data,
        include: { product: { select: PRODUCT_SNAPSHOT_SELECT } },
      })
      await tx.opLog.create({
        data: {
          tenantId, userId, role,
          action: `修改供货关系 ${current.supplier.name} × ${current.product.name} (#${current.product.code})`,
          entityType: 'ProductUpstreamSource', target: current.product.code, targetId: current.id,
          metadata: { before: serializeBinding({ ...current, product: null }), after: parsed.data },
        },
      })
      return row
    }).catch((error: any) => {
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      throw error
    })
    if (reply.sent) return
    void invalidatePattern(`products:full:${req.user.tenantId}:*`)
    return serializeBinding(updated)
  })

  /** 软解绑（isActive=false）；历史单据与成本快照不受影响，重新绑定即恢复。 */
  app.delete('/:id/upstream-products/:productId', auth, async (req: any, reply: any) => {
    if (!WRITE_ROLES.has(req.user.role)) return reply.status(403).send({ error: '无权维护供货关系' })
    const parsedSupplierId = supplierIdSchema.safeParse(req.params.id)
    const parsedProductId = productIdSchema.safeParse(req.params.productId)
    if (!parsedSupplierId.success || !parsedProductId.success) {
      return reply.status(400).send({ error: 'ID 格式不正确' })
    }
    const { tenantId, userId, role } = req.user

    const done = await prisma.$transaction(async tx => {
      const current = await tx.productUpstreamSource.findFirst({
        where: { tenantId, supplierId: parsedSupplierId.data, productId: parsedProductId.data, isActive: true },
        include: { product: { select: { name: true, code: true } }, supplier: { select: { name: true } } },
      })
      if (!current) throw Object.assign(new Error('供货关系不存在或已解绑'), { statusCode: 404 })
      await tx.productUpstreamSource.update({ where: { id: current.id }, data: { isActive: false, isPrimary: false } })
      await tx.opLog.create({
        data: {
          tenantId, userId, role,
          action: `解绑供货关系 ${current.supplier.name} × ${current.product.name} (#${current.product.code})${current.isPrimary ? '（原为主供）' : ''}`,
          entityType: 'ProductUpstreamSource', target: current.product.code, targetId: current.id,
        },
      })
      return current
    }).catch((error: any) => {
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      throw error
    })
    if (reply.sent) return
    void invalidatePattern(`products:full:${tenantId}:*`)
    return { ok: true, productId: done.productId, wasPrimary: done.isPrimary }
  })
}

/**
 * 供货关系总表（只读）：商品 × 供应商扁平列表 + 未绑定商品清单。
 * 供「供货关系」总表页双视角使用；数量级为数百 SKU × 个位数供应商，一次全量返回。
 */
export const upstreamRelationsRoutes: FastifyPluginAsync = async app => {
  const auth = { preHandler: [(app as any).authenticate] }

  app.get('/', auth, async (req: any, reply: any) => {
    if (!READ_ROLES.has(req.user.role)) return reply.status(403).send({ error: '无权查看供货关系' })
    const { tenantId } = req.user
    const rows = await prisma.productUpstreamSource.findMany({
      where: { tenantId, isActive: true },
      include: {
        product: { select: PRODUCT_SNAPSHOT_SELECT },
        supplier: { select: { id: true, no: true, name: true, status: true } },
      },
      orderBy: [{ supplierId: 'asc' }, { isPrimary: 'desc' }, { createdAt: 'asc' }],
    })
    return rows.map(row => ({
      ...serializeBinding(row),
      supplier: row.supplier,
    }))
  })

  /** 未绑定任何上游供应商的启用商品（含分类，供补录清单）。 */
  app.get('/unbound', auth, async (req: any, reply: any) => {
    if (!READ_ROLES.has(req.user.role)) return reply.status(403).send({ error: '无权查看供货关系' })
    const { tenantId } = req.user
    const products = await prisma.product.findMany({
      where: {
        tenantId,
        status: 'ENABLED',
        upstreamSources: { none: { isActive: true } },
      },
      select: PRODUCT_SNAPSHOT_SELECT,
      orderBy: [{ category: 'asc' }, { code: 'asc' }],
    })
    return products.map(product => ({
      ...product,
      price: product.price === null ? null : Number(product.price),
      inventoryUnitsPerPurchaseUnit: product.inventoryUnitsPerPurchaseUnit === null
        ? null : Number(product.inventoryUnitsPerPurchaseUnit),
    }))
  })
}
