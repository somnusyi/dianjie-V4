import Fastify from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@dianjie/db'
import { consumptionAdminRoutes, consumptionRoutes } from '../../src/routes/consumption'

const suffix = `consumption-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const DAY = '2026-07-10'
const MONTH = '2026-07'

let app: ReturnType<typeof Fastify>
let tenantId = ''
let otherTenantId = ''
let storeId = ''
let otherStoreId = ''
let otherTenantStoreId = ''
let managerId = ''
let productAId = ''
let productBId = ''

type TestUser = { tenantId: string; storeId: string | null; userId: string; role: string }

// 提升作用域: 后面的 void/daily-series describe 需要追加 chefDirector 用户
const users: Record<string, TestUser> = {}

async function seedConsumption(data: {
  tenantId: string; storeId: string; productId: string; dishId?: string; date: string
  invQty: string; cost: string; sourceType?: string; sourceId: string; createdById: string
}) {
  await prisma.stockConsumption.create({
    data: {
      tenantId: data.tenantId, storeId: data.storeId, productId: data.productId,
      dishId: data.dishId ?? null,
      date: new Date(`${data.date}T00:00:00.000Z`),
      quantity: data.invQty, inventoryQuantity: data.invQty,
      costAmountSnapshot: data.cost,
      sourceType: data.sourceType ?? 'dish_sale', sourceId: data.sourceId,
      createdById: data.createdById,
    },
  })
}

describe('store consumption view (integration)', () => {
  beforeAll(async () => {
    const tenant = await prisma.tenant.create({ data: { name: suffix, slug: suffix } })
    tenantId = tenant.id
    const otherTenant = await prisma.tenant.create({ data: { name: `${suffix}-b`, slug: `${suffix}-b` } })
    otherTenantId = otherTenant.id

    const store = await prisma.store.create({ data: { tenantId, no: `CS-${suffix}`, name: '消耗验证门店' } })
    storeId = store.id
    const otherStore = await prisma.store.create({ data: { tenantId, no: `CS2-${suffix}`, name: '同租户第二店' } })
    otherStoreId = otherStore.id
    const otherTenantStore = await prisma.store.create({ data: { tenantId: otherTenantId, no: `CS3-${suffix}`, name: '异租户门店' } })
    otherTenantStoreId = otherTenantStore.id

    const manager = await prisma.user.create({
      data: { tenantId, storeId, storeIds: [storeId], name: '消耗验证店长', email: `${suffix}-m@local.test`, password: 'test', role: 'MANAGER' },
    })
    managerId = manager.id
    const chef = await prisma.user.create({
      data: { tenantId, storeId: otherStoreId, storeIds: [otherStoreId], name: '二店厨师长', email: `${suffix}-c@local.test`, password: 'test', role: 'KITCHEN_LEAD' },
    })
    const admin = await prisma.user.create({
      data: { tenantId, name: '租户管理员', email: `${suffix}-a@local.test`, password: 'test', role: 'ADMIN' },
    })

    const productA = await prisma.product.create({
      data: { tenantId, code: 'MR001', name: '牛腩', category: '肉类', unit: 'kg', inventoryUnit: 'kg', price: 20 },
    })
    productAId = productA.id
    const productB = await prisma.product.create({
      data: { tenantId, code: 'MR002', name: '土豆', category: '蔬菜', unit: '斤', inventoryUnit: 'kg', price: 3 },
    })
    productBId = productB.id

    const dish1 = await prisma.dish.create({
      data: { tenantId, name: '土豆牛腩', salePrice: 68 },
    })
    const dish2 = await prisma.dish.create({
      data: { tenantId, name: '清炒土豆丝', salePrice: 22 },
    })

    const base = { tenantId, storeId, createdById: managerId }
    // 当日: pA 牛腩 菜品扣减 (dish1 两行 + dish2 一行)
    await seedConsumption({ ...base, productId: productAId, dishId: dish1.id, date: DAY, invQty: '2', cost: '40', sourceId: 'sale-1' })
    await seedConsumption({ ...base, productId: productAId, dishId: dish1.id, date: DAY, invQty: '1', cost: '20', sourceId: 'sale-2' })
    await seedConsumption({ ...base, productId: productAId, dishId: dish2.id, date: DAY, invQty: '1', cost: '20', sourceId: 'sale-3' })
    // 当日: pB 土豆 人工报损
    await seedConsumption({ ...base, productId: productBId, date: DAY, invQty: '5', cost: '15', sourceType: 'manual', sourceId: 'manual-1' })
    // pA 前 7 日历史 (07-09: 2, 07-07: 4) → 日均 (2+4)/2 = 3
    await seedConsumption({ ...base, productId: productAId, dishId: dish1.id, date: '2026-07-09', invQty: '2', cost: '40', sourceId: 'sale-4' })
    await seedConsumption({ ...base, productId: productAId, dishId: dish1.id, date: '2026-07-07', invQty: '4', cost: '80', sourceId: 'sale-5' })
    // 同月另一天, 供月汇总 daysWithData=2
    await seedConsumption({ ...base, productId: productBId, date: '2026-07-15', invQty: '1', cost: '3', sourceType: 'manual', sourceId: 'manual-2' })
    // 同租户另一门店同日的数据不应混入
    await seedConsumption({ ...base, storeId: otherStoreId, productId: productAId, dishId: dish1.id, date: DAY, invQty: '99', cost: '1980', sourceId: 'sale-other-store' })

    Object.assign(users, {
      manager: { tenantId, storeId, userId: managerId, role: 'MANAGER' },
      chef: { tenantId, storeId: otherStoreId, userId: chef.id, role: 'KITCHEN_LEAD' },
      admin: { tenantId, storeId: null, userId: admin.id, role: 'ADMIN' },
      waiter: { tenantId, storeId, userId: managerId, role: 'WAITER' },
    })

    app = Fastify()
    app.decorate('authenticate', async (request: any) => {
      const key = (request.headers['x-test-user'] as string) || 'manager'
      request.user = users[key]
    })
    await app.register(consumptionRoutes, { prefix: '/api/stores' })
    await app.register(consumptionAdminRoutes, { prefix: '/api/consumption' })
    await app.ready()
  })

  afterAll(async () => {
    if (app) await app.close()
    if (!tenantId) return
    await prisma.opLog.deleteMany({ where: { tenantId: { in: [tenantId, otherTenantId] } } })
    await prisma.revenueRecord.deleteMany({ where: { storeId: { in: [storeId, otherStoreId, otherTenantStoreId] } } })
    await prisma.stockConsumption.deleteMany({ where: { tenantId: { in: [tenantId, otherTenantId] } } })
    await prisma.dish.deleteMany({ where: { tenantId } })
    await prisma.product.deleteMany({ where: { tenantId } })
    await prisma.user.deleteMany({ where: { tenantId: { in: [tenantId, otherTenantId] } } })
    await prisma.store.deleteMany({ where: { tenantId: { in: [tenantId, otherTenantId] } } })
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantId, otherTenantId] } } })
  })

  it('aggregates the day by product with prev-7-day average comparison', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/stores/${storeId}/consumption/daily?date=${DAY}` })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.totalCost).toBe(95)
    expect(body.items).toHaveLength(2)
    // 按 cost 降序: 牛腩 80 在前
    const [beef, potato] = body.items
    expect(beef).toMatchObject({
      productId: productAId, code: 'MR001', name: '牛腩', unit: 'kg',
      qty: 4, cost: 80, dishCount: 2, prev7AvgQty: 3, changePct: 33.3,
    })
    expect(potato).toMatchObject({
      productId: productBId, code: 'MR002', name: '土豆', unit: 'kg',
      qty: 5, cost: 15, dishCount: 0,
    })
    expect(potato.prev7AvgQty).toBeNull()
    expect(potato.changePct).toBeNull()
  })

  it('returns an empty list for a day without consumption data', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/stores/${storeId}/consumption/daily?date=2026-07-20` })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ date: '2026-07-20', totalCost: 0, items: [] })
  })

  it('rejects malformed dates with 400', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/stores/${storeId}/consumption/daily?date=2026-7-1` })
    expect(response.statusCode).toBe(400)
  })

  it('groups the product detail by dish and flags manual loss rows', async () => {
    const beef = await app.inject({ method: 'GET', url: `/api/stores/${storeId}/consumption/daily/${productAId}?date=${DAY}` })
    expect(beef.statusCode).toBe(200)
    const beefBody = beef.json()
    expect(beefBody.product).toMatchObject({ id: productAId, name: '牛腩', unit: 'kg' })
    expect(beefBody.rows).toEqual([
      expect.objectContaining({ dishName: '土豆牛腩', manual: false, qty: 3, cost: 60 }),
      expect.objectContaining({ dishName: '清炒土豆丝', manual: false, qty: 1, cost: 20 }),
    ])

    const potato = await app.inject({ method: 'GET', url: `/api/stores/${storeId}/consumption/daily/${productBId}?date=${DAY}` })
    expect(potato.statusCode).toBe(200)
    expect(potato.json().rows).toEqual([
      expect.objectContaining({ dishId: null, dishName: null, manual: true, qty: 5, cost: 15 }),
    ])
  })

  it('summarizes the month with total cost, data days and top products', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/stores/${storeId}/consumption/summary?month=${MONTH}` })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    // 有数据天: 07-07 / 07-09 / 07-10 / 07-15
    expect(body.daysWithData).toBe(4)
    // 80+15 (07-10) + 40 (07-09) + 80 (07-07) + 3 (07-15)
    expect(body.totalCost).toBe(218)
    expect(body.top).toHaveLength(2)
    expect(body.top[0]).toMatchObject({ productId: productAId, name: '牛腩', qty: 10, cost: 200 })
    expect(body.top[1]).toMatchObject({ productId: productBId, name: '土豆', qty: 6, cost: 18 })
  })

  it('returns an empty month summary without data', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/stores/${storeId}/consumption/summary?month=2026-08` })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ month: '2026-08', totalCost: 0, daysWithData: 0, top: [] })
  })

  it('blocks store-scoped roles from other stores with 403', async () => {
    const response = await app.inject({
      method: 'GET', url: `/api/stores/${otherStoreId}/consumption/daily?date=${DAY}`,
      headers: { 'x-test-user': 'manager' },
    })
    expect(response.statusCode).toBe(403)
  })

  it('hides other-tenant stores behind 404 for tenant-level roles', async () => {
    const response = await app.inject({
      method: 'GET', url: `/api/stores/${otherTenantStoreId}/consumption/summary?month=${MONTH}`,
      headers: { 'x-test-user': 'admin' },
    })
    expect(response.statusCode).toBe(404)
  })

  it('rejects roles without consumption view permission', async () => {
    const response = await app.inject({
      method: 'GET', url: `/api/stores/${storeId}/consumption/daily?date=${DAY}`,
      headers: { 'x-test-user': 'waiter' },
    })
    expect(response.statusCode).toBe(403)
  })

  it('lets a chef see only their own store', async () => {
    const own = await app.inject({
      method: 'GET', url: `/api/stores/${otherStoreId}/consumption/daily?date=${DAY}`,
      headers: { 'x-test-user': 'chef' },
    })
    expect(own.statusCode).toBe(200)
    expect(own.json().items[0]).toMatchObject({ productId: productAId, qty: 99 })

    const cross = await app.inject({
      method: 'GET', url: `/api/stores/${storeId}/consumption/daily?date=${DAY}`,
      headers: { 'x-test-user': 'chef' },
    })
    expect(cross.statusCode).toBe(403)
  })
