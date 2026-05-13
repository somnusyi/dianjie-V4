import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { prisma } from '@dianjie/db'

const auth = (app: any) => ({ preHandler: [app.authenticate] })

// 写权限: FINANCE / ADMIN / SUPER_ADMIN (老板和财务都能改, 选项 1)
const WRITE_ROLES = new Set(['FINANCE', 'ADMIN', 'SUPER_ADMIN'])
// 读权限: 上面 + 工程部 (只能看自己负责的店)
const READ_ROLES = new Set(['FINANCE', 'ADMIN', 'SUPER_ADMIN', 'ENGINEERING'])

const CATEGORY_VALUES = ['CONTRACT','CONSTRUCTION','FIRE','HVAC','VENTILATION','EQUIPMENT','MARKETING','HR','OTHER'] as const

const rowSchema = z.object({
  category: z.enum(CATEGORY_VALUES),
  name:     z.string().trim().min(1).max(80),
  budget:         z.number().nullable().optional(),
  contractAmount: z.number().nullable().optional(),
  paidAmount:     z.number().nullable().optional(),
  approvalNo:     z.string().trim().max(120).nullable().optional(),
  note:           z.string().trim().max(300).nullable().optional(),
})

async function checkStoreAccess(tenantId: string, storeId: string, role: string, userId: string): Promise<{ ok: boolean; error?: string }> {
  const store: any = await prisma.store.findFirst({ where: { id: storeId, tenantId } })
  if (!store) return { ok: false, error: '门店不存在' }
  if (role === 'ENGINEERING' && store.engineerId !== userId) {
    return { ok: false, error: '只能看自己负责的店' }
  }
  return { ok: true }
}

