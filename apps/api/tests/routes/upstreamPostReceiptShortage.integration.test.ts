import Fastify from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@dianjie/db'
import { upstreamProcurementRoutes } from '../../src/routes/upstreamProcurement'

const suffix = `upstream-missing-line-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let tenantId = ''
let supplierId = ''
let warehouseId = ''
let userId = ''
let receivedProductId = ''
let missingProductId = ''
let purchaseOrderId = ''
let receivedOrderLineId = ''
let missingOrderLineId = ''
let receiptId = ''
let app: ReturnType<typeof Fastify>

function shanghaiBusinessDate(date: Date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

async function cleanupFixture() {
  if (!tenantId) return

  await prisma.upstreamSettlementLine.deleteMany({ where: { tenantId } })
  await prisma.upstreamSettlementStatement.deleteMany({ where: { tenantId } })
  await prisma.upstreamArrivalClaimLine.deleteMany({ where: { tenantId } })
  await prisma.upstreamArrivalClaim.deleteMany({ where: { tenantId } })
  await prisma.upstreamReceiptLine.deleteMany({ where: { tenantId } })
  await prisma.upstreamReceipt.deleteMany({ where: { tenantId } })
  await prisma.upstreamPurchaseOrderEvent.deleteMany({ where: { tenantId } })
  await prisma.upstreamPurchaseOrderRevision.deleteMany({ where: { tenantId } })
  await prisma.upstreamPurchaseOrderLine.deleteMany({ where: { tenantId } })
  await prisma.upstreamPurchaseOrder.deleteMany({ where: { tenantId } })
  await prisma.opLog.deleteMany({ where: { tenantId } })
  await prisma.businessSequence.deleteMany({ where: { tenantId } })
  await prisma.product.deleteMany({ where: { tenantId } })
  await prisma.user.deleteMany({ where: { tenantId } })
  await prisma.supplier.deleteMany({ where: { tenantId } })
  await prisma.warehouse.deleteMany({ where: { tenantId } })
  await prisma.tenant.deleteMany({ where: { id: tenantId } })
  tenantId = ''
}

describe('upstream post-receipt shortage for an entirely missing receipt line (integration)', () => {
  beforeAll(async () => {
    try {
      const tenant = await prisma.tenant.create({
        data: { name: `上游缺货补报测试 ${suffix}`, slug: suffix },
      })
      tenantId = tenant.id

      const [warehouse, supplier, user] = await Promise.all([
        prisma.warehouse.findFirstOrThrow({ where: { tenantId, isDefault: true } }),
        prisma.supplier.create({
          data: {
            tenantId,
            no: `SUP-${suffix}`,
            name: '缺货补报测试上游供应商',
            businessScopes: ['WAREHOUSE_UPSTREAM'],
            postReceiptClaimHours: 48,
          },
        }),
        prisma.user.create({
          data: {
            tenantId,
            name: '上游补报测试经办人',
            email: `${suffix}@local.test`,
            password: 'integration-test-only',
            role: 'SUPPLY_CHAIN',
          },
        }),
      ])
      warehouseId = warehouse.id
      supplierId = supplier.id
      userId = user.id

      const [receivedProduct, missingProduct] = await Promise.all([
        prisma.product.create({
          data: {
            tenantId,
            code: `RECEIVED-${suffix}`,
            name: '已收货商品',
            unit: '箱',
            purchaseUnit: '箱',
            inventoryUnit: '箱',
            orderUnit: '箱',
            costUnit: '箱',
            inventoryUnitsPerPurchaseUnit: 1,
            inventoryUnitsPerOrderUnit: 1,
            inventoryUnitsPerCostUnit: 1,
            unitConversionStatus: 'VERIFIED',
            price: 10,
          },
        }),
        prisma.product.create({
          data: {
            tenantId,
            code: `MISSING-${suffix}`,
            name: '完全未收货商品',
            unit: '箱',
            purchaseUnit: '箱',
            inventoryUnit: '箱',
            orderUnit: '箱',
            costUnit: '箱',
            inventoryUnitsPerPurchaseUnit: 1,
            inventoryUnitsPerOrderUnit: 1,
            inventoryUnitsPerCostUnit: 1,
            unitConversionStatus: 'VERIFIED',
            price: 20,
          },
        }),
      ])
      receivedProductId = receivedProduct.id
      missingProductId = missingProduct.id

      const purchaseOrder = await prisma.upstreamPurchaseOrder.create({
        data: {
          tenantId,
          no: `UP-${suffix}`,
          supplierId,
          warehouseId,
          status: 'RECEIVED',
          totalAmount: 200,
          amountWithoutTax: 200,
          createdById: userId,
          lines: {
            create: [
              {
                lineNo: 1,
                productId: receivedProductId,
                productCodeSnapshot: receivedProduct.code,
                productNameSnapshot: receivedProduct.name,
                purchaseUnit: '箱',
                inventoryUnit: '箱',
                inventoryUnitsPerPurchaseUnit: 1,
                orderedQty: 10,
                confirmedQty: 10,
                receivedQty: 8,
                unitPrice: 10,
                amountWithoutTax: 100,
                taxAmount: 0,
                totalAmount: 100,
              },
              {
                lineNo: 2,
                productId: missingProductId,
                productCodeSnapshot: missingProduct.code,
                productNameSnapshot: missingProduct.name,
                purchaseUnit: '箱',
                inventoryUnit: '箱',
                inventoryUnitsPerPurchaseUnit: 1,
                orderedQty: 5,
                confirmedQty: 5,
                receivedQty: 0,
                unitPrice: 20,
                amountWithoutTax: 100,
                taxAmount: 0,
                totalAmount: 100,
              },
            ],
          },
        },
        include: { lines: { orderBy: { lineNo: 'asc' } } },
      })
      purchaseOrderId = purchaseOrder.id
      receivedOrderLineId = purchaseOrder.lines[0].id
      missingOrderLineId = purchaseOrder.lines[1].id

      const postedAt = new Date()
      const receipt = await prisma.upstreamReceipt.create({
        data: {
          tenantId,
          no: `URC-${suffix}`,
          purchaseOrderId: purchaseOrder.id,
          supplierId,
          warehouseId,
          status: 'POSTED',
          arrivedAt: postedAt,
          postedAt,
          payableAmount: 80,
          createdById: userId,
          lines: {
            create: {
              purchaseOrderLineId: receivedOrderLineId,
              productId: receivedProductId,
              orderedQty: 10,
              arrivedQty: 8,
              acceptedQty: 8,
              shortageQty: 2,
              purchaseUnit: '箱',
              inventoryUnit: '箱',
              inventoryUnitsPerPurchaseUnit: 1,
              inventoryAcceptedQty: 8,
              unitPrice: 10,
              payableAmount: 80,
            },
          },
        },
      })
      receiptId = receipt.id

      app = Fastify()
      app.decorate('authenticate', async (request: any) => {
        request.user = { tenantId, userId, role: 'SUPPLY_CHAIN' }
      })
      await app.register(upstreamProcurementRoutes, { prefix: '/api/upstream' })
      await app.ready()
    } catch (error) {
      if (app) await app.close()
      await cleanupFixture()
      throw error
    }
  })

  afterAll(async () => {
    if (app) await app.close()
    await new Promise(resolve => setTimeout(resolve, 100))
    await cleanupFixture()
  })

  it('rejects SHORTAGE while the purchase order still has later delivery or receipt work outstanding', async () => {
    const idempotencyKey = `partial-receipt-${suffix}`
    await prisma.upstreamPurchaseOrder.update({
      where: { id: purchaseOrderId },
      data: { status: 'PARTIALLY_RECEIVED' },
    })

    const claimResponse = await app.inject({
      method: 'POST',
      url: `/api/upstream/receipts/${receiptId}/post-receipt-claims`,
      payload: {
        idempotencyKey,
        type: 'SHORTAGE',
        description: '还有后续分批发货，不应把未发数量当作少发补报',
        evidence: [{ kind: 'PHOTO', note: '现场验收证据' }],
        lines: [{ purchaseOrderLineId: missingOrderLineId, affectedQty: 5 }],
      },
    })

    const accidentallyCreated = await prisma.upstreamArrivalClaim.findMany({
      where: { tenantId, idempotencyKey },
      select: { id: true },
    })
    try {
      expect(claimResponse.statusCode).toBe(409)
      expect(claimResponse.json().error).toContain('完成全部发货与收货')
      expect(accidentallyCreated).toHaveLength(0)
    } finally {
      if (accidentallyCreated.length > 0) {
        const claimIds = accidentallyCreated.map(claim => claim.id)
        await prisma.upstreamArrivalClaimLine.deleteMany({ where: { claimId: { in: claimIds } } })
        await prisma.upstreamArrivalClaim.deleteMany({ where: { id: { in: claimIds } } })
      }
      await prisma.upstreamPurchaseOrder.update({
        where: { id: purchaseOrderId },
        data: { status: 'RECEIVED' },
      })
    }
  })

  it('creates SHORTAGE against the original PO line with no receiptLine and keeps it trace-only in settlement', async () => {
    const claimResponse = await app.inject({
      method: 'POST',
      url: `/api/upstream/receipts/${receiptId}/post-receipt-claims`,
      payload: {
        idempotencyKey: `missing-line-${suffix}`,
        type: 'SHORTAGE',
        description: '原采购单第二项完全未到货',
        evidence: [{ kind: 'PHOTO', note: '现场验收证据' }],
        lines: [{ purchaseOrderLineId: missingOrderLineId, affectedQty: 5 }],
      },
    })

    expect(claimResponse.statusCode).toBe(201)
    const createdClaim = claimResponse.json()
    expect(createdClaim).toMatchObject({ type: 'SHORTAGE', claimedAmount: '100' })
    expect(createdClaim.lines).toHaveLength(1)
    expect(createdClaim.lines[0]).toMatchObject({
      receiptLineId: null,
      purchaseOrderLineId: missingOrderLineId,
      productId: missingProductId,
      affectedQty: '5',
      claimedAmount: '100',
    })

    const storedLine = await prisma.upstreamArrivalClaimLine.findFirstOrThrow({
      where: { claimId: createdClaim.id },
    })
    expect(storedLine.receiptLineId).toBeNull()
    expect(storedLine.purchaseOrderLineId).toBe(missingOrderLineId)

    await prisma.upstreamArrivalClaim.update({
      where: { id: createdClaim.id },
      data: { status: 'SUPPLIER_ACCEPTED' },
    })
    const resolutionResponse = await app.inject({
      method: 'POST',
      url: `/api/upstream/arrival-claims/${createdClaim.id}/resolve`,
      payload: {
        responsibility: 'SUPPLIER',
        resolution: 'DEDUCTION',
        resolvedAmount: 100,
        note: '供应商确认整项未送达',
      },
    })
    expect(resolutionResponse.statusCode).toBe(200)
    expect(resolutionResponse.json()).toMatchObject({ status: 'RESOLVED', type: 'SHORTAGE' })

    const period = shanghaiBusinessDate(new Date())
    const statementResponse = await app.inject({
      method: 'POST',
      url: '/api/upstream/settlement-statements/generate',
      payload: { supplierId, periodStart: period, periodEnd: period },
    })

    expect(statementResponse.statusCode).toBe(201)
    const statement = statementResponse.json()
    expect(statement).toMatchObject({
      receiptAmount: '80',
      deductionAmount: '0',
      payableAmount: '80',
    })

    const receiptLine = statement.lines.find((line: any) => line.sourceType === 'RECEIPT')
    expect(receiptLine).toMatchObject({ payableAmount: '80', receiptLineId: expect.any(String) })
    const shortageTraceLine = statement.lines.find((line: any) => line.sourceType === 'CLAIM')
    expect(shortageTraceLine).toMatchObject({
      sourceId: createdClaim.id,
      originalAmount: '100',
      adjustmentAmount: '0',
      payableAmount: '0',
    })
    expect(shortageTraceLine.description).toContain('已在收货净额中体现，不重复扣款')
  })
})
