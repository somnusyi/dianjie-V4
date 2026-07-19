import Fastify from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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
    const supplier = await prisma.supplier.create({ data: { tenantId, no: `SUP-${suffix}`, name: '供应链流程供应商' } })
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
    expect(await prisma.deliveryOrder.count({ where: { purchaseOrderId: order.id } })).toBe(1)
    expect(Number((await prisma.product.findUniqueOrThrow({ where: { id: productId } })).stock)).toBe(4)
    expect(await prisma.supplierStockMovement.count({ where: { tenantId, type: 'OUTBOUND_PO' } })).toBe(1)
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
})
