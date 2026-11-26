/**
 * 用户反馈：提交、AI 澄清、本人查看与补充。反馈审批已移除。
 *
 * - POST   /api/feedback              创建反馈后立即返回, 后台生成 AI 首轮澄清回复
 * - POST   /api/feedback/:id/messages 用户发言落库后立即返回, 后台生成 AI 回复
 * - GET    /api/feedback/mine         我提的列表
 * - GET    /api/feedback/:id          详情含 messages (本人或 SUPER_ADMIN)
 *
 * 分诊: AI 回复末尾的 triage 标记块由 feedbackTriage 解析 strip;
 *   BUG_BLOCKING → 保留记录并紧急提醒人工处理；改进和需求继续留在反馈记录中
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

type FeedbackCtx = z.infer<typeof contextSchema>

interface Actor { tenantId: string; userId: string; role: string; storeId?: string | null }

/** 只有提报人本人或原有超级管理员能看、补充反馈。 */
function canAccess(actor: Actor, reporterId: string): boolean {
  return actor.userId === reporterId || ADMIN_ROLES.has(actor.role)
}

/**
 * 分诊落库 + 紧急故障提醒；不生成反馈审批任务。
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
  // Feedback is an interactive path. One bounded attempt is enough; the user
  // has already received an acceptance response and must never wait behind AI.
  const raw = await qwenChat(messages, {
    timeoutMs: Number(process.env.FEEDBACK_AI_TIMEOUT_MS) || 75_000,
    maxAttempts: 1,
  })
  const { clean, triage } = parseTriageBlock(raw)
  // 回复只有标记块 / 配置缺失时给一句人话兜底
  const display = clean || (raw === QWEN_NOT_CONFIGURED ? QWEN_NOT_CONFIGURED : '收到，你的反馈已记录。')
  const assistantMsg = await prisma.feedbackMessage.create({
    data: { tenantId, feedbackId, role: 'assistant', content: display },
  })
  return { assistantMsg, triage }
}

const assistantJobs = new Map<string, Promise<void>>()

async function processAssistantJob(actor: Actor, feedbackId: string) {
  const feedback = await prisma.feedback.findFirst({
    where: { id: feedbackId, tenantId: actor.tenantId },
  })
  if (!feedback || ['REJECTED', 'RESOLVED'].includes(feedback.status)) return

  const history = await prisma.feedbackMessage.findMany({
    where: { feedbackId },
    orderBy: { createdAt: 'asc' },
    take: 40,
    select: { role: true, content: true },
  })
  const ctx = { ...(feedback.context as any as FeedbackCtx), role: actor.role }
  const { triage } = await askAssistant(actor.tenantId, feedbackId, ctx, history, feedback.attachments)

  const latest = await prisma.feedback.findUnique({
    where: { id: feedbackId },
    select: { status: true, reporterId: true },
  })
  if (triage && latest?.status === 'CLARIFYING') {
    await applyTriage(actor, { id: feedbackId, reporterId: latest.reporterId }, triage, ctx)
  }
}

/**
 * Serialize AI work per feedback without holding the HTTP request open.
 * The database write is the durable acceptance point; if AI is unavailable,
 * users still see the feedback and can continue the conversation.
 */
function enqueueAssistant(actor: Actor, feedbackId: string) {
  const previous = assistantJobs.get(feedbackId) ?? Promise.resolve()
  const job = previous
    .catch(() => undefined)
    .then(() => processAssistantJob(actor, feedbackId))
    .catch(async (error) => {
      console.error('[feedback] 后台 AI 整理失败:', error)
      await prisma.feedbackMessage.create({
        data: {
          tenantId: actor.tenantId,
          feedbackId,
          role: 'assistant',
          content: '你的反馈已记录。AI 整理暂时失败，可在“我的反馈”继续补充，无需重复提交。',
        },
      }).catch(() => undefined)
    })
  assistantJobs.set(feedbackId, job)
  void job.finally(() => {
    if (assistantJobs.get(feedbackId) === job) assistantJobs.delete(feedbackId)
  })
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

    setImmediate(() => enqueueAssistant(actor, feedback.id))

    return reply.status(201).send({
      id: feedback.id,
      status: feedback.status,
      category: feedback.category,
      reply: '反馈已收到，AI 助手正在后台整理。',
      processing: true,
    })
  })

  // ── 用户发言落库 → 后台 AI 回复 ──────────────────────
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

    setImmediate(() => enqueueAssistant(actor, feedback.id))
    return reply.status(202).send({
      reply: '补充内容已收到，AI 助手正在后台整理。',
      status: feedback.status,
      category: feedback.category,
      title: feedback.title,
      processing: true,
    })
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

}
