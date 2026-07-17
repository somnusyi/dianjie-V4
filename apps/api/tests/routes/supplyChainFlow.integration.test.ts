import Fastify from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@dianjie/db'
import { purchaseOrderRoutes } from '../../src/routes/orders'
import { lossClaimRoutes } from '../../src/routes/lossClaims'
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
    await app.register(lossClaimRoutes, { prefix: '/api/loss-claims' })
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

    const confirm = await app.inject({
      method: 'PATCH', url: `/api/orders/${order.id}/confirm`, headers: { 'x-test-actor': 'supplier' },
    })
    expect(confirm.statusCode).toBe(200)
    expect(await prisma.supplierStockReservation.count({
      where: { purchaseOrderId: order.id, status: 'ACTIVE' },
    })).toBe(1)

    const shipPayload = {
      idempotencyKey: `ship-${suffix}`,
      items: [{ itemId: order.items[0].id, shippedQty: 6 }],
    }
    const ship = await app.inject({
      method: 'PATCH', url: `/api/orders/${order.id}/ship`, headers: { 'x-test-actor': 'supplier' }, payload: shipPayload,
    })
    expect(ship.statusCode).toBe(200)
    const duplicateShip = await app.inject({
      method: 'PATCH', url: `/api/orders/${order.id}/ship`, headers: { 'x-test-actor': 'supplier' }, payload: shipPayload,
    })
    expect(duplicateShip.statusCode).toBe(200)
    expect(duplicateShip.json().duplicated).toBe(true)
    expect(await prisma.deliveryOrder.count({ where: { purchaseOrderId: order.id } })).toBe(1)
    expect(Number((await prisma.product.findUniqueOrThrow({ where: { id: productId } })).stock)).toBe(4)
    expect(await prisma.supplierStockMovement.count({ where: { tenantId, type: 'OUTBOUND_PO' } })).toBe(1)
    expect(Number((await prisma.supplierStockBatch.findFirstOrThrow({ where: { tenantId, productId } })).remainingQty)).toBe(4)

    const deliver = await app.inject({
      method: 'PATCH', url: `/api/orders/${order.id}/deliver`, headers: { 'x-test-actor': 'supplier' }, payload: { note: '已到店' },
    })
    expect(deliver.statusCode).toBe(200)

    const receive = await app.inject({
      method: 'PATCH',
      url: `/api/orders/${order.id}/receive`,
      headers: { 'x-test-actor': 'chef' },
      payload: { items: [{ productId, receivedQty: 5 }], reason: '短量' },
    })
    expect(receive.statusCode).toBe(200)
    const receipt = await prisma.receipt.findFirstOrThrow({
      where: { purchaseOrderId: order.id }, include: { items: true, paymentSchedule: true },
    })
    expect(Number(receipt.totalAmount)).toBe(50)
    expect(Number(receipt.paymentSchedule?.amount)).toBe(50)
    expect(receipt.paymentSchedule?.status).toBe('ON_HOLD')
    expect(receipt.items[0]).toMatchObject({ productNameSnapshot: '流程鲜菌', productUnitSnapshot: '斤' })
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
      headers: { 'x-test-actor': 'admin' }, payload: { finalDeductAmount: 0, note: '原差异不成立' },
    })
    expect(resolve.statusCode).toBe(200)
    expect(Number((await prisma.paymentSchedule.findUniqueOrThrow({ where: { receiptId: receipt.id } })).amount)).toBe(60)

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
    expect(lateClaimResponse.statusCode).toBe(200)
    const lateClaim = lateClaimResponse.json()
    expect(lateClaim).toMatchObject({
      receiptId: receipt.id,
      deliveryOrderId: claim.deliveryOrderId,
      kind: 'ARRIVAL_DAMAGE',
      payableBasis: 'GROSS_PENDING_CLAIM',
      status: 'PENDING',
    })
    const heldSchedule = await prisma.paymentSchedule.findUniqueOrThrow({ where: { receiptId: receipt.id } })
    expect(heldSchedule.status).toBe('ON_HOLD')
    expect(Number(heldSchedule.amount)).toBe(60)

    const duplicateOpenClaim = await app.inject({
      method: 'POST', url: '/api/loss-claims', headers: { 'x-test-actor': 'chef' },
      payload: {
        purchaseOrderId: order.id, receiptId: receipt.id,
        description: '重复补报', items: [{ productId, receivedQty: 4 }],
      },
    })
    expect(duplicateOpenClaim.statusCode).toBe(409)
    expect(duplicateOpenClaim.json().message).toContain('已有未结差异')

    const approveLateClaim = await app.inject({
      method: 'PATCH', url: `/api/loss-claims/${lateClaim.id}/handle`,
      headers: { 'x-test-actor': 'supplier' }, payload: { action: 'approve', note: '确认品质异常' },
    })
    expect(approveLateClaim.statusCode).toBe(200)
    const adjustedSchedule = await prisma.paymentSchedule.findUniqueOrThrow({ where: { receiptId: receipt.id } })
    expect(adjustedSchedule.status).toBe('PENDING')
    expect(Number(adjustedSchedule.amount)).toBe(40)
    const adjustedRecon = await prisma.reconciliationItem.findUniqueOrThrow({
      where: { receiptId: receipt.id }, include: { reconciliation: true },
    })
    expect(Number(adjustedRecon.amount)).toBe(40)
    expect(Number(adjustedRecon.reconciliation.totalAmount)).toBe(40)
    const adjustedAudit = await auditSupplierSupplyChain({ tenantId, supplierId, days: 30 })
    expect(adjustedAudit.issues.filter(issue => [
      'PAYABLE_RECEIPT_AMOUNT_MISMATCH',
      'PAYABLE_DISPUTE_NOT_HELD',
      'STOCK_BATCH_BALANCE_MISMATCH',
    ].includes(issue.code))).toEqual([])

    const overClaim = await app.inject({
      method: 'POST', url: '/api/loss-claims', headers: { 'x-test-actor': 'chef' },
      payload: {
        purchaseOrderId: order.id, receiptId: receipt.id,
        description: '超过尚可补报数量', items: [{ productId, receivedQty: 0 }],
      },
    })
    expect(overClaim.statusCode).toBe(409)
    expect(overClaim.json().message).toContain('超过尚可补报')
  })
})
