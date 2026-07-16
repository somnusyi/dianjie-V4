import 'dotenv/config'
import assert from 'node:assert/strict'
import bcrypt from 'bcryptjs'
import dayjs from 'dayjs'
import { Prisma, prisma } from '@dianjie/db'
import { invoiceUploadSchema } from '../src/routes/invoices'
import { createSupplierInvoice } from '../src/services/invoiceIntegrity'

const API_BASE = process.env.TEST_API_BASE || 'http://localhost:4444'
const TENANT_SLUG = process.env.PREVIEW_TENANT_SLUG || 'yaohai-test'
const PASSWORD = 'yaohai@123'

function assertLocalOnly() {
  const url = process.env.DATABASE_URL || ''
  if (process.env.PREVIEW_MODE !== 'true' || process.env.NODE_ENV === 'production' || !url.includes('dianjie_v4_local')) {
    throw new Error('安全护栏: 发票完整性验证仅允许本地 PREVIEW_MODE 隔离库')
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
  const store = await prisma.store.create({
    data: { tenantId: tenant.id, no: `INV-${suffix}`, name: `发票完整性门店-${suffix}` },
  })
  const supplier = await prisma.supplier.create({
    data: { tenantId: tenant.id, no: `INV-${suffix}`, name: `发票完整性供应商-${suffix}` },
  })
  const otherSupplier = await prisma.supplier.create({
    data: { tenantId: tenant.id, no: `INV-O-${suffix}`, name: `其他发票供应商-${suffix}` },
  })
  const finance = await prisma.user.create({
    data: {
      tenantId: tenant.id, name: '发票完整性财务', email: `invoice-finance-${suffix}@local.test`,
      password, role: 'FINANCE',
    },
  })
  const manager = await prisma.user.create({
    data: {
      tenantId: tenant.id, storeId: store.id, name: '发票越权店长',
      email: `invoice-manager-${suffix}@local.test`, password, role: 'MANAGER',
    },
  })
  const supplierUser = await prisma.user.create({
    data: {
      tenantId: tenant.id, supplierId: supplier.id, name: '发票供应商',
      email: `invoice-supplier-${suffix}@local.test`, password, role: 'SUPPLIER_OWNER',
    },
  })
  const otherSupplierUser = await prisma.user.create({
    data: {
      tenantId: tenant.id, supplierId: otherSupplier.id, name: '其他发票供应商',
      email: `invoice-other-${suffix}@local.test`, password, role: 'SUPPLIER_OWNER',
    },
  })
  const unboundSupplier = await prisma.user.create({
    data: {
      tenantId: tenant.id, name: '未绑定发票供应商',
      email: `invoice-unbound-${suffix}@local.test`, password, role: 'SUPPLIER_STAFF',
    },
  })
  const receiptIds: string[] = []
  const invoiceIds: string[] = []
  const triggerName = `invoice_guard_${suffix.replace(/[^a-z0-9]/gi, '_')}`
  const functionName = `${triggerName}_fn`

  const makeReceipt = async (label: string, amount: number, supplierId = supplier.id, status: any = 'CONFIRMED') => {
    const receipt = await prisma.receipt.create({
      data: {
        tenantId: tenant.id, no: `RK-INV-${suffix}-${label}`, storeId: store.id, supplierId,
        deliveryDate: new Date('2026-07-16'), totalAmount: amount, status,
        createdById: finance.id, confirmedAt: status === 'CONFIRMED' || status === 'ACCOUNTED' ? new Date() : null,
      },
    })
    receiptIds.push(receipt.id)
    return receipt
  }

  const invoiceInput = (invoiceNo: string, receiptIds: string[], amount: number, supplierId = supplier.id, uploadedById = supplierUser.id) => ({
    tenantId: tenant.id, supplierId, uploadedById, role: 'SUPPLIER_OWNER',
    invoiceNo, invoiceCode: null, amount: new Prisma.Decimal(amount),
    amountWithoutTax: null, taxRate: new Prisma.Decimal('0.06'), taxAmount: null,
    issueDate: new Date('2026-07-16T00:00:00.000+08:00'),
    fileUrl: `https://example.test/${invoiceNo}.pdf`, fileType: 'pdf' as const,
    note: null, receiptIds,
  })

  try {
    const [financeToken, managerToken, supplierToken, otherSupplierToken, unboundToken] = await Promise.all([
      login(finance.email), login(manager.email), login(supplierUser.email),
      login(otherSupplierUser.email), login(unboundSupplier.email),
    ])

    const baseUpload = {
      invoiceNo: '12345678', amount: 100, issueDate: '2026-07-16', receiptIds: ['a'],
    }
    assert.equal(invoiceUploadSchema.safeParse({ ...baseUpload, amount: 100.001 }).success, false)
    assert.equal(invoiceUploadSchema.safeParse({ ...baseUpload, issueDate: dayjs().add(1, 'day').format('YYYY-MM-DD') }).success, false)
    assert.equal(invoiceUploadSchema.safeParse({ ...baseUpload, receiptIds: ['a', 'a'] }).success, false)
    assert.equal(invoiceUploadSchema.safeParse({ ...baseUpload, amountWithoutTax: 90, taxAmount: 9 }).success, false)
    assert.equal(invoiceUploadSchema.safeParse({ ...baseUpload, forged: true }).success, false)

    assert.equal((await api('/api/invoices', managerToken)).status, 403)
    assert.equal((await api('/api/invoices', unboundToken)).status, 403)
    assert.equal((await api('/api/invoices?status=INVALID', financeToken)).status, 400)
    assert.equal((await api('/api/invoices/pending-payable', unboundToken)).status, 403)
    assert.equal((await api('/api/invoices/pending-from-finance', managerToken)).status, 403)
    assert.equal((await api('/api/invoices/not-found/verify', managerToken, {
      method: 'PATCH', body: JSON.stringify({ action: 'APPROVE' }),
    })).status, 403)

    const draftReceipt = await makeReceipt('DRAFT', 5, supplier.id, 'DRAFT')
    const confirmedReceipt = await makeReceipt('PENDING-LIST', 6)
    const pendingList = await api('/api/invoices/pending-payable', supplierToken)
    assert.equal(pendingList.status, 200)
    assert.ok(pendingList.body.some((receipt: any) => receipt.id === confirmedReceipt.id))
    assert.ok(!pendingList.body.some((receipt: any) => receipt.id === draftReceipt.id), '草稿入库不得用于开票')

    const concurrentReceipt = await makeReceipt('CONCURRENT', 100)
    const concurrentResults = await Promise.allSettled([
      createSupplierInvoice(invoiceInput(`INV-${suffix}-A`, [concurrentReceipt.id], 100)),
      createSupplierInvoice(invoiceInput(`INV-${suffix}-B`, [concurrentReceipt.id], 100)),
    ])
    assert.equal(concurrentResults.filter(result => result.status === 'fulfilled').length, 1)
    assert.equal(concurrentResults.filter(result => result.status === 'rejected' && (result.reason as any)?.statusCode === 409).length, 1)
    const concurrentWinner = concurrentResults.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<any>
    const concurrentInvoice = concurrentWinner.value.invoice
    invoiceIds.push(concurrentInvoice.id)
    assert.equal((await prisma.receipt.findUniqueOrThrow({ where: { id: concurrentReceipt.id } })).invoiceId, concurrentInvoice.id)
    assert.equal(await prisma.opLog.count({ where: { entityType: 'Invoice', targetId: concurrentInvoice.id, action: { startsWith: '上传发票' } } }), 1)
    const idempotentCreate = await createSupplierInvoice(invoiceInput(
      concurrentInvoice.invoiceNo, [concurrentReceipt.id], 100,
    ))
    assert.equal(idempotentCreate.duplicated, true)
    assert.equal(idempotentCreate.invoice.id, concurrentInvoice.id)

    let duplicateInvoiceNoBlocked = false
    try {
      await prisma.invoice.create({
        data: {
          tenantId: tenant.id, supplierId: supplier.id, invoiceNo: concurrentInvoice.invoiceNo,
          amount: 1, issueDate: new Date(), fileUrl: 'https://example.test/duplicate.pdf',
          uploadedById: supplierUser.id,
        },
      })
    } catch (error) {
      duplicateInvoiceNoBlocked = error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
    }
    assert.equal(duplicateInvoiceNoBlocked, true)

    const rollbackReceipt = await makeReceipt('CREATE-ROLLBACK', 110)
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION "${functionName}"() RETURNS trigger AS $$
      BEGIN
        IF NEW."userId" = '${supplierUser.id}' AND NEW."action" LIKE '上传发票 %' THEN
          RAISE EXCEPTION 'forced invoice create audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `)
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "${triggerName}" BEFORE INSERT ON "op_logs"
      FOR EACH ROW EXECUTE FUNCTION "${functionName}"()
    `)
    await assert.rejects(
      createSupplierInvoice(invoiceInput(`INV-${suffix}-ROLLBACK`, [rollbackReceipt.id], 110)),
    )
    assert.equal(await prisma.invoice.count({ where: { invoiceNo: `INV-${suffix}-ROLLBACK`, tenantId: tenant.id } }), 0)
    assert.equal((await prisma.receipt.findUniqueOrThrow({ where: { id: rollbackReceipt.id } })).invoiceId, null)
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON "op_logs"`)
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`)
    const recoveredCreate = await createSupplierInvoice(invoiceInput(`INV-${suffix}-ROLLBACK`, [rollbackReceipt.id], 110))
    invoiceIds.push(recoveredCreate.invoice.id)

    const orphanInvoice = await prisma.invoice.create({
      data: {
        tenantId: tenant.id, supplierId: supplier.id, invoiceNo: `INV-${suffix}-ORPHAN`,
        amount: 1, issueDate: new Date('2026-07-16'), fileUrl: 'https://example.test/orphan.pdf',
        uploadedById: supplierUser.id,
      },
    })
    invoiceIds.push(orphanInvoice.id)
    assert.equal((await api(`/api/invoices/${orphanInvoice.id}/verify`, financeToken, {
      method: 'PATCH', body: JSON.stringify({ action: 'APPROVE' }),
    })).status, 409, '未关联入库单的历史发票不得审核通过')

    assert.equal((await api(`/api/invoices/${concurrentInvoice.id}/verify`, financeToken, {
      method: 'PATCH', body: '{}',
    })).status, 400)
    assert.equal((await api(`/api/invoices/${concurrentInvoice.id}/verify`, financeToken, {
      method: 'PATCH', body: JSON.stringify({ action: 'REJECT' }),
    })).status, 400)
    assert.equal((await api(`/api/invoices/${concurrentInvoice.id}/verify`, financeToken, {
      method: 'PATCH', body: JSON.stringify({ action: 'APPROVE', forged: true }),
    })).status, 400)

    const concurrentReviews = await Promise.all([
      api(`/api/invoices/${concurrentInvoice.id}/verify`, financeToken, {
        method: 'PATCH', body: JSON.stringify({ action: 'APPROVE', note: '并发通过' }),
      }),
      api(`/api/invoices/${concurrentInvoice.id}/verify`, financeToken, {
        method: 'PATCH', body: JSON.stringify({ action: 'REJECT', note: '并发驳回' }),
      }),
    ])
    assert.deepEqual(concurrentReviews.map(result => result.status).sort(), [200, 409])
    const winner = concurrentReviews.find(result => result.status === 200)!
    const winningAction = winner.body.status === 'VERIFIED' ? 'APPROVE' : 'REJECT'
    const winningNote = winningAction === 'APPROVE' ? '并发通过' : '并发驳回'
    const repeatedReview = await api(`/api/invoices/${concurrentInvoice.id}/verify`, financeToken, {
      method: 'PATCH', body: JSON.stringify({ action: winningAction, note: winningNote }),
    })
    assert.equal(repeatedReview.status, 200)
    assert.equal(repeatedReview.body.duplicated, true)
    assert.equal(await prisma.opLog.count({
      where: { entityType: 'Invoice', targetId: concurrentInvoice.id, metadata: { path: ['action'], equals: winningAction } },
    }), 1)

    const reviewRollbackReceipt = await makeReceipt('REVIEW-ROLLBACK', 120)
    const reviewRollback = await createSupplierInvoice(invoiceInput(
      `INV-${suffix}-REVIEW-ROLLBACK`, [reviewRollbackReceipt.id], 120,
    ))
    invoiceIds.push(reviewRollback.invoice.id)
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION "${functionName}"() RETURNS trigger AS $$
      BEGIN
        IF NEW."entityType" = 'Invoice' AND NEW."targetId" = '${reviewRollback.invoice.id}'
           AND NEW."action" LIKE '驳回发票 %' THEN
          RAISE EXCEPTION 'forced invoice review audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `)
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "${triggerName}" BEFORE INSERT ON "op_logs"
      FOR EACH ROW EXECUTE FUNCTION "${functionName}"()
    `)
    assert.equal((await api(`/api/invoices/${reviewRollback.invoice.id}/verify`, financeToken, {
      method: 'PATCH', body: JSON.stringify({ action: 'REJECT', note: '故障注入驳回' }),
    })).status, 500)
    assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: reviewRollback.invoice.id } })).status, 'PENDING')
    assert.equal((await prisma.receipt.findUniqueOrThrow({ where: { id: reviewRollbackReceipt.id } })).invoiceId, reviewRollback.invoice.id)
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON "op_logs"`)
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`)
    assert.equal((await api(`/api/invoices/${reviewRollback.invoice.id}/verify`, financeToken, {
      method: 'PATCH', body: JSON.stringify({ action: 'REJECT', note: '故障恢复驳回' }),
    })).status, 200)
    assert.equal((await prisma.receipt.findUniqueOrThrow({ where: { id: reviewRollbackReceipt.id } })).invoiceId, null)

    const otherReceipt = await makeReceipt('OTHER', 50, otherSupplier.id)
    const otherInvoice = await createSupplierInvoice(invoiceInput(
      `INV-${suffix}-OTHER`, [otherReceipt.id], 50, otherSupplier.id, otherSupplierUser.id,
    ))
    invoiceIds.push(otherInvoice.invoice.id)
    const supplierList = await api('/api/invoices', supplierToken)
    assert.equal(supplierList.status, 200)
    assert.ok(supplierList.body.every((invoice: any) => invoice.supplierId === supplier.id))
    assert.equal((await api(`/api/invoices/${otherInvoice.invoice.id}`, supplierToken)).status, 404)
    const otherList = await api('/api/invoices', otherSupplierToken)
    assert.equal(otherList.status, 200)
    assert.ok(otherList.body.some((invoice: any) => invoice.id === otherInvoice.invoice.id))

    console.log(JSON.stringify({
      ok: true,
      strictUploadMetadata: true,
      roleAndSupplierIsolation: true,
      onlyConfirmedReceiptsPayable: true,
      concurrentReceiptClaimSerialized: true,
      duplicateUploadIdempotent: true,
      invoiceNumberDatabaseUnique: true,
      createAuditRollbackAndRetry: true,
      approvalRevalidatesReceiptSet: true,
      concurrentReviewSerialized: true,
      duplicateReviewIdempotent: true,
      rejectAuditRollbackAndRetry: true,
    }))
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON "op_logs"`).catch(() => {})
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`).catch(() => {})
    await prisma.opLog.deleteMany({
      where: {
        tenantId: tenant.id,
        OR: [
          { entityType: 'Invoice', targetId: { in: invoiceIds } },
          { userId: { in: [finance.id, manager.id, supplierUser.id, otherSupplierUser.id, unboundSupplier.id] } },
        ],
      },
    })
    await prisma.receipt.updateMany({ where: { id: { in: receiptIds } }, data: { invoiceId: null } })
    await prisma.invoice.deleteMany({ where: { id: { in: invoiceIds } } })
    await prisma.receipt.deleteMany({ where: { id: { in: receiptIds } } })
    await prisma.user.deleteMany({
      where: { id: { in: [finance.id, manager.id, supplierUser.id, otherSupplierUser.id, unboundSupplier.id] } },
    })
    await prisma.supplier.deleteMany({ where: { id: { in: [supplier.id, otherSupplier.id] } } })
    await prisma.store.delete({ where: { id: store.id } })
  }
}

main().catch(async error => {
  console.error(error)
  await prisma.$disconnect()
  process.exit(1)
}).finally(() => prisma.$disconnect())
