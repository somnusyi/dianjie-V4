import 'dotenv/config'
import assert from 'node:assert/strict'
import bcrypt from 'bcryptjs'
import { prisma } from '@dianjie/db'

const API_BASE = process.env.TEST_API_BASE || 'http://localhost:4445'
const TENANT_SLUG = process.env.PREVIEW_TENANT_SLUG || 'yaohai-test'
const PASSWORD = 'yaohai@123'
const KEEP_TEST_ORDER = process.env.KEEP_TEST_ORDER === 'true'

function assertLocalOnly() {
  const url = process.env.DATABASE_URL || ''
  if (process.env.PREVIEW_MODE !== 'true' || process.env.NODE_ENV === 'production' || !url.includes('dianjie_v4_local')) {
    throw new Error('安全护栏: 配送验证脚本仅允许本地 PREVIEW_MODE 隔离库')
  }
}

async function api(path: string, token: string | null, init: RequestInit = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers || {}) },
  })
  const body = await response.json().catch(() => ({}))
  return { status: response.status, body }
}

async function login(identifier: string) {
  const result = await api('/api/auth/login', null, {
    method: 'POST', body: JSON.stringify({ identifier, password: PASSWORD, tenantSlug: TENANT_SLUG }),
  })
  assert.equal(result.status, 200, JSON.stringify(result.body))
  return result.body.token as string
}

