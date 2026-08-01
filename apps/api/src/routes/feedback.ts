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
 *   BUG_BLOCKING → AWAITING_APPROVAL+紧急企微 | IMPROVEMENT/NEW_FEATURE → AWAITING_APPROVAL+审批卡片
 *   QUESTION → CLOSED 闭环
 */
import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { prisma } from '@dianjie/db'
import { fireAndForget as notify } from '../services/notify'
import { sendNotification } from '../services/notification'
import { qwenChat, buildFeedbackSystemPrompt, QWEN_NOT_CONFIGURED, QwenChatMessage } from '../services/qwenChat'
import { fetchFeedbackImageParts } from '../services/feedbackImages'
import { parseTriageBlock, decideTriageAction, TriageResult } from '../services/feedbackTriage'
import { executeApprovedRun } from '../services/autofix/deployment'
import { enqueueAgentDev, runTier2Dev } from '../services/autofix/tier2'
import { resignOssUrls } from './upload'

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

/** 调 Qwen 并落库 AI 回复; 返回展示文本与分诊结果。attachments 有图时以多模态消息带图 */
async function askAssistant(
  tenantId: string,
  feedbackId: string,
  ctx: FeedbackCtx,
  history: Array<{ role: string; content: string }>,
  attachments?: unknown,
) {
  const imageParts = await fetchFeedbackImageParts(attachments)
  const historyMsgs: QwenChatMessage[] = history
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-18)
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))
  // 历史每轮从 DB 重建(纯文本), 图片每轮重新挂到首条用户消息, 保持多轮对话中视觉上下文不丢失
  const firstUser = historyMsgs.find((m) => m.role === 'user')
  if (imageParts.length && firstUser) {
    firstUser.content = [{ type: 'text', text: firstUser.content as string }, ...imageParts]
  }
  const messages: QwenChatMessage[] = [
    { role: 'system' as const, content: buildFeedbackSystemPrompt({ ...ctx, attachmentCount: imageParts.length || undefined }) },
    ...historyMsgs,
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
      d.attachments,
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
    const { assistantMsg, triage } = await askAssistant(actor.tenantId, feedback.id, ctx, history, feedback.attachments)

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
      summary: f.summary, proposal: f.proposal, attachments: resignOssUrls(f.attachments),
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
    return { ...feedback, attachments: resignOssUrls(feedback.attachments) }
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
            ? '管理员已批准该方案，正在创建开发任务，进展会在消息中心通知你。'
            : `管理员驳回了该反馈${note ? `：${note}` : '。'}如有疑问可重新提交补充说明。`,
        },
      })
      return { status: 200, ok: true, feedback }
    })
    if ('error' in result) return reply.status(result.status).send({ error: result.error })

    let autoRunId: string | null = null
    let automationStatus = action === 'approve' ? 'disabled' : 'not_requested'
    if (action === 'approve') {
      // 档2分支：该反馈已有自动修复任务且停在审批节点 → 按阶段推进，而不是重新入队
      const existingRun = await prisma.autoFixRun.findUnique({
        where: { feedbackId: result.feedback.id },
        select: { id: true, status: true },
      })
      if (existingRun && String(existingRun.status) === 'TASKBOOK_READY') {
        await prisma.autoFixRun.update({
          where: { id: existingRun.id },
          data: { status: 'QWEN_DEV' as any, decidedById: actor.userId, decidedAt: new Date(), error: null },
        })
        await prisma.feedbackMessage.create({
          data: {
            tenantId: actor.tenantId,
            feedbackId: result.feedback.id,
            role: 'system',
            content: '管理员已批准开发方案，服务器 AI 开始在隔离环境开发；完成并通过测试后会再请你批准上线。',
          },
        })
        setImmediate(() => void runTier2Dev(existingRun.id).catch((e) => console.error('[tier2] 开发执行异常:', e)))
        autoRunId = existingRun.id
        automationStatus = 'tier2_dev'
      } else if (existingRun && String(existingRun.status) === 'DEPLOY_REVIEW') {
        await prisma.autoFixRun.update({
          where: { id: existingRun.id },
          data: { status: 'DEPLOYING' as any, decidedById: actor.userId, decidedAt: new Date(), error: null },
        })
        await prisma.feedbackMessage.create({
          data: {
            tenantId: actor.tenantId,
            feedbackId: result.feedback.id,
            role: 'system',
            content: '管理员已批准上线，系统开始安全发布（含生产验证与自动回滚兜底）。',
          },
        })
        setImmediate(() => void executeApprovedRun(existingRun.id).catch((e) => console.error('[tier2] 发布执行异常:', e)))
        autoRunId = existingRun.id
        automationStatus = 'tier2_deploy'
      } else {
        try {
          // 统一 agent 管线：Qwen Code 自己定位/设计/开发/自测；approved_auto 下测试通过即自动上线。
          autoRunId = await enqueueAgentDev({
            tenantId: actor.tenantId,
            feedbackId: result.feedback.id,
            approvedById: actor.userId,
          })
          automationStatus = autoRunId ? 'agent_dev' : 'disabled'
          await prisma.feedbackMessage.create({
            data: {
              tenantId: actor.tenantId,
              feedbackId: result.feedback.id,
              role: 'system',
              content: autoRunId
                ? '管理员已批准，AI 开始自动设计方案、开发并运行全部测试；低风险改动测试通过后会自动安全上线，涉及安全红线的改动仍会转人工。'
                : '当前自动开发开关未启用，反馈已保留在开发中并转为人工跟进。',
            },
          })
        } catch (error: any) {
          automationStatus = 'queue_failed'
          const message = error?.message || String(error)
          console.error('[autofix] 批准后入队失败:', error)
          await prisma.$transaction([
            prisma.feedbackMessage.create({
              data: {
                tenantId: actor.tenantId,
                feedbackId: result.feedback.id,
                role: 'system',
                content: '自动开发任务创建失败，已保留审批结果并转人工处理，管理员会收到异常记录。',
              },
            }),
            prisma.opLog.create({
              data: {
                tenantId: actor.tenantId,
                userId: actor.userId,
                role: actor.role,
                action: `反馈批准后自动开发入队失败: ${message}`.slice(0, 500),
                entityType: 'Feedback',
                targetId: result.feedback.id,
                metadata: { automationStatus: 'queue_failed' } as any,
              },
            }),
          ])
        }
      }
    } else {
      // 驳回时同步终结停在审批节点的档2任务
      await prisma.autoFixRun.updateMany({
        where: {
          feedbackId: result.feedback.id,
          status: { in: ['TASKBOOK_READY', 'DEPLOY_REVIEW'] as any },
        },
        data: { status: 'REJECTED' as any, decidedById: actor.userId, decidedAt: new Date(), error: note || '管理员驳回' },
      })
    }

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
          ? (autoRunId ? '方案已批准，系统已开始自动开发和测试。' : '方案已批准，当前转人工开发跟进。')
          : `驳回理由: ${note || '无'}`,
        refType: 'Feedback',
        refId: feedback.id,
        dedupeKey: `FEEDBACK_RESULT:${feedback.id}:${action}`,
      })
    } catch (e) {
      console.error('[feedback] 决策通知写入失败:', e)
    }
    return { ok: true, autoRunId, automationStatus }
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
