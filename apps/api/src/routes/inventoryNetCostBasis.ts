import { FastifyPluginAsync } from 'fastify'
import { Prisma, prisma } from '@dianjie/db'
import { z } from 'zod'
import { confirmInventoryNetCostBasis, inventoryNetCostBasisContext } from '../services/inventoryNetCostBasis'

const id = z.string().trim().min(1).max(100)
const amount = z.string().trim().regex(/^-?\d{1,16}(?:\.\d{1,4})?$/, '请输入最多四位小数的金额')
const query = z.object({ warehouseId: id, productId: id, page: z.coerce.number().int().min(1).default(1) })
const confirmation = z.object({
  requestKey: z.string().min(1).max(120), expectedVersion: z.number().int().min(0),
  basisType: z.enum(['NET_DOCUMENT', 'ALREADY_NET', 'POOL_DOCUMENT']),
  netValueDelta: amount.optional(), poolNetValueAfter: amount.optional(),
  expectedPostingSequence: z.number().int().min(0).optional(),
  evidenceRefs: z.array(z.string().trim().min(1).max(240)).min(1).max(20), note: z.string().trim().max(500).default(''),
}).strict()
const allowed = (role: string) => ['SUPPLY_CHAIN', 'ADMIN', 'SUPER_ADMIN'].includes(role)

/** Append-only evidence confirmation, separate from original quantity/value posting. */
export const inventoryNetCostBasisRoutes: FastifyPluginAsync = async app => {
  const guard = [(app as any).authenticate]
  app.get('/cost-basis/movements', { preHandler: guard }, async (req: any, reply) => {
    if (!req.user?.tenantId || !allowed(req.user.role)) return reply.code(403).send({ error: '仅供应链或管理员可查看成本核定材料' })
    const q = query.safeParse(req.query)
    if (!q.success) return reply.code(400).send({ error: '请选择仓库和商品' })
    const where = { tenantId: req.user.tenantId, warehouseId: q.data.warehouseId, productId: q.data.productId }
    return prisma.$transaction(async tx => {
      const [total, rows] = await Promise.all([
        tx.warehouseLedgerMovement.count({ where }),
        tx.warehouseLedgerMovement.findMany({ where, orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }], skip: (q.data.page - 1) * 30, take: 30,
          include: { netCostBasisConfirmations: { orderBy: { version: 'desc' }, take: 1 }, product: { select: { name: true, code: true } } } }),
      ])
      return { total, page: q.data.page, pageSize: 30, rows: rows.map(m => ({ id: m.id, product: m.product,
        sourceType: m.sourceType, sourceId: m.sourceId, effectiveAt: m.effectiveAt, quantity: m.physicalDelta.toString(),
        amount: m.valueDelta.toString(), quantityAfter: m.physicalAfter.toString(), amountAfter: m.valueAfter.toString(),
        unit: m.inventoryUnit, postingSequence: m.postingSequence, confirmation: m.netCostBasisConfirmations[0] ?? null })) }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead })
  })
  app.get('/cost-basis/:movementId', { preHandler: guard }, async (req: any, reply) => {
    if (!req.user?.tenantId || !allowed(req.user.role)) return reply.code(403).send({ error: '无权核定库存成本' })
    const key = id.safeParse(req.params.movementId)
    if (!key.success) return reply.code(400).send({ error: '库存流水编号无效' })
    return prisma.$transaction(tx => inventoryNetCostBasisContext(tx, req.user.tenantId, key.data), { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead })
  })
  app.post('/cost-basis/:movementId', { preHandler: guard }, async (req: any, reply) => {
    if (!req.user?.tenantId || !allowed(req.user.role)) return reply.code(403).send({ error: '仅供应链或管理员可核定库存成本' })
    const key = id.safeParse(req.params.movementId), input = confirmation.safeParse(req.body)
    if (!key.success || !input.success) return reply.code(400).send({ error: !input.success ? input.error.issues[0].message : '库存流水编号无效' })
    // The service locks the source and pool and checks the expected material version; errors roll back all evidence changes.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await prisma.$transaction(async tx => {
          const material = input.data
          return confirmInventoryNetCostBasis(tx, { ...material, tenantId: req.user.tenantId, movementId: key.data, userId: req.user.userId })
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
        return reply.code(result.replayed ? 200 : 201).send(result)
      } catch (error: any) {
        if (error?.code === 'P2034' && attempt < 2) continue
        if (['P2034', 'P2002'].includes(error?.code)) return reply.code(409).send({ error: '成本材料正在处理或版本已变化，请刷新后重试' })
        if (Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode < 500) return reply.code(error.statusCode).send({ error: error.message })
        req.log.error({ code: 'COST_BASIS_SAVE_FAILED' }, 'Cost basis confirmation failed')
        return reply.code(500).send({ error: '成本材料暂未保存，请稍后重试' })
      }
    }
  })
}
