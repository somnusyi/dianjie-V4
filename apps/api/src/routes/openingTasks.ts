import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { prisma } from '@dianjie/db'

const auth = (app: any) => ({ preHandler: [app.authenticate] })

const ENGINEER_ROLES = new Set(['ENGINEERING','ADMIN','SUPER_ADMIN'])

// 通用 30 项默认任务模板 (按 SOP 排序)
const DEFAULT_TEMPLATE: Array<{ category: string; name: string; priority: number }> = [
  // 商务
  { category: 'BUSINESS',     name: '选址勘察 / 商圈调研',           priority: 100 },
  { category: 'BUSINESS',     name: '物业 / 房东初次接洽',            priority: 99 },
  { category: 'BUSINESS',     name: '租约谈判定稿',                     priority: 98 },
  { category: 'BUSINESS',     name: '签订租约 / 押金支付',              priority: 97 },
  { category: 'BUSINESS',     name: '物业进场对接 (报建/施工时间窗)',   priority: 96 },
  // 装修
  { category: 'CONSTRUCTION', name: '设计公司选定 / 出效果图',          priority: 80 },
  { category: 'CONSTRUCTION', name: '施工图 / 拆改方案确认',            priority: 79 },
  { category: 'CONSTRUCTION', name: '装修队选定 / 合同',                  priority: 78 },
  { category: 'CONSTRUCTION', name: '拆改工程',                            priority: 77 },
  { category: 'CONSTRUCTION', name: '水电改造',                            priority: 76 },
  { category: 'CONSTRUCTION', name: '木工工程',                            priority: 75 },
  { category: 'CONSTRUCTION', name: '油漆 / 涂装',                          priority: 74 },
  { category: 'CONSTRUCTION', name: '收尾 / 业主验收',                    priority: 73 },
  // 设备/物料
  { category: 'EQUIPMENT',    name: '厨房设备清单 + 报价',                priority: 60 },
  { category: 'EQUIPMENT',    name: '厨房设备到货 / 安装',                 priority: 59 },
  { category: 'EQUIPMENT',    name: '餐桌椅 / 餐具到位',                   priority: 58 },
  { category: 'EQUIPMENT',    name: 'POS / 收银设备 / 监控',               priority: 57 },
  { category: 'EQUIPMENT',    name: 'WiFi / 网络部署',                     priority: 56 },
  { category: 'EQUIPMENT',    name: '招牌 / 灯箱制作 + 安装',              priority: 55 },
  // 证照
  { category: 'LICENSING',    name: '营业执照',                            priority: 40 },
  { category: 'LICENSING',    name: '食品经营许可证',                       priority: 39 },
  { category: 'LICENSING',    name: '消防验收',                             priority: 38 },
  { category: 'LICENSING',    name: '燃气接入',                             priority: 37 },
  { category: 'LICENSING',    name: '排污 / 给排水手续',                   priority: 36 },
  // 筹备
  { category: 'PREPARATION',  name: '开荒清洁',                             priority: 20 },
  { category: 'PREPARATION',  name: '员工培训对接 (集团 + 单店)',          priority: 19 },
  { category: 'PREPARATION',  name: '物料首批进货',                          priority: 18 },
  { category: 'PREPARATION',  name: '试营业方案 / 营销物料',                priority: 17 },
  { category: 'PREPARATION',  name: '试营业',                                 priority: 16 },
  { category: 'PREPARATION',  name: '正式开业 / 验收上线',                  priority: 15 },
]

const taskCreateSchema = z.object({
  storeId:    z.string(),
  category:   z.enum(['BUSINESS','CONSTRUCTION','EQUIPMENT','LICENSING','PREPARATION']),
  name:       z.string().trim().min(1).max(60),
  description: z.string().trim().max(500).optional(),
  assigneeId: z.string().optional(),
  dueDate:    z.string().datetime({ offset: true }).optional(),
  priority:   z.number().int().optional(),
  cost:       z.number().optional(),
})

const taskPatchSchema = z.object({
  name:        z.string().trim().min(1).max(60).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  assigneeId:  z.string().nullable().optional(),
  dueDate:     z.string().datetime({ offset: true }).nullable().optional(),
  priority:    z.number().int().optional(),
  status:      z.enum(['TODO','IN_PROGRESS','BLOCKED','DONE','CANCELED']).optional(),
  cost:        z.number().nullable().optional(),
  blockerNote: z.string().trim().max(500).nullable().optional(),
})

