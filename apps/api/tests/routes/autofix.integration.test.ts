import Fastify from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { prisma } from '@dianjie/db'
import { autoFixRoutes } from '../../src/routes/autofix'
import {
  executeApprovedRun,
  executeManualRollback,
} from '../../src/services/autofix/deployment'
import {
  enqueueAutoFix,
  recoverStaleAutoFixRuns,
} from '../../src/services/autofix/engine'

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
let approvalRunA = ''
let approvalRunB = ''
let incompleteApprovalRunA = ''
let concurrentApprovalRunA = ''
let rejectRunA = ''
let rejectRunB = ''
let concurrentRejectRunA = ''
let app: ReturnType<typeof Fastify>
let oldMode: string | undefined
let oldDeploy: string | undefined
let oldStaleMinutes: string | undefined

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
    oldStaleMinutes = process.env.AUTO_FIX_STALE_MINUTES
    process.env.AUTO_FIX_MODE = 'suggest'
    process.env.AUTO_FIX_DEPLOY_ENABLED = 'false'
    process.env.AUTO_FIX_STALE_MINUTES = '15'

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

    const [
      fa,
      fb,
      rollbackFa,
      rollbackFb,
      concurrentRollbackFa,
      approvalFa,
      approvalFb,
      incompleteApprovalFa,
      concurrentApprovalFa,
      rejectFa,
      rejectFb,
      concurrentRejectFa,
    ] = await Promise.all([
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
      prisma.feedback.create({
        data: {
          tenantId: tenantA, reporterId: managerA, category: 'BUG_BLOCKING',
          status: 'AWAITING_APPROVAL', title: 'A 待批准故障', context: { path: '/v2/manager/home' },
        },
      }),
      prisma.feedback.create({
        data: {
          tenantId: tenantB, reporterId: adminB, category: 'BUG_BLOCKING',
          status: 'AWAITING_APPROVAL', title: 'B 待批准故障', context: { path: '/v2/boss/home' },
        },
      }),
      prisma.feedback.create({
        data: {
          tenantId: tenantA, reporterId: managerA, category: 'BUG_BLOCKING',
          status: 'AWAITING_APPROVAL', title: 'A 补丁不完整故障', context: { path: '/v2/manager/home' },
        },
      }),
      prisma.feedback.create({
        data: {
          tenantId: tenantA, reporterId: managerA, category: 'BUG_BLOCKING',
          status: 'AWAITING_APPROVAL', title: 'A 并发批准故障', context: { path: '/v2/manager/home' },
        },
      }),
      prisma.feedback.create({
        data: {
          tenantId: tenantA, reporterId: managerA, category: 'BUG_BLOCKING',
          status: 'AWAITING_APPROVAL', title: 'A 待驳回故障', context: { path: '/v2/manager/home' },
        },
      }),
      prisma.feedback.create({
        data: {
          tenantId: tenantB, reporterId: adminB, category: 'BUG_BLOCKING',
          status: 'AWAITING_APPROVAL', title: 'B 待驳回故障', context: { path: '/v2/boss/home' },
        },
      }),
      prisma.feedback.create({
        data: {
          tenantId: tenantA, reporterId: managerA, category: 'BUG_BLOCKING',
          status: 'AWAITING_APPROVAL', title: 'A 并发驳回故障', context: { path: '/v2/manager/home' },
        },
      }),
    ])
    feedbackA = fa.id
    feedbackB = fb.id
    const [
      ra,
      rb,
      rollbackRa,
      rollbackRb,
      concurrentRollbackRa,
      approvalRa,
      approvalRb,
      incompleteApprovalRa,
      concurrentApprovalRa,
      rejectRa,
      rejectRb,
      concurrentRejectRa,
    ] = await Promise.all([
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
      prisma.autoFixRun.create({
        data: {
          tenantId: tenantA,
          feedbackId: approvalFa.id,
          status: 'AWAITING_APPROVAL',
          diffPatch: 'diff --git a/apps/web/src/app/a.tsx b/apps/web/src/app/a.tsx\n',
          baseCommitSha: 'd'.repeat(40),
          error: '旧错误应在批准时清除',
        },
      }),
      prisma.autoFixRun.create({
        data: {
          tenantId: tenantB,
          feedbackId: approvalFb.id,
          status: 'AWAITING_APPROVAL',
          diffPatch: 'diff --git a/apps/web/src/app/b.tsx b/apps/web/src/app/b.tsx\n',
          baseCommitSha: 'e'.repeat(40),
        },
      }),
      prisma.autoFixRun.create({
        data: {
          tenantId: tenantA,
          feedbackId: incompleteApprovalFa.id,
          status: 'AWAITING_APPROVAL',
          baseCommitSha: 'f'.repeat(40),
        },
      }),
      prisma.autoFixRun.create({
        data: {
          tenantId: tenantA,
          feedbackId: concurrentApprovalFa.id,
          status: 'AWAITING_APPROVAL',
          diffPatch: 'diff --git a/apps/web/src/app/c.tsx b/apps/web/src/app/c.tsx\n',
          baseCommitSha: '1'.repeat(40),
        },
      }),
      prisma.autoFixRun.create({
        data: {
          tenantId: tenantA,
          feedbackId: rejectFa.id,
          status: 'AWAITING_APPROVAL',
        },
      }),
      prisma.autoFixRun.create({
        data: {
          tenantId: tenantB,
          feedbackId: rejectFb.id,
          status: 'AWAITING_APPROVAL',
        },
      }),
      prisma.autoFixRun.create({
        data: {
          tenantId: tenantA,
          feedbackId: concurrentRejectFa.id,
          status: 'AWAITING_APPROVAL',
        },
      }),
    ])
    runA = ra.id
    runB = rb.id
    rollbackRunA = rollbackRa.id
    rollbackRunB = rollbackRb.id
    concurrentRollbackRunA = concurrentRollbackRa.id
    approvalRunA = approvalRa.id
    approvalRunB = approvalRb.id
    incompleteApprovalRunA = incompleteApprovalRa.id
    concurrentApprovalRunA = concurrentApprovalRa.id
    rejectRunA = rejectRa.id
    rejectRunB = rejectRb.id
    concurrentRejectRunA = concurrentRejectRa.id

    await prisma.autoFixRun.updateMany({
      where: { id: { in: [rollbackRunA, concurrentRollbackRunA] } },
      data: { createdAt: new Date('2026-07-26T12:00:00.000Z') },
    })

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
    if (oldStaleMinutes === undefined) delete process.env.AUTO_FIX_STALE_MINUTES
    else process.env.AUTO_FIX_STALE_MINUTES = oldStaleMinutes
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

  it('keeps filtered list pagination stable and rejects unbounded queries', async () => {
    const expectedIds = [rollbackRunA, concurrentRollbackRunA].sort().reverse()
    const first = await inject(
      'adminA',
      'GET',
      '/api/autofix/runs?status=RESOLVED&page=1&pageSize=1',
    )
    const second = await inject(
      'adminA',
      'GET',
      '/api/autofix/runs?status=RESOLVED&page=2&pageSize=1',
    )
    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(200)
    expect(first.json()).toMatchObject({
      total: 2,
      page: 1,
      pageSize: 1,
      items: [{ id: expectedIds[0], status: 'RESOLVED' }],
    })
    expect(second.json()).toMatchObject({
      total: 2,
      page: 2,
      pageSize: 1,
      items: [{ id: expectedIds[1], status: 'RESOLVED' }],
    })
    expect(new Set([
      ...first.json().items.map((item: any) => item.id),
      ...second.json().items.map((item: any) => item.id),
    ])).toEqual(new Set(expectedIds))

    for (const query of [
      'status=UNKNOWN',
      'page=0',
      'page=10001',
      'pageSize=101',
      'unexpected=true',
    ]) {
      expect((await inject('adminA', 'GET', `/api/autofix/runs?${query}`)).statusCode)
        .toBe(400)
    }
  })

  it('bounds detail diff slices without leaking another tenant', async () => {
    const fullPatch = 'diff --git a/apps/web/src/app/a.tsx b/apps/web/src/app/a.tsx\n'
    expect((await inject(
      'managerA',
      'GET',
      `/api/autofix/runs/${runA}?diffOffset=5&diffLimit=12`,
    )).statusCode).toBe(403)

    const detail = await inject(
      'adminA',
      'GET',
      `/api/autofix/runs/${runA}?diffOffset=5&diffLimit=12`,
    )
    expect(detail.statusCode).toBe(200)
    expect(detail.json()).toMatchObject({
      id: runA,
      tenantId: tenantA,
      diffPatch: fullPatch.slice(5, 17),
      diffOffset: 5,
      diffLimit: 12,
      diffTotal: fullPatch.length,
      mode: 'suggest',
      deploymentReady: false,
      feedback: {
        id: feedbackA,
        title: 'A 故障',
      },
    })

    const exhausted = await inject(
      'adminA',
      'GET',
      `/api/autofix/runs/${runA}?diffOffset=${fullPatch.length + 10}&diffLimit=1`,
    )
    expect(exhausted.statusCode).toBe(200)
    expect(exhausted.json()).toMatchObject({
      diffPatch: '',
      diffOffset: fullPatch.length + 10,
      diffLimit: 1,
      diffTotal: fullPatch.length,
    })
    expect((await inject(
      'adminA',
      'GET',
      `/api/autofix/runs/${runB}?diffOffset=0&diffLimit=1`,
    )).statusCode).toBe(404)

    for (const query of [
      'diffOffset=-1',
      'diffLimit=0',
      'diffLimit=50001',
      'unexpected=true',
    ]) {
      expect((await inject(
        'adminA',
        'GET',
        `/api/autofix/runs/${runA}?${query}`,
      )).statusCode).toBe(400)
    }
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

  it('recovers orphaned stale runs exactly once without touching fresh work', async () => {
    const [staleFeedback, freshFeedback] = await Promise.all([
      prisma.feedback.create({
        data: {
          tenantId: tenantA, reporterId: managerA, category: 'IMPROVEMENT',
          status: 'IN_DEV', title: '停滞任务', context: { path: '/v2/manager/home' },
        },
      }),
      prisma.feedback.create({
        data: {
          tenantId: tenantA, reporterId: managerA, category: 'IMPROVEMENT',
          status: 'IN_DEV', title: '正常任务', context: { path: '/v2/manager/home' },
        },
      }),
    ])
    const staleAt = new Date(Date.now() - 16 * 60_000)
    const [staleRun, freshRun] = await Promise.all([
      prisma.autoFixRun.create({
        data: {
          tenantId: tenantA,
          feedbackId: staleFeedback.id,
          status: 'ANALYZING',
          updatedAt: staleAt,
        },
      }),
      prisma.autoFixRun.create({
        data: {
          tenantId: tenantA,
          feedbackId: freshFeedback.id,
          status: 'PATCHING',
        },
      }),
    ])

    const recovered = await Promise.all([
      recoverStaleAutoFixRuns(),
      recoverStaleAutoFixRuns(),
    ])
    expect(recovered.reduce((total, count) => total + count, 0)).toBe(1)

    const [staleAfter, freshAfter, audits] = await Promise.all([
      prisma.autoFixRun.findUnique({ where: { id: staleRun.id } }),
      prisma.autoFixRun.findUnique({ where: { id: freshRun.id } }),
      prisma.opLog.findMany({
        where: { tenantId: tenantA, entityType: 'AutoFixRun', targetId: staleRun.id },
        select: { metadata: true },
      }),
    ])
    expect(staleAfter?.status).toBe('ESCALATED')
    expect(staleAfter?.error).toContain('看门狗已转人工')
    expect(freshAfter?.status).toBe('PATCHING')
    expect(audits).toHaveLength(1)
    expect((audits[0].metadata as any)?.reason).toBe('stale_watchdog')
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

  it('allows only the same-tenant SUPER_ADMIN to approve a complete patch', async () => {
    process.env.AUTO_FIX_DEPLOY_ENABLED = 'true'
    try {
      expect((await inject(
        'managerA',
        'POST',
        `/api/autofix/runs/${approvalRunA}/approve`,
        {},
      )).statusCode).toBe(403)
      expect((await inject(
        'adminA',
        'POST',
        `/api/autofix/runs/${approvalRunB}/approve`,
        {},
      )).statusCode).toBe(404)
      expect((await prisma.autoFixRun.findUnique({ where: { id: approvalRunB } }))?.status)
        .toBe('AWAITING_APPROVAL')

      const incomplete = await inject(
        'adminA',
        'POST',
        `/api/autofix/runs/${incompleteApprovalRunA}/approve`,
        {},
      )
      expect(incomplete.statusCode).toBe(400)
      expect(incomplete.json().error).toContain('补丁或源码基线不完整')

      const response = await inject(
        'adminA',
        'POST',
        `/api/autofix/runs/${approvalRunA}/approve`,
        {},
      )
      expect(response.statusCode).toBe(202)
      expect(response.json()).toEqual({ ok: true, status: 'DEPLOYING' })
      const run = await prisma.autoFixRun.findUnique({ where: { id: approvalRunA } })
      expect(run?.status).toBe('DEPLOYING')
      expect(run?.decidedById).toBe(adminA)
      expect(run?.error).toBeNull()
      expect(await prisma.opLog.count({
        where: {
          tenantId: tenantA,
          entityType: 'AutoFixRun',
          targetId: approvalRunA,
          action: { contains: '批准 AI 自动修复' },
        },
      })).toBe(1)
      await new Promise((resolve) => setImmediate(resolve))
      expect(vi.mocked(executeApprovedRun)).toHaveBeenCalledOnce()
      expect(vi.mocked(executeApprovedRun)).toHaveBeenCalledWith(approvalRunA)
    } finally {
      process.env.AUTO_FIX_DEPLOY_ENABLED = 'false'
    }
  })

  it('serializes duplicate approvals and schedules exactly one deployment', async () => {
    process.env.AUTO_FIX_DEPLOY_ENABLED = 'true'
    try {
      const responses = await Promise.all([
        inject('adminA', 'POST', `/api/autofix/runs/${concurrentApprovalRunA}/approve`, {}),
        inject('adminA', 'POST', `/api/autofix/runs/${concurrentApprovalRunA}/approve`, {}),
      ])
      expect(responses.map((response) => response.statusCode).sort()).toEqual([202, 400])
      expect(await prisma.opLog.count({
        where: {
          tenantId: tenantA,
          entityType: 'AutoFixRun',
          targetId: concurrentApprovalRunA,
          action: { contains: '批准 AI 自动修复' },
        },
      })).toBe(1)
      await new Promise((resolve) => setImmediate(resolve))
      expect(vi.mocked(executeApprovedRun)).toHaveBeenCalledOnce()
      expect(vi.mocked(executeApprovedRun)).toHaveBeenCalledWith(concurrentApprovalRunA)
    } finally {
      process.env.AUTO_FIX_DEPLOY_ENABLED = 'false'
    }
  })

  it('allows only the same-tenant SUPER_ADMIN to reject with an audit reason', async () => {
    expect((await inject(
      'managerA',
      'POST',
      `/api/autofix/runs/${rejectRunA}/reject`,
      { note: '经理无权驳回' },
    )).statusCode).toBe(403)
    expect((await inject(
      'adminA',
      'POST',
      `/api/autofix/runs/${rejectRunB}/reject`,
      { note: '跨租户不得驳回' },
    )).statusCode).toBe(404)
    expect((await prisma.autoFixRun.findUnique({ where: { id: rejectRunB } }))?.status)
      .toBe('AWAITING_APPROVAL')

    const response = await inject(
      'adminA',
      'POST',
      `/api/autofix/runs/${rejectRunA}/reject`,
      { note: '证据不足，暂不自动发布' },
    )
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ ok: true, status: 'REJECTED' })
    const run = await prisma.autoFixRun.findUnique({ where: { id: rejectRunA } })
    expect(run?.status).toBe('REJECTED')
    expect(run?.decidedById).toBe(adminA)
    expect(run?.error).toBe('证据不足，暂不自动发布')
    expect(await prisma.opLog.count({
      where: {
        tenantId: tenantA,
        entityType: 'AutoFixRun',
        targetId: rejectRunA,
        action: { contains: '证据不足，暂不自动发布' },
      },
    })).toBe(1)
    expect(vi.mocked(executeApprovedRun)).not.toHaveBeenCalled()
    expect(vi.mocked(executeManualRollback)).not.toHaveBeenCalled()
  })

  it('serializes duplicate rejections and writes exactly one decision', async () => {
    const notes = ['并发驳回 A', '并发驳回 B']
    const responses = await Promise.all(notes.map((note) => inject(
      'adminA',
      'POST',
      `/api/autofix/runs/${concurrentRejectRunA}/reject`,
      { note },
    )))
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 400])
    const run = await prisma.autoFixRun.findUnique({ where: { id: concurrentRejectRunA } })
    expect(run?.status).toBe('REJECTED')
    expect(notes).toContain(run?.error)
    expect(await prisma.opLog.count({
      where: {
        tenantId: tenantA,
        entityType: 'AutoFixRun',
        targetId: concurrentRejectRunA,
        action: { contains: '驳回 AI 自动修复' },
      },
    })).toBe(1)
    expect(vi.mocked(executeApprovedRun)).not.toHaveBeenCalled()
    expect(vi.mocked(executeManualRollback)).not.toHaveBeenCalled()
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
