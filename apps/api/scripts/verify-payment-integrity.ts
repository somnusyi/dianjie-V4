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
    throw new Error('安全护栏: 付款完整性验证仅允许本地 PREVIEW_MODE 隔离库')
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
  const sequenceKey = { tenantId: tenant.id, scope: 'PAYMENT', period }
  const previousSequence = await prisma.businessSequence.findUnique({ where: { tenantId_scope_period: sequenceKey } })
  const supplier = await prisma.supplier.create({
    data: { tenantId: tenant.id, no: `PAY-${suffix}`, name: `付款完整性供应商-${suffix}` },
  })
  const otherSupplier = await prisma.supplier.create({
    data: { tenantId: tenant.id, no: `PAY-O-${suffix}`, name: `其他付款供应商-${suffix}` },
  })
  const finance = await prisma.user.create({
    data: {
      tenantId: tenant.id, name: '付款完整性财务', email: `payment-finance-${suffix}@local.test`,
      password, role: 'FINANCE',
    },
  })
  const manager = await prisma.user.create({
    data: {
      tenantId: tenant.id, name: '付款越权店长', email: `payment-manager-${suffix}@local.test`,
      password, role: 'MANAGER',
    },
  })
  const supplierUser = await prisma.user.create({
    data: {
      tenantId: tenant.id, supplierId: supplier.id, name: '付款供应商',
      email: `payment-supplier-${suffix}@local.test`, password, role: 'SUPPLIER_OWNER',
    },
  })
  const unboundSupplier = await prisma.user.create({
    data: {
      tenantId: tenant.id, name: '未绑定付款供应商',
      email: `payment-unbound-${suffix}@local.test`, password, role: 'SUPPLIER_STAFF',
    },
  })
  const bankAccount = await prisma.cashAccount.create({
    data: { tenantId: tenant.id, name: `付款测试银行-${suffix}`, type: 'BANK', accountNo: 'TEST1674', balance: 10_000 },
  })
  const cashAccount = await prisma.cashAccount.create({
    data: { tenantId: tenant.id, name: `付款测试现金-${suffix}`, type: 'CASH', balance: 1_000 },
  })
  const reconciliationIds: string[] = []
  const paymentIds: string[] = []
  const triggerName = `payment_guard_${suffix.replace(/[^a-z0-9]/gi, '_')}`
  const functionName = `${triggerName}_fn`
  const paidDate = dayjs().format('YYYY-MM-DD')

  const makeRecon = async (label: string, amount: number, supplierId = supplier.id, status: any = 'APPROVED') => {
    const recon = await prisma.reconciliation.create({
      data: {
        tenantId: tenant.id, no: `DC-PAY-${suffix}-${label}`, supplierId,
        periodStart: new Date('2026-07-01'), periodEnd: new Date('2026-07-16'),
        totalAmount: amount, status,
      },
    })
    reconciliationIds.push(recon.id)
    return recon
  }

  const createPayment = async (token: string, reconId: string, amount: number, method = 'BANK_TRANSFER', note = '') => {
    const response = await api('/api/payments', token, {
      method: 'POST', body: JSON.stringify({ reconciliationId: reconId, amount, method, note }),
    })
    if (response.body.id && !paymentIds.includes(response.body.id)) paymentIds.push(response.body.id)
    return response
  }

  try {
    const [financeToken, managerToken, supplierToken, unboundToken] = await Promise.all([
      login(finance.email), login(manager.email), login(supplierUser.email), login(unboundSupplier.email),
    ])

    assert.equal((await api('/api/payments', managerToken)).status, 403)
    assert.equal((await api('/api/payments', unboundToken)).status, 403)
    assert.equal((await api('/api/payments', managerToken, { method: 'POST', body: '{}' })).status, 403)

    const foreignRecon = await makeRecon('FOREIGN', 55, otherSupplier.id)
    const foreignPayment = await prisma.payment.create({
      data: {
        tenantId: tenant.id, no: `PY-FOREIGN-${suffix}`, supplierId: otherSupplier.id,
        reconciliationId: foreignRecon.id, amount: 55, method: 'BANK_TRANSFER', status: 'UNPAID',
      },
    })
    paymentIds.push(foreignPayment.id)
    const supplierList = await api('/api/payments', supplierToken)
    assert.equal(supplierList.status, 200)
    assert.ok(supplierList.body.items.every((payment: any) => payment.supplierId === supplier.id),
      '供应商只能读取自己的付款单')

    const strictRecon = await makeRecon('STRICT', 100)
    assert.equal((await api('/api/payments', financeToken, {
      method: 'POST', body: JSON.stringify({ reconciliationId: strictRecon.id, amount: 100, method: 'OFFLINE' }),
    })).status, 400)
    assert.equal((await api('/api/payments', financeToken, {
      method: 'POST', body: JSON.stringify({ reconciliationId: strictRecon.id, amount: 100.001, method: 'BANK_TRANSFER' }),
    })).status, 400)
    assert.equal((await api('/api/payments', financeToken, {
      method: 'POST', body: JSON.stringify({ reconciliationId: strictRecon.id, amount: 100, method: 'BANK_TRANSFER', forged: true }),
    })).status, 400)
    assert.equal((await createPayment(financeToken, strictRecon.id, 99, 'BANK_TRANSFER')).status, 400)

    const concurrentBody = JSON.stringify({
      reconciliationId: strictRecon.id, amount: 100, method: 'BANK_TRANSFER', note: '并发创建',
    })
    const concurrentCreates = await Promise.all([1, 2].map(() => api('/api/payments', financeToken, {
      method: 'POST', body: concurrentBody,
    })))
    assert.deepEqual(concurrentCreates.map(result => result.status).sort(), [200, 201])
    const concurrentPaymentId = concurrentCreates[0].body.id as string
    paymentIds.push(concurrentPaymentId)
    assert.ok(concurrentCreates.every(result => result.body.id === concurrentPaymentId))
    assert.equal(await prisma.payment.count({ where: { reconciliationId: strictRecon.id } }), 1)
    assert.equal((await prisma.reconciliation.findUniqueOrThrow({ where: { id: strictRecon.id } })).status, 'PAYMENT_GENERATED')
    assert.equal(await prisma.opLog.count({ where: { entityType: 'Payment', targetId: concurrentPaymentId, action: { startsWith: '创建付款单' } } }), 1)
    assert.equal((await createPayment(financeToken, strictRecon.id, 100, 'CASH', '参数冲突')).status, 409)

    let duplicateReconciliationBlocked = false
    try {
      await prisma.payment.create({
        data: {
          tenantId: tenant.id, no: `PY-DUP-${suffix}`, supplierId: supplier.id,
          reconciliationId: strictRecon.id, amount: 100, method: 'CASH',
        },
      })
    } catch (error) {
      duplicateReconciliationBlocked = error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
    }
    assert.equal(duplicateReconciliationBlocked, true, '数据库必须阻断同一对账单重复付款单')

    const rollbackCreateRecon = await makeRecon('CREATE-ROLLBACK', 110)
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION "${functionName}"() RETURNS trigger AS $$
      BEGIN
        IF NEW."userId" = '${finance.id}' AND NEW."action" LIKE '创建付款单 %' THEN
          RAISE EXCEPTION 'forced payment create audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `)
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "${triggerName}" BEFORE INSERT ON "op_logs"
      FOR EACH ROW EXECUTE FUNCTION "${functionName}"()
    `)
    assert.equal((await createPayment(financeToken, rollbackCreateRecon.id, 110)).status, 500)
    assert.equal(await prisma.payment.count({ where: { reconciliationId: rollbackCreateRecon.id } }), 0)
    assert.equal((await prisma.reconciliation.findUniqueOrThrow({ where: { id: rollbackCreateRecon.id } })).status, 'APPROVED')
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON "op_logs"`)
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`)
    const recoveredCreate = await createPayment(financeToken, rollbackCreateRecon.id, 110)
    assert.equal(recoveredCreate.status, 201, JSON.stringify(recoveredCreate.body))

    assert.equal((await api(`/api/payments/${concurrentPaymentId}/paid`, financeToken, {
      method: 'PATCH', body: JSON.stringify({ paidAt: paidDate, bankTxNo: `TX-${suffix}-MAIN` }),
    })).status, 400)
    assert.equal((await api(`/api/payments/${concurrentPaymentId}/paid`, financeToken, {
      method: 'PATCH', body: JSON.stringify({ accountId: bankAccount.id, paidAt: paidDate }),
    })).status, 400)
    assert.equal((await api(`/api/payments/${concurrentPaymentId}/paid`, financeToken, {
      method: 'PATCH', body: JSON.stringify({ accountId: cashAccount.id, paidAt: paidDate, bankTxNo: `TX-${suffix}-MAIN` }),
    })).status, 400)
    assert.equal((await api(`/api/payments/${concurrentPaymentId}/paid`, financeToken, {
      method: 'PATCH', body: JSON.stringify({ accountId: bankAccount.id, paidAt: dayjs().add(1, 'day').format('YYYY-MM-DD'), bankTxNo: `TX-${suffix}-MAIN` }),
    })).status, 400)

    const payBody = JSON.stringify({
      accountId: bankAccount.id, paidAt: paidDate, bankTxNo: `TX-${suffix}-MAIN`, note: '并发实际付款',
    })
    const beforeMainBalance = Number((await prisma.cashAccount.findUniqueOrThrow({ where: { id: bankAccount.id } })).balance)
    const concurrentPays = await Promise.all([1, 2].map(() => api(`/api/payments/${concurrentPaymentId}/paid`, financeToken, {
      method: 'PATCH', body: payBody,
    })))
    assert.deepEqual(concurrentPays.map(result => result.status), [200, 200])
    assert.equal(concurrentPays.filter(result => result.body.duplicated).length, 1)
    const afterMainBalance = Number((await prisma.cashAccount.findUniqueOrThrow({ where: { id: bankAccount.id } })).balance)
    assert.equal(afterMainBalance, beforeMainBalance - 100)
    assert.equal(await prisma.cashTransaction.count({ where: { refType: 'Payment', refId: concurrentPaymentId } }), 1)
    assert.equal(await prisma.opLog.count({ where: { entityType: 'Payment', targetId: concurrentPaymentId, action: { startsWith: '完成供应商付款' } } }), 1)
    assert.equal((await prisma.reconciliation.findUniqueOrThrow({ where: { id: strictRecon.id } })).status, 'DONE')
    assert.equal(await prisma.voucher.count({ where: { tenantId: tenant.id, sourceType: 'Payment', sourceId: concurrentPaymentId } }), 1)

    const duplicateReferenceRecon = await makeRecon('DUP-REFERENCE', 120)
    const duplicateReferencePayment = await createPayment(financeToken, duplicateReferenceRecon.id, 120)
    assert.equal(duplicateReferencePayment.status, 201)
    assert.equal((await api(`/api/payments/${duplicateReferencePayment.body.id}/paid`, financeToken, {
      method: 'PATCH', body: payBody,
    })).status, 409)

    const rollbackPaidRecon = await makeRecon('PAID-ROLLBACK', 130)
    const rollbackPaidPayment = await createPayment(financeToken, rollbackPaidRecon.id, 130)
    assert.equal(rollbackPaidPayment.status, 201)
    const rollbackPaymentId = rollbackPaidPayment.body.id as string
    const beforeRollbackBalance = Number((await prisma.cashAccount.findUniqueOrThrow({ where: { id: bankAccount.id } })).balance)
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION "${functionName}"() RETURNS trigger AS $$
      BEGIN
        IF NEW."entityType" = 'Payment' AND NEW."targetId" = '${rollbackPaymentId}'
           AND NEW."action" LIKE '完成供应商付款 %' THEN
          RAISE EXCEPTION 'forced payment audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `)
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "${triggerName}" BEFORE INSERT ON "op_logs"
      FOR EACH ROW EXECUTE FUNCTION "${functionName}"()
    `)
    const rollbackPayBody = JSON.stringify({
      accountId: bankAccount.id, paidAt: paidDate, bankTxNo: `TX-${suffix}-ROLLBACK`, note: '付款故障回滚',
    })
    assert.equal((await api(`/api/payments/${rollbackPaymentId}/paid`, financeToken, {
      method: 'PATCH', body: rollbackPayBody,
    })).status, 500)
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: rollbackPaymentId } })).status, 'UNPAID')
    assert.equal((await prisma.reconciliation.findUniqueOrThrow({ where: { id: rollbackPaidRecon.id } })).status, 'PAYMENT_GENERATED')
    assert.equal(await prisma.cashTransaction.count({ where: { refType: 'Payment', refId: rollbackPaymentId } }), 0)
    assert.equal(Number((await prisma.cashAccount.findUniqueOrThrow({ where: { id: bankAccount.id } })).balance), beforeRollbackBalance)
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON "op_logs"`)
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`)
    assert.equal((await api(`/api/payments/${rollbackPaymentId}/paid`, financeToken, {
      method: 'PATCH', body: rollbackPayBody,
    })).status, 200)

    const voucherFailureRecon = await makeRecon('VOUCHER-FAILURE', 140)
    const voucherFailurePayment = await createPayment(financeToken, voucherFailureRecon.id, 140)
    assert.equal(voucherFailurePayment.status, 201)
    const voucherFailurePaymentId = voucherFailurePayment.body.id as string
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION "${functionName}"() RETURNS trigger AS $$
      BEGIN
        IF NEW."sourceType" = 'Payment' AND NEW."sourceId" = '${voucherFailurePaymentId}' THEN
          RAISE EXCEPTION 'forced payment voucher failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `)
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "${triggerName}" BEFORE INSERT ON "vouchers"
      FOR EACH ROW EXECUTE FUNCTION "${functionName}"()
    `)
    const voucherFailureBody = JSON.stringify({
      accountId: bankAccount.id, paidAt: paidDate, bankTxNo: `TX-${suffix}-VOUCHER`, note: '凭证故障恢复',
    })
    const failedVoucherResponse = await api(`/api/payments/${voucherFailurePaymentId}/paid`, financeToken, {
      method: 'PATCH', body: voucherFailureBody,
    })
    assert.equal(failedVoucherResponse.status, 200)
    assert.ok(failedVoucherResponse.body.voucherWarning)
    assert.equal(await prisma.cashTransaction.count({ where: { refType: 'Payment', refId: voucherFailurePaymentId } }), 1)
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON "vouchers"`)
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`)
    const recoveredVoucherResponse = await api(`/api/payments/${voucherFailurePaymentId}/paid`, financeToken, {
      method: 'PATCH', body: voucherFailureBody,
    })
    assert.equal(recoveredVoucherResponse.status, 200)
    assert.equal(recoveredVoucherResponse.body.duplicated, true)
    assert.ok(recoveredVoucherResponse.body.voucherId)
    assert.equal(await prisma.cashTransaction.count({ where: { refType: 'Payment', refId: voucherFailurePaymentId } }), 1)
    assert.equal(await prisma.voucher.count({ where: { tenantId: tenant.id, sourceType: 'Payment', sourceId: voucherFailurePaymentId } }), 1)

    console.log(JSON.stringify({
      ok: true,
      strictInputAndRoleIsolation: true,
      concurrentCreateIdempotent: true,
      reconciliationUniquenessDatabaseEnforced: true,
      createAuditRollbackAndRetry: true,
      explicitAccountAndReferenceRequired: true,
      concurrentPaymentDebitedOnce: true,
      duplicateReferenceRejected: true,
      paymentAuditRollbackAndRetry: true,
      voucherFailureRetryWithoutDoubleDebit: true,
    }))
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON "op_logs"`).catch(() => {})
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON "vouchers"`).catch(() => {})
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`).catch(() => {})
    await prisma.voucherEntry.deleteMany({ where: { voucher: { sourceType: 'Payment', sourceId: { in: paymentIds } } } })
    await prisma.voucher.deleteMany({ where: { sourceType: 'Payment', sourceId: { in: paymentIds } } })
    await prisma.voucherGenerationFailure.deleteMany({ where: { sourceType: 'Payment', sourceId: { in: paymentIds } } })
    await prisma.cashTransaction.deleteMany({ where: { refType: 'Payment', refId: { in: paymentIds } } })
    await prisma.opLog.deleteMany({
      where: {
        tenantId: tenant.id,
        OR: [
          { entityType: 'Payment', targetId: { in: paymentIds } },
          { userId: { in: [finance.id, manager.id, supplierUser.id, unboundSupplier.id] } },
        ],
      },
    })
    await prisma.payment.deleteMany({ where: { id: { in: paymentIds } } })
    await prisma.reconciliation.deleteMany({ where: { id: { in: reconciliationIds } } })
    await prisma.cashAccount.deleteMany({ where: { id: { in: [bankAccount.id, cashAccount.id] } } })
    await prisma.user.deleteMany({ where: { id: { in: [finance.id, manager.id, supplierUser.id, unboundSupplier.id] } } })
    await prisma.supplier.deleteMany({ where: { id: { in: [supplier.id, otherSupplier.id] } } })
    if (previousSequence) {
      await prisma.businessSequence.update({
        where: { tenantId_scope_period: sequenceKey }, data: { value: previousSequence.value },
      })
    } else {
      await prisma.businessSequence.deleteMany({ where: sequenceKey })
    }
  }
}

main().catch(async error => {
  console.error(error)
  await prisma.$disconnect()
  process.exit(1)
}).finally(() => prisma.$disconnect())
