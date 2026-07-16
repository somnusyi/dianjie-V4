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
    throw new Error('安全护栏: 备用金完整性验证仅允许本地 PREVIEW_MODE 隔离库')
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
      tenantId: tenant.id, name: '备用金完整性财务', email: `petty-finance-${suffix}@local.test`,
      password, role: 'FINANCE',
    },
  })
  const stores = await Promise.all(['并发发放', '审计回滚', '报账关账', '关账回滚'].map((name, index) =>
    prisma.store.create({
      data: { tenantId: tenant.id, no: `PC-${index}-${suffix}`, name: `${name}验证店-${suffix}` },
    }),
  ))
  const manager = await prisma.user.create({
    data: {
      tenantId: tenant.id, storeId: stores[2].id, name: '备用金完整性店长',
      email: `petty-manager-${suffix}@local.test`, password, role: 'MANAGER',
    },
  })
  const bank = await prisma.cashAccount.create({
    data: {
      tenantId: tenant.id, name: `中国银行1674-备用金验证-${suffix}`, type: 'BANK',
      bankName: '中国银行', accountNo: `LOCAL${suffix}1674`, balance: 1000, status: 'ACTIVE',
    },
  })
  const cash = await prisma.cashAccount.create({
    data: { tenantId: tenant.id, name: `库存现金-备用金验证-${suffix}`, type: 'CASH', balance: 100, status: 'ACTIVE' },
  })
  const pettyIds: string[] = []
  const makeApproved = async (storeIndex: number, amount: number) => {
    const item = await prisma.pettyCash.create({
      data: {
        tenantId: tenant.id, storeId: stores[storeIndex].id, month: '2026-07',
        requestedAmount: amount, requestedById: manager.id, requestNote: `VERIFY-${suffix}`,
        approvedAmount: amount, approvedById: finance.id, approvedAt: new Date(), status: 'APPROVED',
      },
    })
    pettyIds.push(item.id)
    return item
  }
  const concurrentPay = await makeApproved(0, 100)
  const rollbackPay = await makeApproved(1, 20)
  const reconcileItem = await makeApproved(2, 100)
  const closeRollbackItem = await makeApproved(3, 30)
  const payDate = '2026-07-16'
  const expenseDate = '2026-07-15'
  const auditTrigger = `petty_cash_audit_guard_${suffix.replace(/[^a-z0-9]/gi, '_')}`
  const auditFunction = `${auditTrigger}_fn`

  try {
    const financeToken = await login(finance.email)
    const managerToken = await login(manager.email)

    assert.equal((await api(`/api/petty-cash/${concurrentPay.id}/pay`, financeToken, {
      method: 'PATCH', body: JSON.stringify({ paymentMethod: '转账', paymentDate: payDate }),
    })).status, 400, '发放必须选择账户')
    assert.equal((await api(`/api/petty-cash/${concurrentPay.id}/pay`, financeToken, {
      method: 'PATCH', body: JSON.stringify({ paymentMethod: '转账', accountId: cash.id, paymentDate: payDate }),
    })).status, 409, '转账不得选择现金账户')

    const concurrent = await Promise.all([1, 2].map(() => api(`/api/petty-cash/${concurrentPay.id}/pay`, financeToken, {
      method: 'PATCH',
      body: JSON.stringify({ paymentMethod: '转账', accountId: bank.id, bankTxNo: `PC-${suffix}-1`, paymentDate: payDate }),
    })))
    concurrent.forEach(result => assert.equal(result.status, 200, JSON.stringify(result.body)))
    assert.equal(concurrent.filter(result => result.body.duplicated === true).length, 1)
    assert.equal(Number((await prisma.cashAccount.findUniqueOrThrow({ where: { id: bank.id } })).balance), 900)
    assert.equal(await prisma.cashTransaction.count({
      where: { tenantId: tenant.id, refType: 'PettyCashPay', refId: concurrentPay.id },
    }), 1)
    assert.equal(await prisma.voucher.count({
      where: { tenantId: tenant.id, sourceType: 'PettyCashPay', sourceId: concurrentPay.id },
    }), 1)
    const payVoucher = await prisma.voucher.findFirstOrThrow({
      where: { tenantId: tenant.id, sourceType: 'PettyCashPay', sourceId: concurrentPay.id },
      include: { entries: true },
    })
    assert.ok(payVoucher.entries.some(entry => entry.accountCode === '100201' && Number(entry.credit) === 100))
    assert.equal((await api(`/api/petty-cash/${concurrentPay.id}/pay`, financeToken, {
      method: 'PATCH',
      body: JSON.stringify({ paymentMethod: '转账', accountId: bank.id, bankTxNo: 'CHANGED', paymentDate: payDate }),
    })).status, 409, '已发放参数不得覆盖')

    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION "${auditFunction}"() RETURNS trigger AS $$
      BEGIN
        IF NEW."entityType" = 'PettyCash' AND NEW."targetId" = '${rollbackPay.id}' THEN
          RAISE EXCEPTION 'forced petty cash audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `)
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "${auditTrigger}" BEFORE INSERT ON "op_logs"
      FOR EACH ROW EXECUTE FUNCTION "${auditFunction}"()
    `)
    const failedPay = await api(`/api/petty-cash/${rollbackPay.id}/pay`, financeToken, {
      method: 'PATCH', body: JSON.stringify({ paymentMethod: '转账', accountId: bank.id, paymentDate: payDate }),
    })
    assert.equal(failedPay.status, 500)
    assert.equal((await prisma.pettyCash.findUniqueOrThrow({ where: { id: rollbackPay.id } })).status, 'APPROVED')
    assert.equal(Number((await prisma.cashAccount.findUniqueOrThrow({ where: { id: bank.id } })).balance), 900)
    assert.equal(await prisma.cashTransaction.count({ where: { refType: 'PettyCashPay', refId: rollbackPay.id } }), 0)
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${auditTrigger}" ON "op_logs"`)
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${auditFunction}"()`)
    assert.equal((await api(`/api/petty-cash/${rollbackPay.id}/pay`, financeToken, {
      method: 'PATCH', body: JSON.stringify({ paymentMethod: '转账', accountId: bank.id, paymentDate: payDate }),
    })).status, 200)
    assert.equal(Number((await prisma.cashAccount.findUniqueOrThrow({ where: { id: bank.id } })).balance), 880)

    assert.equal((await api(`/api/petty-cash/${reconcileItem.id}/pay`, financeToken, {
      method: 'PATCH', body: JSON.stringify({ paymentMethod: '转账', accountId: bank.id, paymentDate: payDate }),
    })).status, 200)
    assert.equal(Number((await prisma.cashAccount.findUniqueOrThrow({ where: { id: bank.id } })).balance), 780)
    const concurrentExpenses = await Promise.all([1, 2].map(index => api(
      `/api/petty-cash/${reconcileItem.id}/expenses`, managerToken,
      {
        method: 'POST',
        body: JSON.stringify({ date: expenseDate, category: `并发开支-${index}`, amount: 60 }),
      },
    )))
    assert.deepEqual(concurrentExpenses.map(result => result.status).sort(), [201, 409])
    assert.equal(await prisma.pettyCashExpense.count({ where: { pettyCashId: reconcileItem.id } }), 1)
    assert.equal((await api(`/api/petty-cash/${reconcileItem.id}/expenses`, managerToken, {
      method: 'POST', body: JSON.stringify({ date: '2026-06-30', category: '跨月', amount: 1 }),
    })).status, 409)
    assert.equal((await api(`/api/petty-cash/${reconcileItem.id}/reconcile`, managerToken, {
      method: 'PATCH', body: JSON.stringify({ spentAmount: 50, returnedAmount: 50 }),
    })).status, 409, '申报花销不能脱离开支明细')
    const reconciled = await api(`/api/petty-cash/${reconcileItem.id}/reconcile`, managerToken, {
      method: 'PATCH', body: JSON.stringify({ spentAmount: 60, returnedAmount: 40, reconcileNote: '完整性验证' }),
    })
    assert.equal(reconciled.status, 200, JSON.stringify(reconciled.body))
    assert.equal((await api(`/api/petty-cash/${reconcileItem.id}/expenses`, managerToken, {
      method: 'POST', body: JSON.stringify({ date: expenseDate, category: '报账后修改', amount: 1 }),
    })).status, 409)

    const concurrentClose = await Promise.all([1, 2].map(() => api(`/api/petty-cash/${reconcileItem.id}/close`, financeToken, {
      method: 'PATCH', body: JSON.stringify({ returnAccountId: bank.id, returnDate: payDate }),
    })))
    concurrentClose.forEach(result => assert.equal(result.status, 200, JSON.stringify(result.body)))
    assert.equal(concurrentClose.filter(result => result.body.duplicated === true).length, 1)
    assert.equal(Number((await prisma.cashAccount.findUniqueOrThrow({ where: { id: bank.id } })).balance), 820)
    assert.equal(await prisma.cashTransaction.count({
      where: { tenantId: tenant.id, refType: 'PettyCashReturn', refId: reconcileItem.id },
    }), 1)
    const closeVoucher = await prisma.voucher.findFirstOrThrow({
      where: { tenantId: tenant.id, sourceType: 'PettyCashClose', sourceId: reconcileItem.id },
      include: { entries: true },
    })
    assert.ok(closeVoucher.entries.some(entry => entry.accountCode === '100201' && Number(entry.debit) === 40))
    assert.ok(closeVoucher.entries.some(entry => entry.accountCode === '560125' && Number(entry.debit) === 60))

    assert.equal((await api(`/api/petty-cash/${closeRollbackItem.id}/pay`, financeToken, {
      method: 'PATCH', body: JSON.stringify({ paymentMethod: '现金', accountId: cash.id, paymentDate: payDate }),
    })).status, 200)
    assert.equal((await api(`/api/petty-cash/${closeRollbackItem.id}/expenses`, financeToken, {
      method: 'POST', body: JSON.stringify({ date: expenseDate, category: '关账回滚开支', amount: 20 }),
    })).status, 201)
    assert.equal((await api(`/api/petty-cash/${closeRollbackItem.id}/reconcile`, financeToken, {
      method: 'PATCH', body: JSON.stringify({ spentAmount: 20, returnedAmount: 10 }),
    })).status, 200)
    const cashBeforeFailedClose = Number((await prisma.cashAccount.findUniqueOrThrow({ where: { id: cash.id } })).balance)
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION "${auditFunction}"() RETURNS trigger AS $$
      BEGIN
        IF NEW."entityType" = 'PettyCash' AND NEW."targetId" = '${closeRollbackItem.id}' AND NEW."action" LIKE '关账%' THEN
          RAISE EXCEPTION 'forced petty cash close audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `)
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "${auditTrigger}" BEFORE INSERT ON "op_logs"
      FOR EACH ROW EXECUTE FUNCTION "${auditFunction}"()
    `)
    const failedClose = await api(`/api/petty-cash/${closeRollbackItem.id}/close`, financeToken, {
      method: 'PATCH', body: JSON.stringify({ returnAccountId: cash.id, returnDate: payDate }),
    })
    assert.equal(failedClose.status, 500)
    assert.equal((await prisma.pettyCash.findUniqueOrThrow({ where: { id: closeRollbackItem.id } })).status, 'RECONCILING')
    assert.equal(Number((await prisma.cashAccount.findUniqueOrThrow({ where: { id: cash.id } })).balance), cashBeforeFailedClose)
    assert.equal(await prisma.cashTransaction.count({ where: { refType: 'PettyCashReturn', refId: closeRollbackItem.id } }), 0)
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${auditTrigger}" ON "op_logs"`)
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${auditFunction}"()`)
    assert.equal((await api(`/api/petty-cash/${closeRollbackItem.id}/close`, financeToken, {
      method: 'PATCH', body: JSON.stringify({ returnAccountId: cash.id, returnDate: payDate }),
    })).status, 200)
    assert.equal(Number((await prisma.cashAccount.findUniqueOrThrow({ where: { id: cash.id } })).balance), cashBeforeFailedClose + 10)

    console.log(JSON.stringify({
      ok: true,
      explicitAccountAndStrictInput: true,
      duplicatePayAndCloseIdempotent: true,
      expenseCapAndReconciliationDerived: true,
      cashLedgerAndVoucherAccountExact: true,
      auditFailureRollsBackPayAndReturn: true,
    }))
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${auditTrigger}" ON "op_logs"`).catch(() => {})
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${auditFunction}"()`).catch(() => {})
    await prisma.voucher.deleteMany({
      where: {
        tenantId: tenant.id,
        OR: [
          { sourceType: 'PettyCashPay', sourceId: { in: pettyIds } },
          { sourceType: 'PettyCashClose', sourceId: { in: pettyIds } },
        ],
      },
    })
    await prisma.voucherGenerationFailure.deleteMany({
      where: {
        tenantId: tenant.id,
        OR: [
          { sourceType: 'PettyCashPay', sourceId: { in: pettyIds } },
          { sourceType: 'PettyCashClose', sourceId: { in: pettyIds } },
        ],
      },
    })
    await prisma.cashTransaction.deleteMany({
      where: { tenantId: tenant.id, refId: { in: pettyIds }, refType: { in: ['PettyCashPay', 'PettyCashReturn'] } },
    })
    await prisma.opLog.deleteMany({
      where: { tenantId: tenant.id, OR: [{ targetId: { in: pettyIds } }, { userId: { in: [finance.id, manager.id] } }] },
    })
    await prisma.pettyCash.deleteMany({ where: { id: { in: pettyIds } } })
    await prisma.cashAccount.deleteMany({ where: { id: { in: [bank.id, cash.id] } } })
    await prisma.user.deleteMany({ where: { id: { in: [finance.id, manager.id] } } })
    await prisma.store.deleteMany({ where: { id: { in: stores.map(store => store.id) } } })
  }
}

main().finally(() => prisma.$disconnect())
