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
    throw new Error('安全护栏: 资本支出资金完整性验证仅允许本地 PREVIEW_MODE 隔离库')
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
      tenantId: tenant.id, name: '资本支出完整性财务', email: `capital-finance-${suffix}@local.test`,
      password, role: 'FINANCE',
    },
  })
  const store = await prisma.store.create({
    data: { tenantId: tenant.id, no: `CAP-${suffix}`, name: `资本支出验证店-${suffix}` },
  })
  const otherStore = await prisma.store.create({
    data: { tenantId: tenant.id, no: `CAP-X-${suffix}`, name: `错误还款门店-${suffix}` },
  })
  const bank = await prisma.cashAccount.create({
    data: {
      tenantId: tenant.id, name: `中国银行1674-资本验证-${suffix}`, type: 'BANK',
      bankName: '中国银行', accountNo: `LOCAL${suffix}1674`, balance: 1000, status: 'ACTIVE',
    },
  })
  const cash = await prisma.cashAccount.create({
    data: { tenantId: tenant.id, name: `库存现金-资本验证-${suffix}`, type: 'CASH', balance: 100, status: 'ACTIVE' },
  })
  const project = await prisma.capitalProject.create({
    data: {
      tenantId: tenant.id, storeId: store.id, name: `总部代付验证-${suffix}`,
      type: 'NEW_STORE', status: 'OPERATING', budget: 1000,
    },
  })
  const contract = await prisma.capitalContract.create({
    data: {
      tenantId: tenant.id, projectId: project.id, category: 'DECORATION',
      vendor: `验证装修商-${suffix}`, totalAmount: 300,
    },
  })
  const expenseIds: string[] = []
  const repaymentIds: string[] = []
  const makeExpense = async (label: string, amount: number) => {
    const expense = await prisma.capitalExpense.create({
      data: {
        tenantId: tenant.id, projectId: project.id, contractId: contract.id,
        category: 'DECORATION', vendor: `验证装修商-${label}`, amount,
        requestedById: finance.id, approvedById: finance.id, approvedAt: new Date(), status: 'APPROVED',
      },
    })
    expenseIds.push(expense.id)
    return expense
  }
  const concurrentExpense = await makeExpense('CONCURRENT', 100)
  const rollbackExpense = await makeExpense('ROLLBACK', 20)
  const voucherExpense = await makeExpense('VOUCHER', 10)
  const auditTrigger = `capital_audit_guard_${suffix.replace(/[^a-z0-9]/gi, '_')}`
  const auditFunction = `${auditTrigger}_fn`
  const voucherTrigger = `capital_voucher_guard_${suffix.replace(/[^a-z0-9]/gi, '_')}`
  const voucherFunction = `${voucherTrigger}_fn`
  const paidAt = '2026-07-16'

  try {
    const token = await login(finance.email)
    const reservationRace = await Promise.all([1, 2].map(index => api('/api/capital/expenses', token, {
      method: 'POST', body: JSON.stringify({
        projectId: project.id, contractId: contract.id, category: 'DECORATION',
        vendor: `并发合同占用-${index}-${suffix}`, amount: 100,
      }),
    })))
    assert.deepEqual(reservationRace.map(result => result.status).sort(), [201, 409],
      '合同剩余额度并发申请必须只允许一笔成功')
    const reservedExpense = reservationRace.find(result => result.status === 201)!.body
    expenseIds.push(reservedExpense.id)
    assert.equal(await prisma.capitalExpense.count({
      where: {
        contractId: contract.id, status: { in: ['PENDING_APPROVAL', 'APPROVED', 'PAID'] },
      },
    }), 4)

    const terminalCreated = await api('/api/capital/expenses', token, {
      method: 'POST', body: JSON.stringify({
        projectId: project.id, category: 'OTHER', vendor: `审批撤回竞态-${suffix}`, amount: 5,
      }),
    })
    assert.equal(terminalCreated.status, 201, JSON.stringify(terminalCreated.body))
    expenseIds.push(terminalCreated.body.id)
    const terminalRace = await Promise.all([
      api(`/api/capital/expenses/${terminalCreated.body.id}/approve`, token, {
        method: 'PATCH', body: JSON.stringify({ decision: 'APPROVE' }),
      }),
      api(`/api/capital/expenses/${terminalCreated.body.id}/cancel`, token, { method: 'PATCH', body: '{}' }),
    ])
    assert.deepEqual(terminalRace.map(result => result.status).sort(), [200, 409],
      '审批与撤回并发时必须只有一个终态成功')
    const terminalExpense = await prisma.capitalExpense.findUniqueOrThrow({ where: { id: terminalCreated.body.id } })
    assert.ok(['APPROVED', 'CANCELED'].includes(terminalExpense.status))
    assert.equal(await prisma.opLog.count({
      where: {
        targetId: terminalCreated.body.id,
        OR: [{ action: { startsWith: '批准支出' } }, { action: { startsWith: '撤回支出' } }],
      },
    }), 1, '并发终态只能产生一条审批或撤回日志')

    assert.equal((await api(`/api/capital/expenses/${concurrentExpense.id}/pay`, token, {
      method: 'PATCH', body: JSON.stringify({ paymentMethod: 'bank', paidAt }),
    })).status, 400, '资本支出付款必须选择账户')
    assert.equal((await api(`/api/capital/expenses/${concurrentExpense.id}/pay`, token, {
      method: 'PATCH', body: JSON.stringify({ paymentMethod: 'bank', accountId: cash.id, paidAt }),
    })).status, 409, '银行付款不得选择现金账户')

    const concurrentPay = await Promise.all([1, 2].map(() => api(
      `/api/capital/expenses/${concurrentExpense.id}/pay`, token,
      {
        method: 'PATCH',
        body: JSON.stringify({ paymentMethod: 'bank', accountId: bank.id, bankTxNo: `CAP-PAY-${suffix}`, paidAt }),
      },
    )))
    concurrentPay.forEach(result => assert.equal(result.status, 200, JSON.stringify(result.body)))
    assert.equal(concurrentPay.filter(result => result.body.duplicated === true).length, 1)
    assert.equal(Number((await prisma.cashAccount.findUniqueOrThrow({ where: { id: bank.id } })).balance), 900)
    assert.equal(Number((await prisma.capitalProject.findUniqueOrThrow({ where: { id: project.id } })).spent), 100)
    assert.equal(Number((await prisma.capitalContract.findUniqueOrThrow({ where: { id: contract.id } })).paidAmount), 100)
    assert.equal(await prisma.cashTransaction.count({ where: { refType: 'CapitalExpense', refId: concurrentExpense.id } }), 1)
    const paidVoucher = await prisma.voucher.findFirstOrThrow({
      where: { sourceType: 'CapitalExpense', sourceId: concurrentExpense.id }, include: { entries: true },
    })
    assert.ok(paidVoucher.entries.some(entry => entry.accountCode === '1221' && Number(entry.debit) === 100))
    assert.ok(paidVoucher.entries.some(entry => entry.accountCode === '100201' && Number(entry.credit) === 100))
    assert.equal((await api(`/api/capital/expenses/${concurrentExpense.id}/pay`, token, {
      method: 'PATCH',
      body: JSON.stringify({ paymentMethod: 'bank', accountId: bank.id, bankTxNo: 'CHANGED', paidAt }),
    })).status, 409)

    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION "${auditFunction}"() RETURNS trigger AS $$
      BEGIN
        IF NEW."entityType" = 'CapitalExpense' AND NEW."targetId" = '${rollbackExpense.id}' THEN
          RAISE EXCEPTION 'forced capital expense audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `)
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "${auditTrigger}" BEFORE INSERT ON "op_logs"
      FOR EACH ROW EXECUTE FUNCTION "${auditFunction}"()
    `)
    const failedPay = await api(`/api/capital/expenses/${rollbackExpense.id}/pay`, token, {
      method: 'PATCH', body: JSON.stringify({ paymentMethod: 'bank', accountId: bank.id, paidAt }),
    })
    assert.equal(failedPay.status, 500)
    assert.equal((await prisma.capitalExpense.findUniqueOrThrow({ where: { id: rollbackExpense.id } })).status, 'APPROVED')
    assert.equal(Number((await prisma.cashAccount.findUniqueOrThrow({ where: { id: bank.id } })).balance), 900)
    assert.equal(Number((await prisma.capitalProject.findUniqueOrThrow({ where: { id: project.id } })).spent), 100)
    assert.equal(Number((await prisma.capitalContract.findUniqueOrThrow({ where: { id: contract.id } })).paidAmount), 100)
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${auditTrigger}" ON "op_logs"`)
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${auditFunction}"()`)
    assert.equal((await api(`/api/capital/expenses/${rollbackExpense.id}/pay`, token, {
      method: 'PATCH', body: JSON.stringify({ paymentMethod: 'bank', accountId: bank.id, paidAt }),
    })).status, 200)
    assert.equal(Number((await prisma.cashAccount.findUniqueOrThrow({ where: { id: bank.id } })).balance), 880)
    assert.equal(Number((await prisma.capitalProject.findUniqueOrThrow({ where: { id: project.id } })).spent), 120)

    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION "${voucherFunction}"() RETURNS trigger AS $$
      BEGIN
        IF NEW."sourceType" = 'CapitalExpense' AND NEW."sourceId" = '${voucherExpense.id}' THEN
          RAISE EXCEPTION 'forced capital voucher failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `)
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "${voucherTrigger}" BEFORE INSERT ON "vouchers"
      FOR EACH ROW EXECUTE FUNCTION "${voucherFunction}"()
    `)
    const voucherFailed = await api(`/api/capital/expenses/${voucherExpense.id}/pay`, token, {
      method: 'PATCH', body: JSON.stringify({ paymentMethod: 'bank', accountId: bank.id, bankTxNo: `CAP-V-${suffix}`, paidAt }),
    })
    assert.equal(voucherFailed.status, 200)
    assert.ok(voucherFailed.body.voucherWarning)
    assert.equal(Number((await prisma.cashAccount.findUniqueOrThrow({ where: { id: bank.id } })).balance), 870)
    assert.equal(await prisma.cashTransaction.count({ where: { refType: 'CapitalExpense', refId: voucherExpense.id } }), 1)
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${voucherTrigger}" ON "vouchers"`)
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${voucherFunction}"()`)
    const voucherRecovered = await api(`/api/capital/expenses/${voucherExpense.id}/pay`, token, {
      method: 'PATCH', body: JSON.stringify({ paymentMethod: 'bank', accountId: bank.id, bankTxNo: `CAP-V-${suffix}`, paidAt }),
    })
    assert.equal(voucherRecovered.status, 200)
    assert.equal(voucherRecovered.body.duplicated, true)
    assert.ok(voucherRecovered.body.voucherId)
    assert.equal(Number((await prisma.cashAccount.findUniqueOrThrow({ where: { id: bank.id } })).balance), 870)

    assert.equal((await api('/api/capital/repayments', token, {
      method: 'POST', body: JSON.stringify({
        projectId: project.id, storeId: otherStore.id, amount: 50, paidAt,
        source: 'TRANSFER', bankTxNo: `CAP-REPAY-WRONG-${suffix}`, accountId: bank.id,
      }),
    })).status, 409, '还款门店必须与项目一致')
    const concurrentRepayment = await Promise.all([1, 2].map(() => api('/api/capital/repayments', token, {
      method: 'POST', body: JSON.stringify({
        projectId: project.id, storeId: store.id, amount: 50, paidAt,
        source: 'TRANSFER', bankTxNo: `CAP-REPAY-${suffix}`, accountId: bank.id,
      }),
    })))
    assert.deepEqual(concurrentRepayment.map(result => result.status).sort(), [200, 201])
    assert.equal(concurrentRepayment.filter(result => result.body.duplicated === true).length, 1)
    const repayment = concurrentRepayment[0].body
    repaymentIds.push(repayment.id)
    assert.equal(Number((await prisma.cashAccount.findUniqueOrThrow({ where: { id: bank.id } })).balance), 920)
    assert.equal(Number((await prisma.capitalProject.findUniqueOrThrow({ where: { id: project.id } })).repaidAmount), 50)
    assert.equal(await prisma.storeRepayment.count({ where: { projectId: project.id, bankTxNo: `CAP-REPAY-${suffix}` } }), 1)
    assert.equal(await prisma.cashTransaction.count({ where: { refType: 'CapitalRepayment', refId: repayment.id } }), 1)
    const repaymentVoucher = await prisma.voucher.findFirstOrThrow({
      where: { sourceType: 'CapitalRepayment', sourceId: repayment.id }, include: { entries: true },
    })
    assert.ok(repaymentVoucher.entries.some(entry => entry.accountCode === '100201' && Number(entry.debit) === 50))
    assert.ok(repaymentVoucher.entries.some(entry => entry.accountCode === '1221' && Number(entry.credit) === 50))
    assert.equal((await api('/api/capital/repayments', token, {
      method: 'POST', body: JSON.stringify({
        projectId: project.id, storeId: store.id, amount: 40, paidAt,
        source: 'TRANSFER', bankTxNo: `CAP-REPAY-${suffix}`, accountId: bank.id,
      }),
    })).status, 409, '同一到账流水不得覆盖参数')
    assert.equal((await api('/api/capital/repayments', token, {
      method: 'POST', body: JSON.stringify({
        projectId: project.id, storeId: store.id, amount: 100, paidAt,
        source: 'TRANSFER', bankTxNo: `CAP-OVER-${suffix}`, accountId: bank.id,
      }),
    })).status, 409, '不得超剩余代付余额还款')

    console.log(JSON.stringify({
      ok: true,
      contractReservationSerialized: true,
      approvalCancelTerminalSerialized: true,
      explicitAccountAndStrictInput: true,
      concurrentPaymentIdempotent: true,
      projectContractCashAndAuditAtomic: true,
      voucherFailureRecoverableWithoutSecondDebit: true,
      repaymentIdempotentAndCashLedgerExact: true,
      capitalReceivableVoucherBalanced: true,
    }))
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${auditTrigger}" ON "op_logs"`).catch(() => {})
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${auditFunction}"()`).catch(() => {})
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${voucherTrigger}" ON "vouchers"`).catch(() => {})
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${voucherFunction}"()`).catch(() => {})
    await prisma.voucher.deleteMany({
      where: {
        tenantId: tenant.id,
        OR: [
          { sourceType: 'CapitalExpense', sourceId: { in: expenseIds } },
          { sourceType: 'CapitalRepayment', sourceId: { in: repaymentIds } },
        ],
      },
    })
    await prisma.voucherGenerationFailure.deleteMany({
      where: {
        tenantId: tenant.id,
        OR: [
          { sourceType: 'CapitalExpense', sourceId: { in: expenseIds } },
          { sourceType: 'CapitalRepayment', sourceId: { in: repaymentIds } },
        ],
      },
    })
    await prisma.cashTransaction.deleteMany({
      where: {
        tenantId: tenant.id,
        OR: [
          { refType: 'CapitalExpense', refId: { in: expenseIds } },
          { refType: 'CapitalRepayment', refId: { in: repaymentIds } },
        ],
      },
    })
    await prisma.opLog.deleteMany({
      where: { tenantId: tenant.id, OR: [{ targetId: { in: [...expenseIds, ...repaymentIds] } }, { userId: finance.id }] },
    })
    await prisma.storeRepayment.deleteMany({ where: { projectId: project.id } })
    await prisma.capitalExpense.deleteMany({ where: { projectId: project.id } })
    await prisma.capitalContract.deleteMany({ where: { projectId: project.id } })
    await prisma.capitalProject.delete({ where: { id: project.id } })
    await prisma.cashAccount.deleteMany({ where: { id: { in: [bank.id, cash.id] } } })
    await prisma.user.delete({ where: { id: finance.id } })
    await prisma.store.deleteMany({ where: { id: { in: [store.id, otherStore.id] } } })
  }
}

main().finally(() => prisma.$disconnect())
