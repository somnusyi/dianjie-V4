import Fastify from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@dianjie/db'
import { storeRoutes } from '../../src/routes/stores'
import { userRoutes } from '../../src/routes/users'
import { inventoryCountRoutes } from '../../src/routes/inventoryCounts'
import { inventoryRoutes } from '../../src/routes/inventory'

const suffix = `store-onboarding-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let tenantId = ''
let adminId = ''
let supplierId = ''
let productId = ''
let app: ReturnType<typeof Fastify>

describe('new store onboarding flow (integration)', () => {
  beforeAll(async () => {
    const tenant = await prisma.tenant.create({ data: { name: `新店扩展测试 ${suffix}`, slug: suffix } })
    tenantId = tenant.id
    const admin = await prisma.user.create({
      data: {
        tenantId, name: '扩店管理员', email: `${suffix}@local.test`,
        password: 'integration-test-only', role: 'SUPER_ADMIN',
      },
    })
    adminId = admin.id
    const supplier = await prisma.supplier.create({
      data: { tenantId, no: `SUP-${suffix}`, name: '扩店共享供应商' },
    })
    supplierId = supplier.id
    const product = await prisma.product.create({
      data: {
        tenantId, supplierId, code: `P-${suffix}`, name: '扩店共享原料', category: '测试',
        unit: 'kg', inventoryUnit: 'g', inventoryUnitsPerPurchaseUnit: 1000,
        unitConversionStatus: 'VERIFIED', price: 10,
      },
    })
    productId = product.id
    const dish = await prisma.dish.create({
      data: { tenantId, name: `扩店共享菜品 ${suffix}`, salePrice: 38, createdById: adminId },
    })
    await prisma.dishRecipe.create({
      data: { dishId: dish.id, productId, quantity: 100, unit: 'g', isMain: true },
    })

    app = Fastify()
    app.decorate('authenticate', async (request: any) => {
      request.user = { tenantId, userId: adminId, role: 'SUPER_ADMIN', storeId: null, storeIds: [] }
    })
    await app.register(storeRoutes, { prefix: '/api/stores' })
    await app.register(userRoutes, { prefix: '/api/users' })
    await app.register(inventoryCountRoutes, { prefix: '/api/inventory-counts' })
    await app.register(inventoryRoutes, { prefix: '/api/inventory' })
    await app.ready()
  })

  afterAll(async () => {
    if (app) await app.close()
    if (!tenantId) return
    await prisma.storeInventoryPolicy.deleteMany({ where: { tenantId } })
    await prisma.inventoryCountItem.deleteMany({ where: { inventoryCount: { tenantId } } })
    await prisma.inventoryCount.deleteMany({ where: { tenantId } })
    await prisma.inventorySnapshotItem.deleteMany({ where: { snapshot: { tenantId } } })
    await prisma.inventorySnapshot.deleteMany({ where: { tenantId } })
    await prisma.dishRecipe.deleteMany({ where: { dish: { tenantId } } })
    await prisma.dish.deleteMany({ where: { tenantId } })
    await prisma.opLog.deleteMany({ where: { tenantId } })
    await prisma.businessSequence.deleteMany({ where: { tenantId } })
    await prisma.product.deleteMany({ where: { tenantId } })
    await prisma.user.deleteMany({ where: { tenantId } })
    await prisma.store.deleteMany({ where: { tenantId } })
    await prisma.supplier.deleteMany({ where: { tenantId } })
    await prisma.tenant.delete({ where: { id: tenantId } })
  })

  it('creates a store, binds operating accounts and establishes the first inventory baseline', async () => {
    const storeResponse = await app.inject({
      method: 'POST', url: '/api/stores',
      payload: { no: `DJ${Date.now().toString().slice(-6)}`, name: '扩店流程门店', lifecyclePhase: 'TRIAL' },
    })
    expect(storeResponse.statusCode).toBe(200)
    const store = storeResponse.json()

    for (const [role, email] of [['MANAGER', `manager-${suffix}@local.test`], ['KITCHEN_LEAD', `chef-${suffix}@local.test`]] as const) {
      const userResponse = await app.inject({
        method: 'POST', url: '/api/users',
        payload: { name: `${role} 测试`, email, password: 'store-test-only', role, storeId: store.id },
      })
      expect(userResponse.statusCode).toBe(201)
      expect(userResponse.json()).toMatchObject({ role, storeId: store.id })
    }

    const policyResponse = await app.inject({
      method: 'PATCH', url: `/api/inventory/policies/${productId}`,
      payload: { storeId: store.id, minStock: 500, targetStock: 2000 },
    })
    expect(policyResponse.statusCode).toBe(200)
    expect(policyResponse.json()).toMatchObject({ storeId: store.id, productId, minStock: 500, targetStock: 2000, unit: 'g' })

    const countResponse = await app.inject({
      method: 'POST', url: '/api/inventory-counts',
      payload: { storeId: store.id, countDate: new Date().toISOString().slice(0, 10), note: '新店开业初始盘点' },
    })
    expect(countResponse.statusCode).toBe(201)
    const created = countResponse.json()
    expect(created.items).toHaveLength(1)
    expect(created.items[0]).toMatchObject({ productId, unitSnapshot: 'g', bookQuantity: 0 })

    const started = (await app.inject({
      method: 'POST', url: `/api/inventory-counts/${created.id}/start`, payload: { rowVersion: created.rowVersion },
    })).json()
    const savedResponse = await app.inject({
      method: 'PUT', url: `/api/inventory-counts/${created.id}/items`,
      payload: { rowVersion: started.rowVersion, items: [{ id: started.items[0].id, countedQuantity: 0 }] },
    })
    expect(savedResponse.statusCode).toBe(200)
    const saved = savedResponse.json()
    const submittedResponse = await app.inject({
      method: 'POST', url: `/api/inventory-counts/${created.id}/submit`, payload: { rowVersion: saved.rowVersion },
    })
    expect(submittedResponse.statusCode).toBe(200)
    const submitted = submittedResponse.json()
    const confirmedResponse = await app.inject({
      method: 'POST', url: `/api/inventory-counts/${created.id}/confirm`, payload: { rowVersion: submitted.rowVersion },
    })
    expect(confirmedResponse.statusCode).toBe(200)

    const inventoryResponse = await app.inject({ method: 'GET', url: `/api/inventory?storeId=${store.id}` })
    expect(inventoryResponse.statusCode).toBe(200)
    expect(inventoryResponse.json()).toEqual([
      expect.objectContaining({ id: productId, unit: 'g', stock: 0, minStock: 500, targetStock: 2000, isLowStock: true }),
    ])
  })

  it('requires ordinary chefs to be bound to a store', async () => {
    const response = await app.inject({
      method: 'POST', url: '/api/users',
      payload: { name: '未绑定厨师', email: `unbound-chef-${suffix}@local.test`, password: 'store-test-only', role: 'CHEF' },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toContain('必须绑定门店')
  })
})
