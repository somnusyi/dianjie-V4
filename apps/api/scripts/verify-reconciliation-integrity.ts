import 'dotenv/config'
import assert from 'node:assert/strict'
import bcrypt from 'bcryptjs'
import dayjs from 'dayjs'
import { Prisma, prisma } from '@dianjie/db'

const API_BASE = process.env.TEST_API_BASE || 'http://localhost:4444'
const TENANT_SLUG = process.env.PREVIEW_TENANT_SLUG || 'yaohai-test'
const PASSWORD = 'yaohai@123'

function assertLocalOnly() {
  const url = process.env.DATABASE_URL || ''
  if (process.env.PREVIEW_MODE !== 'true' || process.env.NODE_ENV === 'production' || !url.includes('dianjie_v4_local')) {
    throw new Error('安全护栏: 对账完整性验证仅允许本地 PREVIEW_MODE 隔离库')
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
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: TENANT_SLUG } })
  const password = await bcrypt.hash(PASSWORD, 10)
  const period = dayjs().format('YYYYMM')
  const sequenceKey = { tenantId: tenant.id, scope: 'RECONCILIATION', period }
  const previousSequence = await prisma.businessSequence.findUnique({ where: { tenantId_scope_period: sequenceKey } })
  const store = await prisma.store.create({
    data: { tenantId: tenant.id, no: `REC-${suffix}`, name: `对账完整性门店-${suffix}` },
  })
  const supplier = await prisma.supplier.create({
    data: { tenantId: tenant.id, no: `REC-${suffix}`, name: `对账完整性供应商-${suffix}` },
  })
  const otherSupplier = await prisma.supplier.create({
    data: { tenantId: tenant.id, no: `REC-O-${suffix}`, name: `其他对账供应商-${suffix}` },
  })
  const finance = await prisma.user.create({
    data: {
      tenantId: tenant.id, name: '对账完整性财务', email: `recon-finance-${suffix}@local.test`,
      password, role: 'FINANCE',
    },
  })
  const manager = await prisma.user.create({
    data: {
      tenantId: tenant.id, storeId: store.id, name: '对账越权店长',
      email: `recon-manager-${suffix}@local.test`, password, role: 'MANAGER',
    },
  })
  const supplierUser = await prisma.user.create({
    data: {
      tenantId: tenant.id, supplierId: supplier.id, name: '对账供应商',
      email: `recon-supplier-${suffix}@local.test`, password, role: 'SUPPLIER_OWNER',
    },
  })
  const unboundSupplier = await prisma.user.create({
    data: {
      tenantId: tenant.id, name: '未绑定对账供应商',
      email: `recon-unbound-${suffix}@local.test`, password, role: 'SUPPLIER_STAFF',
    },
  })
  const receiptIds: string[] = []
  const reconciliationIds: string[] = []
  const triggerName = `reconciliation_guard_${suffix.replace(/[^a-z0-9]/gi, '_')}`
  const functionName = `${triggerName}_fn`

  const makeReceipt = async (label: string, amount: number, supplierId = supplier.id) => {
    const receipt = await prisma.receipt.create({
      data: {
        tenantId: tenant.id, no: `RK-REC-${suffix}-${label}`, storeId: store.id, supplierId,
        deliveryDate: new Date('2026-07-16'), totalAmount: amount,
        status: 'CONFIRMED', createdById: finance.id, confirmedAt: new Date('2026-07-16T03:00:00Z'),
      },
    })
    receiptIds.push(receipt.id)
    return receipt
  }

  try {
    const [financeToken, managerToken, supplierToken, unboundToken] = await Promise.all([
      login(finance.email), login(manager.email), login(supplierUser.email), login(unboundSupplier.email),
    ])
    assert.equal((await api('/api/reconciliations', managerToken)).status, 403)
    assert.equal((await api('/api/reconciliations', unboundToken)).status, 403)
    assert.equal((await api('/api/reconciliations', managerToken, {
      method: 'POST', body: JSON.stringify({ supplierId: supplier.id, periodStart: '2026-07-01', periodEnd: '2026-07-16' }),
    })).status, 403)
    assert.equal((await api('/api/reconciliations', financeToken, {
      method: 'POST', body: JSON.stringify({ supplierId: supplier.id, periodStart: '2026-02-30', periodEnd: '2026-07-16' }),
    })).status, 400)
    assert.equal((await api('/api/reconciliations', financeToken, {
      method: 'POST', body: JSON.stringify({ supplierId: supplier.id, periodStart: '2026-07-16', periodEnd: '2026-07-01' }),
    })).status, 400)
    assert.equal((await api('/api/reconciliations', financeToken, {
      method: 'POST', body: JSON.stringify({ supplierId: supplier.id, periodStart: '2026-07-01', periodEnd: '2026-07-16', forged: true }),
    })).status, 400)

    const concurrentReceipts = await Promise.all([
      makeReceipt('CONCURRENT-A', 10), makeReceipt('CONCURRENT-B', 20),
    ])
    const createBody = JSON.stringify({
      supplierId: supplier.id, periodStart: '2026-07-01', periodEnd: '2026-07-16',
    })
    const concurrentCreates = await Promise.all([1, 2].map(() => api('/api/reconciliations', financeToken, {
      method: 'POST', body: createBody,
    })))
    assert.deepEqual(concurrentCreates.map(result => result.status).sort(), [201, 409],
      '同一批入库单并发生成只能成功一次')
    const created = concurrentCreates.find(result => result.status === 201)!.body
    reconciliationIds.push(created.id)
    assert.equal(created.items.length, 2)
    assert.equal(Number(created.totalAmount), 30)
    assert.equal(await prisma.reconciliationItem.count({
      where: { receiptId: { in: concurrentReceipts.map(receipt => receipt.id) } },
    }), 2)
    assert.equal(await prisma.receipt.count({
      where: { id: { in: concurrentReceipts.map(receipt => receipt.id) }, status: 'ACCOUNTED' },
    }), 2)
    assert.equal(await prisma.opLog.count({
      where: { entityType: 'Reconciliation', targetId: created.id, action: { startsWith: '生成对账单' } },
    }), 1)

    const duplicateProbe = await prisma.reconciliation.create({
      data: {
        tenantId: tenant.id, no: `DC-PROBE-${suffix}`, supplierId: supplier.id,
        periodStart: new Date('2026-07-01'), periodEnd: new Date('2026-07-16'), totalAmount: 1,
      },
    })
    reconciliationIds.push(duplicateProbe.id)
    let duplicateBlocked = false
    try {
      await prisma.reconciliationItem.create({
        data: { reconciliationId: duplicateProbe.id, receiptId: concurrentReceipts[0].id, amount: 10 },
      })
    } catch (error) {
      duplicateBlocked = error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
    }
    assert.equal(duplicateBlocked, true, '数据库必须硬阻断一张入库单重复挂入对账单')

    const rollbackReceipt = await makeReceipt('ROLLBACK', 40)
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION "${functionName}"() RETURNS trigger AS $$
      BEGIN
        IF NEW."userId" = '${finance.id}' AND NEW."action" LIKE '生成对账单 %' THEN
          RAISE EXCEPTION 'forced reconciliation create audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `)
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "${triggerName}" BEFORE INSERT ON "op_logs"
      FOR EACH ROW EXECUTE FUNCTION "${functionName}"()
    `)
    const failedCreate = await api('/api/reconciliations', financeToken, {
      method: 'POST', body: createBody,
    })
    assert.equal(failedCreate.status, 500)
    assert.equal((await prisma.receipt.findUniqueOrThrow({ where: { id: rollbackReceipt.id } })).status, 'CONFIRMED')
    assert.equal(await prisma.reconciliationItem.count({ where: { receiptId: rollbackReceipt.id } }), 0)
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON "op_logs"`)
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`)
    const recoveredCreate = await api('/api/reconciliations', financeToken, {
      method: 'POST', body: createBody,
    })
    assert.equal(recoveredCreate.status, 201, JSON.stringify(recoveredCreate.body))
    reconciliationIds.push(recoveredCreate.body.id)

    assert.equal((await api(`/api/reconciliations/${created.id}/review`, financeToken, {
      method: 'PATCH', body: '{}',
    })).status, 400)
    assert.equal((await api(`/api/reconciliations/${created.id}/review`, financeToken, {
      method: 'PATCH', body: JSON.stringify({ action: 'reject' }),
    })).status, 400)
    assert.equal((await api(`/api/reconciliations/${created.id}/review`, financeToken, {
      method: 'PATCH', body: JSON.stringify({ action: 'invalid' }),
    })).status, 400)

    const concurrentReviews = await Promise.all([
      api(`/api/reconciliations/${created.id}/review`, financeToken, {
        method: 'PATCH', body: JSON.stringify({ action: 'approve', note: '并发审核通过' }),
      }),
      api(`/api/reconciliations/${created.id}/review`, financeToken, {
        method: 'PATCH', body: JSON.stringify({ action: 'reject', note: '并发审核驳回' }),
      }),
    ])
    assert.deepEqual(concurrentReviews.map(result => result.status).sort(), [200, 409])
    const reviewWinner = concurrentReviews.find(result => result.status === 200)!
    const winningAction = reviewWinner.body.status === 'APPROVED' ? 'approve' : 'reject'
    const winningNote = winningAction === 'approve' ? '并发审核通过' : '并发审核驳回'
    const repeatedReview = await api(`/api/reconciliations/${created.id}/review`, financeToken, {
      method: 'PATCH', body: JSON.stringify({ action: winningAction, note: winningNote }),
    })
    assert.equal(repeatedReview.status, 200, JSON.stringify(repeatedReview.body))
    assert.equal(repeatedReview.body.duplicated, true)
    assert.equal(await prisma.opLog.count({
      where: { entityType: 'Reconciliation', targetId: created.id, metadata: { path: ['action'], equals: winningAction } },
    }), 1)

    const rollbackReviewId = recoveredCreate.body.id as string
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION "${functionName}"() RETURNS trigger AS $$
      BEGIN
        IF NEW."entityType" = 'Reconciliation' AND NEW."targetId" = '${rollbackReviewId}'
           AND NEW."action" LIKE '审核通过对账单 %' THEN
          RAISE EXCEPTION 'forced reconciliation review audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `)
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "${triggerName}" BEFORE INSERT ON "op_logs"
      FOR EACH ROW EXECUTE FUNCTION "${functionName}"()
    `)
    assert.equal((await api(`/api/reconciliations/${rollbackReviewId}/review`, financeToken, {
      method: 'PATCH', body: JSON.stringify({ action: 'approve', note: '审核故障注入' }),
    })).status, 500)
    const rolledBackReview = await prisma.reconciliation.findUniqueOrThrow({ where: { id: rollbackReviewId } })
    assert.equal(rolledBackReview.status, 'DRAFT')
    assert.equal(rolledBackReview.reviewedAt, null)
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON "op_logs"`)
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`)
    assert.equal((await api(`/api/reconciliations/${rollbackReviewId}/review`, financeToken, {
      method: 'PATCH', body: JSON.stringify({ action: 'approve', note: '审核故障恢复' }),
    })).status, 200)

    const foreignReceipt = await makeReceipt('FOREIGN', 50, otherSupplier.id)
    const foreignRecon = await prisma.reconciliation.create({
      data: {
        tenantId: tenant.id, no: `DC-FOREIGN-${suffix}`, supplierId: otherSupplier.id,
        periodStart: new Date('2026-07-01'), periodEnd: new Date('2026-07-16'), totalAmount: 50,
        items: { create: [{ receiptId: foreignReceipt.id, amount: 50 }] },
      },
    })
    reconciliationIds.push(foreignRecon.id)
    const supplierList = await api('/api/reconciliations', supplierToken)
    assert.equal(supplierList.status, 200)
    assert.ok(supplierList.body.length >= 1)
    assert.ok(supplierList.body.every((recon: any) => recon.supplierId === supplier.id),
      '供应商只能读取自己的对账单')

    console.log(JSON.stringify({
      ok: true,
      roleAndSupplierIsolation: true,
      strictPeriodInput: true,
      concurrentCreateSerialized: true,
      receiptUniquenessDatabaseEnforced: true,
      createAuditRollbackAndRetry: true,
      concurrentReviewSerialized: true,
      duplicateReviewIdempotent: true,
      reviewAuditRollbackAndRetry: true,
    }))
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON "op_logs"`).catch(() => {})
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`).catch(() => {})
    await prisma.opLog.deleteMany({
      where: {
        tenantId: tenant.id,
        OR: [
          { targetId: { in: reconciliationIds } },
          { userId: { in: [finance.id, manager.id, supplierUser.id, unboundSupplier.id] } },
        ],
      },
    })
    await prisma.reconciliation.deleteMany({ where: { id: { in: reconciliationIds } } })
    await prisma.receipt.deleteMany({ where: { id: { in: receiptIds } } })
    await prisma.user.deleteMany({
      where: { id: { in: [finance.id, manager.id, supplierUser.id, unboundSupplier.id] } },
    })
    await prisma.supplier.deleteMany({ where: { id: { in: [supplier.id, otherSupplier.id] } } })
    await prisma.store.delete({ where: { id: store.id } })
    if (previousSequence) {
      await prisma.businessSequence.update({
        where: { tenantId_scope_period: sequenceKey }, data: { value: previousSequence.value },
      })
    } else {
      await prisma.businessSequence.deleteMany({ where: sequenceKey })
    }
  }
}

main().finally(() => prisma.$disconnect())