export const budgetRoutes: FastifyPluginAsync = async (app) => {

  // 列表 (按 storeId)
  app.get('/', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!READ_ROLES.has(role)) return reply.status(403).send({ error: '无权限' })

    const { storeId } = req.query as any
    if (!storeId) return reply.status(400).send({ error: '缺少 storeId' })

    const access = await checkStoreAccess(tenantId, storeId, role, userId)
    if (!access.ok) return reply.status(403).send({ error: access.error })

    const items = await (prisma as any).storeOpeningBudget.findMany({
      where: { tenantId, storeId },
      orderBy: [{ rowOrder: 'asc' }, { createdAt: 'asc' }],
    })
    return items
  })

  // 汇总 (3 段总额 + 按类目拆)
  app.get('/summary', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!READ_ROLES.has(role)) return reply.status(403).send({ error: '无权限' })

    const { storeId } = req.query as any
    if (!storeId) return reply.status(400).send({ error: '缺少 storeId' })

    const access = await checkStoreAccess(tenantId, storeId, role, userId)
    if (!access.ok) return reply.status(403).send({ error: access.error })

    const items = await (prisma as any).storeOpeningBudget.findMany({
      where: { tenantId, storeId },
    })
    const sum = (xs: any[], k: string) => xs.reduce((s, x) => s + Number(x[k] || 0), 0)
    const totals = {
      budget: sum(items, 'budget'),
      contractAmount: sum(items, 'contractAmount'),
      paidAmount: sum(items, 'paidAmount'),
      rowCount: items.length,
    }
    const byCategory: Record<string, any> = {}
    for (const it of items) {
      const c = it.category
      if (!byCategory[c]) byCategory[c] = { category: c, budget: 0, contractAmount: 0, paidAmount: 0, count: 0 }
      byCategory[c].budget += Number(it.budget || 0)
      byCategory[c].contractAmount += Number(it.contractAmount || 0)
      byCategory[c].paidAmount += Number(it.paidAmount || 0)
      byCategory[c].count += 1
    }
    return { totals, byCategory: Object.values(byCategory) }
  })

  // 创建单行 (财务/老板手填)
  app.post('/', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!WRITE_ROLES.has(role)) return reply.status(403).send({ error: '无权限' })

    const body = z.object({ storeId: z.string() }).extend(rowSchema.shape).safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: body.error.issues[0].message })

    const access = await checkStoreAccess(tenantId, body.data.storeId, role, userId)
    if (!access.ok) return reply.status(404).send({ error: access.error })

    const max: any = await (prisma as any).storeOpeningBudget.findFirst({
      where: { tenantId, storeId: body.data.storeId },
      orderBy: { rowOrder: 'desc' },
      select: { rowOrder: true },
    })
    const created = await (prisma as any).storeOpeningBudget.create({
      data: {
        tenantId,
        storeId: body.data.storeId,
        category: body.data.category as any,
        name: body.data.name,
        budget: body.data.budget ?? null,
        contractAmount: body.data.contractAmount ?? null,
        paidAmount: body.data.paidAmount ?? null,
        approvalNo: body.data.approvalNo || null,
        note: body.data.note || null,
        rowOrder: ((max?.rowOrder || 0) + 1),
      },
    })
    return reply.status(201).send(created)
  })

  // 一键导入: 客户端解析好的 rows
  app.post('/import-rows', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!WRITE_ROLES.has(role)) return reply.status(403).send({ error: '无权限' })

    const body = z.object({
      storeId: z.string(),
      rows: z.array(rowSchema).min(1).max(500),
      replace: z.boolean().optional(),  // true = 先清空原有再插
    }).safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: body.error.issues[0].message })

    const access = await checkStoreAccess(tenantId, body.data.storeId, role, userId)
    if (!access.ok) return reply.status(404).send({ error: access.error })

    if (body.data.replace) {
      await (prisma as any).storeOpeningBudget.deleteMany({
        where: { tenantId, storeId: body.data.storeId },
      })
    }

    const max: any = await (prisma as any).storeOpeningBudget.findFirst({
      where: { tenantId, storeId: body.data.storeId },
      orderBy: { rowOrder: 'desc' },
      select: { rowOrder: true },
    })
    let nextOrder = (max?.rowOrder || 0) + 1

    const created = await (prisma as any).storeOpeningBudget.createMany({
      data: body.data.rows.map(r => ({
        tenantId,
        storeId: body.data.storeId,
        category: r.category,
        name: r.name,
        budget: r.budget ?? null,
        contractAmount: r.contractAmount ?? null,
        paidAmount: r.paidAmount ?? null,
        approvalNo: r.approvalNo || null,
        note: r.note || null,
        rowOrder: nextOrder++,
      })),
    })
    await prisma.opLog.create({
      data: { tenantId, userId, action: `导入建店预算 ${created.count} 行`, entityType: 'StoreOpeningBudget', targetId: body.data.storeId },
    })
    return reply.status(201).send({ count: created.count })
  })

  // 改单行
  app.patch('/:id', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!WRITE_ROLES.has(role)) return reply.status(403).send({ error: '无权限' })

    const body = z.object({
      category:       z.enum(CATEGORY_VALUES).optional(),
      name:           z.string().trim().min(1).max(80).optional(),
      budget:         z.number().nullable().optional(),
      contractAmount: z.number().nullable().optional(),
      paidAmount:     z.number().nullable().optional(),
      approvalNo:     z.string().trim().max(120).nullable().optional(),
      note:           z.string().trim().max(300).nullable().optional(),
      voucherUrl:     z.string().trim().nullable().optional(),
      rowOrder:       z.number().int().optional(),
    }).safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: body.error.issues[0].message })

    const exists: any = await (prisma as any).storeOpeningBudget.findFirst({ where: { id: req.params.id, tenantId } })
    if (!exists) return reply.status(404).send({ error: '行不存在' })

    const data: any = {}
    for (const [k, v] of Object.entries(body.data)) if (v !== undefined) data[k] = v

    const updated = await (prisma as any).storeOpeningBudget.update({
      where: { id: exists.id },
      data,
    })
    return updated
  })

  // 删
  app.delete('/:id', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!WRITE_ROLES.has(role)) return reply.status(403).send({ error: '无权限' })

    const exists: any = await (prisma as any).storeOpeningBudget.findFirst({ where: { id: req.params.id, tenantId } })
    if (!exists) return reply.status(404).send({ error: '行不存在' })

    await (prisma as any).storeOpeningBudget.delete({ where: { id: exists.id } })
    return { ok: true }
  })
}
