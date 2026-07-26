/**
 * 反馈系统 P0: 用户反馈 → AI (Qwen) 澄清分诊 → 管理员审批
 *
 * - POST   /api/feedback              创建反馈 (上下文快照+附件), 自动生成 AI 首轮澄清回复
 * - POST   /api/feedback/:id/messages 用户发言 → 同步调 Qwen → 存 AI 回复 → 返回
 * - GET    /api/feedback/mine         我提的列表
 * - GET    /api/feedback/admin/inbox  待批列表 (仅 SUPER_ADMIN)
 * - GET    /api/feedback/:id          详情含 messages (本人或 SUPER_ADMIN)
 * - POST   /api/feedback/:id/decision 批准/驳回 (仅 SUPER_ADMIN, 写 OpLog + 消息中心)
 * - POST   /api/feedback/:id/resolve  标记已解决 (仅 SUPER_ADMIN, 闭环 + 通知提报人)
 *
 * 分诊: AI 回复末尾的 triage 标记块由 feedbackTriage 解析 strip;
 *   BUG_BLOCKING → 紧急企微通知 (P0 人工处理) | IMPROVEMENT/NEW_FEATURE → AWAITING_APPROVAL+审批卡片
 *   QUESTION → CLOSED 闭环
 */
import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { prisma } from '@dianjie/db'
import { fireAndForget as notify } from '../services/notify'
import { sendNotification } from '../services/notification'
import { qwenChat, buildFeedbackSystemPrompt, QWEN_NOT_CONFIGURED } from '../services/qwenChat'
import { parseTriageBlock, decideTriageAction, TriageResult } from '../services/feedbackTriage'
import { enqueueAutoFix } from '../services/autofix/engine'

const auth = (app: any) => ({ preHandler: [app.authenticate] })
const ADMIN_ROLES = new Set(['SUPER_ADMIN'])

const contextSchema = z.object({
  path: z.string().trim().max(200).optional(),
  role: z.string().trim().max(40).optional(),
  storeName: z.string().trim().max(80).optional(),
  userAgent: z.string().trim().max(300).optional(),
  clientTime: z.string().trim().max(60).optional(),
}).strict()

const createSchema = z.object({
  content: z.string().trim().min(1, '请描述你遇到的问题或建议').max(2000),
  context: contextSchema.default({}),
  attachments: z.array(z.string().trim().url().max(500)).max(6).optional(),
}).strict()

const messageSchema = z.object({
  content: z.string().trim().min(1, '请输入内容').max(2000),
}).strict()

const decisionSchema = z.object({
  action: z.enum(['approve', 'reject'], { errorMap: () => ({ message: 'action 必须是 approve / reject' }) }),
  note: z.string().trim().max(300).optional(),
}).strict().refine(
  (d) => d.action !== 'reject' || !!d.note,
  { message: '驳回时请填写理由', path: ['note'] },
)

const resolveSchema = z.object({
  note: z.string().trim().max(300).optional(),
}).strict()

const inboxQuerySchema = z.object({
  status: z.enum(['CLARIFYING', 'AWAITING_APPROVAL', 'APPROVED', 'REJECTED', 'IN_DEV', 'RESOLVED', 'CLOSED'])
    .default('AWAITING_APPROVAL'),
}).strict()

type FeedbackCtx = z.infer<typeof contextSchema>

interface Actor { tenantId: string; userId: string; role: string; storeId?: string | null }

/** 越权防护: 只有提报人本人或 SUPER_ADMIN/ADMIN 能看/发消息 */
function canAccess(actor: Actor, reporterId: string): boolean {
  return actor.userId === reporterId || ADMIN_ROLES.has(actor.role)
}

/**
 * 分诊落库 + 通知 (BUG 紧急企微 / 审批卡片 / 消息中心进度)
 * 只在反馈仍处于 CLARIFYING 时调用 (已进入审批流后不再重复分诊)
 */
