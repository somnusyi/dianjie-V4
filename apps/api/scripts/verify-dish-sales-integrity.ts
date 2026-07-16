/** Local-only E2E for manual dish sales scope, concurrency and atomic BOM consumption. */
import 'dotenv/config'
import bcrypt from 'bcryptjs'
import { prisma } from '@dianjie/db'

const API = process.env.API_BASE_URL || 'http://127.0.0.1:4444'
const DATE = '2026-01-03'
const SOURCE = 'manual'

function assertLocal() {
  if (process.env.PREVIEW_MODE !== 'true' || !(process.env.DATABASE_URL || '').includes('dianjie_v4_local')) {
    throw new Error('此脚本仅允许 PREVIEW_MODE=true 的 dianjie_v4_local 本地库')
  }
}

async function login(identifier: string, password: string) {
  const response = await fetch(`${API}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier, password, tenantSlug: 'yaohai-test' }),
  })
  if (!response.ok) throw new Error(`登录失败 ${response.status}: ${await response.text()}`)
  return (await response.json() as any).token as string
}

async function request(token: string, path: string, options: RequestInit = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  })
  const text = await response.text()
  let body: any = text
  try { body = text ? JSON.parse(text) : null } catch {}
  return { status: response.status, body }
}

async function main() {
  assertLocal()
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: 'yaohai-test' } })
  const store = await prisma.store.findFirstOrThrow({ where: { tenantId: tenant.id, no: 'YH001' } })
  const manager = await prisma.user.findFirstOrThrow({ where: { tenantId: tenant.id, role: 'MANAGER', storeId: store.id } })
  const otherStore = await prisma.store.upsert({
    where: { tenantId_no: { tenantId: tenant.id, no: 'E2EDS' } },
    update: { name: 'E2E其他门店', status: 'ENABLED' },
    create: { tenantId: tenant.id, no: 'E2EDS', name: 'E2E其他门店', status: 'ENABLED' },
  })
  const chefPassword = 'e2e-chef-only'
  const chef = await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: 'e2e-dish-chef@local.invalid' } },
    update: { role: 'CHEF_DIRECTOR', status: 'ACTIVE', password: await bcrypt.hash(chefPassword, 4) },
    create: {
      tenantId: tenant.id, name: 'E2E菜品总厨', email: 'e2e-dish-chef@local.invalid',
      password: await bcrypt.hash(chefPassword, 4), role: 'CHEF_DIRECTOR', status: 'ACTIVE',
    },
  })
  const product = await prisma.product.upsert({
    where: { tenantId_code: { tenantId: tenant.id, code: 'E2E-DISH-SALE-P' } },
    update: { name: 'E2E销量食材', unit: 'kg', status: 'ENABLED' },
    create: {
      tenantId: tenant.id, code: 'E2E-DISH-SALE-P', name: 'E2E销量食材', category: '测试',
      unit: 'kg', price: 10, stock: 0, minStock: 0, shelfDays: 1, status: 'ENABLED',
    },
  })
  const dish = await prisma.dish.upsert({
    where: { tenantId_name: { tenantId: tenant.id, name: 'E2E手工销量测试菜' } },
    update: { inventoryPolicy: 'BOM', status: 'ACTIVE' },
    create: {
      tenantId: tenant.id, name: 'E2E手工销量测试菜', category: '测试', unit: '份', salePrice: 20,
      inventoryPolicy: 'BOM', createdById: manager.id,
    },
  })
  const recipe = await prisma.dishRecipe.upsert({
    where: { dishId_variantKey_productId: { dishId: dish.id, variantKey: '', productId: product.id } },
    update: { quantity: 0.25, unit: 'kg', lossRate: 0 },
    create: { dishId: dish.id, productId: product.id, variantKey: '', quantity: 0.25, unit: 'kg', lossRate: 0 },
  })
  const foreignTenant = await prisma.tenant.create({
    data: { slug: `e2e-dish-foreign-${Date.now()}`, name: 'E2E外租户', status: 'ACTIVE' },
  })
  const foreignProduct = await prisma.product.create({
    data: {
      tenantId: foreignTenant.id, code: 'FOREIGN', name: '外租户食材', category: '测试', unit: 'kg',
      price: 1, stock: 0, minStock: 0, shelfDays: 1, status: 'ENABLED',
    },
  })
  const saleDate = new Date(`${DATE}T00:00:00.000Z`)
  let triggerInstalled = false
  try {
    const [managerToken, chefToken] = await Promise.all([
      login('manager@yaohai.test', 'yaohai@123'),
      login(chef.email, chefPassword),
    ])
    const saleBody = (quantity: number, extra: Record<string, unknown> = {}) => JSON.stringify({
      storeId: store.id, dishId: dish.id, date: DATE, quantity, grossAmount: quantity * 20, ...extra,
    })

    const crossWrite = await request(managerToken, '/api/dishes/sales', {
      method: 'POST', body: JSON.stringify({ storeId: otherStore.id, dishId: dish.id, date: DATE, quantity: 1, grossAmount: 20 }),
    })
    if (crossWrite.status !== 403) throw new Error(`跨店写入未阻断: ${crossWrite.status}`)
    for (const path of [
      `/api/dishes/sales?storeId=${otherStore.id}`,
      `/api/dishes/sales-rank?storeId=${otherStore.id}&month=2026-01`,
      `/api/dishes/projected-consumption?storeId=${otherStore.id}&from=${DATE}&to=${DATE}`,
    ]) {
      const result = await request(managerToken, path)
      if (result.status !== 403) throw new Error(`跨店读取未阻断 ${path}: ${result.status}`)
    }
    const forgedSource = await request(managerToken, '/api/dishes/sales', {
      method: 'POST', body: saleBody(1, { source: 'daily_pos_upload' }),
    })
    if (forgedSource.status !== 400) throw new Error(`系统数据源可被伪造: ${forgedSource.status}`)

    const crossTenantRecipe = await request(chefToken, `/api/dishes/recipes/${recipe.id}`, {
      method: 'PUT', body: JSON.stringify({ productId: foreignProduct.id }),
    })
    if (crossTenantRecipe.status !== 400) throw new Error(`跨租户配方食材未阻断: ${crossTenantRecipe.status}`)
    const wrongUnit = await request(chefToken, `/api/dishes/recipes/${recipe.id}`, {
      method: 'PUT', body: JSON.stringify({ unit: 'g' }),
    })
    if (wrongUnit.status !== 400) throw new Error(`配方单位错配未阻断: ${wrongUnit.status}`)

    const created = await request(managerToken, '/api/dishes/sales', { method: 'POST', body: saleBody(2) })
    if (created.status !== 200) throw new Error(`手工销量创建失败: ${created.status} ${JSON.stringify(created.body)}`)
    const concurrent = await Promise.all([
      request(managerToken, '/api/dishes/sales', { method: 'POST', body: saleBody(3) }),
      request(managerToken, '/api/dishes/sales', { method: 'POST', body: saleBody(4) }),
    ])
    if (concurrent.some(result => result.status !== 200)) {
      throw new Error(`并发销量更新失败: ${JSON.stringify(concurrent.map(result => result.status))}`)
    }
    const beforeFailure = await prisma.dishSale.findUniqueOrThrow({
      where: { storeId_dishId_date_source: { storeId: store.id, dishId: dish.id, date: saleDate, source: SOURCE } },
    })
    const beforeConsumption = await prisma.stockConsumption.findUniqueOrThrow({
      where: { stock_consumption_source_uk: { sourceType: 'dish_sale', sourceId: beforeFailure.id, productId: product.id } },
    })
    if (Number(beforeConsumption.quantity) !== Number(beforeFailure.quantity) * 0.25) {
      throw new Error('并发更新后销量与库存消耗不一致')
    }

    const safeProductId = product.id.replaceAll("'", "''")
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION e2e_fail_dish_sale_consumption() RETURNS trigger AS $$
      BEGIN
        IF NEW."productId" = '${safeProductId}' AND NEW."sourceType" = 'dish_sale' THEN
          RAISE EXCEPTION 'e2e forced consumption failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `)
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER e2e_fail_dish_sale_consumption_trigger
      BEFORE INSERT ON stock_consumptions
      FOR EACH ROW EXECUTE FUNCTION e2e_fail_dish_sale_consumption()
    `)
    triggerInstalled = true
    const failedUpdate = await request(managerToken, '/api/dishes/sales', { method: 'POST', body: saleBody(5) })
    if (failedUpdate.status !== 500) throw new Error(`故障注入应返回 500，实际 ${failedUpdate.status}`)
    await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS e2e_fail_dish_sale_consumption_trigger ON stock_consumptions')
    await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS e2e_fail_dish_sale_consumption()')
    triggerInstalled = false
    const [afterFailure, afterConsumption] = await Promise.all([
      prisma.dishSale.findUniqueOrThrow({
        where: { storeId_dishId_date_source: { storeId: store.id, dishId: dish.id, date: saleDate, source: SOURCE } },
      }),
      prisma.stockConsumption.findUniqueOrThrow({
        where: { stock_consumption_source_uk: { sourceType: 'dish_sale', sourceId: beforeFailure.id, productId: product.id } },
      }),
    ])
    if (Number(afterFailure.quantity) !== Number(beforeFailure.quantity)
      || Number(afterConsumption.quantity) !== Number(beforeConsumption.quantity)) {
      throw new Error('库存写入失败后，销量或原消耗没有原子回滚')
    }
    console.log(JSON.stringify({
      ok: true,
      crossStoreBlocked: true,
      forgedSourceBlocked: true,
      recipeTenantAndUnitBlocked: true,
      concurrentFinalQuantity: Number(afterFailure.quantity),
      concurrentFinalConsumption: Number(afterConsumption.quantity),
      faultRollback: true,
    }, null, 2))
  } finally {
    if (triggerInstalled) {
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS e2e_fail_dish_sale_consumption_trigger ON stock_consumptions')
      await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS e2e_fail_dish_sale_consumption()')
    }
    const sales = await prisma.dishSale.findMany({ where: { storeId: store.id, dishId: dish.id, date: saleDate }, select: { id: true } })
    await prisma.stockConsumption.deleteMany({ where: { sourceType: 'dish_sale', sourceId: { in: sales.map(item => item.id) } } })
    await prisma.dishSale.deleteMany({ where: { id: { in: sales.map(item => item.id) } } })
    await prisma.dishRecipe.deleteMany({ where: { dishId: dish.id } })
    await prisma.dish.deleteMany({ where: { id: dish.id } })
    await prisma.product.deleteMany({ where: { id: product.id } })
    await prisma.user.deleteMany({ where: { id: chef.id } })
    await prisma.store.deleteMany({ where: { id: otherStore.id } })
    await prisma.product.deleteMany({ where: { id: foreignProduct.id } })
    await prisma.tenant.deleteMany({ where: { id: foreignTenant.id } })
  }
}

main().then(() => prisma.$disconnect()).catch(async error => {
  console.error(error)
  await prisma.$disconnect()
  process.exit(1)
})
