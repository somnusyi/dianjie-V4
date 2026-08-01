/**
 * 超管 AI 助手聊天: 老板在手机上直接指挥服务器 AI (Qwen Code) 开发
 *
 * - GET  /api/boss-chat/messages       我的聊天记录 (最近 50 条, 附关联任务状态)
 * - POST /api/boss-chat/messages       下达指令 → 立即开工 (QWEN_DEV), 回复异步到达
 * - POST /api/boss-chat/deploy/:runId  批准上线 → 安全发布 (含生产验证与回滚兜底)
 *
 * 仅 SUPER_ADMIN。开发范围与反馈自动修复同一套硬约束:
 * 只允许 apps/web 内改动, 禁区 (认证/权限/资金/库存/schema/依赖) 由 agent 拒绝 + diff 白名单双重把关。
 */
import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { prisma } from '@dianjie/db'
import { executeApprovedRun } from '../services/autofix/deployment'
import { isApprovedAutoMode, isAutoDeploymentEnabled } from '../services/autofix/policy'
import { enqueueBossChatDev } from '../services/autofix/tier2'

const auth = (app: any) => ({ preHandler: [app.authenticate] })

const messageSchema = z.object({
  content: z.string().trim().min(1, '请输入指令内容').max(2000),
}).strict()

interface Actor { tenantId: string; userId: string; role: string }

function requireSuperAdmin(actor: Actor): string | null {
  return actor.role === 'SUPER_ADMIN' ? null : '仅超级管理员可使用 AI 助手'
}

export const bossChatRoutes: FastifyPluginAsync = async (app) => {

  // ── 聊天记录 (附任务状态, 前端据此显示「批准部署」按钮) ──
  app.get('/messages', auth(app), async (req: any, reply: any) => {
    const actor: Actor = req.user
    const denied = requireSuperAdmin(actor)
    if (denied) return reply.status(403).send({ error: denied })

    const messages = await prisma.bossChatMessage.findMany({
      where: { tenantId: actor.tenantId, userId: actor.userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    })
    const runIds = [...new Set(messages.map((m) => m.runId).filter(Boolean))] as string[]
    const runs = runIds.length
      ? await prisma.autoFixRun.findMany({
          where: { id: { in: runIds }, tenantId: actor.tenantId },
          select: { id: true, status: true, planSummary: true, error: true },
        })
      : []
    const runMap = new Map(runs.map((r) => [r.id, r]))

    return reply.send({
      messages: messages.reverse().map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        runId: m.runId,
        runStatus: m.runId ? runMap.get(m.runId)?.status ?? null : null,
        createdAt: m.createdAt,
      })),
    })
  })

  // ── 下达指令: 存消息 + 立即开工, 回复异步写入 ──
  app.post('/messages', {
    ...auth(app),
    config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
  }, async (req: any, reply: any) => {
    const actor: Actor = req.user
    const denied = requireSuperAdmin(actor)
    if (denied) return reply.status(403).send({ error: denied })

    const parsed = messageSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })

    const userMsg = await prisma.bossChatMessage.create({
      data: {
        tenantId: actor.tenantId,
        userId: actor.userId,
        role: 'user',
        content: parsed.data.content,
      },
    })
    const autoDeploy = isApprovedAutoMode() && isAutoDeploymentEnabled()
    const ack = await prisma.bossChatMessage.create({
      data: {
        tenantId: actor.tenantId,
        userId: actor.userId,
        role: 'system',
        content: autoDeploy
          ? '收到，AI 已开始定位和开发；独立测试通过后会自动安全上线，失败会自动回滚。'
          : '收到，AI 已开始定位和开发，完成并通过测试后会回复你审批上线。',
      },
    })
    const runId = await enqueueBossChatDev({
      tenantId: actor.tenantId,
      userId: actor.userId,
      content: parsed.data.content,
    })
    return reply.status(201).send({
      id: userMsg.id,
      runId,
      ack: { id: ack.id, content: ack.content },
    })
  })

  // ── 批准上线: 校验任务归属与状态后安全发布 ──
  app.post('/deploy/:runId', auth(app), async (req: any, reply: any) => {
    const actor: Actor = req.user
    const denied = requireSuperAdmin(actor)
    if (denied) return reply.status(403).send({ error: denied })

    const run = await prisma.autoFixRun.findFirst({
      where: { id: String(req.params.runId), tenantId: actor.tenantId },
      select: { id: true, status: true, feedbackId: true },
    })
    if (!run) return reply.status(404).send({ error: '任务不存在' })
    if (run.feedbackId) return reply.status(400).send({ error: '反馈任务请在反馈审批里部署' })
    if (String(run.status) !== 'DEPLOY_REVIEW') {
      return reply.status(409).send({ error: `当前状态 ${run.status} 不可部署` })
    }

    await prisma.autoFixRun.update({
      where: { id: run.id },
      data: { status: 'DEPLOYING' as any, decidedById: actor.userId, decidedAt: new Date(), error: null },
    })
    await prisma.bossChatMessage.create({
      data: {
        tenantId: actor.tenantId,
        userId: actor.userId,
        role: 'system',
        runId: run.id,
        content: '已批准上线，系统开始安全发布（含生产验证与自动回滚兜底）。',
      },
    })
    setImmediate(() => void executeApprovedRun(run.id).catch((e) => console.error('[boss-chat] 发布执行异常:', e)))
    return reply.send({ ok: true, runId: run.id, status: 'DEPLOYING' })
  })
}