async function applyTriage(actor: Actor, feedback: { id: string; reporterId: string }, triage: TriageResult, ctx: FeedbackCtx) {
  const action = decideTriageAction(triage)
  const updated = await prisma.feedback.update({
    where: { id: feedback.id },
    data: {
      category: triage.category,
      title: triage.title || null,
      summary: triage.summary || null,
      proposal: triage.category === 'NEW_FEATURE' ? ((triage.proposal ?? undefined) as any) : undefined,
      status: action.status,
    },
  })
  if (action.systemNote) {
    await prisma.feedbackMessage.create({
      data: { tenantId: actor.tenantId, feedbackId: feedback.id, role: 'system', content: action.systemNote },
    })
  }

  const reporterName = ctx.storeName ? `${ctx.storeName}同事` : '同事'
  if (action.notifyEvent === 'FEEDBACK_URGENT_BUG') {
    notify({
      tenantId: actor.tenantId,
      event: 'FEEDBACK_URGENT_BUG',
      eventKey: `FEEDBACK:${feedback.id}:URGENT`,
      payload: {
        feedbackId: feedback.id,
        title: triage.title || '紧急故障',
        summary: triage.summary || '',
        reporterName, storeName: ctx.storeName,
      },
    })
    // P1a is fail-closed: AUTO_FIX_MODE defaults to off. In suggest mode the
    // durable run is created immediately, while AI analysis stays off the
    // feedback request's critical path.
    void enqueueAutoFix({
      tenantId: actor.tenantId,
      feedbackId: feedback.id,
    }).catch((error) => console.error('[autofix] 入队失败:', error))
  } else if (action.notifyEvent === 'FEEDBACK_APPROVAL_PENDING') {
    notify({
      tenantId: actor.tenantId,
      event: 'FEEDBACK_APPROVAL_PENDING',
      eventKey: `FEEDBACK:${feedback.id}:PENDING`,
      payload: {
        feedbackId: feedback.id,
        category: triage.category,
        title: triage.title || '反馈待审批',
        summary: triage.summary || '',
        reporterName, storeName: ctx.storeName,
      },
    })
  }

  // App 内消息中心: 提报人能看到进度
  if (action.systemNote) {
    try {
      const reporter = await prisma.user.findUnique({ where: { id: feedback.reporterId }, select: { role: true } })
      await sendNotification({
        tenantId: actor.tenantId,
        recipientRole: reporter?.role || 'MANAGER',
        recipientId: feedback.reporterId,
        type: 'FEEDBACK_PROGRESS',
        title: `反馈进展: ${triage.title || '已受理'}`,
        body: action.systemNote,
        refType: 'Feedback',
        refId: feedback.id,
      })
    } catch (e) {
      console.error('[feedback] 消息中心写入失败:', e)
    }
  }
  return updated
}

/** 调 Qwen 并落库 AI 回复; 返回展示文本与分诊结果 */
async function askAssistant(tenantId: string, feedbackId: string, ctx: FeedbackCtx, history: Array<{ role: string; content: string }>) {
  const messages = [
    { role: 'system' as const, content: buildFeedbackSystemPrompt(ctx) },
    ...history
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-18)
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
  ]
  const raw = await qwenChat(messages)
  const { clean, triage } = parseTriageBlock(raw)
  // 回复只有标记块 / 配置缺失时给一句人话兜底
  const display = clean || (raw === QWEN_NOT_CONFIGURED ? QWEN_NOT_CONFIGURED : '收到，你的反馈已记录。')
  const assistantMsg = await prisma.feedbackMessage.create({
    data: { tenantId, feedbackId, role: 'assistant', content: display },
  })
  return { assistantMsg, triage }
}

