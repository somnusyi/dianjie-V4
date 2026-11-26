import Fastify from 'fastify'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { prisma } from '@dianjie/db'
import { upstreamProcurementRoutes } from '../../src/routes/upstreamProcurement'

let app: ReturnType<typeof Fastify>, tenantId: string, supplierId: string, userId: string
let lastJanuary: string
const originalTz = process.env.TZ
beforeAll(async () => {
  vi.stubEnv('UPSTREAM_PROCUREMENT_ENABLED', 'true')
  const suffix = randomUUID()
  tenantId = (await prisma.tenant.create({ data: { name: '期间核对机构', slug: `period-${suffix}` } })).id
  const warehouse = await prisma.warehouse.findFirstOrThrow({ where: { tenantId, isDefault: true } })
  supplierId = (await prisma.supplier.create({ data: { tenantId, no: 'SUP-PERIOD', name: '青禾食材', businessScopes: ['WAREHOUSE_UPSTREAM'] } })).id
  userId = (await prisma.user.create({ data: { tenantId, name: '期间经办', email: `${suffix}@local.test`, password: 'local-only', role: 'SUPPLY_CHAIN' } })).id
  const product = await prisma.product.create({ data: { tenantId, code: 'PERIOD-ITEM', name: '香菇', unit: 'kg', price: 1 } })
  const samples: [string, number][] = [
    ['2025-12-31T15:59:59.999Z', 101.01], ['2025-12-31T16:00:00.000Z', 7.89],
    ['2026-01-31T15:59:59.999Z', 23.46], ['2026-01-31T16:00:00.000Z', 202.02],
    ['2025-01-15T04:00:00.000Z', 303.03],
  ]
  for (const [i, [instant, amount]] of samples.entries()) {
    const order = await prisma.upstreamPurchaseOrder.create({ data: { tenantId, no: `UP-PERIOD-${i}`, supplierId,
      warehouseId: warehouse.id, status: 'RECEIVED', totalAmount: amount, amountWithoutTax: amount, createdById: userId,
      lines: { create: { lineNo: 1, productId: product.id, productCodeSnapshot: product.code, productNameSnapshot: product.name,
        purchaseUnit: 'kg', inventoryUnit: 'kg', inventoryUnitsPerPurchaseUnit: 1, orderedQty: 1, confirmedQty: 1,
        receivedQty: 1, unitPrice: amount, amountWithoutTax: amount, totalAmount: amount, taxAmount: 0 } } }, include: { lines: true } })
    await prisma.upstreamReceipt.create({ data: { tenantId, no: `RK-PERIOD-${i}`, purchaseOrderId: order.id,
      supplierId, warehouseId: warehouse.id, status: 'POSTED', arrivedAt: new Date(instant), postedAt: new Date(instant),
      payableAmount: amount, createdById: userId, lines: { create: { purchaseOrderLineId: order.lines[0].id,
        productId: product.id, orderedQty: 1, arrivedQty: 1, acceptedQty: 1, shortageQty: 0, purchaseUnit: 'kg',
        inventoryUnit: 'kg', inventoryUnitsPerPurchaseUnit: 1, inventoryAcceptedQty: 1, unitPrice: amount, payableAmount: amount } } } })
  }
  app = Fastify()
  app.decorate('authenticate', async (req: any) => { req.user = { tenantId, userId, role: 'SUPPLY_CHAIN' } })
  await app.register(upstreamProcurementRoutes, { prefix: '/api/upstream' }); await app.ready()
})
afterAll(async () => {
  await app?.close()
  if (tenantId) {
    await prisma.upstreamSettlementLine.deleteMany({ where: { tenantId } })
    await prisma.upstreamSettlementStatement.deleteMany({ where: { tenantId } })
    await prisma.upstreamReceiptLine.deleteMany({ where: { tenantId } })
    await prisma.upstreamReceipt.deleteMany({ where: { tenantId } })
    await prisma.upstreamPurchaseOrderLine.deleteMany({ where: { tenantId } })
    await prisma.upstreamPurchaseOrder.deleteMany({ where: { tenantId } })
    await prisma.opLog.deleteMany({ where: { tenantId } }); await prisma.businessSequence.deleteMany({ where: { tenantId } })
    await prisma.product.deleteMany({ where: { tenantId } }); await prisma.user.deleteMany({ where: { tenantId } })
    await prisma.supplier.deleteMany({ where: { tenantId } }); await prisma.warehouse.deleteMany({ where: { tenantId } })
    await prisma.tenant.delete({ where: { id: tenantId } })
  }
  vi.unstubAllEnvs(); if (originalTz === undefined) delete process.env.TZ; else process.env.TZ = originalTz
  await prisma.$disconnect()
})
const generate = (start: string, end: string) => app.inject({ method: 'POST', url: '/api/upstream/settlement-statements/generate',
  payload: { supplierId, periodStart: start, periodEnd: end } })
it.each(['UTC', 'America/Los_Angeles', 'Asia/Shanghai'])('keeps selected DATE fields and Shanghai timestamp boundaries under %s', async tz => {
  process.env.TZ = tz
  if (lastJanuary) await prisma.upstreamSettlementStatement.update({ where: { id: lastJanuary }, data: { status: 'CANCELLED' } })
  const response = await generate('2026-01-01', '2026-01-31')
  expect(response.statusCode, response.body).toBe(201)
  const row = response.json(); lastJanuary = row.id
  expect(row.periodStart).toBe('2026-01-01T00:00:00.000Z'); expect(row.periodEnd).toBe('2026-01-31T00:00:00.000Z')
  expect(Number(row.payableAmount)).toBe(31.35); expect(row.lines).toHaveLength(2)
  expect(row.lines.map((line: any) => line.sourceNo).sort()).toEqual(['RK-PERIOD-1', 'RK-PERIOD-2'])
  expect(row.lines.find((line: any) => line.sourceNo === 'RK-PERIOD-1').businessDate.slice(0,10)).toBe('2026-01-01')
  expect(row.lines.find((line: any) => line.sourceNo === 'RK-PERIOD-2').businessDate.slice(0,10)).toBe('2026-01-31')
})
it('uses the canonical selected period for versioning and refuses replay without new sources', async () => {
  const stored = await prisma.upstreamSettlementStatement.findUniqueOrThrow({ where: { id: lastJanuary } })
  expect(stored.version).toBe(3)
  expect((await generate('2026-01-01', '2026-01-31')).statusCode).toBe(409)
  expect(await prisma.upstreamSettlementStatement.count({ where: { tenantId } })).toBe(3)
})
it.each([['2025-01-01', '2025-01-31', 303.03], ['2026-02-01', '2026-02-28', 202.02], ['2025-12-01', '2025-12-31', 101.01]])('does not mix years/months for %s', async (start, end, total) => {
  const response = await generate(start, end); expect(response.statusCode, response.body).toBe(201)
  expect(Number(response.json().payableAmount)).toBe(total); expect(response.json().lines).toHaveLength(1)
})
