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

async function waitForFeedback(
  id: string,
  predicate: (feedback: any) => boolean,
  timeoutMs = 3_000,
) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const feedback = await prisma.feedback.findUnique({
      where: { id },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    })
    if (feedback && predicate(feedback)) return feedback
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out waiting for feedback ${id}`)
}

describe('feedback system flow (integration)', () => {
  beforeAll(async () => {
    oldKey = process.env.QWEN_API_KEY
    oldMode = process.env.AUTO_FIX_MODE
    oldRepoDir = process.env.AUTO_FIX_REPO_DIR
    process.env.QWEN_API_KEY = 'integration-test-placeholder'
    process.env.AUTO_FIX_MODE = 'off'
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
      if (url.startsWith('https://example.com/')) {
        return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
          status: 200,
          headers: { 'Content-Type': 'image/jpeg' },
        })
      }
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

  it('提交和补充反馈后保留记录，不产生审批或自动开发任务', async () => {
    qwenQueue.push('收到，请补充具体页面和操作。')
    const created = await inject('reporter', 'POST', '/api/feedback', {
      content: '验收照片看不太清楚，希望改进一下',
      context: { path: '/v2/chef/purchase', storeName: '瑶海店' },
    })
    expect(created.statusCode).toBe(201)
    const { id } = created.json()
    await waitForFeedback(id, (item) => item.messages.some((m: any) => m.role === 'assistant'))

    qwenQueue.push('已记录这项改进建议。\n```json\n{"triage":{"category":"IMPROVEMENT","title":"验收照片支持放大查看","summary":"验收照片看不清","sufficient":true}}\n```')
    const replied = await inject('reporter', 'POST', `/api/feedback/${id}/messages`, { content: '点图片后不能放大' })
    expect(replied.statusCode).toBe(202)
    const feedback = await waitForFeedback(id, (item) => item.category === 'IMPROVEMENT'
      && item.messages.some((m: any) => m.role === 'system' && m.content.includes('已记录')))
    expect(feedback.status).toBe('CLARIFYING')
    expect((await inject('reporter', 'GET', `/api/feedback/${id}`)).statusCode).toBe(200)
    expect((await inject('admin', 'GET', '/api/feedback/admin/inbox')).statusCode).toBe(404)
    expect((await inject('admin', 'POST', `/api/feedback/${id}/decision`, { action: 'approve' })).statusCode).toBe(404)
    expect((await inject('admin', 'POST', `/api/feedback/${id}/resolve`, {})).statusCode).toBe(404)
    expect(await prisma.autoFixRun.count({ where: { feedbackId: id } })).toBe(0)
  })

  it('QUESTION 分诊 → CLOSED 闭环', async () => {
    qwenQueue.push('改价这样操作：打开「我的 → 供应商管理」，选择供应商后点「调价」。\n```json\n{"triage":{"category":"QUESTION","title":"如何修改供应商报价","summary":"询问改价入口","sufficient":true}}\n```')
    const created = await inject('reporter', 'POST', '/api/feedback', {
      content: '请问供应商报价怎么改？',
      context: { path: '/v2/me' },
    })
    expect(created.statusCode).toBe(201)
    const { id, status } = created.json()
    expect(status).toBe('CLARIFYING')
    const fb = await waitForFeedback(id, (item) => item.status === 'CLOSED')
    expect(fb!.category).toBe('QUESTION')
  })

  it('越权防护: B 租户不可见, 同租户非本人非管理员 403', async () => {
    qwenQueue.push('收到，请补充一下具体情况。')
    const created = await inject('reporter', 'POST', '/api/feedback', {
      content: '越权测试反馈', context: { path: '/v2/manager/home' },
    })
    const { id } = created.json()
    await waitForFeedback(id, (item) => item.messages.some((m: any) => m.role === 'assistant'))

    // B 租户超管: tenant 隔离 → 404
    const crossTenant = await inject('adminB', 'GET', `/api/feedback/${id}`)
    expect(crossTenant.statusCode).toBe(404)
    const crossTenantMsg = await inject('adminB', 'POST', `/api/feedback/${id}/messages`, { content: 'hi' })
    expect(crossTenantMsg.statusCode).toBe(404)

    // 同租户非本人非管理员 → 403
    const otherRead = await inject('other', 'GET', `/api/feedback/${id}`)
    expect(otherRead.statusCode).toBe(403)
    const otherMsg = await inject('other', 'POST', `/api/feedback/${id}/messages`, { content: 'hi' })
    expect(otherMsg.statusCode).toBe(403)

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
    qwenQueue.length = 0 // 队列耗尽 → mock fetch 抛错 → 单次尝试后兜底
    const created = await inject('reporter', 'POST', '/api/feedback', {
      content: '网络故障兜底测试', context: { path: '/v2/chef/home' },
    })
    expect(created.statusCode).toBe(201)
    const { id, reply } = created.json()
    expect(reply).toContain('正在后台整理')
    const fb = await waitForFeedback(id, (item) => item.messages.some(
      (m: any) => m.role === 'assistant' && m.content.includes('暂时繁忙'),
    ))
    expect(fb!.status).toBe('CLARIFYING')
  })
})
