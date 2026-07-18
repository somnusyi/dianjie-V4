import Fastify from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@dianjie/db'
import { inventoryCountRoutes } from '../../src/routes/inventoryCounts'
import { dailyBusinessImportRoutes } from '../../src/routes/dailyBusinessImports'

const suffix = `inventory-count-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let tenantId = ''
let storeId = ''
let userId = ''
let supplierId = ''
let productIds: string[] = []
let app: ReturnType<typeof Fastify>

describe('store inventory count workflow (integration)', () => {
  beforeAll(async () => {
    const tenant = await prisma.tenant.create({ data: { name: `盘点测试 ${suffix}`, slug: suffix } })
    tenantId = tenant.id
    const [store, supplier] = await Promise.all([
      prisma.store.create({ data: { tenantId, no: `STORE-${suffix}`, name: '在线盘点门店' } }),
      prisma.supplier.create({ data: { tenantId, no: `SUP-${suffix}`, name: '盘点供应商' } }),
    ])
    storeId = store.id
    supplierId = supplier.id
    const user = await prisma.user.create({
      data: {
        tenantId, storeId, storeIds: [storeId], name: '盘点厨师长',
        email: `${suffix}@local.test`, password: 'integration-test-only', role: 'KITCHEN_LEAD',
      },
    })
    userId = user.id
    const products = await Promise.all([
      prisma.product.create({ data: { tenantId, supplierId, code: `${suffix}-A`, name: '鲜菌 A', category: '菌菇', unit: '斤', price: 10, stock: 100 } }),
      prisma.product.create({ data: { tenantId, supplierId, code: `${suffix}-B`, name: '蔬菜 B', category: '蔬菜', unit: '斤', price: 5, stock: 80 } }),
    ])
    productIds = products.map(product => product.id)
    await prisma.inventorySnapshot.create({
      data: {
        tenantId, storeId, snapshotDate: new Date('2026-07-10T00:00:00.000Z'),
        sourceFilename: '盘点集成测试基准', totalValue: 200, itemCount: 2, nonzeroCount: 2, zeroCount: 0, matchedCount: 2,
        items: {
          create: products.map((product, index) => ({
            productId: product.id, section: product.category, rawName: product.name, rawSpec: product.spec,
            unit: product.unit, quantity: index === 0 ? 10 : 20, unitPrice: product.price,
            amount: 100, normalizedQuantity: index === 0 ? 10 : 20, normalizedUnit: product.unit,
            normalizationFactor: 1, normalizationStatus: 'EXACT', sortOrder: index,
          })),
        },
      },
    })

    app = Fastify()
    app.decorate('authenticate', async (request: any) => {
      request.user = String(request.headers['x-test-actor'] || 'chef') === 'supplier'
        ? { tenantId, supplierId, userId, role: 'SUPPLIER_OWNER' }
        : { tenantId, storeId, storeIds: [storeId], userId, role: 'KITCHEN_LEAD' }
    })
    await app.register(inventoryCountRoutes, { prefix: '/api/inventory-counts' })
    await app.register(dailyBusinessImportRoutes, { prefix: '/api/daily-business-imports' })
    await app.ready()
  })

  afterAll(async () => {
    if (app) await app.close()
    if (!tenantId) return
    await prisma.inventoryCountItem.deleteMany({ where: { inventoryCount: { tenantId } } })
    await prisma.inventoryCount.deleteMany({ where: { tenantId } })
    await prisma.deferredBomTask.deleteMany({ where: { tenantId } })
    await prisma.dailyBusinessImport.deleteMany({ where: { tenantId } })
    await prisma.inventorySnapshotItem.deleteMany({ where: { snapshot: { tenantId } } })
    await prisma.inventorySnapshot.deleteMany({ where: { tenantId } })
    await prisma.opLog.deleteMany({ where: { tenantId } })
    await prisma.businessSequence.deleteMany({ where: { tenantId } })
    await prisma.product.deleteMany({ where: { tenantId } })
    await prisma.user.deleteMany({ where: { tenantId } })
    await prisma.store.deleteMany({ where: { tenantId } })
    await prisma.supplier.deleteMany({ where: { tenantId } })
    await prisma.tenant.delete({ where: { id: tenantId } })
  })

  it('aggregates confirmed reports, deferred BOM and inventory health for store roles', async () => {
    const imported = await prisma.dailyBusinessImport.create({
      data: {
        tenantId, storeId, businessDate: new Date('2026-07-17T00:00:00.000Z'), revision: 1,
        status: 'CONFIRMED', businessFileName: '营业.xlsx', businessFileHash: 'a'.repeat(64),
        salesFileName: '销售.xlsx', salesFileHash: 'b'.repeat(64), calculationFingerprint: 'c'.repeat(64),
        grossAmount: 1000, discountAmount: 100, netRevenue: 900, orderCount: 20, dishRowCount: 1,
        parsedData: {}, previewData: { dishSales: [{ dishId: 'dish' }], consumptions: [{ productId: productIds[0] }] },
        blockingIssues: [], warningIssues: [], createdById: userId, confirmedById: userId, confirmedAt: new Date(),
      },
    })
    await prisma.deferredBomTask.create({
      data: {
        tenantId, storeId, dailyBusinessImportId: imported.id, businessDate: imported.businessDate,
        rawDishName: '待维护菜品', reasonCode: 'BOM_MISSING', quantity: 1, grossAmount: 100,
        netIncome: 90, rawData: {}, saleRecorded: true,
      },
    })
    const response = await app.inject({ method: 'GET', url: '/api/daily-business-imports/control-center?days=2&endDate=2026-07-17' })
    expect(response.statusCode).toBe(200)
    const control = response.json()
    expect(control.summary.storeCount).toBe(1)
    expect(control.summary.pendingBomTasks).toBe(1)
    expect(control.stores[0].inventory.status).toBe('AVAILABLE')
    expect(control.stores[0].rows[0]).toMatchObject({
      businessDate: '2026-07-17', state: 'CONFIRMED', dishSaleCount: 1, consumptionSkuCount: 1,
      deferredBom: { pending: 1, backfilled: 0, superseded: 0 },
    })
    expect(control.stores[0].rows[1].state).toBe('OVERDUE')
  })

  it('keeps the whole count, evidence gate, confirmation and reversal atomic', async () => {
    const forbidden = await app.inject({ method: 'GET', url: '/api/inventory-counts', headers: { 'x-test-actor': 'supplier' } })
    expect(forbidden.statusCode).toBe(403)

    const createdResponse = await app.inject({
      method: 'POST', url: '/api/inventory-counts', payload: { countDate: '2026-07-18' },
    })
    expect(createdResponse.statusCode).toBe(201)
    const created = createdResponse.json()
    expect(created.status).toBe('DRAFT')
    expect(created.items).toHaveLength(2)

    const startedResponse = await app.inject({
      method: 'POST', url: `/api/inventory-counts/${created.id}/start`, payload: { rowVersion: created.rowVersion },
    })
    expect(startedResponse.statusCode).toBe(200)
    const started = startedResponse.json()
    expect(started.status).toBe('COUNTING')

    const earlySubmit = await app.inject({
      method: 'POST', url: `/api/inventory-counts/${created.id}/submit`, payload: { rowVersion: started.rowVersion },
    })
    expect(earlySubmit.statusCode).toBe(409)
    expect(earlySubmit.json().issues).toHaveLength(2)

    const firstSave = await app.inject({
      method: 'PUT', url: `/api/inventory-counts/${created.id}/items`,
      payload: {
        rowVersion: started.rowVersion,
        items: started.items.map((item: any, index: number) => ({
          id: item.id, countedQuantity: index === 0 ? 8 : 20,
          reasonCode: index === 0 ? 'SPOILAGE' : null,
        })),
      },
    })
    expect(firstSave.statusCode).toBe(200)
    const firstSaved = firstSave.json()
    expect(firstSaved.countedCount).toBe(2)
    expect(firstSaved.differenceCount).toBe(1)

    const evidenceBlocked = await app.inject({
      method: 'POST', url: `/api/inventory-counts/${created.id}/submit`, payload: { rowVersion: firstSaved.rowVersion },
    })
    expect(evidenceBlocked.statusCode).toBe(409)
    expect(evidenceBlocked.json().issues[0]).toContain('图片证据')

    const savedWithEvidence = await app.inject({
      method: 'PUT', url: `/api/inventory-counts/${created.id}/items`,
      payload: {
        rowVersion: firstSaved.rowVersion,
        items: [{
          id: firstSaved.items[0].id, countedQuantity: 8, reasonCode: 'SPOILAGE',
          reasonNote: '闭店称重复核', evidenceKeys: [`inventory-counts/${tenantId}/evidence.jpg`],
        }],
      },
    })
    expect(savedWithEvidence.statusCode).toBe(200)
    const saved = savedWithEvidence.json()

    const submit = await app.inject({
      method: 'POST', url: `/api/inventory-counts/${created.id}/submit`, payload: { rowVersion: saved.rowVersion },
    })
    expect(submit.statusCode).toBe(200)
    const reviewing = submit.json()
    expect(reviewing.status).toBe('REVIEWING')

    const stockBefore = await prisma.product.findMany({ where: { id: { in: productIds } }, orderBy: { id: 'asc' }, select: { stock: true } })
    const confirmations = await Promise.all([0, 1].map(() => app.inject({
      method: 'POST', url: `/api/inventory-counts/${created.id}/confirm`, payload: { rowVersion: reviewing.rowVersion },
    })))
    expect(confirmations.filter(response => response.statusCode === 200)).toHaveLength(1)
    expect(confirmations.filter(response => response.statusCode === 409)).toHaveLength(1)
    const confirmed = confirmations.find(response => response.statusCode === 200)!.json()
    expect(confirmed.status).toBe('CONFIRMED')
    expect(await prisma.inventorySnapshot.count({ where: { tenantId, storeId, snapshotDate: new Date('2026-07-18T00:00:00.000Z') } })).toBe(1)
    const stockAfter = await prisma.product.findMany({ where: { id: { in: productIds } }, orderBy: { id: 'asc' }, select: { stock: true } })
    expect(stockAfter.map(row => Number(row.stock))).toEqual(stockBefore.map(row => Number(row.stock)))

    const reverse = await app.inject({
      method: 'POST', url: `/api/inventory-counts/${created.id}/reverse`,
      payload: { rowVersion: confirmed.rowVersion, reason: '测试整单录入错误' },
    })
    expect(reverse.statusCode).toBe(200)
    expect(reverse.json().status).toBe('REVERSED')
    expect(await prisma.inventorySnapshot.count({ where: { tenantId, storeId, snapshotDate: new Date('2026-07-18T00:00:00.000Z') } })).toBe(0)
    expect(await prisma.inventorySnapshot.count({ where: { tenantId, storeId, snapshotDate: new Date('2026-07-10T00:00:00.000Z') } })).toBe(1)
  })

  it('allows only one active count per store under concurrency', async () => {
    const attempts = await Promise.all([0, 1].map(() => app.inject({
      method: 'POST', url: '/api/inventory-counts', payload: { countDate: '2026-07-18' },
    })))
    expect(attempts.filter(response => response.statusCode === 201)).toHaveLength(1)
    expect(attempts.filter(response => response.statusCode === 409)).toHaveLength(1)
    expect(await prisma.inventoryCount.count({ where: { tenantId, storeId, status: { in: ['DRAFT', 'COUNTING', 'REVIEWING'] } } })).toBe(1)

    const active = attempts.find(response => response.statusCode === 201)!.json()
    const cancelled = await app.inject({
      method: 'POST', url: `/api/inventory-counts/${active.id}/cancel`,
      payload: { rowVersion: active.rowVersion, reason: '并发创建验收后取消' },
    })
    expect(cancelled.statusCode).toBe(200)
    expect(cancelled.json()).toMatchObject({ status: 'CANCELLED', snapshotId: null })
    expect(await prisma.inventorySnapshot.count({ where: { tenantId, storeId, snapshotDate: new Date('2026-07-18T00:00:00.000Z') } })).toBe(0)

    const replacement = await app.inject({
      method: 'POST', url: '/api/inventory-counts', payload: { countDate: '2026-07-18' },
    })
    expect(replacement.statusCode).toBe(201)
    expect(replacement.json().revision).toBeGreaterThan(active.revision)
  })
})
