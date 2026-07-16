import 'dotenv/config'
import assert from 'node:assert/strict'
import bcrypt from 'bcryptjs'
import { Prisma, prisma } from '@dianjie/db'

const API_BASE = process.env.TEST_API_BASE || 'http://localhost:4444'
const TENANT_SLUG = process.env.PREVIEW_TENANT_SLUG || 'yaohai-test'
const PASSWORD = 'yaohai@123'

function assertLocalOnly() {
  const url = process.env.DATABASE_URL || ''
  if (process.env.PREVIEW_MODE !== 'true' || process.env.NODE_ENV === 'production' || !url.includes('dianjie_v4_local')) {
    throw new Error('安全护栏: 发票付款验证仅允许本地 PREVIEW_MODE 隔离库')
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
    method: 'POST',
    body: JSON.stringify({ identifier, password: PASSWORD, tenantSlug: TENANT_SLUG }),
  })
  assert.equal(response.status, 200, JSON.stringify(response.body))
  return response.body.token as string
}

async function main() {
  assertLocalOnly()
  const suffix = Date.now().toString(36)
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: TENANT_SLUG } })
  const password = await bcrypt.hash(PASSWORD, 10)
  const supplier = await prisma.supplier.create({
    data: { tenantId: tenant.id, no: `PAY-${suffix}`, name: `付款完整性供应商-${suffix}` },
  })
  const supplierUser = await prisma.user.create({
    data: {
      tenantId: tenant.id, name: '付款验证供应商', email: `payment-supplier-${suffix}@local.test`,
      password, role: 'SUPPLIER_OWNER', supplierId: supplier.id,
    },
  })
  const unboundSupplier = await prisma.user.create({
    data: {
      tenantId: tenant.id, name: '未绑定付款验证供应商', email: `payment-unbound-${suffix}@local.test`,
      password, role: 'SUPPLIER_STAFF',
    },
  })
  const finance = await prisma.user.create({
    data: {
      tenantId: tenant.id, name: '付款验证财务', email: `payment-finance-${suffix}@local.test`,
      password, role: 'FINANCE',
    },
  })
  const manager = await prisma.user.create({
    data: {
      tenantId: tenant.id, name: '付款越权验证店长', email: `payment-manager-${suffix}@local.test`,
      password, role: 'MANAGER',
    },
  })
  const cashAccount = await prisma.cashAccount.create({
    data: {
      tenantId: tenant.id, name: `付款验证账户-${suffix}`, type: 'BANK',
      balance: 1000, cmbBindAccount: `LOCAL-${suffix}`, status: 'ACTIVE',
    },
  })

  const makeInvoice = (invoiceNo: string, amount: number) => prisma.invoice.create({
    data: {
      tenantId: tenant.id, supplierId: supplier.id, invoiceNo, amount,
      issueDate: new Date('2026-07-16'), fileUrl: 'https://local.invalid/invoice.pdf',
      uploadedById: supplierUser.id, status: 'VERIFIED',
    },
  })
  const invoices = await Promise.all([
    makeInvoice(`INV-${suffix}-1`, 100),
    makeInvoice(`INV-${suffix}-2`, 30),
    makeInvoice(`INV-${suffix}-3`, 20),
  ])
  const paymentIds: string[] = []
  const triggerName = `invoice_payment_guard_${suffix.replace(/[^a-z0-9]/gi, '_')}`
  const functionName = `${triggerName}_fn`

  try {
    const [financeToken, unboundToken, managerToken] = await Promise.all([
      login(finance.email), login(unboundSupplier.email), login(manager.email),
    ])

    for (const path of ['/api/invoices', '/api/invoice-payments/payable', '/api/invoice-payments']) {
      const response = await api(path, unboundToken)
      assert.equal(response.status, 403, `未绑定供应商不得读取 ${path}`)
    }
    assert.equal((await api('/api/invoice-payments', managerToken)).status, 403, '店长不得读取全租户发票付款')

    const invalidPrecision = await api('/api/invoice-payments', financeToken, {
      method: 'POST', body: JSON.stringify({ invoiceId: invoices[0].id, amount: 1.001 }),
    })
    assert.equal(invalidPrecision.status, 400)

    const competing = await Promise.all([
      api('/api/invoice-payments', financeToken, {
        method: 'POST', body: JSON.stringify({ invoiceId: invoices[0].id, amount: 60, paymentMethod: 'manual' }),
      }),
      api('/api/invoice-payments', financeToken, {
        method: 'POST', body: JSON.stringify({ invoiceId: invoices[0].id, amount: 60, paymentMethod: 'manual' }),
      }),
    ])
    assert.deepEqual(competing.map(result => result.status).sort(), [201, 409], '并发付款预占只能成功一笔')
    const payment60 = competing.find(result => result.status === 201)!.body
    paymentIds.push(payment60.id)
    const payment40Response = await api('/api/invoice-payments', financeToken, {
      method: 'POST', body: JSON.stringify({ invoiceId: invoices[0].id, amount: 40, paymentMethod: 'manual' }),
    })
    assert.equal(payment40Response.status, 201, JSON.stringify(payment40Response.body))
    const payment40 = payment40Response.body
    paymentIds.push(payment40.id)
    const reserved = await prisma.invoicePayment.aggregate({
      where: { invoiceId: invoices[0].id, status: { in: ['PENDING', 'SUCCESS'] } },
      _sum: { amount: true },
    })
    assert.equal(Number(reserved._sum.amount), 100)

    const duplicateConfirm = await Promise.all([
      api(`/api/invoice-payments/${payment60.id}/confirm`, financeToken, {
        method: 'PATCH', body: JSON.stringify({ status: 'SUCCESS', bankTxNo: `TX-${suffix}-60` }),
      }),
      api(`/api/invoice-payments/${payment60.id}/confirm`, financeToken, {
        method: 'PATCH', body: JSON.stringify({ status: 'SUCCESS', bankTxNo: `TX-${suffix}-60` }),
      }),
    ])
    duplicateConfirm.forEach(result => assert.equal(result.status, 200, JSON.stringify(result.body)))
    assert.equal(duplicateConfirm.filter(result => result.body.duplicated === true).length, 1)
    assert.equal(Number((await prisma.invoice.findUniqueOrThrow({ where: { id: invoices[0].id } })).paidAmount), 60)
    assert.equal(Number((await prisma.cashAccount.findUniqueOrThrow({ where: { id: cashAccount.id } })).balance), 940)
    assert.equal(await prisma.cashTransaction.count({ where: { refType: 'InvoicePayment', refId: payment60.id } }), 1)

    const payment30Response = await api('/api/invoice-payments', financeToken, {
      method: 'POST', body: JSON.stringify({ invoiceId: invoices[1].id, amount: 30, paymentMethod: 'manual' }),
    })
    assert.equal(payment30Response.status, 201, JSON.stringify(payment30Response.body))
    const payment30 = payment30Response.body
    paymentIds.push(payment30.id)
    const parallelDifferentInvoices = await Promise.all([
      api(`/api/invoice-payments/${payment40.id}/confirm`, financeToken, {
        method: 'PATCH', body: JSON.stringify({ status: 'SUCCESS', bankTxNo: `TX-${suffix}-40` }),
      }),
      api(`/api/invoice-payments/${payment30.id}/confirm`, financeToken, {
        method: 'PATCH', body: JSON.stringify({ status: 'SUCCESS', bankTxNo: `TX-${suffix}-30` }),
      }),
    ])
    parallelDifferentInvoices.forEach(result => assert.equal(result.status, 200, JSON.stringify(result.body)))
    assert.equal(Number((await prisma.cashAccount.findUniqueOrThrow({ where: { id: cashAccount.id } })).balance), 870)
    assert.equal(Number((await prisma.invoice.findUniqueOrThrow({ where: { id: invoices[0].id } })).paidAmount), 100)
    assert.equal(Number((await prisma.invoice.findUniqueOrThrow({ where: { id: invoices[1].id } })).paidAmount), 30)

    const payment20Response = await api('/api/invoice-payments', financeToken, {
      method: 'POST', body: JSON.stringify({ invoiceId: invoices[2].id, amount: 20, paymentMethod: 'manual' }),
    })
    assert.equal(payment20Response.status, 201, JSON.stringify(payment20Response.body))
    const payment20 = payment20Response.body
    paymentIds.push(payment20.id)
    const missingFailureReason = await api(`/api/invoice-payments/${payment20.id}/confirm`, financeToken, {
      method: 'PATCH', body: JSON.stringify({ status: 'FAILED' }),
    })
    assert.equal(missingFailureReason.status, 400)

    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION "${functionName}"() RETURNS trigger AS $$
      BEGIN
        IF NEW."entityType" = 'InvoicePayment' AND NEW."targetId" = '${payment20.id}' THEN
          RAISE EXCEPTION 'forced invoice payment audit failure';
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
    const failedAudit = await api(`/api/invoice-payments/${payment20.id}/confirm`, financeToken, {
      method: 'PATCH', body: JSON.stringify({ status: 'SUCCESS', bankTxNo: `TX-${suffix}-20` }),
    })
    assert.equal(failedAudit.status, 500)
    assert.equal((await prisma.invoicePayment.findUniqueOrThrow({ where: { id: payment20.id } })).status, 'PENDING')
    assert.equal(Number((await prisma.invoice.findUniqueOrThrow({ where: { id: invoices[2].id } })).paidAmount), 0)
    assert.equal(Number((await prisma.cashAccount.findUniqueOrThrow({ where: { id: cashAccount.id } })).balance), 870)
    assert.equal(await prisma.cashTransaction.count({ where: { refType: 'InvoicePayment', refId: payment20.id } }), 0)
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON "op_logs"`)
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`)

    const recovered = await api(`/api/invoice-payments/${payment20.id}/confirm`, financeToken, {
      method: 'PATCH', body: JSON.stringify({ status: 'SUCCESS', bankTxNo: `TX-${suffix}-20` }),
    })
    assert.equal(recovered.status, 200, JSON.stringify(recovered.body))
    assert.equal(Number((await prisma.cashAccount.findUniqueOrThrow({ where: { id: cashAccount.id } })).balance), 850)

    console.log(JSON.stringify({
      ok: true,
      supplierBindingIsolation: true,
      concurrentReservationBounded: true,
      duplicateConfirmationIdempotent: true,
      concurrentCashBalanceSerialized: true,
      auditFailureRollbackAndRetry: true,
    }))
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON "op_logs"`).catch(() => {})
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`).catch(() => {})
    await new Promise(resolve => setTimeout(resolve, 300))
    await prisma.voucher.deleteMany({
      where: { tenantId: tenant.id, sourceType: 'Payment', sourceId: { in: paymentIds } },
    })
    await prisma.voucherGenerationFailure.deleteMany({
      where: { tenantId: tenant.id, sourceType: 'Payment', sourceId: { in: paymentIds } },
    })
    await prisma.cashTransaction.deleteMany({ where: { refType: 'InvoicePayment', refId: { in: paymentIds } } })
    await prisma.opLog.deleteMany({
      where: {
        tenantId: tenant.id,
        OR: [
          { targetId: { in: paymentIds } },
          { userId: { in: [supplierUser.id, unboundSupplier.id, finance.id, manager.id] } },
        ],
      },
    })
    await prisma.invoicePayment.deleteMany({ where: { id: { in: paymentIds } } })
    await prisma.invoice.deleteMany({ where: { id: { in: invoices.map(invoice => invoice.id) } } })
    await prisma.cashAccount.delete({ where: { id: cashAccount.id } })
    await prisma.user.deleteMany({ where: { id: { in: [supplierUser.id, unboundSupplier.id, finance.id, manager.id] } } })
    await prisma.supplier.delete({ where: { id: supplier.id } })
  }
}

main().finally(() => prisma.$disconnect())