async function main() {
  assertLocalOnly()
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: TENANT_SLUG } })
  const store = await prisma.store.findFirstOrThrow({ where: { tenantId: tenant.id } })
  const manager = await prisma.user.findFirstOrThrow({ where: { tenantId: tenant.id, role: 'MANAGER', storeId: store.id } })
  const supplier = await prisma.supplier.upsert({
    where: { tenantId_no: { tenantId: tenant.id, no: 'LOCAL-DELIVERY-VERIFY' } },
    update: { status: 'ENABLED', sourceType: 'HEADQ_WAREHOUSE' },
    create: { tenantId: tenant.id, no: 'LOCAL-DELIVERY-VERIFY', name: '本地配送验证供应商', status: 'ENABLED', sourceType: 'HEADQ_WAREHOUSE' },
  })
  const password = await bcrypt.hash(PASSWORD, 10)
  const supplierUser = await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: 'supplier-delivery-verify@local.test' } },
    update: { password, role: 'SUPPLIER_OWNER', status: 'ACTIVE', supplierId: supplier.id },
    create: { tenantId: tenant.id, name: '本地配送验证账号', email: 'supplier-delivery-verify@local.test', password, role: 'SUPPLIER_OWNER', status: 'ACTIVE', supplierId: supplier.id },
  })
  const product = await prisma.product.upsert({
    where: { tenantId_code: { tenantId: tenant.id, code: 'LOCAL-DELIVERY-A' } },
    update: { supplierId: supplier.id, status: 'ENABLED', price: 6.25, stock: 100 },
    create: { tenantId: tenant.id, supplierId: supplier.id, code: 'LOCAL-DELIVERY-A', name: '配送验证菌菇', unit: 'kg', price: 6.25, stock: 100, status: 'ENABLED' },
  })
  const managerToken = await login(manager.email)
  const supplierToken = await login(supplierUser.email)
  let orderId: string | null = null
  let orderNo: string | null = null
  const deliveryIds: string[] = []
  const receiptIds: string[] = []

  try {
    const created = await api('/api/orders', managerToken, {
      method: 'POST',
      body: JSON.stringify({ supplierId: supplier.id, expectedDate: '2026-07-16', note: '分批配送原始备注', idempotencyKey: `delivery-order-${Date.now()}`, items: [{ productId: product.id, quantity: 5, unitPrice: 0 }] }),
    })
    assert.equal(created.status, 200, JSON.stringify(created.body))
    orderId = created.body.id
    orderNo = created.body.no
    const originalHash = created.body.submittedSnapshotHash
    assert.equal((await api(`/api/orders/${orderId}/confirm`, supplierToken, { method: 'PATCH', body: '{}' })).status, 200)

    const forbiddenPrice = await api(`/api/orders/${orderId}/ship`, supplierToken, {
      method: 'PATCH',
      body: JSON.stringify({ idempotencyKey: `delivery-price-${Date.now()}`, items: [{ itemId: created.body.items[0].id, shippedQty: 2, unitPrice: 0.01 }] }),
    })
    assert.equal(forbiddenPrice.status, 400, '配送接口必须拒绝单价字段')

    const firstKey = `delivery-first-${Date.now()}`
    const firstShipBody = JSON.stringify({ idempotencyKey: firstKey, items: [{ itemId: created.body.items[0].id, shippedQty: 2 }] })
    const firstShip = await api(`/api/orders/${orderId}/ship`, supplierToken, {
      method: 'PATCH', body: firstShipBody,
    })
    assert.equal(firstShip.status, 200, JSON.stringify(firstShip.body))
    deliveryIds.push(firstShip.body.deliveryId)
    const repeatedShip = await api(`/api/orders/${orderId}/ship`, supplierToken, { method: 'PATCH', body: firstShipBody })
    assert.equal(repeatedShip.status, 200)
    assert.equal(repeatedShip.body.deliveryId, firstShip.body.deliveryId, '发货重试必须返回同一配送单')
    assert.equal(repeatedShip.body.duplicated, true)
    assert.equal((await api(`/api/orders/${orderId}/deliver`, supplierToken, { method: 'PATCH', body: '{}' })).status, 200)
    const firstReceive = await api(`/api/orders/${orderId}/receive`, managerToken, {
      method: 'PATCH', body: JSON.stringify({ items: [{ productId: product.id, receivedQty: 2 }] }),
    })
    assert.equal(firstReceive.status, 200, JSON.stringify(firstReceive.body))
    receiptIds.push(firstReceive.body.receipt.id)
    assert.equal(firstReceive.body.remainingDelivery, true)
    assert.equal((await api(`/api/orders/${orderId}`, managerToken)).body.status, 'CONFIRMED')

    const secondShip = await api(`/api/orders/${orderId}/ship`, supplierToken, {
      method: 'PATCH', body: JSON.stringify({ idempotencyKey: `delivery-second-${Date.now()}` }),
    })
    assert.equal(secondShip.status, 200, JSON.stringify(secondShip.body))
    deliveryIds.push(secondShip.body.deliveryId)
    assert.equal(Number(secondShip.body.newTotal), 18.75, '第二次默认只配送剩余 3kg')
    assert.equal((await api(`/api/orders/${orderId}/deliver`, supplierToken, { method: 'PATCH', body: '{}' })).status, 200)
    const secondReceive = await api(`/api/orders/${orderId}/receive`, managerToken, {
      method: 'PATCH', body: JSON.stringify({ items: [{ productId: product.id, receivedQty: 3 }] }),
    })
    assert.equal(secondReceive.status, 200, JSON.stringify(secondReceive.body))
    receiptIds.push(secondReceive.body.receipt.id)

    const detail = await api(`/api/orders/${orderId}`, managerToken)
    assert.equal(detail.status, 200)
    assert.equal(detail.body.submittedSnapshotHash, originalHash)
    assert.equal(detail.body.deliveries.length, 2)
    assert.equal(detail.body.receipts.length, 2)
    assert.equal(Number(detail.body.items[0].shippedQty), 5)
    assert.equal(Number(detail.body.items[0].receivedQty), 5)
    assert.equal(detail.body.status, 'COMPLETED')
    const deliveryList = await api(`/api/deliveries?keyword=${encodeURIComponent(orderNo!)}`, managerToken)
    assert.equal(deliveryList.status, 200)
    assert.equal(deliveryList.body.total, 2)
    const deliveryDetail = await api(`/api/deliveries/${deliveryIds[0]}`, supplierToken)
    assert.equal(deliveryDetail.status, 200)
    assert.equal(deliveryDetail.body.purchaseOrder.no, orderNo)
    const movements = await prisma.supplierStockMovement.findMany({ where: { sourceType: 'DeliveryOrder', sourceId: { in: deliveryIds } } })
    assert.equal(movements.length, 2)
    assert.equal(movements.reduce((sum, movement) => sum + Number(movement.delta), 0), -5)
    console.log(JSON.stringify({ ok: true, orderNo, deliveries: 2, receipts: 2, shipped: 5, received: 5 }))
  } finally {
    if (orderId && !KEEP_TEST_ORDER) {
      await new Promise(resolve => setTimeout(resolve, 150))
      const vouchers = await prisma.voucher.findMany({ where: { sourceType: 'Receipt', sourceId: { in: receiptIds } }, select: { id: true } })
      await prisma.$transaction(async tx => {
        await tx.voucher.deleteMany({ where: { id: { in: vouchers.map(voucher => voucher.id) } } })
        await tx.paymentSchedule.deleteMany({ where: { receiptId: { in: receiptIds } } })
        await tx.reconciliationItem.deleteMany({ where: { receiptId: { in: receiptIds } } })
        await tx.receiptItem.deleteMany({ where: { receiptId: { in: receiptIds } } })
        await tx.receipt.deleteMany({ where: { id: { in: receiptIds } } })
        await tx.supplierStockMovement.deleteMany({ where: { sourceType: 'DeliveryOrder', sourceId: { in: deliveryIds } } })
        await tx.deliveryOrderEvent.deleteMany({ where: { deliveryOrderId: { in: deliveryIds } } })
        await tx.deliveryOrderItem.deleteMany({ where: { deliveryOrderId: { in: deliveryIds } } })
        await tx.deliveryOrder.deleteMany({ where: { id: { in: deliveryIds } } })
        await tx.notification.deleteMany({ where: { refType: 'PurchaseOrder', refId: orderId! } })
        await tx.opLog.deleteMany({ where: { OR: [{ targetId: orderId! }, ...(orderNo ? [{ target: orderNo }] : [])] } })
        await tx.purchaseOrderEvent.deleteMany({ where: { purchaseOrderId: orderId! } })
        await tx.purchaseOrderItem.deleteMany({ where: { purchaseOrderId: orderId! } })
        await tx.purchaseOrder.delete({ where: { id: orderId! } })
      })
    }
  }
}

main().then(() => prisma.$disconnect()).catch(async error => {
  console.error(error)
  await prisma.$disconnect()
  process.exit(1)
})