export const feedbackRoutes: FastifyPluginAsync = async (app) => {

  // ── 创建反馈 (快照+附件) + AI 首轮澄清 ─────────────────
  app.post('/', {
    ...auth(app),
    config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
  }, async (req: any, reply: any) => {
    const actor: Actor = req.user
    const parsed = createSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const d = parsed.data
    const ctx = { ...d.context, role: d.context.role || actor.role }

    const feedback = await prisma.feedback.create({
      data: {
        tenantId: actor.tenantId,
        reporterId: actor.userId,
        storeId: actor.storeId || null,
        context: ctx as any,
        attachments: d.attachments?.length ? (d.attachments as any) : undefined,
        messages: {
          create: { tenantId: actor.tenantId, role: 'user', content: d.content },
        },
      },
    })

    const { assistantMsg, triage } = await askAssistant(
      actor.tenantId, feedback.id, ctx,
      [{ role: 'user', content: d.content }],
    )
    let current = feedback
    if (triage) current = await applyTriage(actor, feedback, triage, ctx)

    return reply.status(201).send({
      id: feedback.id,
      status: current.status,
      category: current.category,
      reply: assistantMsg.content,
    })
  })

  // ── 用户发言 → 同步 AI 回复 ──────────────────────────
  app.post('/:id/messages', {
    ...auth(app),
    config: { rateLimit: { max: 30, timeWindow: '5 minutes' } },
  }, async (req: any, reply: any) => {
    const actor: Actor = req.user
    const parsed = messageSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })

    const feedback = await prisma.feedback.findFirst({
      where: { id: String(req.params.id), tenantId: actor.tenantId },
    })
    if (!feedback) return reply.status(404).send({ error: '反馈不存在' })
    if (!canAccess(actor, feedback.reporterId)) return reply.status(403).send({ error: '无权访问该反馈' })
    if (feedback.status === 'REJECTED' || feedback.status === 'RESOLVED') {
      return reply.status(400).send({ error: '该反馈已结束，如有新问题请重新提交' })
    }

    await prisma.feedbackMessage.create({
      data: { tenantId: actor.tenantId, feedbackId: feedback.id, role: 'user', content: parsed.data.content },
    })
    // CLOSED (问答闭环) 后用户继续追问 → 重新进入澄清
    if (feedback.status === 'CLOSED') {
      await prisma.feedback.update({ where: { id: feedback.id }, data: { status: 'CLARIFYING' } })
      feedback.status = 'CLARIFYING'
    }

    const history = await prisma.feedbackMessage.findMany({
      where: { feedbackId: feedback.id },
      orderBy: { createdAt: 'asc' },
      take: 40,
      select: { role: true, content: true },
    })
    const ctx = { ...(feedback.context as any as FeedbackCtx), role: actor.role }
    const { assistantMsg, triage } = await askAssistant(actor.tenantId, feedback.id, ctx, history)

    let current = feedback
    if (triage && feedback.status === 'CLARIFYING') {
      current = await applyTriage(actor, feedback, triage, ctx)
    }
    return {
      reply: assistantMsg.content,
      status: current.status,
      category: current.category,
      title: current.title,
    }
  })

  // ── 我提的列表 ───────────────────────────────────────
  app.get('/mine', auth(app), async (req: any) => {
    const actor: Actor = req.user
    return prisma.feedback.findMany({
      where: { tenantId: actor.tenantId, reporterId: actor.userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true, category: true, status: true, title: true, summary: true,
        createdAt: true, updatedAt: true,
        _count: { select: { messages: true } },
      },
    })
  })

  // ── 管理端待批列表 ───────────────────────────────────
  app.get('/admin/inbox', auth(app), async (req: any, reply: any) => {
    const actor: Actor = req.user
    if (!ADMIN_ROLES.has(actor.role)) return reply.status(403).send({ error: '无权限' })
    const parsed = inboxQuerySchema.safeParse(req.query || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })

    const list = await prisma.feedback.findMany({
      where: { tenantId: actor.tenantId, status: parsed.data.status },
      orderBy: { updatedAt: 'desc' },
      take: 100,
      include: { reporter: { select: { id: true, name: true, role: true } } },
    })
    return list.map((f) => ({
      id: f.id, category: f.category, status: f.status, title: f.title,
      summary: f.summary, proposal: f.proposal, attachments: f.attachments,
      createdAt: f.createdAt, updatedAt: f.updatedAt,
      reporter: f.reporter,
      storeName: (f.context as any)?.storeName || null,
    }))
  })

  // ── 详情 (含 messages) ───────────────────────────────
  app.get('/:id', auth(app), async (req: any, reply: any) => {
    const actor: Actor = req.user
    const feedback = await prisma.feedback.findFirst({
      where: { id: String(req.params.id), tenantId: actor.tenantId },
      include: {
        messages: { orderBy: { createdAt: 'asc' }, select: { id: true, role: true, content: true, createdAt: true } },
        reporter: { select: { id: true, name: true, role: true } },
      },
    })
    if (!feedback) return reply.status(404).send({ error: '反馈不存在' })
    if (!canAccess(actor, feedback.reporterId)) return reply.status(403).send({ error: '无权访问该反馈' })
    return feedback
  })

  // ── 批准 / 驳回 ─────────────────────────────────────
  app.post('/:id/decision', auth(app), async (req: any, reply: any) => {
    const actor: Actor = req.user
    if (!ADMIN_ROLES.has(actor.role)) return reply.status(403).send({ error: '无权限' })
    const parsed = decisionSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const { action, note } = parsed.data

    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`feedback:${String(req.params.id)}`}))::text AS locked`
      const feedback = await tx.feedback.findFirst({
        where: { id: String(req.params.id), tenantId: actor.tenantId },
      })
      if (!feedback) return { status: 404, error: '反馈不存在' }
      if (feedback.status !== 'AWAITING_APPROVAL') return { status: 400, error: '该反馈不在待审批状态' }

      const next = action === 'approve' ? 'IN_DEV' : 'REJECTED'
      await tx.feedback.update({
        where: { id: feedback.id },
        data: {
          status: next as any,
          decisionById: actor.userId,
          decisionAt: new Date(),
          decisionNote: note || null,
        },
      })
      await tx.opLog.create({
        data: {
          tenantId: actor.tenantId, userId: actor.userId, role: actor.role,
          action: `${action === 'approve' ? '批准' : '驳回'}反馈「${feedback.title || feedback.id}」${note ? `: ${note}` : ''}`,
          entityType: 'Feedback', targetId: feedback.id,
          metadata: { decision: action, category: feedback.category } as any,
        },
      })
      await tx.feedbackMessage.create({
        data: {
          tenantId: actor.tenantId, feedbackId: feedback.id, role: 'system',
          content: action === 'approve'
            ? '管理员已批准该方案，即将安排开发，进展会在消息中心通知你。'
            : `管理员驳回了该反馈${note ? `：${note}` : '。'}如有疑问可重新提交补充说明。`,
        },
      })
      return { status: 200, ok: true, feedback }
    })
    if ('error' in result) return reply.status(result.status).send({ error: result.error })

    // App 内消息中心通知提报人 (企微决策通知 P1 再接)
    try {
      const feedback = result.feedback
      const reporter = await prisma.user.findUnique({ where: { id: feedback.reporterId }, select: { role: true } })
      await sendNotification({
        tenantId: actor.tenantId,
        recipientRole: reporter?.role || 'MANAGER',
        recipientId: feedback.reporterId,
        type: 'FEEDBACK_RESULT',
        title: action === 'approve' ? `反馈已批准: ${feedback.title || ''}` : `反馈已驳回: ${feedback.title || ''}`,
        body: action === 'approve'
          ? '方案已批准，即将安排开发。'
          : `驳回理由: ${note || '无'}`,
        refType: 'Feedback',
        refId: feedback.id,
        dedupeKey: `FEEDBACK_RESULT:${feedback.id}:${action}`,
      })
    } catch (e) {
      console.error('[feedback] 决策通知写入失败:', e)
    }
    return { ok: true }
  })

  // ── 标记已解决 (仅 SUPER_ADMIN, 闭环 + 通知提报人) ─────
  app.post('/:id/resolve', auth(app), async (req: any, reply: any) => {
    const actor: Actor = req.user
    if (!ADMIN_ROLES.has(actor.role)) return reply.status(403).send({ error: '无权限' })
    const parsed = resolveSchema.safeParse(req.body ?? {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const { note } = parsed.data

    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`feedback:${String(req.params.id)}`}))::text AS locked`
      const feedback = await tx.feedback.findFirst({
        where: { id: String(req.params.id), tenantId: actor.tenantId },
      })
      if (!feedback) return { status: 404, error: '反馈不存在' }
      if (!['CLARIFYING', 'AWAITING_APPROVAL', 'APPROVED', 'IN_DEV'].includes(feedback.status)) {
        return { status: 400, error: '该反馈当前状态无法标记已解决' }
      }
      await tx.feedback.update({ where: { id: feedback.id }, data: { status: 'RESOLVED' } })
      await tx.feedbackMessage.create({
        data: {
          tenantId: actor.tenantId, feedbackId: feedback.id, role: 'assistant',
          content: note?.trim() || '该问题已处理完成，标记为已解决。如仍有问题请继续留言或重新提交。',
        },
      })
      await tx.opLog.create({
        data: {
          tenantId: actor.tenantId, userId: actor.userId, role: actor.role,
          action: `标记反馈「${feedback.title || feedback.id}」已解决${note ? `: ${note}` : ''}`,
          entityType: 'Feedback', targetId: feedback.id,
          metadata: { resolve: true, category: feedback.category } as any,
        },
      })
      return { status: 200, ok: true, feedback }
    })
    if ('error' in result) return reply.status(result.status).send({ error: result.error })

    try {
      const feedback = result.feedback
      const reporter = await prisma.user.findUnique({ where: { id: feedback.reporterId }, select: { role: true } })
      await sendNotification({
        tenantId: actor.tenantId,
        recipientRole: reporter?.role || 'MANAGER',
        recipientId: feedback.reporterId,
        type: 'FEEDBACK_RESULT',
        title: `反馈已解决: ${feedback.title || ''}`,
        body: note?.trim() || '问题已处理完成，如仍有问题可继续留言。',
        refType: 'Feedback',
        refId: feedback.id,
        dedupeKey: `FEEDBACK_RESULT:${feedback.id}:resolved`,
      })
    } catch (e) {
      console.error('[feedback] 解决通知写入失败:', e)
    }
    return { ok: true }
  })
}
