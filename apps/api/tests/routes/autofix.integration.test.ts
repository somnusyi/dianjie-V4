import Fastify from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { prisma } from '@dianjie/db'
import { autoFixRoutes } from '../../src/routes/autofix'
import { executeManualRollback } from '../../src/services/autofix/deployment'
import { enqueueAutoFix } from '../../src/services/autofix/engine'

vi.mock('../../src/services/autofix/deployment', () => ({
  executeApprovedRun: vi.fn(),
  executeManualRollback: vi.fn(),
}))

const suffix = `autofix-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let tenantA = ''
let tenantB = ''
let adminA = ''
let managerA = ''
let adminB = ''
let feedbackA = ''
let feedbackB = ''
let runA = ''
let runB = ''
let rollbackRunA = ''
let rollbackRunB = ''
let concurrentRollbackRunA = ''
let app: ReturnType<typeof Fastify>
let oldMode: string | undefined
let oldDeploy: string | undefined

const actors: Record<string, () => any> = {
  adminA: () => ({ tenantId: tenantA, userId: adminA, role: 'SUPER_ADMIN' }),
  managerA: () => ({ tenantId: tenantA, userId: managerA, role: 'MANAGER' }),
  adminB: () => ({ tenantId: tenantB, userId: adminB, role: 'SUPER_ADMIN' }),
}

function inject(actor: keyof typeof actors, method: 'GET' | 'POST', url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: { 'x-test-actor': actor },
    ...(payload !== undefined ? { payload } : {}),
  })
}

describe('auto-fix approval API (integration)', () => {
  beforeAll(async () => {
    oldMode = process.env.AUTO_FIX_MODE
    oldDeploy = process.env.AUTO_FIX_DEPLOY_ENABLED
    process.env.AUTO_FIX_MODE = 'suggest'
    process.env.AUTO_FIX_DEPLOY_ENABLED = 'false'

    const [ta, tb] = await Promise.all([
      prisma.tenant.create({ data: { name: `AutoFix A ${suffix}`, slug: `${suffix}-a` } }),
      prisma.tenant.create({ data: { name: `AutoFix B ${suffix}`, slug: `${suffix}-b` } }),
    ])
    tenantA = ta.id
    tenantB = tb.id
    const [aa, ma, ab] = await Promise.all([
      prisma.user.create({
        data: {
          tenantId: tenantA, name: 'A 超管', email: `aa-${suffix}@local.test`,
          password: 'integration-test-only', role: 'SUPER_ADMIN',
        },
      }),
      prisma.user.create({
        data: {
          tenantId: tenantA, name: 'A 店长', email: `ma-${suffix}@local.test`,
          password: 'integration-test-only', role: 'MANAGER',
        },
      }),
      prisma.user.create({
        data: {
          tenantId: tenantB, name: 'B 超管', email: `ab-${suffix}@local.test`,
          password: 'integration-test-only', role: 'SUPER_ADMIN',
        },
      }),
    ])
    adminA = aa.id
    managerA = ma.id
    adminB = ab.id

    const [fa, fb, rollbackFa, rollbackFb, concurrentRollbackFa] = await Promise.all([
      prisma.feedback.create({
        data: {
          tenantId: tenantA, reporterId: managerA, category: 'BUG_BLOCKING',
          status: 'CLARIFYING', title: 'A 故障', context: { path: '/v2/manager/home' },
        },
      }),
      prisma.feedback.create({
        data: {
          tenantId: tenantB, reporterId: adminB, category: 'BUG_BLOCKING',
          status: 'CLARIFYING', title: 'B 故障', context: { path: '/v2/boss/home' },
        },
      }),
      prisma.feedback.create({
        data: {
          tenantId: tenantA, reporterId: managerA, category: 'BUG_BLOCKING',
          status: 'RESOLVED', title: 'A 已修复故障', context: { path: '/v2/manager/home' },
        },
      }),
      prisma.feedback.create({
        data: {
          tenantId: tenantB, reporterId: adminB, category: 'BUG_BLOCKING',
          status: 'RESOLVED', title: 'B 已修复故障', context: { path: '/v2/boss/home' },
        },
      }),
      prisma.feedback.create({
        data: {
          tenantId: tenantA, reporterId: managerA, category: 'BUG_BLOCKING',
          status: 'RESOLVED', title: 'A 并发回滚故障', context: { path: '/v2/manager/home' },
        },
      }),
    ])
    feedbackA = fa.id
    feedbackB = fb.id
    const [ra, rb, rollbackRa, rollbackRb, concurrentRollbackRa] = await Promise.all([
      prisma.autoFixRun.create({
        data: {
          tenantId: tenantA,
          feedbackId: feedbackA,
          status: 'AWAITING_APPROVAL',
          analysis: '{"rootCause":"空值"}',
          planSummary: '增加空值兜底',
          diffPatch: 'diff --git a/apps/web/src/app/a.tsx b/apps/web/src/app/a.tsx\n',
          diffFiles: [{ path: 'apps/web/src/app/a.tsx', added: 1, deleted: 1 }],
          baseCommitSha: 'base-a',
        },
      }),
      prisma.autoFixRun.create({
        data: {
          tenantId: tenantB,
          feedbackId: feedbackB,
          status: 'ESCALATED',
          error: '转人工',
        },
      }),
      prisma.autoFixRun.create({
        data: {
          tenantId: tenantA,
          feedbackId: rollbackFa.id,
          status: 'RESOLVED',
          commitSha: 'a'.repeat(40),
        },
      }),
      prisma.autoFixRun.create({
        data: {
          tenantId: tenantB,
          feedbackId: rollbackFb.id,
          status: 'RESOLVED',
          commitSha: 'b'.repeat(40),
        },
      }),
      prisma.autoFixRun.create({
        data: {
          tenantId: tenantA,
          feedbackId: concurrentRollbackFa.id,
          status: 'RESOLVED',
          commitSha: 'c'.repeat(40),
        },
      }),
    ])
    runA = ra.id
    runB = rb.id
    rollbackRunA = rollbackRa.id
    rollbackRunB = rollbackRb.id
    concurrentRollbackRunA = concurrentRollbackRa.id

    app = Fastify()
    app.decorate('authenticate', async (request: any) => {
      request.user = actors[String(request.headers['x-test-actor'] || 'managerA')]()
    })
    await app.register(autoFixRoutes, { prefix: '/api/autofix' })
    await app.ready()
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterAll(async () => {
    if (app) await app.close()
    if (oldMode === undefined) delete process.env.AUTO_FIX_MODE
    else process.env.AUTO_FIX_MODE = oldMode
    if (oldDeploy === undefined) delete process.env.AUTO_FIX_DEPLOY_ENABLED
    else process.env.AUTO_FIX_DEPLOY_ENABLED = oldDeploy
    await prisma.autoFixRun.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } })
    await prisma.feedback.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } })
    await prisma.opLog.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } })
    await prisma.user.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } })
    for (const id of [tenantA, tenantB]) {
      if (id) await prisma.tenant.delete({ where: { id } })
    }
    await prisma.$disconnect()
  })

  it('allows only SUPER_ADMIN and isolates every tenant', async () => {
    expect((await inject('managerA', 'GET', '/api/autofix/runs')).statusCode).toBe(403)

    const list = await inject('adminA', 'GET', '/api/autofix/runs')
    expect(list.statusCode).toBe(200)
    const tenantARunIds = list.json().items.map((item: any) => item.id)
    expect(tenantARunIds).toEqual(expect.arrayContaining([
      runA,
      rollbackRunA,
      concurrentRollbackRunA,
    ]))
    expect(tenantARunIds).not.toContain(runB)
    expect(tenantARunIds).not.toContain(rollbackRunB)

    expect((await inject('adminA', 'GET', `/api/autofix/runs/${runB}`)).statusCode).toBe(404)
    expect((await inject('adminB', 'GET', `/api/autofix/runs/${runA}`)).statusCode).toBe(404)
  })

  it('does nothing when AUTO_FIX_MODE is off', async () => {
    process.env.AUTO_FIX_MODE = 'off'
    await expect(enqueueAutoFix({ tenantId: tenantA, feedbackId: 'not-read-when-off' }))
      .resolves.toBeNull()
    process.env.AUTO_FIX_MODE = 'suggest'
  })

  it('fails closed when deployment infrastructure is disabled', async () => {
    const response = await inject('adminA', 'POST', `/api/autofix/runs/${runA}/approve`, {})
    expect(response.statusCode).toBe(409)
    expect(response.json().error).toContain('部署环境未启用')
    expect((await prisma.autoFixRun.findUnique({ where: { id: runA } }))?.status)
      .toBe('AWAITING_APPROVAL')
  })

  it('rejects atomically with a reason and audit log', async () => {
    expect((await inject('adminA', 'POST', `/api/autofix/runs/${runA}/reject`, {})).statusCode).toBe(400)
    const rejected = await inject('adminA', 'POST', `/api/autofix/runs/${runA}/reject`, { note: '定位证据不足' })
    expect(rejected.statusCode).toBe(200)
    const run = await prisma.autoFixRun.findUnique({ where: { id: runA } })
    expect(run?.status).toBe('REJECTED')
    expect(run?.decidedById).toBe(adminA)
    const log = await prisma.opLog.findFirst({
      where: { tenantId: tenantA, entityType: 'AutoFixRun', targetId: runA },
    })
    expect(log?.action).toContain('定位证据不足')
  })

  it('allows only the same-tenant SUPER_ADMIN to start a rollback', async () => {
    process.env.AUTO_FIX_DEPLOY_ENABLED = 'true'
    try {
      expect((await inject(
        'managerA',
        'POST',
        `/api/autofix/runs/${rollbackRunA}/rollback`,
        {},
      )).statusCode).toBe(403)
      expect((await inject(
        'adminA',
        'POST',
        `/api/autofix/runs/${rollbackRunB}/rollback`,
        {},
      )).statusCode).toBe(404)
      expect((await prisma.autoFixRun.findUnique({ where: { id: rollbackRunB } }))?.status)
        .toBe('RESOLVED')

      const response = await inject(
        'adminA',
        'POST',
        `/api/autofix/runs/${rollbackRunA}/rollback`,
        {},
      )
      expect(response.statusCode).toBe(202)
      expect(response.json()).toEqual({ ok: true, status: 'DEPLOYING' })
      const run = await prisma.autoFixRun.findUnique({ where: { id: rollbackRunA } })
      expect(run?.status).toBe('DEPLOYING')
      expect(run?.decidedById).toBe(adminA)
      expect(await prisma.opLog.count({
        where: {
          tenantId: tenantA,
          entityType: 'AutoFixRun',
          targetId: rollbackRunA,
          action: { contains: '发起 AI 自动修复回滚' },
        },
      })).toBe(1)
      await new Promise((resolve) => setImmediate(resolve))
      expect(vi.mocked(executeManualRollback)).toHaveBeenCalledOnce()
      expect(vi.mocked(executeManualRollback)).toHaveBeenCalledWith(rollbackRunA)
    } finally {
      process.env.AUTO_FIX_DEPLOY_ENABLED = 'false'
    }
  })

  it('serializes duplicate rollback requests and schedules exactly one execution', async () => {
    process.env.AUTO_FIX_DEPLOY_ENABLED = 'true'
    try {
      const responses = await Promise.all([
        inject('adminA', 'POST', `/api/autofix/runs/${concurrentRollbackRunA}/rollback`, {}),
        inject('adminA', 'POST', `/api/autofix/runs/${concurrentRollbackRunA}/rollback`, {}),
      ])
      expect(responses.map((response) => response.statusCode).sort()).toEqual([202, 400])
      expect(await prisma.opLog.count({
        where: {
          tenantId: tenantA,
          entityType: 'AutoFixRun',
          targetId: concurrentRollbackRunA,
          action: { contains: '发起 AI 自动修复回滚' },
        },
      })).toBe(1)
      await new Promise((resolve) => setImmediate(resolve))
      expect(vi.mocked(executeManualRollback)).toHaveBeenCalledOnce()
      expect(vi.mocked(executeManualRollback)).toHaveBeenCalledWith(concurrentRollbackRunA)
    } finally {
      process.env.AUTO_FIX_DEPLOY_ENABLED = 'false'
    }
  })
})
