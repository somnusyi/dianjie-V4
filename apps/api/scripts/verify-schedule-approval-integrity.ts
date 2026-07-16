import 'dotenv/config'
import assert from 'node:assert/strict'
import bcrypt from 'bcryptjs'
import { prisma } from '@dianjie/db'

const API_BASE = process.env.TEST_API_BASE || 'http://localhost:4444'
const TENANT_SLUG = process.env.PREVIEW_TENANT_SLUG || 'yaohai-test'
const PASSWORD = 'yaohai@123'

function assertLocalOnly() {
  const url = process.env.DATABASE_URL || ''
  if (process.env.PREVIEW_MODE !== 'true' || process.env.NODE_ENV === 'production' || !url.includes('dianjie_v4_local')) {
    throw new Error('安全护栏: 付款计划审批验证仅允许本地 PREVIEW_MODE 隔离库')
  }
}

async function api(path: string, token: string | null, init: RequestInit = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {}),
    },
  })
  const body = await response.json().catch(() => ({}))
  return { status: response.status, body }
}

async function login(identifier: string) {
  const response = await api('/api/auth/login', null, {
    method: 'POST', body: JSON.stringify({ identifier, password: PASSWORD, tenantSlug: TENANT_SLUG }),
  })
  assert.equal(response.status, 200, JSON.stringify(response.body))
  return response.body.token as string
}

