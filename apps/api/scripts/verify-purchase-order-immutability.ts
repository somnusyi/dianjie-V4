import 'dotenv/config'
import assert from 'node:assert/strict'
import bcrypt from 'bcryptjs'
import { prisma } from '@dianjie/db'

const API_BASE = process.env.TEST_API_BASE || 'http://localhost:4445'
const TENANT_SLUG = process.env.PREVIEW_TENANT_SLUG || 'yaohai-test'
const LOCAL_PASSWORD = 'yaohai@123'
const KEEP_TEST_ORDER = process.env.KEEP_TEST_ORDER === 'true'
const STOP_AT_PENDING = process.env.STOP_AT_PENDING === 'true'

function assertLocalOnly() {
  const url = process.env.DATABASE_URL || ''
  if (process.env.NODE_ENV === 'production' || process.env.PREVIEW_MODE !== 'true' || !url.includes('dianjie_v4_local')) {
    throw new Error('安全护栏: 订货单验证脚本仅允许本地 PREVIEW_MODE 隔离库')
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
  const result = await api('/api/auth/login', null, {
    method: 'POST',
    body: JSON.stringify({ identifier, password: LOCAL_PASSWORD, tenantSlug: TENANT_SLUG }),
  })
  assert.equal(result.status, 200, `登录失败: ${JSON.stringify(result.body)}`)
  return result.body.token as string
}

async function main() {
  assertLocalOnly()
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: TENANT_SLUG } })
  const store = await prisma.store.findFirstOrThrow({ where: { tenantId: tenant.id } })
  const manager = await prisma.user.findFirstOrThrow({ where: { tenantId: tenant.id, role: 'MANAGER', storeId: store.id } })
  const password = await bcrypt.hash(LOCAL_PASSWORD, 10)
  const supplier = await prisma.supplier.upsert({
    where: { tenantId_no: { tenantId: tenant.id, no: 'LOCAL-PO-VERIFY' } },
    update: { name: '本地订货单验证供应商', status: 'ENABLED' },
    create: { tenantId: tenant.id, no: 'LOCAL-PO-VERIFY', name: '本地订货单验证供应商', status: 'ENABLED' },
  })
  const supplierUser = await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: 'supplier-order-verify@local.test' } },
    update: { password, role: 'SUPPLIER_OWNER', status: 'ACTIVE', supplierId: supplier.id },
    create: {
      tenantId: tenant.id, name: '本地供应商验证账号', email: 'supplier-order-verify@local.test',
      password, role: 'SUPPLIER_OWNER', status: 'ACTIVE', supplierId: supplier.id,
    },
  })
  const runMarker = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const productA = await prisma.product.create({
    data: {
      tenantId: tenant.id, supplierId: supplier.id, code: `LOCAL-PO-A-${runMarker}`,
      name: '验证土豆', unit: 'kg', price: 3.33, stock: 20, status: 'ENABLED',
    },
  })
  const productB = await prisma.product.create({
    data: {
      tenantId: tenant.id, supplierId: supplier.id, code: `LOCAL-PO-B-${runMarker}`,
      name: '验证青椒', unit: 'kg', price: 4.5, stock: 20, status: 'ENABLED',
    },
  })
  await prisma.supplierStockBatch.createMany({
    data: [productA, productB].map((product, index) => ({
      tenantId: tenant.id, supplierId: supplier.id, productId: product.id,
      batchNo: `OPENING-${runMarker}-${index + 1}`, kind: 'OPENING' as const,
      initialQty: 20, remainingQty: 20, createdById: supplierUser.id,
    })),
  })

  const managerToken = await login(manager.email)
  const supplierToken = await login(supplierUser.email)
  const idempotencyKey = `verify-${Date.now()}`
  let orderId: string | null = null
  let orderNo: string | null = null
  const cleanupOrders: Array<{ id: string; no: string | null }> = []

  try {
    const createBoundaryPayload = {
      supplierId: supplier.id,
      expectedDate: '2026-07-16',
      items: [{ productId: productA.id, quantity: 1, unitPrice: 0 }],
    }
    for (const invalidPayload of [
      { ...createBoundaryPayload, unexpected: true },
      { ...createBoundaryPayload, items: [{ ...createBoundaryPayload.items[0], unexpected: true }] },
      { ...createBoundaryPayload, note: 'x'.repeat(501) },
    ]) {
      const invalidCreate = await api('/api/orders', managerToken, {
        method: 'POST', body: JSON.stringify(invalidPayload),
      })
      assert.equal(invalidCreate.status, 400, `订货创建必须拒绝未知或超长字段: ${JSON.stringify(invalidCreate.body)}`)
    }

    for (const transition of [
      { marker: 'cancel', endpoint: 'cancel', token: managerToken, maxLength: 200, validReason: '门店正常撤回' },
      { marker: 'reject', endpoint: 'reject', token: supplierToken, maxLength: 100, validReason: '供应商正常拒单' },
    ]) {
      const reasonOrder = await api('/api/orders', managerToken, {
        method: 'POST',
        body: JSON.stringify({
          supplierId: supplier.id,
          expectedDate: '2026-07-16',
          idempotencyKey: `verify-reason-${transition.marker}-${Date.now()}`,
          items: [{ productId: productA.id, quantity: 1, unitPrice: 0 }],
        }),
      })
      assert.equal(reasonOrder.status, 200, JSON.stringify(reasonOrder.body))
      cleanupOrders.push({ id: reasonOrder.body.id, no: reasonOrder.body.no || null })
      for (const invalidPayload of [
        { reason: { invalid: true } },
        { reason: 'x'.repeat(transition.maxLength + 1) },
        { reason: '正常原因', unexpected: true },
      ]) {
        const invalid = await api(`/api/orders/${reasonOrder.body.id}/${transition.endpoint}`, transition.token, {
          method: 'PATCH', body: JSON.stringify(invalidPayload),
        })
        assert.equal(invalid.status, 400, `${transition.endpoint} 必须拒绝畸形原因: ${JSON.stringify(invalid.body)}`)
      }
      const unchanged = await api(`/api/orders/${reasonOrder.body.id}`, managerToken)
      assert.equal(unchanged.status, 200)
      assert.equal(unchanged.body.status, 'SUBMITTED')
      assert.equal(unchanged.body.timeline.filter((event: any) => event.eventType === 'CANCELLED').length, 0)
      const valid = await api(`/api/orders/${reasonOrder.body.id}/${transition.endpoint}`, transition.token, {
        method: 'PATCH', body: JSON.stringify({ reason: transition.validReason }),
      })
      assert.equal(valid.status, 200, JSON.stringify(valid.body))
    }

    const createBody = {
      supplierId: supplier.id,
      expectedDate: '2026-07-16',
      note: '原始备注不可修改',
      idempotencyKey,
      items: [{ productId: productA.id, quantity: 5, unitPrice: 0 }],
    }
    const created = await api('/api/orders', managerToken, { method: 'POST', body: JSON.stringify(createBody) })
    assert.equal(created.status, 200)
    orderId = created.body.id
    orderNo = created.body.no
    cleanupOrders.push({ id: orderId, no: orderNo })
    assert.ok(created.body.submittedSnapshotHash, `创建响应缺少快照哈希: ${JSON.stringify(created.body)}`)
    assert.equal(Number(created.body.originalTotalAmount), 16.65)

    const duplicate = await api('/api/orders', managerToken, { method: 'POST', body: JSON.stringify(createBody) })
    assert.equal(duplicate.status, 200)
    assert.equal(duplicate.body.id, orderId, '持久化幂等必须返回同一订单')

    const originalHash = created.body.submittedSnapshotHash
    const forbiddenPriceChange = await api(`/api/orders/${orderId}/revisions`, supplierToken, {
      method: 'POST',
      body: JSON.stringify({
        reason: '尝试修改价格', baseRowVersion: created.body.rowVersion,
        requestKey: `forbidden-price-${Date.now()}`,
        items: [{ productId: productA.id, quantity: 4, unitPrice: 0.01 }],
      }),
    })
    assert.equal(forbiddenPriceChange.status, 400, '改单接口必须明确拒绝单价字段')

    const revision = await api(`/api/orders/${orderId}/revisions`, supplierToken, {
      method: 'POST',
      body: JSON.stringify({
        reason: '库存不足并补充青椒', baseRowVersion: created.body.rowVersion,
        requestKey: `revision-${Date.now()}`,
        items: [
          { productId: productA.id, quantity: 4 },
          { productId: productB.id, quantity: 3 },
        ],
      }),
    })
    assert.equal(revision.status, 201, JSON.stringify(revision.body))

    const blockedConfirm = await api(`/api/orders/${orderId}/confirm`, supplierToken, { method: 'PATCH', body: '{}' })
    assert.equal(blockedConfirm.status, 409, '有待确认改单时必须禁止接单')

    if (STOP_AT_PENDING) {
      console.log(JSON.stringify({
        ok: true,
        stage: 'PENDING_REVISION',
        orderId,
        orderNo,
        managerUrl: `/v2/chef/purchase/po-success/${orderId}`,
        supplierUrl: `/v2/supplier/orders/${orderId}`,
      }))
      return
    }

    const approved = await api(`/api/orders/${orderId}/revisions/${revision.body.id}/approve`, managerToken, {
      method: 'PATCH', body: JSON.stringify({ note: '同意库存调整' }),
    })
    assert.equal(approved.status, 200, JSON.stringify(approved.body))

    const detail = await api(`/api/orders/${orderId}`, managerToken)
    assert.equal(detail.status, 200)
    assert.equal(detail.body.submittedSnapshotHash, originalHash, '改单后原始快照 hash 不能改变')
    assert.equal(Number(detail.body.originalTotalAmount), 16.65)
    assert.equal(Number(detail.body.currentOrderAmount), 26.82)
    assert.equal(detail.body.original.items.length, 1)
    assert.equal(detail.body.current.items.length, 2)
    assert.equal(detail.body.revisions[0].status, 'APPROVED')

    const invalidConfirm = await api(`/api/orders/${orderId}/confirm`, supplierToken, {
      method: 'PATCH', body: JSON.stringify({ unexpected: true }),
    })
    assert.equal(invalidConfirm.status, 400, '接单必须拒绝未使用字段')
    const beforeConfirm = await api(`/api/orders/${orderId}`, supplierToken)
    assert.equal(beforeConfirm.body.status, 'SUBMITTED')
    assert.equal(beforeConfirm.body.timeline.filter((event: any) => event.eventType === 'ACCEPTED').length, 0)

    const confirmed = await api(`/api/orders/${orderId}/confirm`, supplierToken, { method: 'PATCH', body: '{}' })
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body))
    const finalDetail = await api(`/api/orders/${orderId}`, supplierToken)
    assert.equal(finalDetail.body.status, 'CONFIRMED')
    assert.equal(finalDetail.body.submittedSnapshotHash, originalHash)
    assert.ok(finalDetail.body.timeline.some((event: any) => event.eventType === 'REVISION_REQUESTED'))
    assert.ok(finalDetail.body.timeline.some((event: any) => event.eventType === 'REVISION_APPROVED'))
    assert.ok(finalDetail.body.timeline.some((event: any) => event.eventType === 'ACCEPTED'))

    console.log(JSON.stringify({ ok: true, orderNo: finalDetail.body.no, originalAmount: 16.65, currentAmount: 26.82, events: finalDetail.body.timeline.length }))
  } finally {
    if (!KEEP_TEST_ORDER) {
      for (const cleanupOrder of cleanupOrders.reverse()) {
        await prisma.$transaction(async tx => {
          await tx.notification.deleteMany({ where: { refType: 'PurchaseOrder', refId: cleanupOrder.id } })
          await tx.opLog.deleteMany({
            where: { OR: [{ targetId: cleanupOrder.id }, ...(cleanupOrder.no ? [{ target: cleanupOrder.no }] : [])] },
          })
          await tx.purchaseOrderEvent.deleteMany({ where: { purchaseOrderId: cleanupOrder.id } })
          await tx.supplierStockReservation.deleteMany({ where: { purchaseOrderId: cleanupOrder.id } })
          await tx.purchaseOrderItem.deleteMany({ where: { purchaseOrderId: cleanupOrder.id } })
          await tx.purchaseOrderRevision.deleteMany({ where: { purchaseOrderId: cleanupOrder.id } })
          await tx.purchaseOrder.deleteMany({ where: { id: cleanupOrder.id } })
        })
      }
    }
    if (!KEEP_TEST_ORDER) {
      await prisma.$transaction(async tx => {
        await tx.supplierStockBatch.deleteMany({ where: { productId: { in: [productA.id, productB.id] } } })
        await tx.product.deleteMany({ where: { id: { in: [productA.id, productB.id] } } })
      })
    }
  }
}

main().then(() => prisma.$disconnect()).catch(async error => {
  console.error(error)
  await prisma.$disconnect()
  process.exit(1)
})
