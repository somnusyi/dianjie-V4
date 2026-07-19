import 'dotenv/config'
import assert from 'node:assert/strict'
import bcrypt from 'bcryptjs'
import { prisma } from '@dianjie/db'
import { autoReceivePurchaseOrder } from '../src/services/scheduler'

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

async function verifyShipmentAuditRollback(orderId: string, itemId: string, productId: string, supplierToken: string) {
  const sqlSuffix = Date.now().toString()
  const failureFunction = `local_shipment_log_failure_fn_${sqlSuffix}`
  const failureTrigger = `local_shipment_log_failure_trg_${sqlSuffix}`
  const idempotencyKey = `local-shipment-log-failure-${sqlSuffix}`
  try {
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION "${failureFunction}"() RETURNS trigger AS $$
      BEGIN
        IF NEW."targetId" = '${orderId}' AND NEW."action" LIKE '供应商确认发货%' THEN
          RAISE EXCEPTION 'local shipment audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `)
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "${failureTrigger}"
      BEFORE INSERT ON "op_logs"
      FOR EACH ROW EXECUTE FUNCTION "${failureFunction}"()
    `)
    const failedShipment = await api(`/api/orders/${orderId}/ship`, supplierToken, {
      method: 'PATCH',
      body: JSON.stringify({ idempotencyKey, items: [{ itemId, shippedQty: 2 }] }),
    })
    assert.equal(failedShipment.status, 500, JSON.stringify(failedShipment.body))
    assert.equal((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: orderId } })).status, 'CONFIRMED')
    assert.equal(await prisma.deliveryOrder.count({ where: { purchaseOrderId: orderId, idempotencyKey } }), 0)
    assert.equal(Number((await prisma.product.findUniqueOrThrow({ where: { id: productId } })).stock), 100)
    assert.equal(Number((await prisma.supplierStockBatch.findFirstOrThrow({ where: { productId } })).remainingQty), 100)
    assert.equal(await prisma.supplierStockMovement.count({ where: { productId, type: 'OUTBOUND_PO' } }), 0)
    assert.equal(await prisma.opLog.count({
      where: { targetId: orderId, action: { startsWith: '供应商确认发货' } },
    }), 0)
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${failureTrigger}" ON "op_logs"`)
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${failureFunction}"()`)
  }
}

async function verifyDeliveryAuditRollback(orderId: string, deliveryId: string, supplierToken: string) {
  const sqlSuffix = Date.now().toString()
  const failureFunction = `local_delivery_log_failure_fn_${sqlSuffix}`
  const failureTrigger = `local_delivery_log_failure_trg_${sqlSuffix}`
  try {
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION "${failureFunction}"() RETURNS trigger AS $$
      BEGIN
        IF NEW."targetId" = '${orderId}' AND NEW."action" LIKE '供应商标记送达%' THEN
          RAISE EXCEPTION 'local delivery audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `)
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "${failureTrigger}"
      BEFORE INSERT ON "op_logs"
      FOR EACH ROW EXECUTE FUNCTION "${failureFunction}"()
    `)
    const failedDelivery = await api(`/api/orders/${orderId}/deliver`, supplierToken, {
      method: 'PATCH', body: JSON.stringify({ note: '真实 HTTP 送达日志故障' }),
    })
    assert.equal(failedDelivery.status, 500, JSON.stringify(failedDelivery.body))
    assert.equal((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: orderId } })).status, 'DELIVERING')
    assert.equal((await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: deliveryId } })).status, 'SHIPPED')
    assert.equal(await prisma.deliveryOrderEvent.count({ where: { deliveryOrderId: deliveryId, eventType: 'DELIVERED' } }), 0)
    assert.equal(await prisma.opLog.count({
      where: { targetId: orderId, action: { startsWith: '供应商标记送达' } },
    }), 0)
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${failureTrigger}" ON "op_logs"`)
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${failureFunction}"()`)
  }
}