export const openingTaskRoutes: FastifyPluginAsync = async (app) => {

  // 列表 (按 store 或 assignee 过滤)
  app.get('/', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!ENGINEER_ROLES.has(role)) return reply.status(403).send({ error: '无权限' })

    const { storeId, assignee, status } = req.query as any
    const where: any = { tenantId }
    if (storeId) where.storeId = storeId
    if (status) where.status = status
    // 工程部只能看自己负责店的任务 (或 assignee=自己)
    if (role === 'ENGINEERING') {
      const myStores = await prisma.store.findMany({
        where: { tenantId, engineerId: userId },
        select: { id: true },
      })
      where.storeId = { in: myStores.map(s => s.id) }
    }
    if (assignee === 'me') where.assigneeId = userId

    const tasks = await (prisma as any).openingTask.findMany({
      where,
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    })
    return tasks
  })

  // 创建
  app.post('/', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!ENGINEER_ROLES.has(role)) return reply.status(403).send({ error: '无权限' })

    const parsed = taskCreateSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })

    const store: any = await prisma.store.findFirst({ where: { id: parsed.data.storeId, tenantId } })
    if (!store) return reply.status(404).send({ error: '门店不存在' })
    if (role === 'ENGINEERING' && store.engineerId !== userId) {
      return reply.status(403).send({ error: '只能在自己负责的店建任务' })
    }

    const task = await (prisma as any).openingTask.create({
      data: {
        tenantId,
        storeId: parsed.data.storeId,
        category: parsed.data.category,
        name: parsed.data.name,
        description: parsed.data.description || null,
        assigneeId: parsed.data.assigneeId || store.engineerId || userId,
        dueDate: parsed.data.dueDate ? new Date(parsed.data.dueDate) : null,
        priority: parsed.data.priority ?? 0,
        cost: parsed.data.cost != null ? parsed.data.cost : null,
      },
    })
    return reply.status(201).send(task)
  })

  // 更新 (含状态切换)
  app.patch('/:id', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!ENGINEER_ROLES.has(role)) return reply.status(403).send({ error: '无权限' })

    const parsed = taskPatchSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })

    const task: any = await (prisma as any).openingTask.findFirst({ where: { id: req.params.id, tenantId } })
    if (!task) return reply.status(404).send({ error: '任务不存在' })
    if (role === 'ENGINEERING') {
      const store: any = await prisma.store.findFirst({ where: { id: task.storeId, tenantId } })
      if (!store || store.engineerId !== userId) return reply.status(403).send({ error: '只能改自己负责店的任务' })
    }

    const data: any = {}
    for (const k of ['name','description','priority','blockerNote','cost']) {
      if (parsed.data[k as keyof typeof parsed.data] !== undefined) data[k] = parsed.data[k as keyof typeof parsed.data]
    }
    if (parsed.data.assigneeId !== undefined) data.assigneeId = parsed.data.assigneeId
    if (parsed.data.dueDate !== undefined) data.dueDate = parsed.data.dueDate ? new Date(parsed.data.dueDate) : null
    if (parsed.data.status !== undefined) {
      data.status = parsed.data.status
      if (parsed.data.status === 'DONE') {
        data.completedAt = new Date()
        data.completedById = userId
      }
    }

    const updated = await (prisma as any).openingTask.update({
      where: { id: task.id },
      data,
    })
    return updated
  })

  // 删除
  app.delete('/:id', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!ENGINEER_ROLES.has(role)) return reply.status(403).send({ error: '无权限' })

    const task: any = await (prisma as any).openingTask.findFirst({ where: { id: req.params.id, tenantId } })
    if (!task) return reply.status(404).send({ error: '任务不存在' })
    if (role === 'ENGINEERING') {
      const store: any = await prisma.store.findFirst({ where: { id: task.storeId, tenantId } })
      if (!store || store.engineerId !== userId) return reply.status(403).send({ error: '只能删自己负责店的任务' })
    }
    await (prisma as any).openingTask.delete({ where: { id: task.id } })
    return { ok: true }
  })

  // 用模板初始化某门店任务 (仅在 store 没任务时, 或老板可强制)
  app.post('/seed-template/:storeId', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!ENGINEER_ROLES.has(role)) return reply.status(403).send({ error: '无权限' })

    const store: any = await prisma.store.findFirst({ where: { id: req.params.storeId, tenantId } })
    if (!store) return reply.status(404).send({ error: '门店不存在' })
    if (role === 'ENGINEERING' && store.engineerId !== userId) {
      return reply.status(403).send({ error: '只能在自己负责的店初始化任务' })
    }

    const existing = await (prisma as any).openingTask.count({ where: { tenantId, storeId: store.id } })
    if (existing > 0) return reply.status(400).send({ error: '该店已有任务, 不要重复初始化' })

    const created = await (prisma as any).openingTask.createMany({
      data: DEFAULT_TEMPLATE.map(t => ({
        tenantId,
        storeId: store.id,
        category: t.category,
        name: t.name,
        priority: t.priority,
        assigneeId: store.engineerId || userId,
      })),
    })
    return reply.status(201).send({ count: created.count })
  })

  // 单店进度汇总
  app.get('/progress/:storeId', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!ENGINEER_ROLES.has(role)) return reply.status(403).send({ error: '无权限' })
    const store: any = await prisma.store.findFirst({ where: { id: req.params.storeId, tenantId } })
    if (!store) return reply.status(404).send({ error: '门店不存在' })
    if (role === 'ENGINEERING' && store.engineerId !== userId) {
      return reply.status(403).send({ error: '只能看自己负责店' })
    }
    const tasks = await (prisma as any).openingTask.findMany({
      where: { tenantId, storeId: store.id },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    })
    const total = tasks.length
    const done = tasks.filter((t: any) => t.status === 'DONE').length
    const blocked = tasks.filter((t: any) => t.status === 'BLOCKED').length
    return {
      store: { id: store.id, no: store.no, name: store.name, lifecyclePhase: store.lifecyclePhase, expectedOpenAt: store.expectedOpenAt, engineerId: store.engineerId },
      summary: { total, done, blocked, percent: total ? Math.round(done * 100 / total) : 0 },
      tasks,
    }
  })
}
