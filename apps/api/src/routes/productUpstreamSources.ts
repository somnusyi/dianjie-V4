import { FastifyPluginAsync } from 'fastify'
import { prisma } from '@dianjie/db'
import { z } from 'zod'
import { invalidatePattern } from '../lib/cache'

const READ_ROLES = new Set(['ADMIN', 'SUPER_ADMIN', 'FINANCE', 'PURCHASER', 'SUPPLY_CHAIN'])
const WRITE_ROLES = new Set(['ADMIN', 'SUPER_ADMIN', 'PURCHASER', 'SUPPLY_CHAIN'])

const productIdSchema = z.string().trim().min(1).max(64)
const sourceSchema = z.object({
  supplierId: z.string().trim().min(1).max(64),
  isPrimary: z.boolean(),
  supplierSku: z.string().trim().max(80).optional().nullable(),
  purchaseUnit: z.string().trim().min(1).max(16),
  inventoryUnitsPerPurchaseUnit: z.number().positive().max(99_999_999),
  quotedUnitPrice: z.number().nonnegative().max(999_999_999.9999).optional().nullable(),
  minOrderQty: z.number().positive().max(99_999_999),
  leadTimeDays: z.number().int().min(0).max(365),
  note: z.string().trim().max(240).optional().nullable(),
}).strict()

export const productUpstreamSourcesBodySchema = z.object({
  sources: z.array(sourceSchema).max(20),
}).strict().superRefine((value, context) => {
  const supplierIds = value.sources.map(source => source.supplierId)
  if (new Set(supplierIds).size !== supplierIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['sources'], message: '同一上游供应商不能重复添加' })
  }
  const primaryCount = value.sources.filter(source => source.isPrimary).length
  if (value.sources.length > 0 && primaryCount !== 1) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['sources'], message: '有采购来源时必须且只能指定一个主供' })
  }
})

function serializeSource(source: any) {
  return {
    id: source.id,
    productId: source.productId,
    supplierId: source.supplierId,
    supplier: source.supplier,
    isPrimary: source.isPrimary,
    supplierSku: source.supplierSku,
    purchaseUnit: source.purchaseUnit,
    inventoryUnitsPerPurchaseUnit: Number(source.inventoryUnitsPerPurchaseUnit),
    quotedUnitPrice: source.quotedUnitPrice === null ? null : Number(source.quotedUnitPrice),
    minOrderQty: Number(source.minOrderQty),
    leadTimeDays: source.leadTimeDays,
    note: source.note,
  }
}

async function readSources(tenantId: string, productId: string) {
  const rows = await prisma.productUpstreamSource.findMany({
    where: { tenantId, productId, isActive: true },
    include: { supplier: { select: { id: true, no: true, name: true, status: true } } },
    orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
  })
  return rows.map(serializeSource)
}

export const productUpstreamSourceRoutes: FastifyPluginAsync = async app => {
  const auth = { preHandler: [(app as any).authenticate] }

  app.get('/:productId', auth, async (req: any, reply: any) => {
    if (!READ_ROLES.has(req.user.role)) return reply.status(403).send({ error: '无权查看商品采购来源' })
    const parsedId = productIdSchema.safeParse(req.params.productId)
    if (!parsedId.success) return reply.status(400).send({ error: '商品 ID 格式不正确' })
    const product = await prisma.product.findFirst({
      where: { id: parsedId.data, tenantId: req.user.tenantId }, select: { id: true },
    })
    if (!product) return reply.status(404).send({ error: '商品不存在' })
    return { productId: product.id, sources: await readSources(req.user.tenantId, product.id) }
  })

  app.put('/:productId', auth, async (req: any, reply: any) => {
    if (!WRITE_ROLES.has(req.user.role)) return reply.status(403).send({ error: '无权维护商品采购来源' })
    const parsedId = productIdSchema.safeParse(req.params.productId)
    if (!parsedId.success) return reply.status(400).send({ error: '商品 ID 格式不正确' })
    const parsed = productUpstreamSourcesBodySchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })

    const { tenantId, userId, role } = req.user
    const product = await prisma.product.findFirst({
      where: { id: parsedId.data, tenantId }, select: { id: true, code: true, name: true },
    })
    if (!product) return reply.status(404).send({ error: '商品不存在' })

    const supplierIds = parsed.data.sources.map(source => source.supplierId)
    const suppliers = supplierIds.length
      ? await prisma.supplier.findMany({
          where: {
            tenantId,
            id: { in: supplierIds },
            status: 'ENABLED',
            businessScopes: { has: 'WAREHOUSE_UPSTREAM' },
          },
          select: { id: true, name: true },
        })
      : []
    if (suppliers.length !== supplierIds.length) {
      return reply.status(400).send({ error: '采购来源只能选择本租户启用中的上游供应商' })
    }

    await prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`product-upstream:${tenantId}:${product.id}`}))`
      const before = await tx.productUpstreamSource.findMany({
        where: { tenantId, productId: product.id },
        select: { supplierId: true, isPrimary: true, purchaseUnit: true, inventoryUnitsPerPurchaseUnit: true, quotedUnitPrice: true, minOrderQty: true, leadTimeDays: true },
      })
      await tx.productUpstreamSource.deleteMany({ where: { tenantId, productId: product.id } })
      if (parsed.data.sources.length) {
        await tx.productUpstreamSource.createMany({
          data: parsed.data.sources.map(source => ({
            tenantId,
            productId: product.id,
            supplierId: source.supplierId,
            isPrimary: source.isPrimary,
            isActive: true,
            supplierSku: source.supplierSku || null,
            purchaseUnit: source.purchaseUnit,
            inventoryUnitsPerPurchaseUnit: source.inventoryUnitsPerPurchaseUnit,
            quotedUnitPrice: source.quotedUnitPrice ?? null,
            minOrderQty: source.minOrderQty,
            leadTimeDays: source.leadTimeDays,
            note: source.note || null,
          })),
        })
      }
      await tx.opLog.create({
        data: {
          tenantId, userId, role,
          action: `维护商品采购来源 ${product.name} (#${product.code})：${parsed.data.sources.length} 家`,
          entityType: 'ProductUpstreamSource', target: product.code, targetId: product.id,
          metadata: {
            before: before.map(item => ({ ...item, inventoryUnitsPerPurchaseUnit: String(item.inventoryUnitsPerPurchaseUnit), quotedUnitPrice: item.quotedUnitPrice === null ? null : String(item.quotedUnitPrice), minOrderQty: String(item.minOrderQty) })),
            after: parsed.data.sources,
          },
        },
      })
    })
    void invalidatePattern(`products:full:${tenantId}:*`)
    return { productId: product.id, sources: await readSources(tenantId, product.id) }
  })
}
