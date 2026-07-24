import Fastify from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@dianjie/db'
import { deliveryRoutes } from '../../src/routes/deliveries'
import { purchaseOrderRoutes } from '../../src/routes/orders'
import { lossClaimRoutes } from '../../src/routes/lossClaims'
import { receiptRoutes } from '../../src/routes/receipts'
import { auditSupplierSupplyChain } from '../../src/services/supplyChainAudit'
import { claimPaymentScheduleForExecution } from '../../src/services/paymentSchedule'

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

  it('keeps receipt verification audit atomic and serializes supplier revocation with finance verification', async () => {
    const sqlSuffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const auditFunction = `test_receipt_verify_audit_fn_${sqlSuffix}`
    const auditTrigger = `test_receipt_verify_audit_trg_${sqlSuffix}`
    const delaySequence = `test_receipt_verify_delay_seq_${sqlSuffix}`
    const delayFunction = `test_receipt_verify_delay_fn_${sqlSuffix}`
    const delayTrigger = `test_receipt_verify_delay_trg_${sqlSuffix}`
    const receipt = await prisma.receipt.create({
      data: {
        tenantId,
        no: `VERIFY-RACE-${sqlSuffix}`,
        storeId,
        supplierId,
        deliveryDate: new Date('2026-07-20T00:00:00.000Z'),
        totalAmount: 10,
        status: 'ACCOUNTED',
        confirmedAt: new Date('2026-07-20T01:00:00.000Z'),
        createdById: chefUserId,
      },
    })
    let auditArtifactsCreated = false
    let delayArtifactsCreated = false

    try {
      await prisma.$executeRawUnsafe(`
        CREATE FUNCTION "${auditFunction}"() RETURNS trigger AS $$
        BEGIN
          IF NEW."targetId" = '${receipt.id}' AND NEW."action" LIKE '供应商核对入库单%' THEN
            RAISE EXCEPTION 'test receipt verification audit failure';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `)
      await prisma.$executeRawUnsafe(`
        CREATE TRIGGER "${auditTrigger}"
        BEFORE INSERT ON "op_logs"
        FOR EACH ROW EXECUTE FUNCTION "${auditFunction}"()
      `)
      auditArtifactsCreated = true

      const failedVerification = await app.inject({
        method: 'PATCH',
        url: `/api/receipts/${receipt.id}/verify`,
        headers: { 'x-test-actor': 'supplier' },
        payload: { actor: 'supplier', note: '审计故障必须整体回滚' },
      })
      expect(failedVerification.statusCode).toBe(500)
      expect(await prisma.receipt.findUniqueOrThrow({ where: { id: receipt.id } })).toMatchObject({
        supplierVerifiedAt: null,
        supplierVerifiedById: null,
        supplierVerifyNote: null,
      })
      expect(await prisma.opLog.count({
        where: { tenantId, targetId: receipt.id, action: { startsWith: '供应商核对入库单' } },
      })).toBe(0)

      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${auditTrigger}" ON "op_logs"`)
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${auditFunction}"()`)
      auditArtifactsCreated = false

      const supplierVerification = await app.inject({
        method: 'PATCH',
        url: `/api/receipts/${receipt.id}/verify`,
        headers: { 'x-test-actor': 'supplier' },
        payload: { actor: 'supplier', note: '供应商已核对' },
      })
      expect(supplierVerification.statusCode).toBe(200)
      const financeVerification = await app.inject({
        method: 'PATCH',
        url: `/api/receipts/${receipt.id}/verify`,
        headers: { 'x-test-actor': 'admin' },
        payload: { actor: 'finance', note: '财务已核对' },
      })
      expect(financeVerification.statusCode).toBe(200)
      const financeRevoke = await app.inject({
        method: 'PATCH',
        url: `/api/receipts/${receipt.id}/verify/revoke`,
        headers: { 'x-test-actor': 'admin' },
        payload: { actor: 'finance' },
      })
      expect(financeRevoke.statusCode).toBe(200)

      await prisma.$executeRawUnsafe(`CREATE SEQUENCE "${delaySequence}"`)
      await prisma.$executeRawUnsafe(`
        CREATE FUNCTION "${delayFunction}"() RETURNS trigger AS $$
        BEGIN
          IF (
            NEW."id" = '${receipt.id}'
            AND OLD."supplierVerifiedAt" IS NOT NULL
            AND NEW."supplierVerifiedAt" IS NULL
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
        BEFORE UPDATE OF "supplierVerifiedAt" ON "receipts"
        FOR EACH ROW EXECUTE FUNCTION "${delayFunction}"()
      `)
      delayArtifactsCreated = true

      const sequenceValue = async () => {
        const [row] = await prisma.$queryRawUnsafe<Array<{ value: bigint; is_called: boolean }>>(
          `SELECT last_value::bigint AS value, is_called FROM "${delaySequence}"`,
        )
        return row.is_called ? row.value : 0n
      }
      const previous = await sequenceValue()
      const supplierRevokePromise = app.inject({
        method: 'PATCH',
        url: `/api/receipts/${receipt.id}/verify/revoke`,
        headers: { 'x-test-actor': 'admin' },
        payload: { actor: 'supplier' },
      })
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await sequenceValue() > previous) break
        if (attempt === 99) throw new Error('未观察到供应商核对撤销进入并发延迟触发器')
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      const racingFinanceVerification = app.inject({
        method: 'PATCH',
        url: `/api/receipts/${receipt.id}/verify`,
        headers: { 'x-test-actor': 'admin' },
        payload: { actor: 'finance', note: '不得越过并发撤销' },
      })
      const [supplierRevoke, financeRace] = await Promise.all([
        supplierRevokePromise,
        racingFinanceVerification,
      ])
      expect(supplierRevoke.statusCode).toBe(200)
      expect(financeRace.statusCode).toBe(400)
      expect(await prisma.receipt.findUniqueOrThrow({ where: { id: receipt.id } })).toMatchObject({
        supplierVerifiedAt: null,
        supplierVerifiedById: null,
        financeVerifiedAt: null,
        financeVerifiedById: null,
      })
      expect(await prisma.opLog.count({
        where: { tenantId, targetId: receipt.id, action: { contains: '核对入库单' } },
      })).toBe(4)
    } finally {
      if (auditArtifactsCreated) {
        await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${auditTrigger}" ON "op_logs"`)
        await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${auditFunction}"()`)
      }
      if (delayArtifactsCreated) {
        await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${delayTrigger}" ON "receipts"`)
        await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${delayFunction}"()`)
        await prisma.$executeRawUnsafe(`DROP SEQUENCE IF EXISTS "${delaySequence}"`)
      }
      await prisma.opLog.deleteMany({ where: { tenantId, targetId: receipt.id } })
      await prisma.receipt.deleteMany({ where: { id: receipt.id } })
    }
  })

  it('serializes concurrent approval and rejection of the same order revision', async () => {
    const sqlSuffix = Date.now().toString()
    const delaySequence = `test_revision_review_delay_seq_${sqlSuffix}`
    const delayFunction = `test_revision_review_delay_fn_${sqlSuffix}`
    const delayTrigger = `test_revision_review_delay_trg_${sqlSuffix}`
    const create = await app.inject({
      method: 'POST', url: '/api/orders', headers: { 'x-test-actor': 'chef' },
      payload: {
        supplierId, storeId, expectedDate: '2026-07-20', idempotencyKey: `revision-review-${suffix}`,
        items: [{ productId, quantity: 2, unitPrice: 10 }],
      },
    })
    expect(create.statusCode).toBe(200)
    const order = create.json()
    const request = await app.inject({
      method: 'POST', url: `/api/orders/${order.id}/revisions`, headers: { 'x-test-actor': 'supplier' },
      payload: {
        reason: '并发审核回归', baseRowVersion: order.rowVersion, requestKey: `revision-review-request-${suffix}`,
        items: [{ productId, quantity: 3 }],
      },
    })
    expect(request.statusCode).toBe(201)
    const revisionId = request.json().id

    await prisma.$executeRawUnsafe(`CREATE SEQUENCE "${delaySequence}"`)
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION "${delayFunction}"() RETURNS trigger AS $$
      BEGIN
        IF NEW."id" = '${order.id}' AND NEW."currentRevisionNo" = 1 THEN
          PERFORM nextval('${delaySequence}');
          PERFORM pg_sleep(0.75);
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `)
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "${delayTrigger}"
      BEFORE UPDATE OF "currentRevisionNo" ON "purchase_orders"
      FOR EACH ROW EXECUTE FUNCTION "${delayFunction}"()
    `)

    const sequenceValue = async () => {
      const [row] = await prisma.$queryRawUnsafe<Array<{ value: bigint; is_called: boolean }>>(
        `SELECT last_value::bigint AS value, is_called FROM "${delaySequence}"`,
      )
      return row.is_called ? row.value : 0n
    }
    const waitForApprovalUpdate = async () => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await sequenceValue() > 0n) return
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      throw new Error('未观察到改单批准进入并发延迟触发器')
    }

    try {
      const approvePromise = app.inject({
        method: 'PATCH', url: `/api/orders/${order.id}/revisions/${revisionId}/approve`,
        headers: { 'x-test-actor': 'chef' }, payload: { note: '批准改单' },
      })
      await waitForApprovalUpdate()
      const rejectPromise = app.inject({
        method: 'PATCH', url: `/api/orders/${order.id}/revisions/${revisionId}/reject`,
        headers: { 'x-test-actor': 'chef' }, payload: { note: '并发驳回不应越过批准' },
      })
      const [approved, rejected] = await Promise.all([approvePromise, rejectPromise])
      expect(approved.statusCode).toBe(200)
      expect(rejected.statusCode).toBe(409)
      expect(await prisma.purchaseOrderRevision.findUniqueOrThrow({ where: { id: revisionId } })).toMatchObject({
        status: 'APPROVED', reviewedById: chefUserId, reviewNote: '批准改单',
      })
      expect(await prisma.purchaseOrderEvent.count({
        where: { purchaseOrderId: order.id, eventType: 'REVISION_APPROVED' },
      })).toBe(1)
      expect(await prisma.purchaseOrderEvent.count({
        where: { purchaseOrderId: order.id, eventType: 'REVISION_REJECTED' },
      })).toBe(0)
      expect(await prisma.opLog.count({
        where: { tenantId, targetId: revisionId, action: { startsWith: '确认订货单修改' } },
      })).toBe(1)
      expect(await prisma.opLog.count({
        where: { tenantId, targetId: revisionId, action: { startsWith: '驳回订货单修改' } },
      })).toBe(0)
      const finalOrder = await prisma.purchaseOrder.findUniqueOrThrow({
        where: { id: order.id }, include: { items: { where: { isActive: true } } },
      })
      expect(finalOrder.currentRevisionNo).toBe(1)
      expect(Number(finalOrder.items[0].quantity)).toBe(3)
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${delayTrigger}" ON "purchase_orders"`)
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${delayFunction}"()`)
      await prisma.$executeRawUnsafe(`DROP SEQUENCE IF EXISTS "${delaySequence}"`)
    }
  })

  it('serializes new revision requests with supplier confirmation and rejection', async () => {
    const sqlSuffix = Date.now().toString()
    const delaySequence = `test_revision_transition_delay_seq_${sqlSuffix}`
    const delayFunction = `test_revision_transition_delay_fn_${sqlSuffix}`
    const delayTrigger = `test_revision_transition_delay_trg_${sqlSuffix}`
    const createOrder = async (marker: string) => {
      const response = await app.inject({
        method: 'POST', url: '/api/orders', headers: { 'x-test-actor': 'chef' },
        payload: {
          supplierId, storeId, expectedDate: '2026-07-20', idempotencyKey: `revision-transition-${marker}-${suffix}`,
          items: [{ productId, quantity: 1, unitPrice: 10 }],
        },
      })
      expect(response.statusCode).toBe(200)
      return response.json()
    }
    const confirmOrder = await createOrder('confirm')
    const rejectOrder = await createOrder('reject')

    await prisma.$executeRawUnsafe(`CREATE SEQUENCE "${delaySequence}"`)
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION "${delayFunction}"() RETURNS trigger AS $$
      BEGIN
        IF NEW."id" IN ('${confirmOrder.id}', '${rejectOrder.id}')
          AND NEW."status" IN ('CONFIRMED', 'CANCELLED') THEN
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
    const waitForTransitionUpdate = async (previous: bigint) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await sequenceValue() > previous) return
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      throw new Error('未观察到订货单状态转换进入并发延迟触发器')
    }

    try {
      for (const race of [
        { order: confirmOrder, endpoint: 'confirm', payload: undefined, status: 'CONFIRMED' },
        { order: rejectOrder, endpoint: 'reject', payload: { reason: '供应商并发拒单' }, status: 'CANCELLED' },
      ]) {
        const previous = await sequenceValue()
        const transitionPromise = app.inject({
          method: 'PATCH', url: `/api/orders/${race.order.id}/${race.endpoint}`,
          headers: { 'x-test-actor': 'supplier' },
          ...(race.payload ? { payload: race.payload } : {}),
        })
        await waitForTransitionUpdate(previous)
        const revisionPromise = app.inject({
          method: 'POST', url: `/api/orders/${race.order.id}/revisions`, headers: { 'x-test-actor': 'supplier' },
          payload: {
            reason: '并发状态转换回归', baseRowVersion: race.order.rowVersion,
            requestKey: `revision-transition-request-${race.endpoint}-${suffix}`,
            items: [{ productId, quantity: 2 }],
          },
        })
        const [transition, revision] = await Promise.all([transitionPromise, revisionPromise])
        expect(transition.statusCode).toBe(200)
        expect(revision.statusCode, JSON.stringify(revision.json())).toBe(409)
        expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: race.order.id } })).status).toBe(race.status)
        expect(await prisma.purchaseOrderRevision.count({
          where: { purchaseOrderId: race.order.id, status: 'PENDING' },
        })).toBe(0)
      }
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${delayTrigger}" ON "purchase_orders"`)
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${delayFunction}"()`)
      await prisma.$executeRawUnsafe(`DROP SEQUENCE IF EXISTS "${delaySequence}"`)
    }
  })

  it('rejects malformed cancellation and supplier rejection reasons before writes', async () => {
    const createOrder = async (marker: string) => {
      const response = await app.inject({
        method: 'POST', url: '/api/orders', headers: { 'x-test-actor': 'chef' },
        payload: {
          supplierId, storeId, expectedDate: '2026-07-20', idempotencyKey: `order-reason-${marker}-${suffix}`,
          items: [{ productId, quantity: 1, unitPrice: 10 }],
        },
      })
      expect(response.statusCode).toBe(200)
      return response.json()
    }
    const cancelOrder = await createOrder('cancel')
    const rejectOrder = await createOrder('reject')

    for (const payload of [
      {},
      { reason: { invalid: true } },
      { reason: 'x'.repeat(201) },
      { reason: '正常原因', unexpected: true },
    ]) {
      const response = await app.inject({
        method: 'PATCH', url: `/api/orders/${cancelOrder.id}/cancel`,
        headers: { 'x-test-actor': 'chef' }, payload,
      })
      expect(response.statusCode).toBe(400)
    }
    for (const payload of [
      {},
      { reason: { invalid: true } },
      { reason: 'x'.repeat(101) },
      { reason: '正常原因', unexpected: true },
    ]) {
      const response = await app.inject({
        method: 'PATCH', url: `/api/orders/${rejectOrder.id}/reject`,
        headers: { 'x-test-actor': 'supplier' }, payload,
      })
      expect(response.statusCode).toBe(400)
    }

    for (const order of [cancelOrder, rejectOrder]) {
      expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('SUBMITTED')
      expect(await prisma.purchaseOrderEvent.count({
        where: { purchaseOrderId: order.id, eventType: 'CANCELLED' },
      })).toBe(0)
    }
    const cancelled = await app.inject({
      method: 'PATCH', url: `/api/orders/${cancelOrder.id}/cancel`,
      headers: { 'x-test-actor': 'chef' }, payload: { reason: '门店正常撤回' },
    })
    const rejected = await app.inject({
      method: 'PATCH', url: `/api/orders/${rejectOrder.id}/reject`,
      headers: { 'x-test-actor': 'supplier' }, payload: { reason: '供应商正常拒单' },
    })
    expect(cancelled.statusCode).toBe(200)
    expect(rejected.statusCode).toBe(200)
  })

  it('rejects unknown order creation fields and confirmation bodies before writes', async () => {
    const beforeOrderCount = await prisma.purchaseOrder.count({ where: { tenantId } })
    const basePayload = {
      supplierId, storeId, expectedDate: '2026-07-20',
      items: [{ productId, quantity: 1, unitPrice: 10 }],
    }
    for (const payload of [
      { ...basePayload, unexpected: true },
      { ...basePayload, items: [{ ...basePayload.items[0], unexpected: true }] },
      { ...basePayload, note: 'x'.repeat(501) },
    ]) {
      const response = await app.inject({
        method: 'POST', url: '/api/orders', headers: { 'x-test-actor': 'chef' }, payload,
      })
      expect(response.statusCode).toBe(400)
    }
    expect(await prisma.purchaseOrder.count({ where: { tenantId } })).toBe(beforeOrderCount)

    const create = await app.inject({
      method: 'POST', url: '/api/orders', headers: { 'x-test-actor': 'chef' },
      payload: { ...basePayload, idempotencyKey: `confirm-body-${suffix}` },
    })
    expect(create.statusCode).toBe(200)
    const order = create.json()
    const invalidConfirm = await app.inject({
      method: 'PATCH', url: `/api/orders/${order.id}/confirm`, headers: { 'x-test-actor': 'supplier' },
      payload: { unexpected: true },
    })
    expect(invalidConfirm.statusCode).toBe(400)
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('SUBMITTED')
    expect(await prisma.supplierStockReservation.count({ where: { purchaseOrderId: order.id } })).toBe(0)
    expect(await prisma.purchaseOrderEvent.count({
      where: { purchaseOrderId: order.id, eventType: 'ACCEPTED' },
    })).toBe(0)

    const validConfirm = await app.inject({
      method: 'PATCH', url: `/api/orders/${order.id}/confirm`, headers: { 'x-test-actor': 'supplier' },
    })
    expect(validConfirm.statusCode).toBe(200)
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

    await prisma.paymentSchedule.update({
      where: { receiptId: receipt.id },
      data: { needApproval: true },
    })
    const resolve = await app.inject({
      method: 'PATCH', url: `/api/loss-claims/${claim.id}/resolve`,
      headers: { 'x-test-actor': 'admin' }, payload: { finalDeductAmount: 5, note: '最终确认部分差异' },
    })
    expect(resolve.statusCode).toBe(200)
    const resolvedSchedule = await prisma.paymentSchedule.findUniqueOrThrow({ where: { receiptId: receipt.id } })
    expect(Number(resolvedSchedule.amount)).toBe(55)
    expect(resolvedSchedule).toMatchObject({
      status: 'PENDING_APPROVAL',
      needApproval: true,
    })
    await expect(claimPaymentScheduleForExecution(resolvedSchedule.id)).rejects.toThrow('不可执行付款')
    expect((await prisma.paymentSchedule.findUniqueOrThrow({ where: { id: resolvedSchedule.id } })).status)
      .toBe('PENDING_APPROVAL')
    await prisma.paymentSchedule.update({
      where: { id: resolvedSchedule.id },
      data: { status: 'APPROVED', dueAt: new Date('2026-07-01T00:00:00.000Z') },
    })
    const paymentClaims = await Promise.allSettled([
      claimPaymentScheduleForExecution(resolvedSchedule.id),
      claimPaymentScheduleForExecution(resolvedSchedule.id),
    ])
    expect(paymentClaims.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(paymentClaims.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect((await prisma.paymentSchedule.findUniqueOrThrow({ where: { id: resolvedSchedule.id } })).status)
      .toBe('PROCESSING')
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