async function verifyChefAckDeliveryRace(orderId: string, supplierToken: string, managerToken: string) {
  const sqlSuffix = Date.now().toString()
  const delaySequence = `local_chef_ack_delay_seq_${sqlSuffix}`
  const delayFunction = `local_chef_ack_delay_fn_${sqlSuffix}`
  const delayTrigger = `local_chef_ack_delay_trg_${sqlSuffix}`
  try {
    await prisma.$executeRawUnsafe(`CREATE SEQUENCE "${delaySequence}"`)
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION "${delayFunction}"() RETURNS trigger AS $$
      BEGIN
        IF NEW."id" = '${orderId}' AND NEW."status" = 'PENDING_CONFIRM' THEN
          PERFORM nextval('${delaySequence}');
          PERFORM pg_sleep(0.75);
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `)
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "${delayTrigger}"
      BEFORE UPDATE OF "status" ON "purchase_orders"
      FOR EACH ROW EXECUTE FUNCTION "${delayFunction}"()
    `)
    const sequenceValue = async () => {
      const [row] = await prisma.$queryRawUnsafe<Array<{ value: bigint; is_called: boolean }>>(
        `SELECT last_value::bigint AS value, is_called FROM "${delaySequence}"`,
      )
      return row.is_called ? row.value : 0n
    }
    const deliveryPromise = api(`/api/orders/${orderId}/deliver`, supplierToken, {
      method: 'PATCH', body: JSON.stringify({ note: '真实 HTTP 并发送达' }),
    })
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await sequenceValue() > 0n) break
      if (attempt === 99) throw new Error('未观察到真实 API 送达更新进入并发延迟触发器')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const acknowledgementPromise = api(`/api/orders/${orderId}/chef-ack`, managerToken, {
      method: 'PATCH',
      body: JSON.stringify({ images: ['local://chef-ack-race'], note: '过期验收单必须被拒绝' }),
    })
    const [delivery, acknowledgement] = await Promise.all([deliveryPromise, acknowledgementPromise])
    assert.equal(delivery.status, 200, JSON.stringify(delivery.body))
    assert.equal(acknowledgement.status, 409, JSON.stringify(acknowledgement.body))
    const finalOrder = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: orderId } })
    assert.equal(finalOrder.status, 'PENDING_CONFIRM')
    assert.deepEqual(finalOrder.chefAckImages, [])
    assert.equal(finalOrder.chefAckAt, null)
    assert.equal(await prisma.opLog.count({
      where: { tenantId: finalOrder.tenantId, targetId: orderId, action: { startsWith: '厨师发送验收单' } },
    }), 0)
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${delayTrigger}" ON "purchase_orders"`)
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${delayFunction}"()`)
    await prisma.$executeRawUnsafe(`DROP SEQUENCE IF EXISTS "${delaySequence}"`)
  }
}