async function main() {
  assertLocalOnly()
  const suffix = Date.now().toString(36)
  const startedAt = new Date()
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: TENANT_SLUG } })
  const password = await bcrypt.hash(PASSWORD, 10)
  const store = await prisma.store.create({
    data: { tenantId: tenant.id, no: `SCH-${suffix}`, name: `审批完整性门店-${suffix}` },
  })
  const supplier = await prisma.supplier.create({
    data: { tenantId: tenant.id, no: `SCH-${suffix}`, name: `审批完整性供应商-${suffix}` },
  })
  const finance = await prisma.user.create({
    data: {
      tenantId: tenant.id, name: '付款计划完整性财务', email: `schedule-finance-${suffix}@local.test`,
      password, role: 'FINANCE',
    },
  })
  const manager = await prisma.user.create({
    data: {
      tenantId: tenant.id, storeId: store.id, name: '付款计划越权店长',
      email: `schedule-manager-${suffix}@local.test`, password, role: 'MANAGER',
    },
  })
  const scheduleIds: string[] = []
  const receiptIds: string[] = []
  const triggerName = `schedule_review_guard_${suffix.replace(/[^a-z0-9]/gi, '_')}`
  const functionName = `${triggerName}_fn`

  const makeSchedule = async (label: string) => {
    const receipt = await prisma.receipt.create({
      data: {
        tenantId: tenant.id, no: `RK-SCH-${suffix}-${label}`, storeId: store.id, supplierId: supplier.id,
        deliveryDate: new Date('2026-07-16'), totalAmount: 3000,
        status: 'ACCOUNTED', createdById: finance.id, confirmedAt: new Date('2026-07-16T03:00:00Z'),
      },
    })
    receiptIds.push(receipt.id)
    const schedule = await prisma.paymentSchedule.create({
      data: {
        tenantId: tenant.id, receiptId: receipt.id, supplierId: supplier.id, storeId: store.id,
        amount: 3000, creditDays: 30, confirmedAt: new Date('2026-07-16T03:00:00Z'),
        dueAt: new Date('2026-08-15T03:00:00Z'), needApproval: true, status: 'PENDING_APPROVAL',
      },
    })
    scheduleIds.push(schedule.id)
    return schedule
  }

  try {
    const [financeToken, managerToken] = await Promise.all([login(finance.email), login(manager.email)])
    const concurrentSchedule = await makeSchedule('CONCURRENT')

    assert.equal((await api(`/api/schedules/${concurrentSchedule.id}/approve`, financeToken, {
      method: 'PATCH', body: '{}',
    })).status, 400, '资金审批必须显式提交动作')
    assert.equal((await api(`/api/schedules/${concurrentSchedule.id}/approve`, financeToken, {
      method: 'PATCH', body: JSON.stringify({ action: 'anything' }),
    })).status, 400, '非法审批动作必须拒绝')
    assert.equal((await api(`/api/schedules/${concurrentSchedule.id}/approve`, financeToken, {
      method: 'PATCH', body: JSON.stringify({ action: 'reject' }),
    })).status, 400, '驳回必须填写原因')
    assert.equal((await api(`/api/schedules/${concurrentSchedule.id}/approve`, managerToken, {
      method: 'PATCH', body: JSON.stringify({ action: 'approve' }),
    })).status, 403, '门店角色不得审批付款计划')

    const concurrent = await Promise.all([
      api(`/api/schedules/${concurrentSchedule.id}/approve`, financeToken, {
        method: 'PATCH', body: JSON.stringify({ action: 'approve', note: '并发审批通过' }),
      }),
      api(`/api/schedules/${concurrentSchedule.id}/approve`, financeToken, {
        method: 'PATCH', body: JSON.stringify({ action: 'reject', note: '并发审批驳回' }),
      }),
    ])
    assert.deepEqual(concurrent.map(result => result.status).sort(), [200, 409], '审批与驳回并发只能成功一个')
    const winner = concurrent.find(result => result.status === 200)!
    const winningAction = winner.body.status === 'APPROVED' ? 'approve' : 'reject'
    const winningNote = winningAction === 'approve' ? '并发审批通过' : '并发审批驳回'
    const duplicate = await api(`/api/schedules/${concurrentSchedule.id}/approve`, financeToken, {
      method: 'PATCH', body: JSON.stringify({ action: winningAction, note: winningNote }),
    })
    assert.equal(duplicate.status, 200, JSON.stringify(duplicate.body))
    assert.equal(duplicate.body.duplicated, true)
    assert.equal(await prisma.opLog.count({
      where: { entityType: 'PaymentSchedule', targetId: concurrentSchedule.id },
    }), 1, '重复请求不得重复写审批日志')

    const rollbackSchedule = await makeSchedule('ROLLBACK')
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION "${functionName}"() RETURNS trigger AS $$
      BEGIN
        IF NEW."entityType" = 'PaymentSchedule' AND NEW."targetId" = '${rollbackSchedule.id}' THEN
          RAISE EXCEPTION 'forced schedule review audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `)
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "${triggerName}" BEFORE INSERT ON "op_logs"
      FOR EACH ROW EXECUTE FUNCTION "${functionName}"()
    `)
    const failedReview = await api(`/api/schedules/${rollbackSchedule.id}/approve`, financeToken, {
      method: 'PATCH', body: JSON.stringify({ action: 'approve', note: '故障注入审批' }),
    })
    assert.equal(failedReview.status, 500)
    const rolledBack = await prisma.paymentSchedule.findUniqueOrThrow({ where: { id: rollbackSchedule.id } })
    assert.equal(rolledBack.status, 'PENDING_APPROVAL', '日志失败时审批状态必须回滚')
    assert.equal(rolledBack.approvedById, null)
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON "op_logs"`)
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`)
    const recovered = await api(`/api/schedules/${rollbackSchedule.id}/approve`, financeToken, {
      method: 'PATCH', body: JSON.stringify({ action: 'approve', note: '故障恢复审批' }),
    })
    assert.equal(recovered.status, 200, JSON.stringify(recovered.body))
    assert.equal(recovered.body.duplicated, false)

    const legacySchedule = await makeSchedule('LEGACY')
    const firstLegacyReject = await api(`/api/schedules/${legacySchedule.id}/reject`, financeToken, {
      method: 'PATCH', body: JSON.stringify({ note: '旧接口驳回原因' }),
    })
    const repeatedLegacyReject = await api(`/api/schedules/${legacySchedule.id}/reject`, financeToken, {
      method: 'PATCH', body: JSON.stringify({ note: '旧接口驳回原因' }),
    })
    assert.equal(firstLegacyReject.status, 200, JSON.stringify(firstLegacyReject.body))
    assert.equal(firstLegacyReject.body.duplicated, false)
    assert.equal(repeatedLegacyReject.status, 200, JSON.stringify(repeatedLegacyReject.body))
    assert.equal(repeatedLegacyReject.body.duplicated, true)
    assert.equal(await prisma.opLog.count({
      where: { entityType: 'PaymentSchedule', targetId: legacySchedule.id },
    }), 1, '兼容驳回接口也必须只写一次审计日志')

    await new Promise(resolve => setTimeout(resolve, 300))
    const expectedApprovalNotifications = [winner, recovered]
      .filter(result => result.body.status === 'APPROVED').length
    assert.equal(await prisma.notification.count({
      where: {
        tenantId: tenant.id, type: 'APPROVAL_DONE', createdAt: { gte: startedAt },
        body: { contains: supplier.name },
      },
    }), expectedApprovalNotifications, '幂等重试不得重复发送审批通知')

    console.log(JSON.stringify({
      ok: true,
      strictReviewInput: true,
      roleBoundaryEnforced: true,
      concurrentTerminalTransitionSerialized: true,
      duplicateReviewIdempotent: true,
      auditFailureRollbackAndRetry: true,
      legacyRejectAudited: true,
      duplicateNotificationPrevented: true,
    }))
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON "op_logs"`).catch(() => {})
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`).catch(() => {})
    await new Promise(resolve => setTimeout(resolve, 300))
    await prisma.notification.deleteMany({
      where: { tenantId: tenant.id, createdAt: { gte: startedAt }, body: { contains: supplier.name } },
    })
    await prisma.opLog.deleteMany({
      where: {
        tenantId: tenant.id,
        OR: [{ targetId: { in: scheduleIds } }, { userId: { in: [finance.id, manager.id] } }],
      },
    })
    await prisma.paymentSchedule.deleteMany({ where: { id: { in: scheduleIds } } })
    await prisma.receipt.deleteMany({ where: { id: { in: receiptIds } } })
    await prisma.user.deleteMany({ where: { id: { in: [finance.id, manager.id] } } })
    await prisma.supplier.delete({ where: { id: supplier.id } })
    await prisma.store.delete({ where: { id: store.id } })
  }
}

main().finally(() => prisma.$disconnect())
