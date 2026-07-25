import Fastify from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { prisma } from '@dianjie/db'
import { deliveryRoutes } from '../../src/routes/deliveries'
import { purchaseOrderRoutes } from '../../src/routes/orders'
import { lossClaimRoutes } from '../../src/routes/lossClaims'
import { receiptRoutes } from '../../src/routes/receipts'
import { auditSupplierSupplyChain } from '../../src/services/supplyChainAudit'

const suffix = `supply-flow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let tenantId = ''
let supplierId = ''
let storeId = ''
let supplierUserId = ''
let chefUserId = ''
let productId = ''
let app: ReturnType<typeof Fastify>

describe('supplier order to receipt flow (integration)', () => {
  beforeAll(async () => {
    const tenant = await prisma.tenant.create({ data: { name: `供应链流程测试 ${suffix}`, slug: suffix } })
    tenantId = tenant.id
    const supplier = await prisma.supplier.create({ data: { tenantId, no: `SUP-${suffix}`, name: '供应链流程供应商', inventoryMode: 'STRICT' } })
    supplierId = supplier.id
    const store = await prisma.store.create({ data: { tenantId, no: `STORE-${suffix}`, name: '供应链流程门店' } })
    storeId = store.id
    const [supplierUser, chefUser] = await Promise.all([
      prisma.user.create({
        data: {
          tenantId, supplierId, name: '流程供应商', email: `supplier-${suffix}@local.test`,
          password: 'integration-test-only', role: 'SUPPLIER_OWNER',
        },
      }),
      prisma.user.create({
        data: {
          tenantId, storeId, storeIds: [storeId], name: '流程厨师长', email: `chef-${suffix}@local.test`,
          password: 'integration-test-only', role: 'KITCHEN_LEAD',
        },
      }),
    ])
    supplierUserId = supplierUser.id
    chefUserId = chefUser.id
    const product = await prisma.product.create({
      data: {
        tenantId, supplierId, code: `${suffix}-P`, name: '流程鲜菌', category: '菌菇', unit: '斤',
        inventoryUnit: 'g', inventoryUnitsPerPurchaseUnit: 500, unitConversionStatus: 'VERIFIED',
        price: 10, stock: 10, minOrderQty: 1, stepQty: 1, shelfDays: 7,
      },
    })
    productId = product.id
    await prisma.supplierStockBatch.create({
      data: {
        tenantId, supplierId, productId, batchNo: `OPENING-${suffix}`, kind: 'OPENING',
        initialQty: 10, remainingQty: 10, createdById: supplierUserId,
      },
    })

    app = Fastify()
    app.decorate('authenticate', async (request: any) => {
      const actor = String(request.headers['x-test-actor'] || 'chef')
      request.user = actor === 'supplier'
        ? { tenantId, supplierId, userId: supplierUserId, role: 'SUPPLIER_OWNER' }
        : actor === 'admin'
          ? { tenantId, userId: chefUserId, role: 'ADMIN' }
          : { tenantId, storeId, storeIds: [storeId], userId: chefUserId, role: 'KITCHEN_LEAD' }
    })
    await app.register(purchaseOrderRoutes, { prefix: '/api/orders' })
    await app.register(deliveryRoutes, { prefix: '/api/deliveries' })
    await app.register(lossClaimRoutes, { prefix: '/api/loss-claims' })
    await app.register(receiptRoutes, { prefix: '/api/receipts' })
    await app.ready()
  })

  afterAll(async () => {
    if (app) await app.close()
    await new Promise(resolve => setTimeout(resolve, 100))
    if (!tenantId) return
    await prisma.invoicePayment.deleteMany({ where: { tenantId } })
    await prisma.paymentSchedule.deleteMany({ where: { tenantId } })
    await prisma.reconciliationItem.deleteMany({ where: { reconciliation: { tenantId } } })
    await prisma.reconciliation.deleteMany({ where: { tenantId } })
    await prisma.voucherEntry.deleteMany({ where: { voucher: { tenantId } } })
    await prisma.voucher.deleteMany({ where: { tenantId } })
    await prisma.lossClaimItem.deleteMany({ where: { lossClaim: { tenantId } } })
    await prisma.lossClaim.deleteMany({ where: { tenantId } })
    await prisma.receiptItem.deleteMany({ where: { receipt: { tenantId } } })
    await prisma.receipt.deleteMany({ where: { tenantId } })
    await prisma.deliveryOrderEvent.deleteMany({ where: { tenantId } })
    await prisma.deliveryOrderItem.deleteMany({ where: { deliveryOrder: { tenantId } } })
    await prisma.deliveryOrder.deleteMany({ where: { tenantId } })
    await prisma.supplierStockReservation.deleteMany({ where: { tenantId } })
    await prisma.supplierStockBatchAllocation.deleteMany({ where: { tenantId } })
    await prisma.supplierStockBatch.deleteMany({ where: { tenantId } })
    await prisma.supplierStockMovement.deleteMany({ where: { tenantId } })
    await prisma.purchaseOrderEvent.deleteMany({ where: { tenantId } })
    await prisma.purchaseOrderRevision.deleteMany({ where: { tenantId } })
    await prisma.purchaseOrderItem.deleteMany({ where: { purchaseOrder: { tenantId } } })
    await prisma.purchaseOrder.deleteMany({ where: { tenantId } })
    await prisma.notification.deleteMany({ where: { tenantId } })
    await prisma.opLog.deleteMany({ where: { tenantId } })
    await prisma.businessSequence.deleteMany({ where: { tenantId } })
    await prisma.product.deleteMany({ where: { tenantId } })
    await prisma.user.deleteMany({ where: { tenantId } })
    await prisma.store.deleteMany({ where: { tenantId } })
    await prisma.supplier.deleteMany({ where: { tenantId } })
    await prisma.tenant.delete({ where: { id: tenantId } })
  })

  it('rejects invalid list dates, oversized pages and order numeric overflows before writes', async () => {
    for (const endpoint of ['/api/orders', '/api/deliveries']) {
      for (const query of ['dateFrom=2026-02-29', 'dateTo=2026-04-31', 'page=100001']) {
        const response = await app.inject({
          method: 'GET',
          url: `${endpoint}?${query}`,
          headers: { 'x-test-actor': 'supplier' },
        })
        expect(response.statusCode).toBe(400)
      }
    }
    const invalidCreate = await app.inject({
      method: 'POST', url: '/api/orders', headers: { 'x-test-actor': 'chef' },
      payload: {
        supplierId, storeId, expectedDate: '2026-02-29',
        items: [{ productId, quantity: 1, unitPrice: 10 }],
      },
    })
    expect(invalidCreate.statusCode).toBe(400)

    const beforeOrderCount = await prisma.purchaseOrder.count({ where: { tenantId } })
    const invalidQuantity = await app.inject({
      method: 'POST', url: '/api/orders', headers: { 'x-test-actor': 'chef' },
      payload: {
        supplierId, storeId, expectedDate: '2026-07-20',
        items: [{ productId, quantity: 100_000_000, unitPrice: 10 }],
      },
    })
    expect(invalidQuantity.statusCode).toBe(400)
    const tooManyLines = await app.inject({
      method: 'POST', url: '/api/orders', headers: { 'x-test-actor': 'chef' },
      payload: {
        supplierId, storeId, expectedDate: '2026-07-20',
        items: Array.from({ length: 501 }, () => ({ productId, quantity: 1, unitPrice: 10 })),
      },
    })
    expect(tooManyLines.statusCode).toBe(400)

    const highPriceProduct = await prisma.product.create({
      data: {
        tenantId, supplierId, code: `${suffix}-HIGH`, name: '金额边界商品',
        category: '菌菇', unit: '斤', price: 99_999_999.99, stock: 0,
      },
    })
    await prisma.product.update({ where: { id: productId }, data: { price: 99_999_999.99 } })
    try {
      const lineOverflow = await app.inject({
        method: 'POST', url: '/api/orders', headers: { 'x-test-actor': 'chef' },
        payload: {
          supplierId, storeId, expectedDate: '2026-07-20',
          items: [{ productId, quantity: 101, unitPrice: 0 }],
        },
      })
      expect(lineOverflow.statusCode).toBe(400)
      const totalOverflow = await app.inject({
        method: 'POST', url: '/api/orders', headers: { 'x-test-actor': 'chef' },
        payload: {
          supplierId, storeId, expectedDate: '2026-07-20',
          items: [
            { productId, quantity: 100, unitPrice: 0 },
            { productId: highPriceProduct.id, quantity: 100, unitPrice: 0 },
          ],
        },
      })
      expect(totalOverflow.statusCode).toBe(400)

      const manualReceiptCount = await prisma.receipt.count({ where: { tenantId } })
      const manualLineOverflow = await app.inject({
        method: 'POST', url: '/api/receipts', headers: { 'x-test-actor': 'chef' },
        payload: {
          storeId, supplierId, deliveryDate: '2026-07-20',
          items: [{ productId, quantity: 1_000, unitPrice: 10_000_000 }],
        },
      })
      expect(manualLineOverflow.statusCode).toBe(400)
      const manualTotalOverflow = await app.inject({
        method: 'POST', url: '/api/receipts', headers: { 'x-test-actor': 'chef' },
        payload: {
          storeId, supplierId, deliveryDate: '2026-07-20',
          items: [
            { productId, quantity: 500, unitPrice: 10_000_000 },
            { productId: highPriceProduct.id, quantity: 500, unitPrice: 10_000_000 },
          ],
        },
      })
      expect(manualTotalOverflow.statusCode).toBe(400)
      expect(await prisma.receipt.count({ where: { tenantId } })).toBe(manualReceiptCount)
    } finally {
      await prisma.product.update({ where: { id: productId }, data: { price: 10 } })
      await prisma.product.delete({ where: { id: highPriceProduct.id } })
    }
    expect(await prisma.purchaseOrder.count({ where: { tenantId } })).toBe(beforeOrderCount)
  })

  it('rejects conflicting purchase order creation replays', async () => {
    const failureSuffix = Date.now().toString()
    const failureFunction = `test_order_create_log_failure_fn_${failureSuffix}`
    const failureTrigger = `test_order_create_log_failure_trg_${failureSuffix}`
    const failureKey = `create-log-failure-${suffix}`
    try {
      await prisma.$executeRawUnsafe(`
        CREATE FUNCTION "${failureFunction}"() RETURNS trigger AS $$
        BEGIN
          IF NEW."tenantId" = '${tenantId}' AND NEW."userId" = '${chefUserId}' AND NEW."action" LIKE '创建采购订单%' THEN
            RAISE EXCEPTION 'test order creation audit failure';
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
      const failedCreate = await app.inject({
        method: 'POST', url: '/api/orders', headers: { 'x-test-actor': 'chef' },
        payload: {
          supplierId, storeId, expectedDate: '2026-07-20', idempotencyKey: failureKey,
          items: [{ productId, quantity: 1, unitPrice: 999 }],
        },
      })
      expect(failedCreate.statusCode).toBe(500)
      expect(await prisma.purchaseOrder.count({ where: { tenantId, createdById: chefUserId, idempotencyKey: failureKey } })).toBe(0)
      expect(await prisma.opLog.count({ where: { tenantId, userId: chefUserId, action: { startsWith: '创建采购订单' } } })).toBe(0)
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${failureTrigger}" ON "op_logs"`)
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${failureFunction}"()`)
    }

    const idempotencyKey = `create-replay-${suffix}`
    const payload = {
      supplierId, storeId, expectedDate: '2026-07-20', note: '订货创建幂等', idempotencyKey,
      items: [{ productId, quantity: 1, unitPrice: 999 }],
    }
    const created = await app.inject({
      method: 'POST', url: '/api/orders', headers: { 'x-test-actor': 'chef' }, payload,
    })
    expect(created.statusCode).toBe(200)
    const replayed = await app.inject({
      method: 'POST', url: '/api/orders', headers: { 'x-test-actor': 'chef' }, payload,
    })
    expect(replayed.statusCode).toBe(200)
    expect(replayed.json().id).toBe(created.json().id)
    const conflicting = await app.inject({
      method: 'POST', url: '/api/orders', headers: { 'x-test-actor': 'chef' },
      payload: { ...payload, items: [{ productId, quantity: 2, unitPrice: 999 }] },
    })
    expect(conflicting.statusCode).toBe(409)
    expect(await prisma.purchaseOrder.count({ where: { tenantId, createdById: chefUserId, idempotencyKey } })).toBe(1)

    const concurrentKey = `create-concurrent-${suffix}`
    const concurrentPayload = { ...payload, idempotencyKey: concurrentKey, note: '订货创建并发幂等' }
    const concurrentCreates = await Promise.all([0, 1].map(() => app.inject({
      method: 'POST', url: '/api/orders', headers: { 'x-test-actor': 'chef' }, payload: concurrentPayload,
    })))
    expect(concurrentCreates.map(result => result.statusCode)).toEqual([200, 200])
    expect(new Set(concurrentCreates.map(result => result.json().id)).size).toBe(1)
    const concurrentOrderId = concurrentCreates[0].json().id
    expect(await prisma.purchaseOrder.count({
      where: { tenantId, createdById: chefUserId, idempotencyKey: concurrentKey },
    })).toBe(1)
    expect(await prisma.purchaseOrderEvent.count({ where: { purchaseOrderId: concurrentOrderId } })).toBe(2)
    expect(await prisma.opLog.count({
      where: { tenantId, userId: chefUserId, targetId: concurrentOrderId, action: { startsWith: '创建采购订单' } },
    })).toBe(1)
  })

  it('serializes receipt delivery, confirmation, rejection and void transitions', async () => {
    const sqlSuffix = Date.now().toString()
    const delaySequence = `test_receipt_state_delay_seq_${sqlSuffix}`
    const delayFunction = `test_receipt_state_delay_fn_${sqlSuffix}`
    const delayTrigger = `test_receipt_state_delay_trg_${sqlSuffix}`
    const createReceipt = (marker: string, status: 'DRAFT' | 'PENDING_CONFIRM') => prisma.receipt.create({
      data: {
        tenantId,
        no: `RACE-${marker}-${suffix}`,
        storeId,
        supplierId,
        deliveryDate: new Date('2026-07-20T00:00:00.000Z'),
        totalAmount: 10,
        status,
        isManual: true,
        createdById: chefUserId,
        items: {
          create: {
            productId,
            quantity: 1,
            unitPrice: 10,
            amount: 10,
            productCodeSnapshot: `${suffix}-P`,
            productNameSnapshot: '流程鲜菌',
            productUnitSnapshot: '斤',
          },
        },
      },
    })
    const [rejectRace, voidRace, deliveryRace] = await Promise.all([
      createReceipt('REJECT', 'PENDING_CONFIRM'),
      createReceipt('VOID', 'PENDING_CONFIRM'),
      createReceipt('DELIVERY', 'DRAFT'),
    ])

    await prisma.$executeRawUnsafe(`CREATE SEQUENCE "${delaySequence}"`)
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION "${delayFunction}"() RETURNS trigger AS $$
      BEGIN
        IF (
          NEW."id" IN ('${rejectRace.id}', '${voidRace.id}')
          AND NEW."status" = 'CONFIRMED'
        ) OR (
          NEW."id" = '${deliveryRace.id}'
          AND NEW."status" = 'PENDING_CONFIRM'
        ) THEN
          PERFORM nextval('${delaySequence}');
          PERFORM pg_sleep(0.75);
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `)
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "${delayTrigger}"
      BEFORE UPDATE OF "status" ON "receipts"
      FOR EACH ROW EXECUTE FUNCTION "${delayFunction}"()
    `)

    const sequenceValue = async () => {
      const [row] = await prisma.$queryRawUnsafe<Array<{ value: bigint; is_called: boolean }>>(
        `SELECT last_value::bigint AS value, is_called FROM "${delaySequence}"`,
      )
      return row.is_called ? row.value : 0n
    }
    const waitForDelayedUpdate = async (previous: bigint) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await sequenceValue() > previous) return
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      throw new Error('未观察到入库单状态更新进入并发延迟触发器')
    }

    try {
      for (const race of [
        { receiptId: rejectRace.id, endpoint: 'reject', payload: { reason: '并发拒收' } },
        { receiptId: voidRace.id, endpoint: 'void', payload: undefined },
      ]) {
        const previous = await sequenceValue()
        const confirmPromise = app.inject({
          method: 'PATCH', url: `/api/receipts/${race.receiptId}/confirm`,
          headers: { 'x-test-actor': 'chef' },
        })
        await waitForDelayedUpdate(previous)
        const competingPromise = app.inject({
          method: 'PATCH', url: `/api/receipts/${race.receiptId}/${race.endpoint}`,
          headers: { 'x-test-actor': 'chef' },
          ...(race.payload ? { payload: race.payload } : {}),
        })
        const [confirmed, competing] = await Promise.all([confirmPromise, competingPromise])
        expect(confirmed.statusCode).toBe(200)
        expect(competing.statusCode).toBe(409)
        expect((await prisma.receipt.findUniqueOrThrow({ where: { id: race.receiptId } })).status).toBe('ACCOUNTED')
      }

      const previous = await sequenceValue()
      const firstDelivery = app.inject({
        method: 'PATCH', url: `/api/receipts/${deliveryRace.id}/mark-delivered`,
        headers: { 'x-test-actor': 'admin' },
      })
      await waitForDelayedUpdate(previous)
      const secondDelivery = app.inject({
        method: 'PATCH', url: `/api/receipts/${deliveryRace.id}/mark-delivered`,
        headers: { 'x-test-actor': 'admin' },
      })
      const deliveryResponses = await Promise.all([firstDelivery, secondDelivery])
      expect(deliveryResponses.map(response => response.statusCode).sort()).toEqual([200, 409])
      expect((await prisma.receipt.findUniqueOrThrow({ where: { id: deliveryRace.id } })).status).toBe('PENDING_CONFIRM')
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${delayTrigger}" ON "receipts"`)
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${delayFunction}"()`)
      await prisma.$executeRawUnsafe(`DROP SEQUENCE IF EXISTS "${delaySequence}"`)
    }
  })

  it('rejects a stale chef acknowledgement after supplier delivery wins the race', async () => {
    const sqlSuffix = Date.now().toString()
    const delaySequence = `test_chef_ack_delay_seq_${sqlSuffix}`
    const delayFunction = `test_chef_ack_delay_fn_${sqlSuffix}`
    const delayTrigger = `test_chef_ack_delay_trg_${sqlSuffix}`
    const order = await prisma.purchaseOrder.create({
      data: {
        tenantId,
        no: `ACK-RACE-${suffix}`,
        storeId,
        supplierId,
        expectedDate: new Date('2026-07-20T00:00:00.000Z'),
        totalAmount: 10,
        status: 'DELIVERING',
        createdById: chefUserId,
      },
    })
    await prisma.deliveryOrder.create({
      data: {
        tenantId,
        no: `DO-ACK-RACE-${suffix}`,
        purchaseOrderId: order.id,
        storeId,
        supplierId,
        status: 'SHIPPED',
        actualTotalAmount: 10,
        createdById: supplierUserId,
        shippedById: supplierUserId,
        shippedAt: new Date(),
      },
    })

    await prisma.$executeRawUnsafe(`CREATE SEQUENCE "${delaySequence}"`)
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION "${delayFunction}"() RETURNS trigger AS $$
      BEGIN
        IF NEW."id" = '${order.id}' AND NEW."status" = 'PENDING_CONFIRM' THEN
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
    const waitForDeliveryUpdate = async () => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await sequenceValue() > 0n) return
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      throw new Error('未观察到订货单送达状态更新进入并发延迟触发器')
    }

    try {
      const deliveryPromise = app.inject({
        method: 'PATCH', url: `/api/orders/${order.id}/deliver`,
        headers: { 'x-test-actor': 'supplier' }, payload: { note: '供应商已送达' },
      })
      await waitForDeliveryUpdate()
      const acknowledgementPromise = app.inject({
        method: 'PATCH', url: `/api/orders/${order.id}/chef-ack`,
        headers: { 'x-test-actor': 'chef' },
        payload: { images: ['local://chef-ack-race'], note: '并发验收单不应越过送达终态' },
      })
      const [delivery, acknowledgement] = await Promise.all([deliveryPromise, acknowledgementPromise])
      expect(delivery.statusCode).toBe(200)
      expect(acknowledgement.statusCode).toBe(409)
      const finalOrder = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: order.id } })
      expect(finalOrder.status).toBe('PENDING_CONFIRM')
      expect(finalOrder.chefAckImages).toEqual([])
      expect(finalOrder.chefAckAt).toBeNull()
      expect(await prisma.opLog.count({
        where: { tenantId, targetId: order.id, action: { startsWith: '厨师发送验收单' } },
      })).toBe(0)
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${delayTrigger}" ON "purchase_orders"`)
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${delayFunction}"()`)
      await prisma.$executeRawUnsafe(`DROP SEQUENCE IF EXISTS "${delaySequence}"`)
    }
  })

  it('rolls back supplier delivery when its audit log cannot be written', async () => {
    const sqlSuffix = Date.now().toString()
    const failureFunction = `test_delivery_log_failure_fn_${sqlSuffix}`
    const failureTrigger = `test_delivery_log_failure_trg_${sqlSuffix}`
    const order = await prisma.purchaseOrder.create({
      data: {
        tenantId,
        no: `DELIVERY-ROLLBACK-${suffix}`,
        storeId,
        supplierId,
        expectedDate: new Date('2026-07-20T00:00:00.000Z'),
        totalAmount: 10,
        status: 'DELIVERING',
        createdById: chefUserId,
      },
    })
    const delivery = await prisma.deliveryOrder.create({
      data: {
        tenantId,
        no: `DO-DELIVERY-ROLLBACK-${suffix}`,
        purchaseOrderId: order.id,
        storeId,
        supplierId,
        status: 'SHIPPED',
        actualTotalAmount: 10,
        createdById: supplierUserId,
        shippedById: supplierUserId,
        shippedAt: new Date(),
      },
    })

    try {
      await prisma.$executeRawUnsafe(`
        CREATE FUNCTION "${failureFunction}"() RETURNS trigger AS $$
        BEGIN
          IF NEW."targetId" = '${order.id}' AND NEW."action" LIKE '供应商标记送达%' THEN
            RAISE EXCEPTION 'test delivery audit failure';
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
      const failedDelivery = await app.inject({
        method: 'PATCH', url: `/api/orders/${order.id}/deliver`,
        headers: { 'x-test-actor': 'supplier' }, payload: { note: '故障注入送达' },
      })
      expect(failedDelivery.statusCode).toBe(500)
      expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('DELIVERING')
      expect((await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: delivery.id } })).status).toBe('SHIPPED')
      expect(await prisma.deliveryOrderEvent.count({ where: { deliveryOrderId: delivery.id } })).toBe(0)
      expect(await prisma.opLog.count({ where: { targetId: order.id, action: { startsWith: '供应商标记送达' } } })).toBe(0)
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${failureTrigger}" ON "op_logs"`)
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${failureFunction}"()`)
    }

    const retry = await app.inject({
      method: 'PATCH', url: `/api/orders/${order.id}/deliver`,
      headers: { 'x-test-actor': 'supplier' }, payload: { note: '清除故障后重试' },
    })
    expect(retry.statusCode).toBe(200)
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('PENDING_CONFIRM')
    expect((await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: delivery.id } })).status).toBe('DELIVERED')
    expect(await prisma.deliveryOrderEvent.count({ where: { deliveryOrderId: delivery.id } })).toBe(1)
    expect(await prisma.opLog.count({ where: { targetId: order.id, action: { startsWith: '供应商标记送达' } } })).toBe(1)
  })

  it('rolls back receipt, loss claim and document states as one transaction', async () => {
    const sqlSuffix = Date.now().toString()
    const failureFunction = `test_receive_loss_failure_fn_${sqlSuffix}`
    const failureTrigger = `test_receive_loss_failure_trg_${sqlSuffix}`
    const rollbackProduct = await prisma.product.create({
      data: {
        tenantId,
        supplierId,
        code: `${suffix}-ROLLBACK`,
        name: '收货事务回滚商品',
        category: '事务测试',
        unit: '斤',
        inventoryUnit: 'g',
        inventoryUnitsPerPurchaseUnit: 500,
        unitConversionStatus: 'VERIFIED',
        price: 10,
        stock: 0,
      },
    })
    const order = await prisma.purchaseOrder.create({
      data: {
        tenantId,
        no: `RECEIVE-ROLLBACK-${suffix}`,
        storeId,
        supplierId,
        expectedDate: new Date('2026-07-20T00:00:00.000Z'),
        totalAmount: 20,
        status: 'PENDING_CONFIRM',
        createdById: chefUserId,
        items: {
          create: {
            productId: rollbackProduct.id,
            quantity: 2,
            originalQuantity: 2,
            shippedQty: 2,
            unitPrice: 10,
            originalUnitPrice: 10,
            amount: 20,
            originalAmount: 20,
          },
        },
      },
      include: { items: true },
    })
    const delivery = await prisma.deliveryOrder.create({
      data: {
        tenantId,
        no: `DO-RECEIVE-ROLLBACK-${suffix}`,
        purchaseOrderId: order.id,
        storeId,
        supplierId,
        status: 'DELIVERED',
        actualTotalAmount: 20,
        createdById: supplierUserId,
        shippedById: supplierUserId,
        deliveredById: supplierUserId,
        shippedAt: new Date(),
        deliveredAt: new Date(),
        items: {
          create: {
            purchaseOrderItemId: order.items[0].id,
            productId: rollbackProduct.id,
            orderedQtySnapshot: 2,
            shippedQty: 2,
            unitPriceSnapshot: 10,
            amount: 20,
            productCodeSnapshot: rollbackProduct.code,
            productNameSnapshot: rollbackProduct.name,
            productUnitSnapshot: '斤',
            productCategorySnapshot: '菌菇',
          },
        },
      },
    })

    try {
      await prisma.$executeRawUnsafe(`
        CREATE FUNCTION "${failureFunction}"() RETURNS trigger AS $$
        BEGIN
          IF NEW."purchaseOrderId" = '${order.id}' THEN
            RAISE EXCEPTION 'test receive loss claim failure';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `)
      await prisma.$executeRawUnsafe(`
        CREATE TRIGGER "${failureTrigger}"
        BEFORE INSERT ON "loss_claims"
        FOR EACH ROW EXECUTE FUNCTION "${failureFunction}"()
      `)
      const failedReceive = await app.inject({
        method: 'PATCH',
        url: `/api/orders/${order.id}/receive`,
        headers: { 'x-test-actor': 'chef' },
        payload: { items: [{ productId: rollbackProduct.id, receivedQty: 1 }], reason: '故障注入短量' },
      })
      expect(failedReceive.statusCode).toBe(500)
      expect(await prisma.receipt.count({ where: { purchaseOrderId: order.id } })).toBe(0)
      expect(await prisma.lossClaim.count({ where: { purchaseOrderId: order.id } })).toBe(0)
      expect(await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: delivery.id } })).toMatchObject({
        status: 'DELIVERED',
        receivedAt: null,
        receivedById: null,
        rowVersion: 0,
      })
      expect(await prisma.deliveryOrderItem.findFirstOrThrow({
        where: { deliveryOrderId: delivery.id, productId: rollbackProduct.id },
      })).toMatchObject({ receivedQty: null })
      expect(await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({
        status: 'PENDING_CONFIRM',
        receivedAt: null,
        receiptId: null,
      })
      expect(await prisma.purchaseOrderItem.findFirstOrThrow({
        where: { purchaseOrderId: order.id, productId: rollbackProduct.id },
      })).toMatchObject({ receivedQty: null })
      expect(await prisma.deliveryOrderEvent.count({
        where: { deliveryOrderId: delivery.id, eventType: 'RECEIVED' },
      })).toBe(0)
      expect(await prisma.opLog.count({
        where: { tenantId, targetId: order.id, action: { startsWith: '确认收货' } },
      })).toBe(0)
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${failureTrigger}" ON "loss_claims"`)
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${failureFunction}"()`)
    }

    const retry = await app.inject({
      method: 'PATCH',
      url: `/api/orders/${order.id}/receive`,
      headers: { 'x-test-actor': 'chef' },
      payload: { items: [{ productId: rollbackProduct.id, receivedQty: 1 }], reason: '清除故障后重试' },
    })
    expect(retry.statusCode).toBe(200)
    expect(await prisma.receipt.count({ where: { purchaseOrderId: order.id } })).toBe(1)
    expect(await prisma.lossClaim.count({ where: { purchaseOrderId: order.id } })).toBe(1)
    expect((await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: delivery.id } })).status).toBe('RECEIVED')
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('RECEIVED')
  })

  it('returns the same delivery for concurrent identical shipment retries', async () => {
    const replayProduct = await prisma.product.create({
      data: {
        tenantId, supplierId, code: `${suffix}-REPLAY`, name: '并发幂等商品', category: '菌菇', unit: '斤',
        price: 10, stock: 3, minOrderQty: 1, stepQty: 1,
      },
    })
    await prisma.supplierStockBatch.create({
      data: {
        tenantId, supplierId, productId: replayProduct.id, batchNo: `REPLAY-${suffix}`, kind: 'OPENING',
        initialQty: 3, remainingQty: 3, createdById: supplierUserId,
      },
    })
    const create = await app.inject({
      method: 'POST', url: '/api/orders', headers: { 'x-test-actor': 'chef' },
      payload: {
        supplierId, storeId, expectedDate: '2026-07-20', idempotencyKey: `replay-create-${suffix}`,
        items: [{ productId: replayProduct.id, quantity: 2, unitPrice: 10 }],
      },
    })
    expect(create.statusCode).toBe(200)
    const order = create.json()
    const confirm = await app.inject({
      method: 'PATCH', url: `/api/orders/${order.id}/confirm`, headers: { 'x-test-actor': 'supplier' },
    })
    expect(confirm.statusCode).toBe(200)
    const payload = {
      idempotencyKey: `concurrent-replay-${suffix}`,
      note: '完全相同的并发重试',
      items: [{ itemId: order.items[0].id, shippedQty: 2 }],
    }
    const responses = await Promise.all([0, 1].map(() => app.inject({
      method: 'PATCH', url: `/api/orders/${order.id}/ship`, headers: { 'x-test-actor': 'supplier' }, payload,
    })))
    expect(responses.map(response => response.statusCode)).toEqual([200, 200])
    const deliveryIds = responses.map(response => response.json().deliveryId)
    expect(new Set(deliveryIds).size).toBe(1)
    expect(responses.filter(response => response.json().duplicated === true)).toHaveLength(1)
    expect(await prisma.deliveryOrder.count({ where: { purchaseOrderId: order.id } })).toBe(1)
    expect(Number((await prisma.product.findUniqueOrThrow({ where: { id: replayProduct.id } })).stock)).toBe(1)
    expect(await prisma.supplierStockMovement.count({ where: { tenantId, productId: replayProduct.id, type: 'OUTBOUND_PO' } })).toBe(1)
  })

  it('keeps the first-submission snapshot immutable after store approval and ships actual quantity', async () => {
    const integrityProduct = await prisma.product.create({
      data: {
        tenantId, supplierId, code: `${suffix}-INTEGRITY`, name: '改单快照商品', category: '菌菇', unit: '斤',
        price: 10, stock: 10, minOrderQty: 1, stepQty: 1,
      },
    })
    await prisma.supplierStockBatch.create({
      data: {
        tenantId, supplierId, productId: integrityProduct.id, batchNo: `INTEGRITY-${suffix}`, kind: 'OPENING',
        initialQty: 10, remainingQty: 10, createdById: supplierUserId,
      },
    })
    const create = await app.inject({
      method: 'POST', url: '/api/orders', headers: { 'x-test-actor': 'chef' },
      payload: {
        supplierId, storeId, expectedDate: '2026-07-20', note: '首次提交',
        idempotencyKey: `integrity-create-${suffix}`,
        items: [{ productId: integrityProduct.id, quantity: 4, unitPrice: 999 }],
      },
    })
    expect(create.statusCode).toBe(200)
    const created = create.json()
    const originalSnapshot = structuredClone(created.submittedSnapshot)
    const originalSnapshotHash = created.submittedSnapshotHash

    const requestRevision = await app.inject({
      method: 'POST', url: `/api/orders/${created.id}/revisions`, headers: { 'x-test-actor': 'supplier' },
      payload: {
        reason: '实际可发数量调整', baseRowVersion: created.rowVersion,
        requestKey: `integrity-revision-${suffix}`,
        items: [{ productId: integrityProduct.id, quantity: 7 }],
      },
    })
    expect(requestRevision.statusCode).toBe(201)
    const revisionId = requestRevision.json().id

    const supplierSelfApproval = await app.inject({
      method: 'PATCH', url: `/api/orders/${created.id}/revisions/${revisionId}/approve`,
      headers: { 'x-test-actor': 'supplier' }, payload: { note: '供应商不能自批' },
    })
    expect(supplierSelfApproval.statusCode).toBe(403)

    const approve = await app.inject({
      method: 'PATCH', url: `/api/orders/${created.id}/revisions/${revisionId}/approve`,
      headers: { 'x-test-actor': 'chef' }, payload: { note: '门店确认改单' },
    })
    expect(approve.statusCode).toBe(200)

    const approvedOrder = await prisma.purchaseOrder.findUniqueOrThrow({
      where: { id: created.id },
      include: { items: { orderBy: { id: 'asc' } } },
    })
    expect(approvedOrder.submittedSnapshot).toEqual(originalSnapshot)
    expect(approvedOrder.submittedSnapshotHash).toBe(originalSnapshotHash)
    expect(Number(approvedOrder.originalTotalAmount)).toBe(40)
    expect(Number(approvedOrder.currentOrderAmount)).toBe(70)
    expect(Number(approvedOrder.items[0].originalQuantity)).toBe(4)
    expect(Number(approvedOrder.items[0].quantity)).toBe(7)
    const approvedRevision = await prisma.purchaseOrderRevision.findUniqueOrThrow({ where: { id: revisionId } })
    expect(approvedRevision.requestedById).toBe(supplierUserId)
    expect(approvedRevision.reviewedById).toBe(chefUserId)
    expect(approvedRevision.requestedAt).toBeInstanceOf(Date)
    expect(approvedRevision.reviewedAt).toBeInstanceOf(Date)

    const confirm = await app.inject({
      method: 'PATCH', url: `/api/orders/${created.id}/confirm`, headers: { 'x-test-actor': 'supplier' },
    })
    expect(confirm.statusCode).toBe(200)
    const broadShippedNotificationCount = await prisma.notification.count({
      where: { tenantId, type: 'ORDER_SHIPPED', recipientId: null },
    })
    const ship = await app.inject({
      method: 'PATCH', url: `/api/orders/${created.id}/ship`, headers: { 'x-test-actor': 'supplier' },
      payload: {
        idempotencyKey: `integrity-ship-${suffix}`,
        items: [{ itemId: approvedOrder.items[0].id, shippedQty: 3 }],
      },
    })
    expect(ship.statusCode).toBe(200)
    const delivery = await prisma.deliveryOrder.findUniqueOrThrow({
      where: { id: ship.json().deliveryId },
      include: { items: true },
    })
    expect(Number(delivery.actualTotalAmount)).toBe(30)
    expect(delivery.items).toHaveLength(1)
    expect(Number(delivery.items[0].shippedQty)).toBe(3)
    expect(Number(delivery.items[0].amount)).toBe(30)
    expect(delivery.items[0].productNameSnapshot).toBe('改单快照商品')
    expect(delivery.items[0].productCodeSnapshot).toBe(`${suffix}-INTEGRITY`)
    expect(ship.json().fulfillment).toMatchObject({
      policy: 'CLOSE_UNSHIPPED_REMAINDER',
      remainderClosed: true,
      hasClosedRemainder: true,
      lines: [{ orderedQty: 7, shippedQty: 3, closedQty: 4 }],
    })
    const closedReservation = await prisma.supplierStockReservation.findUniqueOrThrow({
      where: { purchaseOrderItemId: approvedOrder.items[0].id },
    })
    expect(closedReservation.status).toBe('CONSUMED')
    expect(Number(closedReservation.quantity)).toBe(7)
    expect(Number(closedReservation.fulfilledQty)).toBe(3)
    expect(closedReservation.consumedAt).toBeInstanceOf(Date)
    expect(closedReservation.releasedAt).toBeInstanceOf(Date)
    expect(Number((await prisma.product.findUniqueOrThrow({ where: { id: integrityProduct.id } })).stock)).toBe(7)
    const closureEvent = await prisma.deliveryOrderEvent.findFirstOrThrow({
      where: { deliveryOrderId: delivery.id, eventType: 'SHIPPED' },
    })
    expect(closureEvent.metadata).toMatchObject({
      fulfillment: {
        policy: 'CLOSE_UNSHIPPED_REMAINDER',
        lines: [{ orderedQty: 7, shippedQty: 3, closedQty: 4 }],
      },
    })
    await vi.waitFor(async () => {
      const exactNotification = await prisma.notification.findFirst({
        where: {
          tenantId,
          recipientId: chefUserId,
          type: 'ORDER_PARTIAL_CLOSED',
          refId: created.id,
        },
      })
      expect(exactNotification).toMatchObject({
        recipientRole: 'ORDER_CREATOR',
        refType: 'PurchaseOrder',
      })
      expect(exactNotification?.body).toContain('不会补送')
      const exactShippedNotification = await prisma.notification.findFirst({
        where: {
          tenantId,
          recipientId: chefUserId,
          type: 'ORDER_SHIPPED',
          refId: created.id,
        },
      })
      expect(exactShippedNotification).toMatchObject({
        recipientRole: 'ORDER_CREATOR',
        refType: 'PurchaseOrder',
      })
    })
    expect(await prisma.notification.count({
      where: { tenantId, type: 'ORDER_SHIPPED', recipientId: null },
    })).toBe(broadShippedNotificationCount)

    const secondShipment = await app.inject({
      method: 'PATCH', url: `/api/orders/${created.id}/ship`, headers: { 'x-test-actor': 'supplier' },
      payload: {
        idempotencyKey: `integrity-second-ship-${suffix}`,
        items: [{ itemId: approvedOrder.items[0].id, shippedQty: 4 }],
      },
    })
    expect(secondShipment.statusCode).toBe(409)
    expect(secondShipment.json().error).toContain('不得创建第二张有效配送单')
    expect(await prisma.deliveryOrder.count({
      where: { purchaseOrderId: created.id, status: { not: 'CANCELLED' } },
    })).toBe(1)
    expect(await prisma.notification.count({
      where: {
        tenantId,
        recipientId: chefUserId,
        type: 'ORDER_PARTIAL_CLOSED',
        refId: created.id,
      },
    })).toBe(1)
  })

  it('orders, reserves, ships once, receives actual quantity and creates payable facts', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { 'x-test-actor': 'chef' },
      payload: {
        supplierId,
        storeId,
        expectedDate: '2026-07-20',
        idempotencyKey: `create-${suffix}`,
        items: [{ productId, quantity: 6, unitPrice: 999 }],
      },
    })
    expect(create.statusCode).toBe(200)
    const order = create.json()
    expect(Number(order.totalAmount)).toBe(60)

    const invalidRevision = await app.inject({
      method: 'POST', url: `/api/orders/${order.id}/revisions`, headers: { 'x-test-actor': 'chef' },
      payload: { reason: '验证非法日期', expectedDate: '2026-04-31', baseRowVersion: order.rowVersion },
    })
    expect(invalidRevision.statusCode).toBe(400)
    const oversizedRevision = await app.inject({
      method: 'POST', url: `/api/orders/${order.id}/revisions`, headers: { 'x-test-actor': 'chef' },
      payload: {
        reason: '验证订货数量上限', baseRowVersion: order.rowVersion,
        items: [{ productId, quantity: 100_000_000 }],
      },
    })
    expect(oversizedRevision.statusCode).toBe(400)

    const revisionRequestKey = `revision-replay-${suffix}`
    const revisionPayload = {
      reason: '供应商申请调整数量', baseRowVersion: order.rowVersion, requestKey: revisionRequestKey,
      items: [{ productId, quantity: 5 }],
    }
    const concurrentRevisions = await Promise.all([0, 1].map(() => app.inject({
      method: 'POST', url: `/api/orders/${order.id}/revisions`, headers: { 'x-test-actor': 'supplier' }, payload: revisionPayload,
    })))
    expect(concurrentRevisions.map(result => result.statusCode).sort()).toEqual([200, 201])
    expect(new Set(concurrentRevisions.map(result => result.json().id)).size).toBe(1)
    const revisionId = concurrentRevisions[0].json().id
    expect(await prisma.purchaseOrderRevision.count({ where: { purchaseOrderId: order.id, requestKey: revisionRequestKey } })).toBe(1)
    expect(await prisma.purchaseOrderEvent.count({
      where: { purchaseOrderId: order.id, eventType: 'REVISION_REQUESTED', metadata: { path: ['revisionId'], equals: revisionId } },
    })).toBe(1)
    expect(await prisma.opLog.count({
      where: { tenantId, userId: supplierUserId, targetId: revisionId, action: { startsWith: '申请修改订货单' } },
    })).toBe(1)
    const conflictingRevisionReplay = await app.inject({
      method: 'POST', url: `/api/orders/${order.id}/revisions`, headers: { 'x-test-actor': 'supplier' },
      payload: { ...revisionPayload, items: [{ productId, quantity: 4 }] },
    })
    expect(conflictingRevisionReplay.statusCode).toBe(409)
    const rejectRevision = await app.inject({
      method: 'PATCH', url: `/api/orders/${order.id}/revisions/${revisionId}/reject`, headers: { 'x-test-actor': 'chef' },
      payload: { note: '保持原订货数量' },
    })
    expect(rejectRevision.statusCode).toBe(200)
    const revisionDetail = await prisma.purchaseOrderRevision.findUniqueOrThrow({ where: { id: revisionId } })
    expect(revisionDetail.requestedById).toBe(supplierUserId)
    expect(revisionDetail.reviewedById).toBe(chefUserId)
    expect(revisionDetail.requestedAt).toBeInstanceOf(Date)
    expect(revisionDetail.reviewedAt).toBeInstanceOf(Date)

    const confirm = await app.inject({
      method: 'PATCH', url: `/api/orders/${order.id}/confirm`, headers: { 'x-test-actor': 'supplier' },
    })
    expect(confirm.statusCode).toBe(200)
    expect(await prisma.supplierStockReservation.count({
      where: { purchaseOrderId: order.id, status: 'ACTIVE' },
    })).toBe(1)

    const shipmentFailureSuffix = Date.now().toString()
    const shipmentFailureFunction = `test_shipment_log_failure_fn_${shipmentFailureSuffix}`
    const shipmentFailureTrigger = `test_shipment_log_failure_trg_${shipmentFailureSuffix}`
    const failedShipmentKey = `ship-log-failure-${suffix}`
    try {
      await prisma.$executeRawUnsafe(`
        CREATE FUNCTION "${shipmentFailureFunction}"() RETURNS trigger AS $$
        BEGIN
          IF NEW."targetId" = '${order.id}' AND NEW."action" LIKE '供应商确认发货%' THEN
            RAISE EXCEPTION 'test shipment audit failure';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `)
      await prisma.$executeRawUnsafe(`
        CREATE TRIGGER "${shipmentFailureTrigger}"
        BEFORE INSERT ON "op_logs"
        FOR EACH ROW EXECUTE FUNCTION "${shipmentFailureFunction}"()
      `)
      const failedShipment = await app.inject({
        method: 'PATCH', url: `/api/orders/${order.id}/ship`, headers: { 'x-test-actor': 'supplier' },
        payload: { idempotencyKey: failedShipmentKey, items: [{ itemId: order.items[0].id, shippedQty: 6 }] },
      })
      expect(failedShipment.statusCode).toBe(500)
      expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('CONFIRMED')
      expect(await prisma.deliveryOrder.count({ where: { purchaseOrderId: order.id, idempotencyKey: failedShipmentKey } })).toBe(0)
      expect(Number((await prisma.product.findUniqueOrThrow({ where: { id: productId } })).stock)).toBe(10)
      expect(Number((await prisma.supplierStockBatch.findFirstOrThrow({ where: { tenantId, productId } })).remainingQty)).toBe(10)
      expect(await prisma.supplierStockMovement.count({ where: { tenantId, productId, type: 'OUTBOUND_PO' } })).toBe(0)
      expect(await prisma.opLog.count({ where: { targetId: order.id, action: { startsWith: '供应商确认发货' } } })).toBe(0)
      const activeReservation = await prisma.supplierStockReservation.findUniqueOrThrow({
        where: { purchaseOrderItemId: order.items[0].id },
      })
      expect(activeReservation).toMatchObject({
        status: 'ACTIVE',
        releasedAt: null,
        consumedAt: null,
      })
      expect(Number(activeReservation.fulfilledQty)).toBe(0)
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${shipmentFailureTrigger}" ON "op_logs"`)
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${shipmentFailureFunction}"()`)
    }

    const oversizedShipment = await app.inject({
      method: 'PATCH', url: `/api/orders/${order.id}/ship`, headers: { 'x-test-actor': 'supplier' },
      payload: {
        idempotencyKey: `ship-oversized-${suffix}`,
        items: [{ itemId: order.items[0].id, shippedQty: 100_000_000 }],
      },
    })
    expect(oversizedShipment.statusCode).toBe(400)

    const shipPayloads = [`ship-a-${suffix}`, `ship-b-${suffix}`].map(idempotencyKey => ({
      idempotencyKey,
      items: [{ itemId: order.items[0].id, shippedQty: 6 }],
    }))
    const shipAttempts = await Promise.all(shipPayloads.map(payload => app.inject({
      method: 'PATCH', url: `/api/orders/${order.id}/ship`, headers: { 'x-test-actor': 'supplier' }, payload,
    })))
    const successfulShipIndex = shipAttempts.findIndex(response => response.statusCode === 200)
    expect(shipAttempts.filter(response => response.statusCode === 200)).toHaveLength(1)
    expect(shipAttempts.filter(response => response.statusCode >= 400 && response.statusCode < 500)).toHaveLength(1)
    expect(successfulShipIndex).toBeGreaterThanOrEqual(0)

    const duplicateShip = await app.inject({
      method: 'PATCH', url: `/api/orders/${order.id}/ship`, headers: { 'x-test-actor': 'supplier' }, payload: shipPayloads[successfulShipIndex],
    })
    expect(duplicateShip.statusCode).toBe(200)
    expect(duplicateShip.json().duplicated).toBe(true)
    const conflictingDuplicateShip = await app.inject({
      method: 'PATCH', url: `/api/orders/${order.id}/ship`, headers: { 'x-test-actor': 'supplier' },
      payload: {
        ...shipPayloads[successfulShipIndex],
        note: '同一幂等键不应接受不同请求',
        items: [{ itemId: order.items[0].id, shippedQty: 5 }],
      },
    })
    expect(conflictingDuplicateShip.statusCode).toBe(409)
    expect(await prisma.deliveryOrder.count({ where: { purchaseOrderId: order.id } })).toBe(1)
    expect(Number((await prisma.product.findUniqueOrThrow({ where: { id: productId } })).stock)).toBe(4)
    expect(await prisma.supplierStockMovement.count({ where: { tenantId, productId, type: 'OUTBOUND_PO' } })).toBe(1)
    expect(Number((await prisma.supplierStockBatch.findFirstOrThrow({ where: { tenantId, productId } })).remainingQty)).toBe(4)

    const invalidAck = await app.inject({
      method: 'PATCH', url: `/api/orders/${order.id}/chef-ack`, headers: { 'x-test-actor': 'chef' },
      payload: { images: [123] },
    })
    expect(invalidAck.statusCode).toBe(400)
    const invalidDeliver = await app.inject({
      method: 'PATCH', url: `/api/orders/${order.id}/deliver`, headers: { 'x-test-actor': 'supplier' },
      payload: { note: { invalid: true } },
    })
    expect(invalidDeliver.statusCode).toBe(400)
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: order.id } })).chefAckImages).toEqual([])
    expect((await prisma.deliveryOrder.findFirstOrThrow({ where: { purchaseOrderId: order.id } })).status).toBe('SHIPPED')

    await prisma.product.update({
      where: { id: productId },
      data: { name: '流程鲜菌已改名', code: `${suffix}-P-NEW` },
    })
    for (const keyword of ['流程鲜菌', `${suffix}-P`]) {
      const deliverySearch = await app.inject({
        method: 'GET',
        url: `/api/deliveries?keyword=${encodeURIComponent(keyword)}&page=1&pageSize=20`,
        headers: { 'x-test-actor': 'supplier' },
      })
      expect(deliverySearch.statusCode).toBe(200)
      expect(deliverySearch.json()).toMatchObject({ total: 1 })
      expect(deliverySearch.json().items[0].items[0].product).toMatchObject({
        name: '流程鲜菌',
        code: `${suffix}-P`,
      })
    }

    const deliver = await app.inject({
      method: 'PATCH', url: `/api/orders/${order.id}/deliver`, headers: { 'x-test-actor': 'supplier' }, payload: { note: '已到店' },
    })
    expect(deliver.statusCode).toBe(200)

    const invalidReceivePayloads = [
      { items: [null] },
      { items: [{ productId, receivedQty: '5' }] },
      { items: [{ productId, receivedQty: 5 }, { productId, receivedQty: 4 }] },
      { items: Array.from({ length: 501 }, () => ({ productId, receivedQty: 5 })) },
      { evidenceImages: [123] },
      { kind: 'UNKNOWN' },
      { unexpected: true },
    ]
    for (const payload of invalidReceivePayloads) {
      const invalidReceive = await app.inject({
        method: 'PATCH', url: `/api/orders/${order.id}/receive`, headers: { 'x-test-actor': 'chef' }, payload,
      })
      expect(invalidReceive.statusCode).toBe(400)
    }
    expect(await prisma.receipt.count({ where: { purchaseOrderId: order.id } })).toBe(0)
    expect((await prisma.deliveryOrder.findFirstOrThrow({ where: { purchaseOrderId: order.id } })).status).toBe('DELIVERED')

    const receiveAttempts = await Promise.all([1, 2].map(() => app.inject({
      method: 'PATCH',
      url: `/api/orders/${order.id}/receive`,
      headers: { 'x-test-actor': 'chef' },
      payload: { items: [{ productId, receivedQty: 5 }], reason: '短量' },
    })))
    expect(receiveAttempts.map(response => response.statusCode)).toEqual([200, 200])
    const receiveResults = receiveAttempts.map(response => response.json())
    expect(receiveResults.filter(result => result.duplicated === true)).toHaveLength(1)
    expect(new Set(receiveResults.map(result => result.receipt.id))).toHaveProperty('size', 1)
    const receipt = await prisma.receipt.findFirstOrThrow({
      where: { purchaseOrderId: order.id }, include: { items: true, paymentSchedule: true },
    })
    expect(await prisma.receipt.count({ where: { deliveryOrderId: receiveResults[0].deliveryId } })).toBe(1)
    expect(await prisma.lossClaim.count({ where: { deliveryOrderId: receiveResults[0].deliveryId } })).toBe(1)
    expect(Number(receipt.totalAmount)).toBe(50)
    expect(Number(receipt.paymentSchedule?.amount)).toBe(50)
    expect(receipt.paymentSchedule?.status).toBe('ON_HOLD')
    expect(receipt.items[0]).toMatchObject({ productNameSnapshot: '流程鲜菌', productUnitSnapshot: '斤' })
    expect(Number(receipt.items[0].inventoryQuantity)).toBe(2500)
    expect(receipt.items[0].inventoryUnitSnapshot).toBe('g')
    expect(Number(receipt.items[0].inventoryUnitsPerPurchaseUnitSnapshot)).toBe(500)
    expect(Number(receipt.items[0].inventoryUnitCostSnapshot)).toBeCloseTo(0.02)
    const verificationAt = new Date('2026-07-20T00:00:00.000Z')
    await prisma.receipt.update({
      where: { id: receipt.id },
      data: {
        supplierVerifiedAt: verificationAt,
        supplierVerifiedById: supplierUserId,
        supplierVerifyNote: '供应商原核对备注',
        financeVerifiedAt: verificationAt,
        financeVerifiedById: chefUserId,
        financeVerifyNote: '财务原核对备注',
      },
    })
    for (const payload of [
      { actor: 'supplier', note: { invalid: true } },
      { actor: 'supplier', note: 'x'.repeat(501) },
      { actor: 'supplier', unexpected: true },
    ]) {
      const invalidVerify = await app.inject({
        method: 'PATCH', url: `/api/receipts/${receipt.id}/verify`,
        headers: { 'x-test-actor': 'supplier' }, payload,
      })
      expect(invalidVerify.statusCode).toBe(400)
    }
    for (const payload of [
      {},
      { actor: 'invalid' },
      { actor: 'finance', unexpected: true },
    ]) {
      const invalidRevoke = await app.inject({
        method: 'PATCH', url: `/api/receipts/${receipt.id}/verify/revoke`,
        headers: { 'x-test-actor': 'admin' }, payload,
      })
      expect(invalidRevoke.statusCode).toBe(400)
    }
    expect(await prisma.receipt.findUniqueOrThrow({ where: { id: receipt.id } })).toMatchObject({
      supplierVerifiedAt: verificationAt,
      supplierVerifiedById: supplierUserId,
      supplierVerifyNote: '供应商原核对备注',
      financeVerifiedAt: verificationAt,
      financeVerifiedById: chefUserId,
      financeVerifyNote: '财务原核对备注',
    })
    const claim = await prisma.lossClaim.findFirstOrThrow({
      where: { purchaseOrderId: order.id }, include: { items: true },
    })
    expect(Number(claim.totalLossAmount)).toBe(10)
    expect(claim.kind).toBe('ARRIVAL_SHORTAGE')
    expect(claim.payableBasis).toBe('NET_AT_RECEIPT')
    expect(claim.deliveryOrderId).toBeTruthy()
    expect(claim.receiptId).toBe(receipt.id)
    expect(claim.items[0].deliveryOrderItemId).toBeTruthy()
    expect(claim.items[0]).toMatchObject({ productNameSnapshot: '流程鲜菌', productUnitSnapshot: '斤' })
    const audit = await auditSupplierSupplyChain({ tenantId, supplierId, days: 30 })
    expect(audit.issues.filter(issue => issue.code.startsWith('ARRIVAL_SHORTAGE_TRACE_'))).toEqual([])
    expect(audit.issues.filter(issue => issue.code === 'STOCK_BATCH_BALANCE_MISMATCH')).toEqual([])

    // Simulate a split-delivery era order whose legacy primary-receipt
    // pointer is absent. The claim exact receipt must still drive payable.
    await prisma.purchaseOrder.update({ where: { id: order.id }, data: { receiptId: null } })
    for (const payload of [
      null,
      { action: 'reject', note: {} },
      { action: 'approve', note: 'x'.repeat(501) },
      { action: 'approve', unexpected: true },
    ]) {
      const invalidReview = await app.inject({
        method: 'PATCH', url: `/api/loss-claims/${claim.id}/handle`,
        headers: { 'x-test-actor': 'supplier' }, payload,
      })
      expect(invalidReview.statusCode).toBe(400)
    }
    expect((await prisma.lossClaim.findUniqueOrThrow({ where: { id: claim.id } })).status).toBe('PENDING')
    expect(Number((await prisma.paymentSchedule.findUniqueOrThrow({ where: { receiptId: receipt.id } })).amount)).toBe(50)
    const reject = await app.inject({
      method: 'PATCH', url: `/api/loss-claims/${claim.id}/handle`,
      headers: { 'x-test-actor': 'supplier' }, payload: { action: 'reject', note: '实发数量无误，申请复核' },
    })
    expect(reject.statusCode).toBe(200)
    const disputedSchedule = await prisma.paymentSchedule.findUniqueOrThrow({ where: { receiptId: receipt.id } })
    expect(disputedSchedule.status).toBe('ON_HOLD')
    expect(Number(disputedSchedule.amount)).toBe(60)
    const disputedRecon = await prisma.reconciliationItem.findUniqueOrThrow({
      where: { receiptId: receipt.id }, include: { reconciliation: true },
    })
    expect(Number(disputedRecon.amount)).toBe(60)
    expect(Number(disputedRecon.reconciliation.totalAmount)).toBe(60)

    const resolve = await app.inject({
      method: 'PATCH', url: `/api/loss-claims/${claim.id}/resolve`,
      headers: { 'x-test-actor': 'admin' }, payload: { finalDeductAmount: 5, note: '最终确认部分差异' },
    })
    expect(resolve.statusCode).toBe(200)
    expect(Number((await prisma.paymentSchedule.findUniqueOrThrow({ where: { receiptId: receipt.id } })).amount)).toBe(55)
    expect(Number((await prisma.product.findUniqueOrThrow({ where: { id: productId } })).stock)).toBe(4)
    expect(await prisma.supplierStockMovement.count({ where: { tenantId, sourceType: 'LossClaim' } })).toBe(0)

    const lateClaimResponse = await app.inject({
      method: 'POST', url: '/api/loss-claims', headers: { 'x-test-actor': 'chef' },
      payload: {
        purchaseOrderId: order.id,
        receiptId: receipt.id,
        kind: 'ARRIVAL_DAMAGE',
        reason: '开箱后发现品质异常',
        description: '验收后复核发现 2 斤不可用',
        items: [{ productId, receivedQty: 4 }],
      },
    })
    expect(lateClaimResponse.statusCode).toBe(409)
    expect(lateClaimResponse.json()).toMatchObject({ code: 'ARRIVAL_CLAIM_WINDOW_CLOSED' })
    expect(Number((await prisma.paymentSchedule.findUniqueOrThrow({ where: { receiptId: receipt.id } })).amount)).toBe(55)
    const adjustedAudit = await auditSupplierSupplyChain({ tenantId, supplierId, days: 30 })
    expect(adjustedAudit.issues.filter(issue => [
      'PAYABLE_RECEIPT_AMOUNT_MISMATCH',
      'PAYABLE_DISPUTE_NOT_HELD',
      'STOCK_BATCH_BALANCE_MISMATCH',
    ].includes(issue.code))).toEqual([])

  })

  it('allows order confirmation and shipment when supplier inventory is not tracked', async () => {
    await prisma.supplier.update({
      where: { id: supplierId },
      data: { inventoryMode: 'NOT_TRACKED', inventoryActivatedAt: null },
    })
    await prisma.product.update({ where: { id: productId }, data: { stock: 0 } })
    const movementCountBefore = await prisma.supplierStockMovement.count({ where: { tenantId } })

    const create = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { 'x-test-actor': 'chef' },
      payload: {
        supplierId,
        storeId,
        expectedDate: '2026-07-21',
        idempotencyKey: `untracked-create-${suffix}`,
        items: [{ productId, quantity: 3, unitPrice: 10 }],
      },
    })
    expect(create.statusCode).toBe(200)
    const order = create.json()

    const confirm = await app.inject({
      method: 'PATCH', url: `/api/orders/${order.id}/confirm`, headers: { 'x-test-actor': 'supplier' },
    })
    expect(confirm.statusCode).toBe(200)
    expect(await prisma.supplierStockReservation.count({ where: { purchaseOrderId: order.id } })).toBe(0)

    const ship = await app.inject({
      method: 'PATCH',
      url: `/api/orders/${order.id}/ship`,
      headers: { 'x-test-actor': 'supplier' },
      payload: {
        idempotencyKey: `untracked-ship-${suffix}`,
        items: [{ itemId: order.items[0].id, shippedQty: 3 }],
      },
    })
    expect(ship.statusCode).toBe(200)
    expect(Number((await prisma.product.findUniqueOrThrow({ where: { id: productId } })).stock)).toBe(0)
    expect(await prisma.supplierStockMovement.count({ where: { tenantId } })).toBe(movementCountBefore)
  })
})
