import { FastifyPluginAsync } from 'fastify'
import { prisma } from '@dianjie/db'
import { z } from 'zod'
import { isStoreScoped, isSupplierRole } from '../lib/auth-scope'
import { requireSupplierCapability } from '../lib/supplier-access'
import { withDocumentProductSnapshot } from '../lib/supply-document-snapshot'

const listQuerySchema = z.object({
  status: z.enum(['DRAFT', 'SHIPPED', 'DELIVERED', 'RECEIVED', 'CANCELLED']).optional(),
  storeId: z.string().optional(),
  supplierId: z.string().optional(),
  productId: z.string().optional(),
  keyword: z.string().trim().max(80).optional(),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
}).refine(q => !q.dateFrom || !q.dateTo || q.dateFrom <= q.dateTo, {
  message: '开始日期不能晚于结束日期',
  path: ['dateFrom'],
})

export const deliveryRoutes: FastifyPluginAsync = async app => {
  app.get('/', { preHandler: [(app as any).authenticate] }, async (req: any, reply) => {
    const parsed = listQuerySchema.safeParse(req.query || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const { tenantId, role, storeId: actorStoreId, supplierId: actorSupplierId } = req.user
    const q = parsed.data
    const where: any = { tenantId }
    if (isStoreScoped(role)) where.storeId = actorStoreId
    else if (q.storeId) where.storeId = q.storeId
    if (isSupplierRole(role)) where.supplierId = requireSupplierCapability(role, actorSupplierId, 'order.read')
    else if (q.supplierId) where.supplierId = q.supplierId
    if (q.status) where.status = q.status
    const and: any[] = []
    if (q.productId) and.push({ items: { some: { productId: q.productId } } })
    if (q.keyword) {
      and.push({
        OR: [
          { no: { contains: q.keyword, mode: 'insensitive' } },
          { purchaseOrder: { no: { contains: q.keyword, mode: 'insensitive' } } },
          { store: { name: { contains: q.keyword, mode: 'insensitive' } } },
          {
            items: {
              some: {
                product: {
                  OR: [
                    { name: { contains: q.keyword, mode: 'insensitive' } },
                    { code: { contains: q.keyword, mode: 'insensitive' } },
                    { spec: { contains: q.keyword, mode: 'insensitive' } },
                  ],
                },
              },
            },
          },
        ],
      })
    }
    if (and.length) where.AND = and
    if (q.dateFrom || q.dateTo) {
      where.createdAt = {
        ...(q.dateFrom ? { gte: new Date(`${q.dateFrom}T00:00:00+08:00`) } : {}),
        ...(q.dateTo ? { lte: new Date(`${q.dateTo}T23:59:59.999+08:00`) } : {}),
      }
    }
    const skip = (q.page - 1) * q.pageSize
    const [items, total] = await Promise.all([
      prisma.deliveryOrder.findMany({
        where, orderBy: { createdAt: 'desc' }, skip, take: q.pageSize,
        include: {
          purchaseOrder: { select: { id: true, no: true, status: true, originalTotalAmount: true, currentOrderAmount: true } },
          store: { select: { id: true, name: true } },
          supplier: { select: { id: true, name: true } },
          items: { include: { product: { select: { id: true, code: true, name: true, unit: true, spec: true } } } },
          receipt: { select: { id: true, no: true, totalAmount: true, status: true } },
        },
      }),
      prisma.deliveryOrder.count({ where }),
    ])
    return {
      items: items.map(delivery => ({
        ...delivery,
        items: delivery.items.map(withDocumentProductSnapshot),
      })),
      total, page: q.page, pageSize: q.pageSize,
    }
  })

  app.get('/:id', { preHandler: [(app as any).authenticate] }, async (req: any) => {
    const { tenantId, role, storeId, supplierId } = req.user
    const where: any = { id: req.params.id, tenantId }
    if (isStoreScoped(role)) where.storeId = storeId
    if (isSupplierRole(role)) where.supplierId = requireSupplierCapability(role, supplierId, 'order.read')
    const delivery = await prisma.deliveryOrder.findFirst({
      where,
      include: {
        purchaseOrder: { include: { items: { where: { isActive: true }, include: { product: true } } } },
        store: true, supplier: true,
        createdBy: { select: { id: true, name: true, role: true } },
        shippedBy: { select: { id: true, name: true } },
        deliveredBy: { select: { id: true, name: true } },
        receivedBy: { select: { id: true, name: true } },
        items: { include: { product: true } },
        events: { orderBy: { occurredAt: 'asc' }, include: { actor: { select: { id: true, name: true, role: true } } } },
        receipt: { include: { items: { include: { product: true } } } },
      },
    })
    if (!delivery) throw { statusCode: 404, message: '配送单不存在' }
    return {
      ...delivery,
      items: delivery.items.map(withDocumentProductSnapshot),
      receipt: delivery.receipt ? {
        ...delivery.receipt,
        items: delivery.receipt.items.map(withDocumentProductSnapshot),
      } : null,
    }
  })
}
