import 'dotenv/config'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import { prisma } from '@dianjie/db'

const API_BASE = process.env.TEST_API_BASE || 'http://localhost:4444'
const TENANT_SLUG = process.env.PREVIEW_TENANT_SLUG || 'yaohai-test'
const PASSWORD = 'yaohai@123'

function assertLocalOnly() {
  const url = process.env.DATABASE_URL || ''
  if (process.env.PREVIEW_MODE !== 'true' || process.env.NODE_ENV === 'production' || !url.includes('dianjie_v4_local')) {
    throw new Error('安全护栏: 资金台账完整性验证仅允许本地 PREVIEW_MODE 隔离库')
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
      tenantId: tenant.id, name: '资金台账完整性财务', email: `cashbook-finance-${suffix}@local.test`,
      password, role: 'FINANCE',
    },
  })
  const accountIds: string[] = []
  const operationIds: string[] = []
  const auditTrigger = `cashbook_audit_guard_${suffix.replace(/[^a-z0-9]/gi, '_')}`
  const auditFunction = `${auditTrigger}_fn`
  const today = '2026-07-16'

  try {
    const token = await login(finance.email)
    assert.equal((await api('/api/cashbook/internal-transfer', token, {
      method: 'POST', body: '{}',
    })).status, 503, '预览环境不得调用真实银行转账')
    assert.equal((await api('/api/cashbook/sync-from-cmb', token, {
      method: 'POST', body: '{}',
    })).status, 503, '预览环境不得调用真实银行流水同步')
    assert.equal((await api('/api/schedules?status=FAILED', token)).status, 400,
      '非法账期状态必须返回 400 而不是 Prisma 500')
    assert.equal((await api('/api/schedules?status=OVERDUE', token)).status, 200)
    assert.equal((await api('/api/cashbook/accounts', token, {
      method: 'POST', body: JSON.stringify({ name: '非法支付账户', type: 'BITCOIN' }),
    })).status, 400)
    assert.equal((await api('/api/cashbook/accounts', token, {
      method: 'POST', body: JSON.stringify({ name: '非法招行钱包', type: 'ALIPAY', cmbBindAccount: '123456789012' }),
    })).status, 400)

    const created = await api('/api/cashbook/accounts', token, {
      method: 'POST', body: JSON.stringify({
        name: `资金并发账户-${suffix}`, type: 'BANK', bankName: '本地验证银行', accountNo: `LOCAL-CASH-${suffix}`,
      }),
    })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    accountIds.push(created.body.id)
    await prisma.cashAccount.update({ where: { id: created.body.id }, data: { balance: 100 } })
    assert.equal((await api('/api/cashbook/accounts', token, {
      method: 'POST', body: JSON.stringify({ name: `资金并发账户-${suffix}`, type: 'BANK' }),
    })).status, 409, '活动账户名称不得重复')

    const concurrentAccountName = `并发同名账户-${suffix}`
    const concurrentAccounts = await Promise.all([1, 2].map(() => api('/api/cashbook/accounts', token, {
      method: 'POST', body: JSON.stringify({ name: concurrentAccountName, type: 'CASH' }),
    })))
    assert.deepEqual(concurrentAccounts.map(result => result.status).sort(), [201, 409])
    accountIds.push(concurrentAccounts.find(result => result.status === 201)!.body.id)

    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION "${auditFunction}"() RETURNS trigger AS $$
      BEGIN
        IF NEW."entityType" = 'CashAccount' AND NEW."action" LIKE '%审计回滚账户-${suffix}%' THEN
          RAISE EXCEPTION 'forced cash account audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `)
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "${auditTrigger}" BEFORE INSERT ON "op_logs"
      FOR EACH ROW EXECUTE FUNCTION "${auditFunction}"()
    `)
    const failedAccount = await api('/api/cashbook/accounts', token, {
      method: 'POST', body: JSON.stringify({ name: `审计回滚账户-${suffix}`, type: 'CASH' }),
    })
    assert.equal(failedAccount.status, 500)
    assert.equal(await prisma.cashAccount.count({ where: { tenantId: tenant.id, name: `审计回滚账户-${suffix}` } }), 0)
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${auditTrigger}" ON "op_logs"`)
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${auditFunction}"()`)

    const operation = crypto.randomUUID()
    operationIds.push(operation)
    const duplicateWrites = await Promise.all([1, 2].map(() => api('/api/cashbook/transactions', token, {
      method: 'POST', body: JSON.stringify({
        operationId: operation, accountId: created.body.id, direction: 1,
        category: '完整性验证收入', amount: 20, txDate: today,
      }),
    })))
    assert.deepEqual(duplicateWrites.map(result => result.status).sort(), [200, 201])
    assert.equal(duplicateWrites.filter(result => result.body.duplicated === true).length, 1)
    assert.equal(Number((await prisma.cashAccount.findUniqueOrThrow({ where: { id: created.body.id } })).balance), 120)
    assert.equal(await prisma.cashTransaction.count({ where: { refType: 'MANUAL_CASHBOOK', refId: operation } }), 1)
    assert.equal((await api('/api/cashbook/transactions', token, {
      method: 'POST', body: JSON.stringify({
        operationId: operation, accountId: created.body.id, direction: 1,
        category: '完整性验证收入', amount: 21, txDate: today,
      }),
    })).status, 409, '相同 operationId 不得覆盖金额')

    const incomeOperation = crypto.randomUUID()
    const expenseOperation = crypto.randomUUID()
    operationIds.push(incomeOperation, expenseOperation)
    const concurrentLedger = await Promise.all([
      api('/api/cashbook/transactions', token, {
        method: 'POST', body: JSON.stringify({
          operationId: incomeOperation, accountId: created.body.id, direction: 1,
          category: '并发收入', amount: 30, txDate: today,
        }),
      }),
      api('/api/cashbook/transactions', token, {
        method: 'POST', body: JSON.stringify({
          operationId: expenseOperation, accountId: created.body.id, direction: -1,
          category: '并发支出', amount: 40, txDate: today,
        }),
      }),
    ])
    concurrentLedger.forEach(result => assert.equal(result.status, 201, JSON.stringify(result.body)))
    assert.equal(Number((await prisma.cashAccount.findUniqueOrThrow({ where: { id: created.body.id } })).balance), 110)
    const balanceSnapshots = (await prisma.cashTransaction.findMany({
      where: { refType: 'MANUAL_CASHBOOK', refId: { in: [incomeOperation, expenseOperation] } },
      select: { balanceAfter: true }, orderBy: { createdAt: 'asc' },
    })).map(item => Number(item.balanceAfter))
    assert.ok(balanceSnapshots.includes(110), '最后一笔余额快照必须等于最终余额')

    assert.equal((await api('/api/cashbook/transactions?direction=0', token)).status, 400)
    assert.equal((await api('/api/cashbook/transactions?month=2026-13', token)).status, 400)
    assert.equal((await api('/api/cashbook/transactions', token, {
      method: 'POST', body: JSON.stringify({
        operationId: crypto.randomUUID(), accountId: created.body.id, direction: 1,
        category: '伪造关联', amount: 1, txDate: today, refType: 'CapitalExpense',
      }),
    })).status, 400, '手工流水不得伪造系统 refType')
    assert.equal((await api('/api/cashbook/transactions', token, {
      method: 'POST', body: JSON.stringify({
        operationId: crypto.randomUUID(), accountId: created.body.id, direction: 1,
        category: '未来流水', amount: 1, txDate: '2099-01-01',
      }),
    })).status, 400)

    const rollbackOperation = crypto.randomUUID()
    operationIds.push(rollbackOperation)
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION "${auditFunction}"() RETURNS trigger AS $$
      BEGIN
        IF NEW."entityType" = 'CashTransaction' AND NEW."action" LIKE '%审计故障收入%' THEN
          RAISE EXCEPTION 'forced manual cash audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `)
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "${auditTrigger}" BEFORE INSERT ON "op_logs"
      FOR EACH ROW EXECUTE FUNCTION "${auditFunction}"()
    `)
    const failedTransaction = await api('/api/cashbook/transactions', token, {
      method: 'POST', body: JSON.stringify({
        operationId: rollbackOperation, accountId: created.body.id, direction: 1,
        category: '审计故障收入', amount: 10, txDate: today,
      }),
    })
    assert.equal(failedTransaction.status, 500)
    assert.equal(Number((await prisma.cashAccount.findUniqueOrThrow({ where: { id: created.body.id } })).balance), 110)
    assert.equal(await prisma.cashTransaction.count({ where: { refType: 'MANUAL_CASHBOOK', refId: rollbackOperation } }), 0)
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${auditTrigger}" ON "op_logs"`)
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${auditFunction}"()`)
    assert.equal((await api('/api/cashbook/transactions', token, {
      method: 'POST', body: JSON.stringify({
        operationId: rollbackOperation, accountId: created.body.id, direction: 1,
        category: '审计故障收入', amount: 10, txDate: today,
      }),
    })).status, 201)
    assert.equal(Number((await prisma.cashAccount.findUniqueOrThrow({ where: { id: created.body.id } })).balance), 120)
    assert.equal((await api(`/api/cashbook/accounts/${created.body.id}`, token, { method: 'DELETE' })).status, 409,
      '非零余额账户不得停用')

    const zeroAccount = await api('/api/cashbook/accounts', token, {
      method: 'POST', body: JSON.stringify({ name: `零余额停用-${suffix}`, type: 'CASH' }),
    })
    assert.equal(zeroAccount.status, 201)
    accountIds.push(zeroAccount.body.id)
    const firstDisable = await api(`/api/cashbook/accounts/${zeroAccount.body.id}`, token, { method: 'DELETE' })
    const retryDisable = await api(`/api/cashbook/accounts/${zeroAccount.body.id}`, token, { method: 'DELETE' })
    assert.equal(firstDisable.status, 200)
    assert.equal(retryDisable.status, 200)
    assert.equal(retryDisable.body.duplicated, true)
    assert.equal(await prisma.opLog.count({
      where: { entityType: 'CashAccount', targetId: zeroAccount.body.id, action: { startsWith: '停用资金账户' } },
    }), 1)

    console.log(JSON.stringify({
      ok: true,
      accountInputAndIdentifierGuarded: true,
      accountAuditAtomic: true,
      manualOperationDurablyIdempotent: true,
      concurrentBalanceSerialized: true,
      manualReferenceForgeryBlocked: true,
      transactionAuditRollbackExact: true,
      nonzeroAccountDisableBlocked: true,
      previewBankCallsBlocked: true,
    }))
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${auditTrigger}" ON "op_logs"`).catch(() => {})
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${auditFunction}"()`).catch(() => {})
    await prisma.cashTransaction.deleteMany({
      where: { tenantId: tenant.id, OR: [{ refType: 'MANUAL_CASHBOOK', refId: { in: operationIds } }, { createdById: finance.id }] },
    })
    await prisma.opLog.deleteMany({
      where: { tenantId: tenant.id, OR: [{ userId: finance.id }, { targetId: { in: accountIds } }] },
    })
    await prisma.cashAccount.deleteMany({ where: { id: { in: accountIds } } })
    await prisma.user.delete({ where: { id: finance.id } })
  }
}

main().finally(() => prisma.$disconnect())
