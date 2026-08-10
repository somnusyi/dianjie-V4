import Fastify from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@dianjie/db'
import { lossClaimRoutes } from '../../src/routes/lossClaims'

const suffix = `post-receipt-loss-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
let app: ReturnType<typeof Fastify>
let tenantId = ''
let storeId = ''
let supplierId = ''
let userId = ''
let productId = ''
let purchaseOrderId = ''
let receiptId = ''

describe('post-receipt arrival loss (integration)', () => {
  beforeAll(async () => {
    const tenant = await prisma.tenant.create({ data: { name: suffix, slug: suffix } })
    tenantId = tenant.id
    const [store, supplier] = await Promise.all([
      prisma.store.create({ data: { tenantId, no: `S-${suffix}`, name: '48小时补报测试门店' } }),
      prisma.supplier.create({ data: { tenantId, no: `SUP-${suffix}`, name: '48小时补报测试供应商' } }),
    ])
    storeId = store.id
    supplierId = supplier.id
    const user = await prisma.user.create({
      data: { tenantId, storeId, storeIds: [storeId], name: '测试厨师长', email: `${suffix}@local.test`, password: 'test-only', role: 'KITCHEN_LEAD' },
    })
    userId = user.id
    const product = await prisma.product.create({
      data: {
        tenantId, supplierId, code: `P-${suffix}`, name: '拆包测试商品', unit: '箱', spec: '500g*2袋', price: 10,
        inventoryUnit: 'g', inventoryUnitsPerPurchaseUnit: 1000, unitConversionStatus: 'VERIFIED',
      },
    })
    productId = product.id
    const order = await prisma.purchaseOrder.create({
      data: {
        tenantId, no: `PO-${suffix}`, storeId, supplierId, expectedDate: new Date(), totalAmount: 20,
        status: 'COMPLETED', receivedAt: new Date(), createdById: userId,
        items: { create: { productId, quantity: 2, unitPrice: 10, amount: 20 } },
      },
    })
    purchaseOrderId = order.id
    const receipt = await prisma.receipt.create({
      data: {
        tenantId, no: `RK-${suffix}`, storeId, supplierId, purchaseOrderId, deliveryDate: new Date(),
        totalAmount: 20, status: 'CONFIRMED', confirmedAt: new Date(), createdById: userId,
        items: {
          create: {
            productId, quantity: 2, unitPrice: 10, amount: 20,
            purchaseUnitSnapshot: '箱', productUnitSnapshot: '箱', inventoryQuantity: 2000,
            inventoryUnitSnapshot: 'g', inventoryUnitCostSnapshot: 0.01,
          },
        },
      },
    })
    receiptId = receipt.id
    await prisma.paymentSchedule.create({
      data: {
        tenantId, receiptId, supplierId, storeId, amount: 20, creditDays: 30,
        confirmedAt: new Date(), dueAt: new Date(Date.now() + 30 * 86_400_000), status: 'PENDING',
      },
    })
    app = Fastify()
    app.decorate('authenticate', async (request: any) => {
      request.user = { tenantId, storeId, storeIds: [storeId], userId, role: 'KITCHEN_LEAD' }
    })
    await app.register(lossClaimRoutes, { prefix: '/api/loss-claims' })
    await app.ready()
  })

  afterAll(async () => {
    if (app) await app.close()
    if (!tenantId) return
    await prisma.lossClaimItem.deleteMany({ where: { lossClaim: { tenantId } } })
    await prisma.lossClaim.deleteMany({ where: { tenantId } })
    await prisma.paymentSchedule.deleteMany({ where: { tenantId } })
    await prisma.receiptItem.deleteMany({ where: { receipt: { tenantId } } })
    await prisma.receipt.deleteMany({ where: { tenantId } })
    await prisma.purchaseOrderItem.deleteMany({ where: { purchaseOrder: { tenantId } } })
    await prisma.purchaseOrder.deleteMany({ where: { tenantId } })
    await prisma.opLog.deleteMany({ where: { tenantId } })
    await prisma.notification.deleteMany({ where: { tenantId } })
    await prisma.notificationLog.deleteMany({ where: { tenantId } })
    await prisma.businessSequence.deleteMany({ where: { tenantId } })
    await prisma.product.deleteMany({ where: { tenantId } })
    await prisma.user.deleteMany({ where: { tenantId } })
    await prisma.store.deleteMany({ where: { tenantId } })
    await prisma.supplier.deleteMany({ where: { tenantId } })
    await prisma.tenant.delete({ where: { id: tenantId } })
  })

  const payload = () => ({
    purchaseOrderId,
    receiptId,
    kind: 'ARRIVAL_DAMAGE',
    reason: '拆包后发现腐坏',
    description: '收货后拆开内袋发现商品腐坏，现场隔离',
    evidenceImages: ['https://example.test/evidence.jpg'],
    items: [{ productId, lossQty: 0.5 }],
  })

  it('requires evidence for a post-receipt claim', async () => {
    const response = await app.inject({
      method: 'POST', url: '/api/loss-claims', payload: { ...payload(), evidenceImages: [] },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toContain('至少上传')
  })

  it('creates the claim, converts inventory quantity, freezes payable and reopens the order', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/loss-claims', payload: payload() })
    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({
      purchaseOrderId, receiptId, payableBasis: 'GROSS_PENDING_CLAIM', status: 'PENDING', totalLossAmount: '5',
    })
    const [item, schedule, order] = await Promise.all([
      prisma.lossClaimItem.findFirstOrThrow({ where: { lossClaim: { tenantId, receiptId } } }),
      prisma.paymentSchedule.findUniqueOrThrow({ where: { receiptId } }),
      prisma.purchaseOrder.findUniqueOrThrow({ where: { id: purchaseOrderId } }),
    ])
    expect(Number(item.lossQty)).toBe(0.5)
    expect(Number(item.inventoryQuantity)).toBe(500)
    expect(schedule.status).toBe('ON_HOLD')
    expect(Number(schedule.amount)).toBe(20)
    expect(order.status).toBe('RECEIVED')
  })

  it('prevents cumulative claims from exceeding the received quantity', async () => {
    const response = await app.inject({
      method: 'POST', url: '/api/loss-claims', payload: { ...payload(), items: [{ productId, lossQty: 1.51 }] },
    })
    expect(response.statusCode).toBe(409)
    expect(response.json().error).toContain('最多还可补报')
  })

  it('closes the supplier claim window exactly after 48 hours', async () => {
    await prisma.receipt.update({
      where: { id: receiptId },
      data: { confirmedAt: new Date(Date.now() - 49 * 60 * 60 * 1000) },
    })
    const response = await app.inject({
      method: 'POST', url: '/api/loss-claims', payload: { ...payload(), items: [{ productId, lossQty: 0.1 }] },
    })
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ code: 'POST_RECEIPT_CLAIM_WINDOW_EXPIRED' })
  })
})
