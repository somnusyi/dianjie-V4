/** Local-only E2E for immutable BOM publish and historical correction. */
import 'dotenv/config'
import bcrypt from 'bcryptjs'
import { prisma } from '@dianjie/db'

const API = process.env.API_BASE_URL || 'http://127.0.0.1:4444'
const TENANT_SLUG = process.env.PREVIEW_TENANT_SLUG || 'yaohai-test'
const EMAIL = 'e2e-bom-chef@local.invalid'
const PASSWORD = 'E2eBom!2026'

function assertLocal() {
  if (process.env.PREVIEW_MODE !== 'true' || !(process.env.DATABASE_URL || '').includes('dianjie_v4_local')) {
    throw new Error('此脚本仅允许 PREVIEW_MODE=true 的 dianjie_v4_local 本地库')
  }
}

async function api(path: string, token: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const payload = await response.json() as any
  return { response, payload }
}

async function main() {
  assertLocal()
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: TENANT_SLUG } })
  const chef = await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: EMAIL } },
    update: { password: await bcrypt.hash(PASSWORD, 4), role: 'CHEF_DIRECTOR', status: 'ACTIVE' },
    create: {
      tenantId: tenant.id, name: 'E2E BOM 总厨', email: EMAIL,
      password: await bcrypt.hash(PASSWORD, 4), role: 'CHEF_DIRECTOR', status: 'ACTIVE',
    },
  })
  const product = await prisma.product.upsert({
    where: { tenantId_code: { tenantId: tenant.id, code: 'E2E-BOM-001' } },
    update: { name: 'E2E BOM 食材', unit: 'kg', status: 'ENABLED' },
    create: {
      tenantId: tenant.id, code: 'E2E-BOM-001', name: 'E2E BOM 食材', category: '测试',
      unit: 'kg', price: 10, stock: 0, minStock: 0, shelfDays: 1, status: 'ENABLED',
    },
  })
  const dish = await prisma.dish.create({
    data: { tenantId: tenant.id, name: `E2E BOM 菜品 ${Date.now()}`, unit: '份', salePrice: 30, createdById: chef.id },
  })

  try {
    await prisma.dishBomVersion.create({
      data: {
        tenantId: tenant.id, dishId: dish.id, variantKey: '', versionNo: 1,
        status: 'PUBLISHED', changeType: 'INITIAL', changeReason: '初始版本',
        effectiveFrom: new Date('2026-07-01T00:00:00.000Z'), createdById: chef.id,
        publishedById: chef.id, publishedAt: new Date(),
        items: { create: [{ productId: product.id, quantity: 0.2, unit: 'kg', lossRate: 0, isMain: true }] },
      },
    })
    await prisma.dishBomVersion.create({
      data: {
        tenantId: tenant.id, dishId: dish.id, variantKey: '', versionNo: 2,
        status: 'PUBLISHED', changeType: 'BUSINESS_CHANGE', changeReason: '未来版本',
        effectiveFrom: new Date('2026-08-01T00:00:00.000Z'), createdById: chef.id,
        publishedById: chef.id, publishedAt: new Date(),
        items: { create: [{ productId: product.id, quantity: 0.3, unit: 'kg', lossRate: 0, isMain: true }] },
      },
    })

    const loginResponse = await fetch(`${API}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: EMAIL, password: PASSWORD, tenantSlug: TENANT_SLUG }),
    })
    if (!loginResponse.ok) throw new Error(`登录失败 ${loginResponse.status}: ${await loginResponse.text()}`)
    const token = (await loginResponse.json() as any).token as string

    const draftResult = await api(`/api/dishes/${dish.id}/bom-versions/draft`, token, 'POST', {
      variantKey: '', effectiveFrom: '2026-07-10', changeType: 'HISTORICAL_CORRECTION', changeReason: '修正历史标准用量',
    })
    if (!draftResult.response.ok) throw new Error(`创建纠错草稿失败: ${JSON.stringify(draftResult.payload)}`)
    const draftId = draftResult.payload.id as string
    const itemResult = await api(`/api/dishes/bom-versions/${draftId}/items`, token, 'PUT', {
      items: [{ productId: product.id, quantity: 0.5, unit: 'kg', lossRate: 0, isMain: true }],
    })
    if (!itemResult.response.ok) throw new Error(`保存纠错草稿失败: ${JSON.stringify(itemResult.payload)}`)

    const guarded = await api(`/api/dishes/bom-versions/${draftId}/publish`, token, 'POST', {})
    if (guarded.response.status !== 409 || guarded.payload.code !== 'HISTORICAL_CONFIRMATION_REQUIRED') {
      throw new Error(`历史纠错未触发二次确认: ${guarded.response.status} ${JSON.stringify(guarded.payload)}`)
    }
    const published = await api(`/api/dishes/bom-versions/${draftId}/publish`, token, 'POST', { confirmHistoricalCorrection: true })
    if (!published.response.ok) throw new Error(`发布历史纠错失败: ${JSON.stringify(published.payload)}`)

    const versions = await prisma.dishBomVersion.findMany({ where: { dishId: dish.id }, orderBy: { versionNo: 'asc' } })
    const report = versions.map(version => ({
      versionNo: version.versionNo, status: version.status,
      from: version.effectiveFrom?.toISOString().slice(0, 10), to: version.effectiveTo?.toISOString().slice(0, 10) || null,
    }))
    const expected = [
      { versionNo: 1, status: 'PUBLISHED', from: '2026-07-01', to: '2026-07-09' },
      { versionNo: 2, status: 'PUBLISHED', from: '2026-08-01', to: null },
      { versionNo: 3, status: 'PUBLISHED', from: '2026-07-10', to: '2026-07-31' },
    ]
    if (JSON.stringify(report) !== JSON.stringify(expected)) throw new Error(`版本区间异常: ${JSON.stringify(report)}`)
    console.log(JSON.stringify({ ok: true, confirmationGuard: true, versions: report }, null, 2))
  } finally {
    await prisma.opLog.deleteMany({ where: { tenantId: tenant.id, userId: chef.id } })
    await prisma.dish.deleteMany({ where: { id: dish.id } })
    await prisma.product.deleteMany({ where: { id: product.id } })
    await prisma.user.deleteMany({ where: { id: chef.id } })
  }
}

main().then(() => prisma.$disconnect()).catch(async error => {
  console.error(error)
  await prisma.$disconnect()
  process.exit(1)
})
