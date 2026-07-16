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
    throw new Error('安全护栏: 付款申请完整性验证仅允许本地 PREVIEW_MODE 隔离库')
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
  const finance = await prisma.user.create({
    data: {
      tenantId: tenant.id, name: '付款申请完整性财务', email: `payreq-finance-${suffix}@local.test`,
      password, role: 'FINANCE',
    },
  })
  const manager = await prisma.user.create({
    data: {
      tenantId: tenant.id, name: '付款申请越权店长', email: `payreq-manager-${suffix}@local.test`,
      password, role: 'MANAGER',
    },
  })
  const bankAccount = await prisma.cashAccount.create({
    data: {
      tenantId: tenant.id, name: `中国银行1674-完整性验证-${suffix}`, type: 'BANK',
      bankName: '中国银行', accountNo: `LOCAL${suffix}1674`, balance: 1000, status: 'ACTIVE',
    },
  })
  const cashAccount = await prisma.cashAccount.create({
    data: {
      tenantId: tenant.id, name: `库存现金-完整性验证-${suffix}`, type: 'CASH', balance: 100, status: 'ACTIVE',
    },
  })

  const docIds: string[] = []
  const makeDoc = async (label: string, amount: number, status: 'APPROVED' | 'PENDING' = 'APPROVED') => {
    const doc = await prisma.document.create({
      data: {
        tenantId: tenant.id, no: `PAYREQ-${suffix}-${label}`, type: 'PAYMENT_REQUEST',
        title: `付款申请验证-${label}`, amount, initiatorId: manager.id, status,
        finalizedAt: status === 'APPROVED' ? new Date() : null,
        payload: {
          payeeName: `收款方-${label}`, usage: 'repair', usageLabel: '维修费',
          accountCode: '560113', accountName: '维修费', bankFrom: '100201',
        },
      },
    })
    docIds.push(doc.id)
    return doc
  }

  const concurrentDoc = await makeDoc('CONCURRENT', 100)
  const rollbackDoc = await makeDoc('ROLLBACK', 20)
  const cashDoc = await makeDoc('CASH', 30)
  const missingAccountDoc = await makeDoc('MISSING', 15)
  const cancelDoc = await makeDoc('CANCEL', 5, 'PENDING')
  const triggerName = `payment_request_guard_${suffix.replace(/[^a-z0-9]/gi, '_')}`
  const functionName = `${triggerName}_fn`

  try {
    const [financeToken, managerToken] = await Promise.all([login(finance.email), login(manager.email)])

    const invalidPrecision = await api('/api/payment-requests', managerToken, {
      method: 'POST', body: JSON.stringify({ payeeName: '测试', amount: 1.001, usage: 'repair' }),
    })
    assert.equal(invalidPrecision.status, 400)
    const customByManager = await api('/api/payment-requests', managerToken, {
      method: 'POST',
      body: JSON.stringify({
        payeeName: '越权自定义科目', amount: 10, usage: 'repair',
        customAccountCode: '9999', customAccountName: '越权科目',
      }),
    })
    assert.equal(customByManager.status, 403)
    assert.equal((await api('/api/payment-requests?status=NOT_A_STATUS', financeToken)).status, 400)
    assert.equal((await api('/api/payment-requests?page=NaN', financeToken)).status, 400)
    assert.equal((await api('/api/payment-requests?status=ALL&pageSize=200', financeToken)).status, 200)
    assert.equal((await api(`/api/payment-requests/${concurrentDoc.id}/mark-paid`, financeToken, {
      method: 'PATCH', body: JSON.stringify({ bankFrom: '100201', unexpected: true }),
    })).status, 400)

    const concurrent = await Promise.all([
      api(`/api/payment-requests/${concurrentDoc.id}/mark-paid`, financeToken, {
        method: 'PATCH', body: JSON.stringify({ bankFrom: '100201', bankTxNo: `TX-${suffix}-A` }),
      }),
      api(`/api/payment-requests/${concurrentDoc.id}/mark-paid`, financeToken, {
        method: 'PATCH', body: JSON.stringify({ bankFrom: '100201', bankTxNo: `TX-${suffix}-A` }),
      }),
    ])
    concurrent.forEach(result => assert.equal(result.status, 200, JSON.stringify(result.body)))
    assert.equal(concurrent.filter(result => result.body.duplicated === true).length, 1)
    assert.equal(Number((await prisma.cashAccount.findUniqueOrThrow({ where: { id: bankAccount.id } })).balance), 900)
    assert.equal(await prisma.cashTransaction.count({
      where: { refType: 'PaymentRequest', refId: concurrentDoc.id },
    }), 1)
    assert.equal(await prisma.voucher.count({
      where: { tenantId: tenant.id, sourceType: 'PaymentRequest', sourceId: concurrentDoc.id },
    }), 1)
    const paidPayload: any = (await prisma.document.findUniqueOrThrow({ where: { id: concurrentDoc.id } })).payload
    assert.equal(paidPayload.cashAccountId, bankAccount.id)
    assert.ok(paidPayload.cashTransactionId)
    assert.ok(paidPayload.voucherId)

    const missingAccount = await api(`/api/payment-requests/${missingAccountDoc.id}/mark-paid`, financeToken, {
      method: 'PATCH', body: JSON.stringify({ bankFrom: '100202' }),
    })
    assert.equal(missingAccount.status, 409)
    assert.equal(await prisma.cashTransaction.count({
      where: { refType: 'PaymentRequest', refId: missingAccountDoc.id },
    }), 0)
    assert.equal((await prisma.document.findUniqueOrThrow({ where: { id: missingAccountDoc.id } })).payload?.hasOwnProperty('paidAt'), false)

    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION "${functionName}"() RETURNS trigger AS $$
      BEGIN
        IF NEW."entityType" = 'Document' AND NEW."targetId" = '${rollbackDoc.id}' THEN
          RAISE EXCEPTION 'forced payment request audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `)
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "${triggerName}"
      BEFORE INSERT ON "op_logs"
      FOR EACH ROW EXECUTE FUNCTION "${functionName}"()
    `)
    const failedAudit = await api(`/api/payment-requests/${rollbackDoc.id}/mark-paid`, financeToken, {
      method: 'PATCH', body: JSON.stringify({ bankFrom: '100201' }),
    })
    assert.equal(failedAudit.status, 500)
    assert.equal(Number((await prisma.cashAccount.findUniqueOrThrow({ where: { id: bankAccount.id } })).balance), 900)
    assert.equal(await prisma.cashTransaction.count({ where: { refType: 'PaymentRequest', refId: rollbackDoc.id } }), 0)
    assert.equal((await prisma.document.findUniqueOrThrow({ where: { id: rollbackDoc.id } })).payload?.hasOwnProperty('paidAt'), false)
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON "op_logs"`)
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`)

    const recovered = await api(`/api/payment-requests/${rollbackDoc.id}/mark-paid`, financeToken, {
      method: 'PATCH', body: JSON.stringify({ bankFrom: '100201' }),
    })
    assert.equal(recovered.status, 200, JSON.stringify(recovered.body))
    assert.equal(Number((await prisma.cashAccount.findUniqueOrThrow({ where: { id: bankAccount.id } })).balance), 880)

    const paidCash = await api(`/api/payment-requests/${cashDoc.id}/mark-paid`, financeToken, {
      method: 'PATCH', body: JSON.stringify({ bankFrom: '1001' }),
    })
    assert.equal(paidCash.status, 200, JSON.stringify(paidCash.body))
    assert.equal(Number((await prisma.cashAccount.findUniqueOrThrow({ where: { id: cashAccount.id } })).balance), 70)
    assert.equal(Number((await prisma.cashAccount.findUniqueOrThrow({ where: { id: bankAccount.id } })).balance), 880)
    const cashPayload: any = (await prisma.document.findUniqueOrThrow({ where: { id: cashDoc.id } })).payload
    assert.equal(cashPayload.cashAccountId, cashAccount.id)

    const canceled = await Promise.all([
      api(`/api/payment-requests/${cancelDoc.id}/cancel`, managerToken, { method: 'PATCH', body: '{}' }),
      api(`/api/payment-requests/${cancelDoc.id}/cancel`, managerToken, { method: 'PATCH', body: '{}' }),
    ])
    canceled.forEach(result => assert.equal(result.status, 200, JSON.stringify(result.body)))
    assert.equal(canceled.filter(result => result.body.duplicated === true).length, 1)
    assert.equal((await prisma.document.findUniqueOrThrow({ where: { id: cancelDoc.id } })).status, 'CANCELED')
    assert.equal(await prisma.opLog.count({
      where: { targetId: cancelDoc.id, action: { startsWith: '撤回付款申请' } },
    }), 1)

    console.log(JSON.stringify({
      ok: true,
      strictInputAndRoleBoundaries: true,
      duplicatePaymentIdempotent: true,
      exactCashAccountRouting: true,
      cashBalanceAndLedgerAtomic: true,
      auditFailureRollbackAndRetry: true,
      concurrentCancelIdempotent: true,
    }))
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON "op_logs"`).catch(() => {})
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`).catch(() => {})
    await prisma.voucher.deleteMany({
      where: { tenantId: tenant.id, sourceType: 'PaymentRequest', sourceId: { in: docIds } },
    })
    await prisma.voucherGenerationFailure.deleteMany({
      where: { tenantId: tenant.id, sourceType: 'PaymentRequest', sourceId: { in: docIds } },
    })
    await prisma.cashTransaction.deleteMany({ where: { refType: 'PaymentRequest', refId: { in: docIds } } })
    await prisma.opLog.deleteMany({
      where: {
        tenantId: tenant.id,
        OR: [{ targetId: { in: docIds } }, { userId: { in: [finance.id, manager.id] } }],
      },
    })
    await prisma.document.deleteMany({ where: { id: { in: docIds } } })
    await prisma.cashAccount.deleteMany({ where: { id: { in: [bankAccount.id, cashAccount.id] } } })
    await prisma.user.deleteMany({ where: { id: { in: [finance.id, manager.id] } } })
  }
}

main().finally(() => prisma.$disconnect())