async function main() {
  assertLocalOnly()
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: TENANT_SLUG } })
  const store = await prisma.store.findFirstOrThrow({ where: { tenantId: tenant.id } })
  const manager = await prisma.user.findFirstOrThrow({ where: { tenantId: tenant.id, role: 'MANAGER', storeId: store.id } })
  const supplier = await prisma.supplier.upsert({
    where: { tenantId_no: { tenantId: tenant.id, no: 'LOCAL-DELIVERY-VERIFY' } },
    update: { status: 'ENABLED', sourceType: 'MAIN_SUPPLIER' },
    create: { tenantId: tenant.id, no: 'LOCAL-DELIVERY-VERIFY', name: '本地配送验证供应商', status: 'ENABLED', sourceType: 'MAIN_SUPPLIER' },
  })
  const password = await bcrypt.hash(PASSWORD, 10)
  const supplierUser = await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: 'supplier-delivery-verify@local.test' } },
    update: { password, role: 'SUPPLIER_OWNER', status: 'ACTIVE', supplierId: supplier.id },
    create: { tenantId: tenant.id, name: '本地配送验证账号', email: 'supplier-delivery-verify@local.test', password, role: 'SUPPLIER_OWNER', status: 'ACTIVE', supplierId: supplier.id },
  })
  const runMarker = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const product = await prisma.product.create({
    data: {
      tenantId: tenant.id, supplierId: supplier.id, code: `LOCAL-DELIVERY-${runMarker}`,
      name: `配送验证菌菇-${runMarker}`, unit: 'kg', price: 6.25, stock: 100, status: 'ENABLED',
    },
  })
  await prisma.supplierStockBatch.create({
    data: {
      tenantId: tenant.id, supplierId: supplier.id, productId: product.id,
      batchNo: `OPENING-${runMarker}`, kind: 'OPENING', initialQty: 100, remainingQty: 100,
      createdById: supplierUser.id,
    },
  })
    const managerToken = await login(manager.email)
    const supplierToken = await login(supplierUser.email)
    const startedAt = new Date()
  let orderId: string | null = null
  let orderNo: string | null = null
  const deliveryIds: string[] = []
  const receiptIds: string[] = []

  try {
    const localDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())
    const oversizedManualReceipt = await api('/api/receipts', managerToken, {
      method: 'POST',
      body: JSON.stringify({
        storeId: store.id, supplierId: supplier.id, deliveryDate: localDate,
        items: [{ productId: product.id, quantity: 1_000, unitPrice: 10_000_000 }],
      }),
    })
    assert.equal(oversizedManualReceipt.status, 400, JSON.stringify(oversizedManualReceipt.body))

    const oversizedOrder = await api('/api/orders', managerToken, {
      method: 'POST',
      body: JSON.stringify({
        supplierId: supplier.id, expectedDate: '2026-07-16',
        items: [{ productId: product.id, quantity: 100_000_000, unitPrice: 0 }],
      }),
    })
    assert.equal(oversizedOrder.status, 400, JSON.stringify(oversizedOrder.body))

    const created = await api('/api/orders', managerToken, {
      method: 'POST',
      body: JSON.stringify({ supplierId: supplier.id, expectedDate: '2026-07-16', note: '分批配送原始备注', idempotencyKey: `delivery-order-${Date.now()}`, items: [{ productId: product.id, quantity: 5, unitPrice: 0 }] }),
    })
    assert.equal(created.status, 200, JSON.stringify(created.body))
    orderId = created.body.id
    orderNo = created.body.no
    const originalHash = created.body.submittedSnapshotHash
    assert.equal((await api(`/api/orders/${orderId}/confirm`, supplierToken, { method: 'PATCH', body: '{}' })).status, 200)

    const oversizedShipment = await api(`/api/orders/${orderId}/ship`, supplierToken, {
      method: 'PATCH',
      body: JSON.stringify({
        idempotencyKey: `delivery-oversized-${Date.now()}`,
        items: [{ itemId: created.body.items[0].id, shippedQty: 100_000_000 }],
      }),
    })
    assert.equal(oversizedShipment.status, 400, JSON.stringify(oversizedShipment.body))

    const forbiddenPrice = await api(`/api/orders/${orderId}/ship`, supplierToken, {
      method: 'PATCH',
      body: JSON.stringify({ idempotencyKey: `delivery-price-${Date.now()}`, items: [{ itemId: created.body.items[0].id, shippedQty: 2, unitPrice: 0.01 }] }),
    })
    assert.equal(forbiddenPrice.status, 400, '配送接口必须拒绝单价字段')

    await verifyShipmentAuditRollback(orderId, created.body.items[0].id, product.id, supplierToken)

    const firstKey = `delivery-first-${Date.now()}`
    const firstShipBody = JSON.stringify({ idempotencyKey: firstKey, items: [{ itemId: created.body.items[0].id, shippedQty: 2 }] })
    const concurrentShips = await Promise.all([0, 1].map(() => api(`/api/orders/${orderId}/ship`, supplierToken, {
      method: 'PATCH', body: firstShipBody,
    })))
    assert.deepEqual(concurrentShips.map(result => result.status), [200, 200], JSON.stringify(concurrentShips.map(result => result.body)))
    const firstShip = concurrentShips.find(result => result.body.duplicated !== true)!
    const repeatedShip = concurrentShips.find(result => result.body.duplicated === true)!
    assert.ok(firstShip)
    assert.ok(repeatedShip)
    deliveryIds.push(firstShip.body.deliveryId)
    assert.equal(repeatedShip.body.deliveryId, firstShip.body.deliveryId, '发货重试必须返回同一配送单')
    assert.equal(repeatedShip.body.duplicated, true)
    const conflictingShipReplay = await api(`/api/orders/${orderId}/ship`, supplierToken, {
      method: 'PATCH',
      body: JSON.stringify({
        idempotencyKey: firstKey,
        note: '同一幂等键冲突请求',
        items: [{ itemId: created.body.items[0].id, shippedQty: 3 }],
      }),
    })
    assert.equal(conflictingShipReplay.status, 409, JSON.stringify(conflictingShipReplay.body))
    assert.equal(await prisma.deliveryOrder.count({ where: { purchaseOrderId: orderId } }), 1)
    assert.equal(Number((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).stock), 98)
    const invalidAck = await api(`/api/orders/${orderId}/chef-ack`, managerToken, {
      method: 'PATCH', body: JSON.stringify({ images: [123] }),
    })
    assert.equal(invalidAck.status, 400, JSON.stringify(invalidAck.body))
    const invalidDeliver = await api(`/api/orders/${orderId}/deliver`, supplierToken, {
      method: 'PATCH', body: JSON.stringify({ note: { invalid: true } }),
    })
    assert.equal(invalidDeliver.status, 400, JSON.stringify(invalidDeliver.body))
    assert.equal((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: orderId } })).chefAckImages.length, 0)
    assert.equal((await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: firstShip.body.deliveryId } })).status, 'SHIPPED')
    await verifyDeliveryAuditRollback(orderId, firstShip.body.deliveryId, supplierToken)
    await verifyChefAckDeliveryRace(orderId, supplierToken, managerToken)
    for (const payload of [
      { items: [null] },
      { items: [{ productId: product.id, receivedQty: '2' }] },
      { items: [{ productId: product.id, receivedQty: 2 }, { productId: product.id, receivedQty: 1 }] },
      { evidenceImages: [123] },
      { unexpected: true },
    ]) {
      const invalidReceive = await api(`/api/orders/${orderId}/receive`, managerToken, {
        method: 'PATCH', body: JSON.stringify(payload),
      })
      assert.equal(invalidReceive.status, 400, JSON.stringify(invalidReceive.body))
    }
    assert.equal(await prisma.receipt.count({ where: { deliveryOrderId: firstShip.body.deliveryId } }), 0)
    assert.equal((await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: firstShip.body.deliveryId } })).status, 'DELIVERED')
    const firstReceiveBody = JSON.stringify({ items: [{ productId: product.id, receivedQty: 2 }] })
    const [receiveA, receiveB] = await Promise.all([
      api(`/api/orders/${orderId}/receive`, managerToken, { method: 'PATCH', body: firstReceiveBody }),
      api(`/api/orders/${orderId}/receive`, managerToken, { method: 'PATCH', body: firstReceiveBody }),
    ])
    assert.equal(receiveA.status, 200, JSON.stringify(receiveA.body))
    assert.equal(receiveB.status, 200, JSON.stringify(receiveB.body))
    const firstReceive = receiveA.body.duplicated ? receiveB : receiveA
    const repeatedReceive = receiveA.body.duplicated ? receiveA : receiveB
    assert.equal(firstReceive.status, 200, JSON.stringify(firstReceive.body))
    receiptIds.push(firstReceive.body.receipt.id)
    assert.equal(firstReceive.body.remainingDelivery, true)
    assert.equal((await api(`/api/orders/${orderId}`, managerToken)).body.status, 'CONFIRMED')

    assert.equal(repeatedReceive.status, 200, JSON.stringify(repeatedReceive.body))
    assert.equal(repeatedReceive.body.duplicated, true, '并发双收货必须有一个请求返回原入库单')
    assert.equal(repeatedReceive.body.receipt.id, firstReceive.body.receipt.id)
    assert.equal(await prisma.receipt.count({ where: { deliveryOrderId: firstShip.body.deliveryId } }), 1)
    assert.equal(await prisma.deliveryOrderEvent.count({ where: { deliveryOrderId: firstShip.body.deliveryId, eventType: 'RECEIVED' } }), 1)
    assert.equal(await prisma.paymentSchedule.count({ where: { receiptId: firstReceive.body.receipt.id } }), 1)
    assert.equal(await prisma.reconciliationItem.count({ where: { receiptId: firstReceive.body.receipt.id } }), 1)

    const secondShip = await api(`/api/orders/${orderId}/ship`, supplierToken, {
      method: 'PATCH', body: JSON.stringify({ idempotencyKey: `delivery-second-${Date.now()}` }),
    })
    assert.equal(secondShip.status, 200, JSON.stringify(secondShip.body))
    deliveryIds.push(secondShip.body.deliveryId)
    assert.equal(Number(secondShip.body.newTotal), 18.75, '第二次默认只配送剩余 3kg')
    assert.equal((await api(`/api/orders/${orderId}/deliver`, supplierToken, { method: 'PATCH', body: '{}' })).status, 200)
    const overdueDeliveredAt = new Date(Date.now() - 25 * 60 * 60 * 1000)
    await prisma.$transaction([
      prisma.purchaseOrder.update({ where: { id: orderId }, data: { deliveredAt: overdueDeliveredAt } }),
      prisma.deliveryOrder.update({ where: { id: secondShip.body.deliveryId }, data: { deliveredAt: overdueDeliveredAt } }),
    ])
    const [secondAutoReceive, secondManualReceive] = await Promise.all([
      autoReceivePurchaseOrder(orderId),
      api(`/api/orders/${orderId}/receive`, managerToken, {
        method: 'PATCH', body: JSON.stringify({ items: [{ productId: product.id, receivedQty: 3 }] }),
      }),
    ])
    assert.ok(secondAutoReceive, '自动收货竞争后必须返回入库单')
    assert.equal(secondManualReceive.status, 200, JSON.stringify(secondManualReceive.body))
    assert.equal(secondAutoReceive.receipt.id, secondManualReceive.body.receipt.id)
    assert.equal(
      [secondAutoReceive.duplicated, secondManualReceive.body.duplicated === true].filter(Boolean).length,
      1,
      '自动收货与手工收货竞争时必须恰好一方命中幂等结果',
    )
    assert.equal(await prisma.receipt.count({ where: { deliveryOrderId: secondShip.body.deliveryId } }), 1)
    assert.equal(await prisma.deliveryOrderEvent.count({ where: { deliveryOrderId: secondShip.body.deliveryId, eventType: 'RECEIVED' } }), 1)
    assert.equal(await prisma.paymentSchedule.count({ where: { receiptId: secondAutoReceive.receipt.id } }), 1)
    assert.equal(await prisma.reconciliationItem.count({ where: { receiptId: secondAutoReceive.receipt.id } }), 1)
    receiptIds.push(secondAutoReceive.receipt.id)

    const detail = await api(`/api/orders/${orderId}`, managerToken)
    assert.equal(detail.status, 200)
    assert.equal(detail.body.submittedSnapshotHash, originalHash)
    assert.equal(detail.body.deliveries.length, 2)
    assert.equal(detail.body.receipts.length, 2)
    assert.equal(Number(detail.body.items[0].shippedQty), 5)
    assert.equal(Number(detail.body.items[0].receivedQty), 5)
    assert.equal(detail.body.status, 'COMPLETED')
    const orderByProductName = await api(`/api/orders?keyword=${encodeURIComponent(product.name)}&dateFrom=${localDate}&dateTo=${localDate}`, supplierToken)
    assert.equal(orderByProductName.status, 200, JSON.stringify(orderByProductName.body))
    assert.equal(orderByProductName.body.items.some((item: any) => item.id === orderId), true, '订货单应支持按商品名称和日期检索')
    const orderByProductCode = await api(`/api/orders?keyword=${encodeURIComponent(product.code)}`, supplierToken)
    assert.equal(orderByProductCode.status, 200, JSON.stringify(orderByProductCode.body))
    assert.equal(orderByProductCode.body.items.some((item: any) => item.id === orderId), true, '订货单应支持按商品编码检索')
    assert.equal((await api('/api/orders?dateFrom=2026-07-16&dateTo=2026-07-15', supplierToken)).status, 400, '订货单应拒绝反向日期范围')
    const deliveryList = await api(`/api/deliveries?keyword=${encodeURIComponent(orderNo!)}`, managerToken)
    assert.equal(deliveryList.status, 200)
    assert.equal(deliveryList.body.total, 2)
    const deliveryByProduct = await api(`/api/deliveries?keyword=${encodeURIComponent(product.name)}&dateFrom=${localDate}&dateTo=${localDate}`, supplierToken)
    assert.equal(deliveryByProduct.status, 200, JSON.stringify(deliveryByProduct.body))
    assert.deepEqual(new Set(deliveryByProduct.body.items.map((item: any) => item.id)), new Set(deliveryIds), '配送单应支持按商品和日期检索')
    assert.equal((await api('/api/deliveries?dateFrom=2026-07-16&dateTo=2026-07-15', supplierToken)).status, 400, '配送单应拒绝反向日期范围')
    const deliveryDetail = await api(`/api/deliveries/${deliveryIds[0]}`, supplierToken)
    assert.equal(deliveryDetail.status, 200)
    assert.equal(deliveryDetail.body.purchaseOrder.no, orderNo)
    const movements = await prisma.supplierStockMovement.findMany({ where: { sourceType: 'DeliveryOrder', sourceId: { in: deliveryIds } } })
    assert.equal(movements.length, 2)
    assert.equal(movements.reduce((sum, movement) => sum + Number(movement.delta), 0), -5)
    console.log(JSON.stringify({ ok: true, numericBounds: true, manualReceiptAmountBounds: true, statusPayloadValidation: true, shipmentAuditRollback: true, shipmentConcurrentReplay: true, shipmentReplayConflict: true, deliveryAuditRollback: true, chefAckDeliveryRace: true, receiveValidation: true, orderNo, deliveries: 2, receipts: 2, shipped: 5, received: 5 }))
  } finally {
    if (orderId && !KEEP_TEST_ORDER) {
      await new Promise(resolve => setTimeout(resolve, 150))
      const runReceipts = await prisma.receipt.findMany({
        where: {
          tenantId: tenant.id,
          OR: [
            { id: { in: receiptIds } },
            { purchaseOrderId: orderId },
            ...(deliveryIds.length ? [{ deliveryOrderId: { in: deliveryIds } }] : []),
            { supplierId: supplier.id, createdById: manager.id, createdAt: { gte: startedAt } },
          ],
        },
        select: { id: true },
      })
      const cleanupReceiptIds = [...new Set([...receiptIds, ...runReceipts.map(receipt => receipt.id)])]
      const vouchers = await prisma.voucher.findMany({ where: { sourceType: 'Receipt', sourceId: { in: cleanupReceiptIds } }, select: { id: true } })
      const reconciliationItems = await prisma.reconciliationItem.findMany({
        where: { receiptId: { in: cleanupReceiptIds } },
        select: { reconciliationId: true },
      })
      const reconciliationIds = [...new Set(reconciliationItems.map(item => item.reconciliationId))]
      await prisma.$transaction(async tx => {
        await tx.voucher.deleteMany({ where: { id: { in: vouchers.map(voucher => voucher.id) } } })
        await tx.paymentSchedule.deleteMany({ where: { receiptId: { in: cleanupReceiptIds } } })
        await tx.reconciliationItem.deleteMany({ where: { receiptId: { in: cleanupReceiptIds } } })
        await tx.reconciliation.deleteMany({ where: { id: { in: reconciliationIds } } })
        await tx.receiptItem.deleteMany({ where: { receiptId: { in: cleanupReceiptIds } } })
        await tx.receipt.deleteMany({ where: { id: { in: cleanupReceiptIds } } })
        await tx.supplierStockBatchAllocation.deleteMany({ where: { productId: product.id } })
        await tx.supplierStockMovement.deleteMany({ where: { sourceType: 'DeliveryOrder', sourceId: { in: deliveryIds } } })
        await tx.deliveryOrderEvent.deleteMany({ where: { deliveryOrderId: { in: deliveryIds } } })
        await tx.deliveryOrderItem.deleteMany({ where: { deliveryOrderId: { in: deliveryIds } } })
        await tx.deliveryOrder.deleteMany({ where: { id: { in: deliveryIds } } })
        await tx.notification.deleteMany({ where: { refType: 'PurchaseOrder', refId: orderId! } })
        await tx.opLog.deleteMany({ where: { OR: [{ targetId: orderId! }, ...(orderNo ? [{ target: orderNo }] : [])] } })
        await tx.purchaseOrderEvent.deleteMany({ where: { purchaseOrderId: orderId! } })
        await tx.supplierStockReservation.deleteMany({ where: { purchaseOrderId: orderId! } })
        await tx.purchaseOrderItem.deleteMany({ where: { purchaseOrderId: orderId! } })
        await tx.purchaseOrder.delete({ where: { id: orderId! } })
      })
    }
    if (!KEEP_TEST_ORDER) {
      await prisma.$transaction(async tx => {
        await tx.supplierStockBatchAllocation.deleteMany({ where: { productId: product.id } })
        await tx.supplierStockMovement.deleteMany({ where: { productId: product.id } })
        await tx.supplierStockBatch.deleteMany({ where: { productId: product.id } })
        await tx.product.delete({ where: { id: product.id } })
      })
    }
  }
}

main().then(() => prisma.$disconnect()).catch(async error => {
  console.error(error)
  await prisma.$disconnect()
  process.exit(1)
})
