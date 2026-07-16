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
    throw new Error('安全护栏: 工资付款完整性验证仅允许本地 PREVIEW_MODE 隔离库')
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
      tenantId: tenant.id, name: '工资付款完整性财务', email: `payroll-finance-${suffix}@local.test`,
      password, role: 'FINANCE',
    },
  })
  const store = await prisma.store.create({
    data: { tenantId: tenant.id, no: `PR-${suffix}`, name: `工资付款验证店-${suffix}` },
  })
  const bankAccount = await prisma.cashAccount.create({
    data: {
      tenantId: tenant.id, name: `中国银行1674-工资验证-${suffix}`, type: 'BANK',
      bankName: '中国银行', accountNo: `LOCAL${suffix}1674`, balance: 1000, status: 'ACTIVE',
    },
  })
  const cashAccount = await prisma.cashAccount.create({
    data: { tenantId: tenant.id, name: `库存现金-工资验证-${suffix}`, type: 'CASH', balance: 100, status: 'ACTIVE' },
  })
  const payrollIds: string[] = []
  const makePayroll = async (
    label: string,
    amounts: { gross: number; net: number; social?: number; tax?: number; other?: number },
  ) => {
    const payroll = await prisma.payroll.create({
      data: {
        tenantId: tenant.id, storeId: store.id, month: `2099-${String(payrollIds.length + 1).padStart(2, '0')}`,
        totalGross: amounts.gross, totalNet: amounts.net,
        totalSocialSec: amounts.social || null, totalTax: amounts.tax || null,
        status: 'APPROVED', approvedById: finance.id, approvedAt: new Date(), createdById: finance.id,
        note: label,
        items: {
          create: {
            employeeName: `员工-${label}`, baseSalary: amounts.gross,
            deductSocialSec: amounts.social || null, deductTax: amounts.tax || null,
            deductOther: amounts.other || null, netAmount: amounts.net,
          },
        },
      },
    })
    payrollIds.push(payroll.id)
    return payroll
  }

  const concurrentPayroll = await makePayroll('CONCURRENT', { gross: 100, net: 80, social: 10, tax: 10 })
  const rollbackPayroll = await makePayroll('ROLLBACK', { gross: 20, net: 20 })
  const cashPayroll = await makePayroll('CASH', { gross: 30, net: 30 })
  const unbalancedPayroll = await makePayroll('UNBALANCED', { gross: 50, net: 40 })
  const otherDeductionPayroll = await makePayroll('OTHER', { gross: 50, net: 40, other: 10 })
  const voucherRecoveryPayroll = await makePayroll('VOUCHER', { gross: 15, net: 15 })
  const auditTrigger = `payroll_audit_guard_${suffix.replace(/[^a-z0-9]/gi, '_')}`
  const auditFunction = `${auditTrigger}_fn`
  const voucherTrigger = `payroll_voucher_guard_${suffix.replace(/[^a-z0-9]/gi, '_')}`
  const voucherFunction = `${voucherTrigger}_fn`
  const payDate = '2026-07-16'

  try {
    const token = await login(finance.email)
    const invalidCreate = await api('/api/payroll', token, {
      method: 'POST',
      body: JSON.stringify({
        storeId: store.id, month: '2026-13',
        items: [{ employeeName: '输入校验', netAmount: 1.001 }],
      }),
    })
    assert.equal(invalidCreate.status, 400)
    assert.equal((await api(`/api/payroll/${concurrentPayroll.id}/mark-paid`, token, {
      method: 'PATCH', body: JSON.stringify({ payMethod: '转账', payDate }),
    })).status, 400, '付款必须显式选择资金账户')
    assert.equal((await api(`/api/payroll/${concurrentPayroll.id}/mark-paid`, token, {
      method: 'PATCH', body: JSON.stringify({ payMethod: '转账', accountId: cashAccount.id, payDate }),
    })).status, 409, '转账不得选择库存现金')

    const concurrent = await Promise.all([
      api(`/api/payroll/${concurrentPayroll.id}/mark-paid`, token, {
        method: 'PATCH',
        body: JSON.stringify({ payMethod: '转账', accountId: bankAccount.id, bankTxNo: `TX-${suffix}-1`, payDate }),
      }),
      api(`/api/payroll/${concurrentPayroll.id}/mark-paid`, token, {
        method: 'PATCH',
        body: JSON.stringify({ payMethod: '转账', accountId: bankAccount.id, bankTxNo: `TX-${suffix}-1`, payDate }),
      }),
    ])
    concurrent.forEach(result => assert.equal(result.status, 200, JSON.stringify(result.body)))
    assert.equal(concurrent.filter(result => result.body.duplicated === true).length, 1)
    assert.equal(Number((await prisma.cashAccount.findUniqueOrThrow({ where: { id: bankAccount.id } })).balance), 920)
    assert.equal(await prisma.cashTransaction.count({ where: { refType: 'Payroll', refId: concurrentPayroll.id } }), 1)
    assert.equal(await prisma.voucher.count({ where: { sourceType: 'Payroll', sourceId: concurrentPayroll.id } }), 1)
    const voucher = await prisma.voucher.findFirstOrThrow({
      where: { sourceType: 'Payroll', sourceId: concurrentPayroll.id }, include: { entries: true },
    })
    assert.ok(voucher.entries.some(entry => entry.accountCode === '100201' && Number(entry.credit) === 80))
    assert.equal((await api(`/api/payroll/${concurrentPayroll.id}/mark-paid`, token, {
      method: 'PATCH',
      body: JSON.stringify({ payMethod: '转账', accountId: bankAccount.id, bankTxNo: 'CHANGED', payDate }),
    })).status, 409, '已发工资不得用不同参数覆盖')

    assert.equal((await api(`/api/payroll/${unbalancedPayroll.id}/mark-paid`, token, {
      method: 'PATCH', body: JSON.stringify({ payMethod: '转账', accountId: bankAccount.id, payDate }),
    })).status, 409)
    assert.equal((await api(`/api/payroll/${otherDeductionPayroll.id}/mark-paid`, token, {
      method: 'PATCH', body: JSON.stringify({ payMethod: '转账', accountId: bankAccount.id, payDate }),
    })).status, 409)

    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION "${auditFunction}"() RETURNS trigger AS $$
      BEGIN
        IF NEW."entityType" = 'Payroll' AND NEW."targetId" = '${rollbackPayroll.id}' THEN
          RAISE EXCEPTION 'forced payroll audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `)
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "${auditTrigger}" BEFORE INSERT ON "op_logs"
      FOR EACH ROW EXECUTE FUNCTION "${auditFunction}"()
    `)
    const failedAudit = await api(`/api/payroll/${rollbackPayroll.id}/mark-paid`, token, {
      method: 'PATCH', body: JSON.stringify({ payMethod: '转账', accountId: bankAccount.id, payDate }),
    })
    assert.equal(failedAudit.status, 500)
    assert.equal((await prisma.payroll.findUniqueOrThrow({ where: { id: rollbackPayroll.id } })).status, 'APPROVED')
    assert.equal(Number((await prisma.cashAccount.findUniqueOrThrow({ where: { id: bankAccount.id } })).balance), 920)
    assert.equal(await prisma.cashTransaction.count({ where: { refType: 'Payroll', refId: rollbackPayroll.id } }), 0)
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${auditTrigger}" ON "op_logs"`)
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${auditFunction}"()`)
    const recoveredAudit = await api(`/api/payroll/${rollbackPayroll.id}/mark-paid`, token, {
      method: 'PATCH', body: JSON.stringify({ payMethod: '转账', accountId: bankAccount.id, payDate }),
    })
    assert.equal(recoveredAudit.status, 200, JSON.stringify(recoveredAudit.body))
    assert.equal(Number((await prisma.cashAccount.findUniqueOrThrow({ where: { id: bankAccount.id } })).balance), 900)

    const cashPaid = await api(`/api/payroll/${cashPayroll.id}/mark-paid`, token, {
      method: 'PATCH', body: JSON.stringify({ payMethod: '现金', accountId: cashAccount.id, payDate }),
    })
    assert.equal(cashPaid.status, 200, JSON.stringify(cashPaid.body))
    assert.equal(Number((await prisma.cashAccount.findUniqueOrThrow({ where: { id: cashAccount.id } })).balance), 70)
    const cashVoucher = await prisma.voucher.findFirstOrThrow({
      where: { sourceType: 'Payroll', sourceId: cashPayroll.id }, include: { entries: true },
    })
    assert.ok(cashVoucher.entries.some(entry => entry.accountCode === '1001' && Number(entry.credit) === 30))

    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION "${voucherFunction}"() RETURNS trigger AS $$
      BEGIN
        IF NEW."sourceType" = 'Payroll' AND NEW."sourceId" = '${voucherRecoveryPayroll.id}' THEN
          RAISE EXCEPTION 'forced payroll voucher failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `)
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "${voucherTrigger}" BEFORE INSERT ON "vouchers"
      FOR EACH ROW EXECUTE FUNCTION "${voucherFunction}"()
    `)
    const voucherFailed = await api(`/api/payroll/${voucherRecoveryPayroll.id}/mark-paid`, token, {
      method: 'PATCH',
      body: JSON.stringify({ payMethod: '转账', accountId: bankAccount.id, bankTxNo: `TX-${suffix}-V`, payDate }),
    })
    assert.equal(voucherFailed.status, 200, JSON.stringify(voucherFailed.body))
    assert.ok(voucherFailed.body.voucherWarning)
    assert.equal((await prisma.payroll.findUniqueOrThrow({ where: { id: voucherRecoveryPayroll.id } })).status, 'PAID')
    assert.equal(Number((await prisma.cashAccount.findUniqueOrThrow({ where: { id: bankAccount.id } })).balance), 885)
    assert.equal(await prisma.cashTransaction.count({ where: { refType: 'Payroll', refId: voucherRecoveryPayroll.id } }), 1)
    assert.equal(await prisma.voucher.count({ where: { sourceType: 'Payroll', sourceId: voucherRecoveryPayroll.id } }), 0)
    assert.equal(await prisma.voucherGenerationFailure.count({
      where: { sourceType: 'Payroll', sourceId: voucherRecoveryPayroll.id, resolved: false },
    }), 1)
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${voucherTrigger}" ON "vouchers"`)
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${voucherFunction}"()`)
    const voucherRecovered = await api(`/api/payroll/${voucherRecoveryPayroll.id}/mark-paid`, token, {
      method: 'PATCH',
      body: JSON.stringify({ payMethod: '转账', accountId: bankAccount.id, bankTxNo: `TX-${suffix}-V`, payDate }),
    })
    assert.equal(voucherRecovered.status, 200, JSON.stringify(voucherRecovered.body))
    assert.equal(voucherRecovered.body.duplicated, true)
    assert.ok(voucherRecovered.body.voucherId)
    assert.equal(Number((await prisma.cashAccount.findUniqueOrThrow({ where: { id: bankAccount.id } })).balance), 885)
    assert.equal(await prisma.cashTransaction.count({ where: { refType: 'Payroll', refId: voucherRecoveryPayroll.id } }), 1)
    assert.equal(await prisma.voucher.count({ where: { sourceType: 'Payroll', sourceId: voucherRecoveryPayroll.id } }), 1)
    assert.equal(await prisma.voucherGenerationFailure.count({
      where: { sourceType: 'Payroll', sourceId: voucherRecoveryPayroll.id, resolved: true },
    }), 1)

    console.log(JSON.stringify({
      ok: true,
      strictInputAndAccountSelection: true,
      duplicatePaymentIdempotent: true,
      payrollAccountingBalanceGuarded: true,
      cashLedgerAtomic: true,
      auditFailureRollbackAndRetry: true,
      voucherFailureRecoverableWithoutSecondDebit: true,
    }))
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${auditTrigger}" ON "op_logs"`).catch(() => {})
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${auditFunction}"()`).catch(() => {})
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${voucherTrigger}" ON "vouchers"`).catch(() => {})
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${voucherFunction}"()`).catch(() => {})
    await prisma.voucher.deleteMany({ where: { sourceType: 'Payroll', sourceId: { in: payrollIds } } })
    await prisma.voucherGenerationFailure.deleteMany({ where: { sourceType: 'Payroll', sourceId: { in: payrollIds } } })
    await prisma.cashTransaction.deleteMany({ where: { refType: 'Payroll', refId: { in: payrollIds } } })
    await prisma.opLog.deleteMany({
      where: { tenantId: tenant.id, OR: [{ targetId: { in: payrollIds } }, { userId: finance.id }] },
    })
    await prisma.payroll.deleteMany({ where: { id: { in: payrollIds } } })
    await prisma.cashAccount.deleteMany({ where: { id: { in: [bankAccount.id, cashAccount.id] } } })
    await prisma.store.delete({ where: { id: store.id } })
    await prisma.user.delete({ where: { id: finance.id } })
  }
}

main().finally(() => prisma.$disconnect())