// ── 冲销/补记 + 日线序列 (integration) ─────────────────────
// 嵌套在外层 describe 内, 共享其种子数据与 afterAll 清理;
// 使用独立日期 (07-18/07-19) 与独立食材, 不影响上面已有用例的聚合断言。
describe('consumption void / correction / daily-series (integration)', () => {
  const VOID_DAY = '2026-07-18'
  const VOID_ONLY_DAY = '2026-07-19'
  let productCId = ''
  let rowToCorrectId = ''
  let rowVoidOnlyId = ''
  let otherTenantRowId = ''
  let chefDirectorId = ''
  let adminUserId = ''

  beforeAll(async () => {
    const director = await prisma.user.create({
      data: { tenantId, name: '总厨', email: `${suffix}-cd@local.test`, password: 'test', role: 'CHEF_DIRECTOR' },
    })
    chefDirectorId = director.id
    users.chefDirector = { tenantId, storeId: null, userId: director.id, role: 'CHEF_DIRECTOR' }
    const admin = await prisma.user.findFirstOrThrow({ where: { tenantId, role: 'ADMIN' } })
    adminUserId = admin.id

    const productC = await prisma.product.create({
      data: { tenantId, code: 'MR003', name: '奇异果果酱', category: '酱料', unit: '桶', inventoryUnit: 'g', price: 38 },
    })
    productCId = productC.id

    // 待冲销+补记行: 100g × ¥4/g = ¥200
    const rowToCorrect = await prisma.stockConsumption.create({
      data: {
        tenantId, storeId, productId: productCId,
        date: new Date(`${VOID_DAY}T00:00:00.000Z`),
        quantity: '4', inventoryQuantity: '100', unitSnapshot: '桶', inventoryUnitSnapshot: 'g',
        unitCostSnapshot: '4', costAmountSnapshot: '200',
        sourceType: 'daily_pos', sourceId: 'anomalous-1', createdById: managerId,
      },
    })
    rowToCorrectId = rowToCorrect.id
    // 同日正常行 ¥50
    await prisma.stockConsumption.create({
      data: {
        tenantId, storeId, productId: productCId,
        date: new Date(`${VOID_DAY}T00:00:00.000Z`),
        quantity: '1', inventoryQuantity: '25', unitSnapshot: '桶', inventoryUnitSnapshot: 'g',
        unitCostSnapshot: '2', costAmountSnapshot: '50',
        sourceType: 'daily_pos', sourceId: 'normal-1', createdById: managerId,
      },
    })
    // 只冲销不补记的行 ¥30
    const rowVoidOnly = await prisma.stockConsumption.create({
      data: {
        tenantId, storeId, productId: productCId,
        date: new Date(`${VOID_ONLY_DAY}T00:00:00.000Z`),
        quantity: '1', inventoryQuantity: '10', unitSnapshot: '桶', inventoryUnitSnapshot: 'g',
        unitCostSnapshot: '3', costAmountSnapshot: '30',
        sourceType: 'daily_pos', sourceId: 'anomalous-2', createdById: managerId,
      },
    })
    rowVoidOnlyId = rowVoidOnly.id
    // 异租户行 (越权冲销应 404)
    const otherTenantRow = await prisma.stockConsumption.create({
      data: {
        tenantId: otherTenantId, storeId: otherTenantStoreId, productId: productCId,
        date: new Date(`${VOID_DAY}T00:00:00.000Z`),
        quantity: '1', inventoryQuantity: '1', costAmountSnapshot: '1',
        sourceType: 'daily_pos', sourceId: 'other-tenant-row', createdById: managerId,
      },
    })
    otherTenantRowId = otherTenantRow.id

    // 营业额: VOID_DAY ¥4000; VOID_ONLY_DAY 无记录 (revenue=0 → costRate null)
    await prisma.revenueRecord.create({
      data: { storeId, date: new Date(`${DAY}T00:00:00.000Z`), amount: '1000' },
    })
    await prisma.revenueRecord.create({
      data: { storeId, date: new Date(`${VOID_DAY}T00:00:00.000Z`), amount: '4000' },
    })
  })

  it('rejects roles without void permission (MANAGER / KITCHEN_LEAD / WAITER)', async () => {
    for (const key of ['manager', 'chef', 'waiter']) {
      const response = await app.inject({
        method: 'POST', url: `/api/consumption/${rowToCorrectId}/void`,
        headers: { 'x-test-user': key },
        payload: { reason: '无权限测试' },
      })
      expect(response.statusCode).toBe(403)
    }
  })

  it('requires a void reason', async () => {
    const response = await app.inject({
      method: 'POST', url: `/api/consumption/${rowToCorrectId}/void`,
      headers: { 'x-test-user': 'admin' },
      payload: {},
    })
    expect(response.statusCode).toBe(400)
  })

  it('hides other-tenant rows behind 404', async () => {
    const response = await app.inject({
      method: 'POST', url: `/api/consumption/${otherTenantRowId}/void`,
      headers: { 'x-test-user': 'admin' },
      payload: { reason: '跨租户冲销' },
    })
    expect(response.statusCode).toBe(404)
  })

  it('voids the original row and inserts a correction row (CHEF_DIRECTOR)', async () => {
    const response = await app.inject({
      method: 'POST', url: `/api/consumption/${rowToCorrectId}/void`,
      headers: { 'x-test-user': 'chefDirector' },
      payload: { reason: '单位换算 bug（×1000）', correctedQuantity: 0.018333, correctedInventoryQuantity: 25 },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.success).toBe(true)
    expect(body.voidedId).toBe(rowToCorrectId)
    expect(body.correctionId).toBeTruthy()

    const original = await prisma.stockConsumption.findUniqueOrThrow({ where: { id: rowToCorrectId } })
    expect(original.voidedAt).toBeTruthy()
    expect(original.voidedReason).toBe('单位换算 bug（×1000）')
    expect(original.voidedById).toBe(chefDirectorId)

    const correction = await prisma.stockConsumption.findUniqueOrThrow({ where: { id: body.correctionId } })
    expect(correction).toMatchObject({
      tenantId, storeId, productId: productCId,
      sourceType: 'correction', sourceId: rowToCorrectId, sourceLineKey: 'correction',
      correctionOfId: rowToCorrectId, createdById: chefDirectorId,
    })
    expect(correction.date.toISOString().slice(0, 10)).toBe(VOID_DAY)
    expect(Number(correction.quantity)).toBeCloseTo(0.018333, 6)
    expect(Number(correction.inventoryQuantity)).toBe(25)
    // 未传修正金额 → 修正库存量 × 原 unitCostSnapshot (25 × 4)
    expect(Number(correction.costAmountSnapshot)).toBe(100)
    expect(correction.calculationSnapshot).toMatchObject({
      correctionOf: rowToCorrectId, originalInventoryQuantity: '100', reason: '单位换算 bug（×1000）',
    })
  })

  it('rejects a repeated void with 409 (idempotent error)', async () => {
    const response = await app.inject({
      method: 'POST', url: `/api/consumption/${rowToCorrectId}/void`,
      headers: { 'x-test-user': 'admin' },
      payload: { reason: '重复冲销' },
    })
    expect(response.statusCode).toBe(409)
  })

  it('excludes the voided row and counts the correction row in daily aggregates', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/stores/${storeId}/consumption/daily?date=${VOID_DAY}` })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    // 原 ¥200 作废, 补记 ¥100 + 正常行 ¥50 = ¥150
    expect(body.totalCost).toBe(150)
    expect(body.items).toHaveLength(1)
    expect(body.items[0]).toMatchObject({ productId: productCId, qty: 50, cost: 150 })
  })

  it('voids a row without correction so it disappears entirely', async () => {
    const response = await app.inject({
      method: 'POST', url: `/api/consumption/${rowVoidOnlyId}/void`,
      headers: { 'x-test-user': 'admin' },
      payload: { reason: 'BOM 配方录入错误，待总厨确认真实配方后补记' },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().correctionId).toBeNull()

    const daily = await app.inject({ method: 'GET', url: `/api/stores/${storeId}/consumption/daily?date=${VOID_ONLY_DAY}` })
    expect(daily.statusCode).toBe(200)
    expect(daily.json()).toMatchObject({ date: VOID_ONLY_DAY, totalCost: 0, items: [] })
  })

  it('returns the daily consumption × revenue series for the month', async () => {
    const response = await app.inject({
      method: 'GET', url: `/api/consumption/daily-series?storeId=${storeId}&month=${MONTH}`,
    })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body).toMatchObject({ storeId, month: MONTH })
    expect(body.series).toHaveLength(31)

    const byDate = new Map(body.series.map((d: any) => [d.date, d]))
    // 07-10: 消耗 ¥95 (已有种子数据), 营业额 ¥1000
    expect(byDate.get(DAY)).toEqual({ date: DAY, consumptionCost: 95, revenue: 1000, costRate: 9.5 })
    // 07-18: 作废行被排除, 补记行被计入 (100+50=150), 营业额 ¥4000
    expect(byDate.get(VOID_DAY)).toEqual({ date: VOID_DAY, consumptionCost: 150, revenue: 4000, costRate: 3.75 })
    // 07-19: 只冲销行已消失; 无营业额记录 → revenue=0, costRate=null
    expect(byDate.get(VOID_ONLY_DAY)).toEqual({ date: VOID_ONLY_DAY, consumptionCost: 0, revenue: 0, costRate: null })
    // 无数据日补 0
    expect(byDate.get('2026-07-25')).toEqual({ date: '2026-07-25', consumptionCost: 0, revenue: 0, costRate: null })
  })

  it('enforces daily-series permissions and scoping', async () => {
    const waiter = await app.inject({
      method: 'GET', url: `/api/consumption/daily-series?storeId=${storeId}&month=${MONTH}`,
      headers: { 'x-test-user': 'waiter' },
    })
    expect(waiter.statusCode).toBe(403)

    const crossStoreChef = await app.inject({
      method: 'GET', url: `/api/consumption/daily-series?storeId=${storeId}&month=${MONTH}`,
      headers: { 'x-test-user': 'chef' },
    })
    expect(crossStoreChef.statusCode).toBe(403)

    const otherTenantStore = await app.inject({
      method: 'GET', url: `/api/consumption/daily-series?storeId=${otherTenantStoreId}&month=${MONTH}`,
      headers: { 'x-test-user': 'admin' },
    })
    expect(otherTenantStore.statusCode).toBe(404)

    const badMonth = await app.inject({
      method: 'GET', url: `/api/consumption/daily-series?storeId=${storeId}&month=2026-7`,
    })
    expect(badMonth.statusCode).toBe(400)

    const admin = await app.inject({
      method: 'GET', url: `/api/consumption/daily-series?storeId=${storeId}&month=${MONTH}`,
      headers: { 'x-test-user': 'admin' },
    })
    expect(admin.statusCode).toBe(200)
  })
})
})
