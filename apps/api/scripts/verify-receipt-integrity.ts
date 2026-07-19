import 'dotenv/config'
import assert from 'node:assert/strict'
import bcrypt from 'bcryptjs'
import { prisma } from '@dianjie/db'

const API_BASE = process.env.TEST_API_BASE || 'http://localhost:4444'
const PASSWORD = 'receipt-local-123'
const TENANT_SLUG = process.env.PREVIEW_TENANT_SLUG || 'yaohai-test'

function assertLocalOnly() {
  const url = process.env.DATABASE_URL || ''
  if (process.env.PREVIEW_MODE !== 'true' || process.env.NODE_ENV === 'production' || !url.includes('dianjie_v4_local')) {
    throw new Error('安全护栏：入库单完整性验证仅允许本地 PREVIEW_MODE 隔离库')
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

async function login(identifier: string, tenantSlug: string) {
  const result = await api('/api/auth/login', null, {
    method: 'POST',
    body: JSON.stringify({ identifier, password: PASSWORD, tenantSlug }),
  })
  assert.equal(result.status, 200, `登录失败: ${JSON.stringify(result.body)}`)
  return result.body.token as string
}

async function main() {
  assertLocalOnly()
  const suffix = Date.now().toString(36)
  const startedAt = new Date()
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: TENANT_SLUG } })
  let receiptId: string | null = null
  let receiptNo: string | null = null
  const failureFunction = `local_receipt_finance_fail_${suffix}`
  const failureTrigger = `local_receipt_finance_trigger_${suffix}`
  let failureTriggerInstalled = false
  const createdStoreIds: string[] = []
  const createdSupplierIds: string[] = []
  const createdUserIds: string[] = []
  const createdProductIds: string[] = []

  try {
    const [storeA, storeB] = await Promise.all([
      prisma.store.create({ data: { tenantId: tenant.id, no: `RV-${suffix}-1`, name: `入库验证一店-${suffix}` } }),
      prisma.store.create({ data: { tenantId: tenant.id, no: `RV-${suffix}-2`, name: `入库验证二店-${suffix}` } }),
    ])
    createdStoreIds.push(storeA.id, storeB.id)
    const [supplierA, supplierB] = await Promise.all([
      prisma.supplier.create({ data: { tenantId: tenant.id, no: `RVS-${suffix}-1`, name: `入库验证供应商甲-${suffix}` } }),
      prisma.supplier.create({ data: { tenantId: tenant.id, no: `RVS-${suffix}-2`, name: `入库验证供应商乙-${suffix}` } }),
    ])
    createdSupplierIds.push(supplierA.id, supplierB.id)
    const password = await bcrypt.hash(PASSWORD, 10)
    const [managerA, managerB, supplierUserA, supplierUserB, financeUser] = await Promise.all([
      prisma.user.create({
        data: { tenantId: tenant.id, name: '验证店长甲', email: `manager-a-${suffix}@local.test`, password, role: 'MANAGER', storeId: storeA.id, storeIds: [storeA.id] },
      }),
      prisma.user.create({
        data: { tenantId: tenant.id, name: '验证店长乙', email: `manager-b-${suffix}@local.test`, password, role: 'MANAGER', storeId: storeB.id, storeIds: [storeB.id] },
      }),
      prisma.user.create({
        data: { tenantId: tenant.id, name: '验证供应商甲', email: `supplier-a-${suffix}@local.test`, password, role: 'SUPPLIER_OWNER', supplierId: supplierA.id },
      }),
      prisma.user.create({
        data: { tenantId: tenant.id, name: '验证供应商乙', email: `supplier-b-${suffix}@local.test`, password, role: 'SUPPLIER_OWNER', supplierId: supplierB.id },
      }),
      prisma.user.create({
        data: { tenantId: tenant.id, name: '验证财务', email: `finance-${suffix}@local.test`, password, role: 'FINANCE' },
      }),
    ])
    createdUserIds.push(managerA.id, managerB.id, supplierUserA.id, supplierUserB.id, financeUser.id)
    const [productA1, productA2, productB] = await Promise.all([
      prisma.product.create({ data: { tenantId: tenant.id, supplierId: supplierA.id, code: `RVP-${suffix}-A1`, name: '验证菌菇', price: 3.33 } }),
      prisma.product.create({ data: { tenantId: tenant.id, supplierId: supplierA.id, code: `RVP-${suffix}-A2`, name: '验证蔬菜', price: 1.11 } }),
      prisma.product.create({ data: { tenantId: tenant.id, supplierId: supplierB.id, code: `RVP-${suffix}-B1`, name: '跨供应商商品', price: 9.99 } }),
    ])
    createdProductIds.push(productA1.id, productA2.id, productB.id)

    const [managerTokenA, managerTokenB, supplierTokenA, supplierTokenB, financeToken] = await Promise.all([
      login(managerA.email, tenant.slug),
      login(managerB.email, tenant.slug),
      login(supplierUserA.email, tenant.slug),
      login(supplierUserB.email, tenant.slug),
      login(financeUser.email, tenant.slug),
    ])
    const baseBody = {
      storeId: storeA.id,
      supplierId: supplierA.id,
      deliveryDate: '2026-07-16',
      note: '入库边界验证',
      items: [
        { productId: productA1.id, quantity: 5, unitPrice: 3.33 },
        { productId: productA2.id, quantity: 2, unitPrice: 1.11 },
      ],
    }

    assert.equal((await api('/api/receipts', supplierTokenA, { method: 'POST', body: JSON.stringify(baseBody) })).status, 403, '供应商不能补录入库单')
    assert.equal((await api('/api/receipts', managerTokenB, { method: 'POST', body: JSON.stringify(baseBody) })).status, 403, '店长不能跨店补录')
    assert.equal((await api('/api/receipts', managerTokenA, {
      method: 'POST',
      body: JSON.stringify({ ...baseBody, items: [...baseBody.items, { productId: productB.id, quantity: 1, unitPrice: 9.99 }] }),
    })).status, 400, '入库商品必须属于所选供应商')
    assert.equal((await api('/api/receipts', managerTokenA, {
      method: 'POST',
      body: JSON.stringify({ ...baseBody, items: [{ ...baseBody.items[0], quantity: 5.001 }, baseBody.items[1]] }),
    })).status, 400, '数量精度不能超过数据库支持的 2 位小数')
    assert.equal((await api('/api/receipts', managerTokenA, {
      method: 'POST',
      body: JSON.stringify({ ...baseBody, items: [{ ...baseBody.items[0], unitPrice: 3.333 }, baseBody.items[1]] }),
    })).status, 400, '单价精度不能超过数据库支持的 2 位小数')

    const created = await api('/api/receipts', managerTokenA, { method: 'POST', body: JSON.stringify(baseBody) })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    receiptId = created.body.id
    receiptNo = created.body.no
    assert.equal(Number(created.body.totalAmount), 18.87)
    assert.equal((await api(`/api/receipts/${receiptId}/mark-delivered`, supplierTokenB, { method: 'PATCH', body: '{}' })).status, 400, '其他供应商不能标记送达')
    assert.equal((await api(`/api/receipts/${receiptId}/mark-delivered`, supplierTokenA, { method: 'PATCH', body: '{}' })).status, 200)

    const lossBody = {
      description: '验收短量',
      evidenceImages: ['local://receipt-proof'],
      items: [
        { productId: productA1.id, receivedQty: 4 },
        { productId: productA2.id, receivedQty: 1 },
      ],
    }
    assert.equal((await api(`/api/receipts/${receiptId}/confirm-with-loss`, managerTokenB, { method: 'PATCH', body: JSON.stringify(lossBody) })).status, 404, '店长不能跨店报损入库')
    assert.equal((await api(`/api/receipts/${receiptId}/confirm-with-loss`, supplierTokenA, { method: 'PATCH', body: JSON.stringify(lossBody) })).status, 403, '供应商不能确认报损入库')
    assert.equal((await api(`/api/receipts/${receiptId}/confirm-with-loss`, managerTokenA, {
      method: 'PATCH', body: JSON.stringify({ ...lossBody, items: lossBody.items.slice(0, 1) }),
    })).status, 400, '报损入库必须完整提交所有明细')
    assert.equal((await api(`/api/receipts/${receiptId}/confirm-with-loss`, managerTokenA, {
      method: 'PATCH', body: JSON.stringify({ ...lossBody, items: [{ productId: productA1.id, receivedQty: 6 }, lossBody.items[1]] }),
    })).status, 400, '实收不能超过应收')

    const [confirmedA, confirmedB] = await Promise.all([
      api(`/api/receipts/${receiptId}/confirm-with-loss`, managerTokenA, { method: 'PATCH', body: JSON.stringify(lossBody) }),
      api(`/api/receipts/${receiptId}/confirm-with-loss`, managerTokenA, { method: 'PATCH', body: JSON.stringify(lossBody) }),
    ])
    const statuses = [confirmedA.status, confirmedB.status].sort((a, b) => a - b)
    assert.equal(statuses[0], 200, JSON.stringify({ confirmedA, confirmedB }))
    assert.ok([404, 409].includes(statuses[1]), `并发重复确认应被拒绝: ${statuses.join(',')}`)

    const stored = await prisma.receipt.findUniqueOrThrow({ where: { id: receiptId }, include: { items: true } })
    assert.equal(stored.status, 'ACCOUNTED')
    assert.equal(Number(stored.totalAmount), 14.43)
    assert.deepEqual(stored.items.map(item => Number(item.quantity)).sort((a, b) => a - b), [1, 4])
    const claims = await prisma.lossClaim.findMany({ where: { tenantId: tenant.id, storeId: storeA.id }, include: { items: true } })
    assert.equal(claims.length, 1)
    assert.equal(Number(claims[0].totalLossAmount), 4.44)
    assert.equal(await prisma.paymentSchedule.count({ where: { receiptId } }), 1)
    assert.equal(await prisma.reconciliationItem.count({ where: { receiptId } }), 1)

    assert.equal((await api(`/api/receipts/${receiptId}/verify`, supplierTokenB, {
      method: 'PATCH', body: JSON.stringify({ actor: 'supplier', note: '不应成功' }),
    })).status, 404, '供应商只能核对自己的入库单')
    for (const payload of [
      { actor: 'supplier', note: { invalid: true } },
      { actor: 'supplier', note: 'x'.repeat(501) },
      { actor: 'supplier', unexpected: true },
    ]) {
      assert.equal((await api(`/api/receipts/${receiptId}/verify`, supplierTokenA, {
        method: 'PATCH', body: JSON.stringify(payload),
      })).status, 400, '核对异常输入必须在写入前拒绝')
    }
    assert.equal((await api(`/api/receipts/${receiptId}/verify`, supplierTokenA, {
      method: 'PATCH', body: JSON.stringify({ actor: 'supplier', note: '数量金额已核对' }),
    })).status, 200)
    assert.equal((await api(`/api/receipts/${receiptId}/verify`, financeToken, {
      method: 'PATCH', body: JSON.stringify({ actor: 'finance', note: '财务已核对' }),
    })).status, 200)
    const verifiedReceipt = await prisma.receipt.findUniqueOrThrow({ where: { id: receiptId } })
    for (const payload of [{}, { actor: 'invalid' }, { actor: 'finance', unexpected: true }]) {
      assert.equal((await api(`/api/receipts/${receiptId}/verify/revoke`, financeToken, {
        method: 'PATCH', body: JSON.stringify(payload),
      })).status, 400, '撤销核对必须明确指定合法 actor')
    }
    assert.deepEqual(
      (await prisma.receipt.findUniqueOrThrow({ where: { id: receiptId } })).financeVerifiedAt,
      verifiedReceipt.financeVerifiedAt,
      '非法撤销请求不得改写财务核对时间',
    )
    assert.equal((await api(`/api/receipts/${receiptId}/verify/revoke`, financeToken, {
      method: 'PATCH', body: JSON.stringify({ actor: 'finance' }),
    })).status, 200)
    assert.equal((await prisma.receipt.findUniqueOrThrow({ where: { id: receiptId } })).financeVerifiedAt, null)

    const recoveryCreated = await api('/api/receipts', managerTokenA, {
      method: 'POST', body: JSON.stringify({ ...baseBody, note: '财务派生故障恢复验证' }),
    })
    assert.equal(recoveryCreated.status, 201, JSON.stringify(recoveryCreated.body))
    const recoveryReceiptId = recoveryCreated.body.id as string
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION "${failureFunction}"() RETURNS trigger AS $$
      BEGIN
        IF NEW."receiptId" = '${recoveryReceiptId}' THEN
          RAISE EXCEPTION 'local receipt finance failure injection';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `)
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "${failureTrigger}"
      BEFORE INSERT ON payment_schedules
      FOR EACH ROW EXECUTE FUNCTION "${failureFunction}"()
    `)
    failureTriggerInstalled = true
    const failedConfirm = await api(`/api/receipts/${recoveryReceiptId}/confirm`, managerTokenA, { method: 'PATCH', body: '{}' })
    assert.equal(failedConfirm.status, 500, '财务派生失败时首次确认应明确失败')
    assert.equal((await prisma.receipt.findUniqueOrThrow({ where: { id: recoveryReceiptId } })).status, 'CONFIRMED', '主确认状态应保留供重试补偿')
    assert.equal(await prisma.paymentSchedule.count({ where: { receiptId: recoveryReceiptId } }), 0)
    assert.equal(await prisma.reconciliationItem.count({ where: { receiptId: recoveryReceiptId } }), 0)
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${failureTrigger}" ON payment_schedules`)
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${failureFunction}"()`)
    failureTriggerInstalled = false

    const recoveredConfirm = await api(`/api/receipts/${recoveryReceiptId}/confirm`, managerTokenA, { method: 'PATCH', body: '{}' })
    assert.equal(recoveredConfirm.status, 200, JSON.stringify(recoveredConfirm.body))
    assert.equal(recoveredConfirm.body.duplicated, true, '重试应进入幂等补偿分支')
    assert.equal((await prisma.receipt.findUniqueOrThrow({ where: { id: recoveryReceiptId } })).status, 'ACCOUNTED')
    assert.equal(await prisma.paymentSchedule.count({ where: { receiptId: recoveryReceiptId } }), 1)
    assert.equal(await prisma.reconciliationItem.count({ where: { receiptId: recoveryReceiptId } }), 1)

    console.log(JSON.stringify({
      ok: true,
      tenantIsolation: true,
      storeIsolation: true,
      supplierIsolation: true,
      atomicLossConfirmation: true,
      financeFailureRecovery: true,
      actualAmount: 14.43,
      lossAmount: 4.44,
    }))
  } finally {
    await new Promise(resolve => setTimeout(resolve, 150))
    if (failureTriggerInstalled) {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${failureTrigger}" ON payment_schedules`)
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${failureFunction}"()`)
    }
    const discoveredReceipts = await prisma.receipt.findMany({
      where: {
        tenantId: tenant.id,
        storeId: { in: createdStoreIds },
        createdById: { in: createdUserIds },
        createdAt: { gte: startedAt },
      },
      select: { id: true, no: true },
    })
    const receiptIds = [...new Set([...(receiptId ? [receiptId] : []), ...discoveredReceipts.map(item => item.id)])]
    const receiptNos = [...new Set([...(receiptNo ? [receiptNo] : []), ...discoveredReceipts.map(item => item.no)])]
    const reconciliationItems = await prisma.reconciliationItem.findMany({
      where: { receiptId: { in: receiptIds } }, select: { reconciliationId: true },
    })
    const reconciliationIds = [...new Set(reconciliationItems.map(item => item.reconciliationId))]
    const vouchers = await prisma.voucher.findMany({
      where: { sourceType: 'Receipt', sourceId: { in: receiptIds } }, select: { id: true },
    })
    const claimIds = (await prisma.lossClaim.findMany({
      where: { storeId: { in: createdStoreIds }, createdById: { in: createdUserIds }, createdAt: { gte: startedAt } },
      select: { id: true },
    })).map(item => item.id)
    await prisma.$transaction(async tx => {
      await tx.voucherEntry.deleteMany({ where: { voucherId: { in: vouchers.map(item => item.id) } } })
      await tx.voucher.deleteMany({ where: { id: { in: vouchers.map(item => item.id) } } })
      await tx.voucherGenerationFailure.deleteMany({
        where: { tenantId: tenant.id, sourceType: 'Receipt', sourceId: { in: receiptIds } },
      })
      for (const no of receiptNos) {
        await tx.notification.deleteMany({
          where: { tenantId: tenant.id, type: 'RECEIPT_CONFIRMED', createdAt: { gte: startedAt }, body: { contains: no } },
        })
      }
      await tx.opLog.deleteMany({
        where: { tenantId: tenant.id, OR: [{ targetId: { in: receiptIds } }, { userId: { in: createdUserIds }, createdAt: { gte: startedAt } }] },
      })
      await tx.paymentSchedule.deleteMany({ where: { receiptId: { in: receiptIds } } })
      await tx.reconciliationItem.deleteMany({ where: { reconciliationId: { in: reconciliationIds } } })
      await tx.reconciliation.deleteMany({ where: { id: { in: reconciliationIds } } })
      await tx.lossClaimItem.deleteMany({ where: { lossClaimId: { in: claimIds } } })
      await tx.lossClaim.deleteMany({ where: { id: { in: claimIds } } })
      await tx.receiptItem.deleteMany({ where: { receiptId: { in: receiptIds } } })
      await tx.receipt.deleteMany({ where: { id: { in: receiptIds } } })
      await tx.product.deleteMany({ where: { id: { in: createdProductIds } } })
      await tx.user.deleteMany({ where: { id: { in: createdUserIds } } })
      await tx.store.deleteMany({ where: { id: { in: createdStoreIds } } })
      await tx.supplier.deleteMany({ where: { id: { in: createdSupplierIds } } })
    })
  }
}

main().then(() => prisma.$disconnect()).catch(async error => {
  console.error(error)
  await prisma.$disconnect()
  process.exit(1)
})
