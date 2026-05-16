/**
 * 凭证模板 HTTP 路由
 * 仅 FINANCE / ADMIN / SUPER_ADMIN
 */
import { FastifyPluginAsync } from 'fastify'
import { prisma } from '@dianjie/db'
import { z } from 'zod'
import { runDueTemplates } from '../services/voucher/templates'

const FINANCE_ROLES = ['FINANCE', 'ADMIN', 'SUPER_ADMIN']
const auth = (app: any) => ({ preHandler: [app.authenticate] })

const entrySchema = z.object({
  accountCode: z.string().min(1),
  accountName: z.string().min(1),
  debit: z.number().nonnegative().optional().default(0),
  credit: z.number().nonnegative().optional().default(0),
  summary: z.string().optional(),
})

const templateSchema = z.object({
  name: z.string().min(1).max(40),
  description: z.string().optional(),
  dayOfMonth: z.number().int().min(1).max(28),
  summary: z.string().min(1),
  entries: z.array(entrySchema).min(2),
  enabled: z.boolean().optional().default(true),
})

export const voucherTemplateRoutes: FastifyPluginAsync = async (app) => {

  app.get('/', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!FINANCE_ROLES.includes(role)) return reply.status(403).send({ error: '无权' })
    const items = await prisma.voucherTemplate.findMany({
      where: { tenantId },
      orderBy: [{ enabled: 'desc' }, { dayOfMonth: 'asc' }],
    })
    return items
  })

  app.post('/', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, role } = req.user
    if (!FINANCE_ROLES.includes(role)) return reply.status(403).send({ error: '无权' })
    const parsed = templateSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message })
    // 借贷平校验
    const sumD = parsed.data.entries.reduce((s, e) => s + Number(e.debit || 0), 0)
    const sumC = parsed.data.entries.reduce((s, e) => s + Number(e.credit || 0), 0)
    if (Math.abs(sumD - sumC) > 0.01) {
      return reply.status(400).send({ error: `借贷不平 (借 ¥${sumD.toFixed(2)} / 贷 ¥${sumC.toFixed(2)})` })
    }
    const t = await prisma.voucherTemplate.create({
      data: {
        tenantId, name: parsed.data.name, description: parsed.data.description,
        dayOfMonth: parsed.data.dayOfMonth,
        summary: parsed.data.summary,
        entriesJson: parsed.data.entries as any,
        enabled: parsed.data.enabled,
        createdById: userId,
      },
    })
    return reply.status(201).send(t)
  })

  app.put('/:id', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!FINANCE_ROLES.includes(role)) return reply.status(403).send({ error: '无权' })
    const parsed = templateSchema.partial().safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message })
    const data: any = { ...parsed.data }
    if (parsed.data.entries) data.entriesJson = parsed.data.entries
    delete data.entries
    const r = await prisma.voucherTemplate.updateMany({
      where: { id: req.params.id, tenantId },
      data,
    })
    if (r.count === 0) return reply.status(404).send({ error: '模板不存在' })
    return prisma.voucherTemplate.findUnique({ where: { id: req.params.id } })
  })

  app.delete('/:id', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!FINANCE_ROLES.includes(role)) return reply.status(403).send({ error: '无权' })
    const r = await prisma.voucherTemplate.deleteMany({ where: { id: req.params.id, tenantId } })
    if (r.count === 0) return reply.status(404).send({ error: '模板不存在' })
    return { ok: true }
  })

  // 手动触发: 立即跑一遍当前模板, 生成本月的凭证 (用于补跑或测试)
  app.post('/run-now', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!FINANCE_ROLES.includes(role)) return reply.status(403).send({ error: '无权' })
    const result = await runDueTemplates(tenantId)
    return result
  })
}
