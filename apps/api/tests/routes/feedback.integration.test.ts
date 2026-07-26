import Fastify from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { prisma } from '@dianjie/db'
import { feedbackRoutes } from '../../src/routes/feedback'

const suffix = `fb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let tenantA = ''
let tenantB = ''
let reporterId = ''
let otherUserId = ''
let adminId = ''
let adminBId = ''
let app: ReturnType<typeof Fastify>

// Qwen mock: 每次 chat/completions 调用按队列顺序返回内容
const qwenQueue: string[] = []
let oldKey: string | undefined
let oldMode: string | undefined
let oldRepoDir: string | undefined

function qwenResponse(content: string) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  })
}

const ACTORS: Record<string, () => any> = {
  reporter: () => ({ tenantId: tenantA, userId: reporterId, role: 'MANAGER', storeId: null }),
  other: () => ({ tenantId: tenantA, userId: otherUserId, role: 'KITCHEN_LEAD', storeId: null }),
  admin: () => ({ tenantId: tenantA, userId: adminId, role: 'SUPER_ADMIN' }),
  adminB: () => ({ tenantId: tenantB, userId: adminBId, role: 'SUPER_ADMIN' }),
}

function inject(actor: keyof typeof ACTORS, method: 'GET' | 'POST', url: string, payload?: any) {
  return app.inject({
    method, url,
    headers: { 'x-test-actor': actor },
    ...(payload !== undefined ? { payload } : {}),
  })
}

describe('feedback system flow (integration)', () => {
  beforeAll(async () => {
    oldKey = process.env.QWEN_API_KEY
    oldMode = process.env.AUTO_FIX_MODE
    oldRepoDir = process.env.AUTO_FIX_REPO_DIR
    process.env.QWEN_API_KEY = 'integration-test-placeholder'
    process.env.AUTO_FIX_MODE = 'off'
    vi.stubGlobal('fetch', vi.fn(async () => {
      const next = qwenQueue.shift()
      if (!next) throw new Error('qwenQueue exhausted')
      return qwenResponse(next)
    }))

    const [ta, tb] = await Promise.all([
      prisma.tenant.create({ data: { name: `反馈测试A ${suffix}`, slug: `${suffix}-a` } }),
      prisma.tenant.create({ data: { name: `反馈测试B ${suffix}`, slug: `${suffix}-b` } }),
    ])
    tenantA = ta.id
    tenantB = tb.id
    const [reporter, other, admin, adminB] = await Promise.all([
      prisma.user.create({
        data: {
          tenantId: tenantA, name: '反馈店长', email: `reporter-${suffix}@local.test`,
          password: 'integration-test-only', role: 'MANAGER',
        },
      }),
      prisma.user.create({
        data: {
          tenantId: tenantA, name: '旁观厨师长', email: `other-${suffix}@local.test`,
          password: 'integration-test-only', role: 'KITCHEN_LEAD',
        },
      }),
      prisma.user.create({
        data: {
          tenantId: tenantA, name: '反馈超管', email: `admin-${suffix}@local.test`,
          password: 'integration-test-only', role: 'SUPER_ADMIN',
        },
      }),
      prisma.user.create({
        data: {
          tenantId: tenantB, name: 'B租户超管', email: `adminb-${suffix}@local.test`,
          password: 'integration-test-only', role: 'SUPER_ADMIN',
        },
      }),
    ])
    reporterId = reporter.id
    otherUserId = other.id
    adminId = admin.id
    adminBId = adminB.id

    app = Fastify()
    app.decorate('authenticate', async (request: any) => {
      const actor = ACTORS[String(request.headers['x-test-actor'] || 'reporter')]
      request.user = actor()
    })
    await app.register(feedbackRoutes, { prefix: '/api/feedback' })
    await app.ready()
  })

  afterAll(async () => {
    vi.unstubAllGlobals()
    if (oldKey === undefined) delete process.env.QWEN_API_KEY
    else process.env.QWEN_API_KEY = oldKey
    if (oldMode === undefined) delete process.env.AUTO_FIX_MODE
    else process.env.AUTO_FIX_MODE = oldMode
    if (oldRepoDir === undefined) delete process.env.AUTO_FIX_REPO_DIR
    else process.env.AUTO_FIX_REPO_DIR = oldRepoDir
    if (app) await app.close()
    await new Promise((resolve) => setTimeout(resolve, 300))
    for (const tid of [tenantA, tenantB].filter(Boolean)) {
      await prisma.autoFixRun.deleteMany({ where: { tenantId: tid } })
      await prisma.feedbackMessage.deleteMany({ where: { tenantId: tid } })
      await prisma.feedback.deleteMany({ where: { tenantId: tid } })
      await prisma.notificationLog.deleteMany({ where: { tenantId: tid } })
      await prisma.notification.deleteMany({ where: { tenantId: tid } })
      await prisma.opLog.deleteMany({ where: { tenantId: tid } })
      await prisma.user.deleteMany({ where: { tenantId: tid } })
      await prisma.tenant.delete({ where: { id: tid } })
    }
    await prisma.$disconnect()
  })

  it('完整流: 创建 → AI 首轮澄清 → 用户回复 → triage IMPROVEMENT → inbox → approve → 状态/OpLog/消息中心', async () => {
    // 1. 创建反馈: AI 首轮主动澄清
    qwenQueue.push('收到！为了更好地定位，想确认两点：1) 是在哪个页面想放大图片？2) 是点图片没反应吗？')
    const created = await inject('reporter', 'POST', '/api/feedback', {
      content: '验收照片看不太清楚，希望改进一下',
      context: { path: '/v2/chef/purchase', storeName: '瑶海店', userAgent: 'test-agent', clientTime: '2026-07-26 10:00' },
      attachments: ['https://example.com/a.jpg'],
    })
    expect(created.statusCode).toBe(201)
    const { id, status, reply } = created.json()
    expect(status).toBe('CLARIFYING')
    expect(reply).toContain('哪个页面')

    let fb = await prisma.feedback.findUnique({ where: { id }, include: { messages: true } })
    expect(fb!.tenantId).toBe(tenantA)
    expect(fb!.reporterId).toBe(reporterId)
    expect((fb!.context as any).path).toBe('/v2/chef/purchase')
    expect(fb!.messages).toHaveLength(2) // user + assistant

    // 2. 用户回复 → AI 分诊 IMPROVEMENT
    qwenQueue.push('明白了，验收图片需要能放大看细节。已为你整理好方案提交管理员审批。\n```json\n{"triage":{"category":"IMPROVEMENT","title":"验收图片支持放大查看","summary":"验收照片无法放大,细节看不清,希望点击可全屏放大","sufficient":true}}\n```')
    const replied = await inject('reporter', 'POST', `/api/feedback/${id}/messages`, {
      content: '在验收页面，点图片没反应，不能放大',
    })
    expect(replied.statusCode).toBe(200)
    const body = replied.json()
    expect(body.status).toBe('AWAITING_APPROVAL')
    expect(body.category).toBe('IMPROVEMENT')
    expect(body.title).toBe('验收图片支持放大查看')
    expect(body.reply).not.toContain('```')
    expect(body.reply).toContain('提交管理员审批')

    fb = await prisma.feedback.findUnique({ where: { id }, include: { messages: true } })
    expect(fb!.status).toBe('AWAITING_APPROVAL')
    expect(fb!.category).toBe('IMPROVEMENT')
    expect(fb!.summary).toContain('放大')
    // system 进度提示消息已写入
    expect(fb!.messages.some((m) => m.role === 'system' && m.content.includes('提交给管理员审批'))).toBe(true)

    // 3. 管理端 inbox 出现该反馈
    const inbox = await inject('admin', 'GET', '/api/feedback/admin/inbox')
    expect(inbox.statusCode).toBe(200)
    const items = inbox.json()
    const hit = items.find((i: any) => i.id === id)
    expect(hit).toBeTruthy()
    expect(hit.reporter.name).toBe('反馈店长')
    expect(hit.storeName).toBe('瑶海店')

    // 非管理员不能看 inbox
    const inboxForbidden = await inject('reporter', 'GET', '/api/feedback/admin/inbox')
    expect(inboxForbidden.statusCode).toBe(403)

    // 4. 驳回必须给理由
    const rejectNoNote = await inject('admin', 'POST', `/api/feedback/${id}/decision`, { action: 'reject' })
    expect(rejectNoNote.statusCode).toBe(400)

    // 5. 批准 → IN_DEV + OpLog + 消息中心通知
    const approved = await inject('admin', 'POST', `/api/feedback/${id}/decision`, { action: 'approve' })
    expect(approved.statusCode).toBe(200)
    expect(approved.json()).toMatchObject({
      ok: true,
      autoRunId: null,
      automationStatus: 'disabled',
    })
    fb = await prisma.feedback.findUnique({ where: { id } })
    expect(fb!.status).toBe('IN_DEV')
    expect(fb!.decisionById).toBe(adminId)
    expect(fb!.decisionAt).toBeTruthy()

    const opLog = await prisma.opLog.findFirst({
      where: { tenantId: tenantA, entityType: 'Feedback', targetId: id },
    })
    expect(opLog).toBeTruthy()
    expect(opLog!.action).toContain('批准')

    const inapp = await prisma.notification.findFirst({
      where: { tenantId: tenantA, recipientId: reporterId, type: 'FEEDBACK_RESULT', refId: id },
    })
    expect(inapp).toBeTruthy()
    expect(inapp!.title).toContain('已批准')

    // 已决策后不能重复审批
    const again = await inject('admin', 'POST', `/api/feedback/${id}/decision`, { action: 'approve' })
    expect(again.statusCode).toBe(400)
  })

  it('管理员批准是唯一授权点，启用 suggest 时才创建带审批人的自动开发任务', async () => {
    const feedback = await prisma.feedback.create({
      data: {
        tenantId: tenantA,
        reporterId,
        category: 'IMPROVEMENT',
        status: 'AWAITING_APPROVAL',
        title: '自动开发入队验证',
        summary: '批准后才允许系统读取源码并生成补丁',
        context: { path: '/route-that-does-not-exist' },
      },
    })

    process.env.AUTO_FIX_MODE = 'suggest'
    process.env.AUTO_FIX_REPO_DIR = '/definitely-missing-autofix-repo'
    try {
      const response = await inject('admin', 'POST', `/api/feedback/${feedback.id}/decision`, {
        action: 'approve',
      })
      expect(response.statusCode).toBe(200)
      const body = response.json()
      expect(body.automationStatus).toBe('queued')
      expect(body.autoRunId).toBeTruthy()

      const run = await prisma.autoFixRun.findUnique({ where: { id: body.autoRunId } })
      expect(run?.feedbackId).toBe(feedback.id)
      expect(run?.decidedById).toBe(adminId)
      expect(run?.decidedAt).toBeTruthy()

      for (let attempt = 0; attempt < 30; attempt++) {
        const current = await prisma.autoFixRun.findUnique({ where: { id: body.autoRunId } })
        if (current?.status === 'ESCALATED') break
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      expect((await prisma.autoFixRun.findUnique({ where: { id: body.autoRunId } }))?.status)
        .toBe('ESCALATED')
    } finally {
      process.env.AUTO_FIX_MODE = 'off'
      if (oldRepoDir === undefined) delete process.env.AUTO_FIX_REPO_DIR
      else process.env.AUTO_FIX_REPO_DIR = oldRepoDir
    }
  })

  it('QUESTION 分诊 → CLOSED 闭环', async () => {
    qwenQueue.push('改价这样操作：打开「我的 → 供应商管理」，选择供应商后点「调价」。\n```json\n{"triage":{"category":"QUESTION","title":"如何修改供应商报价","summary":"询问改价入口","sufficient":true}}\n```')
    const created = await inject('reporter', 'POST', '/api/feedback', {
      content: '请问供应商报价怎么改？',
      context: { path: '/v2/me' },
    })
    expect(created.statusCode).toBe(201)
    const { id, status } = created.json()
    expect(status).toBe('CLOSED')
    const fb = await prisma.feedback.findUnique({ where: { id } })
    expect(fb!.category).toBe('QUESTION')
  })

  it('越权防护: B 租户不可见, 同租户非本人非管理员 403', async () => {
    qwenQueue.push('收到，请补充一下具体情况。')
    const created = await inject('reporter', 'POST', '/api/feedback', {
      content: '越权测试反馈', context: { path: '/v2/manager/home' },
    })
    const { id } = created.json()

    // B 租户超管: tenant 隔离 → 404
    const crossTenant = await inject('adminB', 'GET', `/api/feedback/${id}`)
    expect(crossTenant.statusCode).toBe(404)
    const crossTenantMsg = await inject('adminB', 'POST', `/api/feedback/${id}/messages`, { content: 'hi' })
    expect(crossTenantMsg.statusCode).toBe(404)
    const inboxB = await inject('adminB', 'GET', '/api/feedback/admin/inbox')
    expect(inboxB.json().find((i: any) => i.id === id)).toBeUndefined()

    // 同租户非本人非管理员 → 403
    const otherRead = await inject('other', 'GET', `/api/feedback/${id}`)
    expect(otherRead.statusCode).toBe(403)
    const otherMsg = await inject('other', 'POST', `/api/feedback/${id}/messages`, { content: 'hi' })
    expect(otherMsg.statusCode).toBe(403)
    const otherDecision = await inject('other', 'POST', `/api/feedback/${id}/decision`, { action: 'approve' })
    expect(otherDecision.statusCode).toBe(403)

    // 本人和管理员可读
    expect((await inject('reporter', 'GET', `/api/feedback/${id}`)).statusCode).toBe(200)
    expect((await inject('admin', 'GET', `/api/feedback/${id}`)).statusCode).toBe(200)
  })

  it('mine 列表只返回本人反馈', async () => {
    const mine = await inject('reporter', 'GET', '/api/feedback/mine')
    expect(mine.statusCode).toBe(200)
    expect(mine.json().length).toBeGreaterThanOrEqual(3)
    const otherMine = await inject('other', 'GET', '/api/feedback/mine')
    expect(otherMine.json()).toHaveLength(0)
  })

  it('Qwen 故障兜底: 反馈仍落库, 返回兜底文案', async () => {
    qwenQueue.length = 0 // 队列耗尽 → mock fetch 抛错 → 重试后兜底
    const created = await inject('reporter', 'POST', '/api/feedback', {
      content: '网络故障兜底测试', context: { path: '/v2/chef/home' },
    })
    expect(created.statusCode).toBe(201)
    const { id, reply } = created.json()
    expect(reply).toContain('暂时繁忙')
    const fb = await prisma.feedback.findUnique({ where: { id } })
    expect(fb!.status).toBe('CLARIFYING')
  })
})
