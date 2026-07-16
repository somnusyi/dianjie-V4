/** Idempotent, reviewed stock-consumption batch importer. */
import 'dotenv/config'
import fs from 'node:fs/promises'
import { prisma } from '@dianjie/db'

type ConsumptionPayload = {
  version: 1
  tenantSlug: string
  targetStoreNo: string
  sourceType: string
  rows: Array<{
    date: string
    sourceId: string
    productId: string
    productCode: string
    productName: string
    quantity: number
    unit: string
    note: string
  }>
  skipped?: unknown[]
}

function dateOnly(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`日期格式错误: ${value}`)
  return new Date(`${value}T00:00:00.000Z`)
}

async function main() {
  const args = process.argv.slice(2)
  const path = args.find(arg => !arg.startsWith('--'))
  const commit = args.includes('--commit')
  const confirm = args.find(arg => arg.startsWith('--confirm='))?.slice('--confirm='.length)
  if (!path) throw new Error('请传入消耗 payload JSON')
  if (commit && confirm !== 'import-stock-consumptions') throw new Error('写入需 --confirm=import-stock-consumptions')
  const payload = JSON.parse(await fs.readFile(path, 'utf8')) as ConsumptionPayload
  if (payload.version !== 1) throw new Error(`不支持 payload version ${payload.version}`)
  if (!payload.sourceType || payload.sourceType.length > 20) throw new Error('sourceType 必须为 1-20 字符')
  if (payload.rows.length === 0) throw new Error('没有可导入的消耗行')
  if (payload.rows.some(row => !Number.isFinite(row.quantity) || row.quantity <= 0)) throw new Error('消耗数量必须为正数')
  if (payload.rows.some(row => row.sourceId.length > 64)) throw new Error('sourceId 超过 64 字符')

  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: payload.tenantSlug } })
  const store = await prisma.store.findUniqueOrThrow({
    where: { tenantId_no: { tenantId: tenant.id, no: payload.targetStoreNo } },
  })
  const productIds = [...new Set(payload.rows.map(row => row.productId))]
  const products = await prisma.product.findMany({ where: { tenantId: tenant.id, id: { in: productIds } } })
  const byId = new Map(products.map(product => [product.id, product]))
  for (const row of payload.rows) {
    const product = byId.get(row.productId)
    if (!product) throw new Error(`商品不属于目标租户或不存在: ${row.productName} ${row.productId}`)
    if (product.code !== row.productCode) throw new Error(`商品编码漂移: ${row.productName}`)
    if (product.unit.trim().toLowerCase() !== row.unit.trim().toLowerCase()) {
      throw new Error(`单位不一致: ${row.productName} payload=${row.unit} database=${product.unit}`)
    }
  }
  const snapshot = await prisma.inventorySnapshot.findFirstOrThrow({
    where: { tenantId: tenant.id, storeId: store.id }, orderBy: { snapshotDate: 'desc' },
  })
  const openingDate = new Date(snapshot.snapshotDate)
  openingDate.setUTCDate(openingDate.getUTCDate() + 1)
  if (payload.rows.some(row => dateOnly(row.date) < openingDate)) throw new Error('消耗日期早于盘点期初日')
  const sourceIds = [...new Set(payload.rows.map(row => row.sourceId))]
  const existing = await prisma.stockConsumption.findMany({
    where: { tenantId: tenant.id, storeId: store.id, sourceType: payload.sourceType, sourceId: { in: sourceIds } },
  })
  const creators = await prisma.user.findMany({
    where: { tenantId: tenant.id, role: { in: ['ADMIN', 'SUPER_ADMIN', 'CHEF_DIRECTOR', 'CHEF', 'MANAGER'] }, status: 'ACTIVE' },
    orderBy: { createdAt: 'asc' }, take: 1,
  })
  if (creators.length !== 1) throw new Error('目标租户没有可用于审计的活跃录入账号')
  const byDate = new Map<string, { rows: number; quantity: number }>()
  for (const row of payload.rows) {
    const current = byDate.get(row.date) || { rows: 0, quantity: 0 }
    current.rows += 1
    current.quantity += row.quantity
    byDate.set(row.date, current)
  }
  console.log(JSON.stringify({
    mode: commit ? 'commit' : 'dry-run', tenant: tenant.slug, store: { no: store.no, name: store.name },
    rows: payload.rows.length, products: productIds.length, dates: Object.fromEntries(byDate),
    existingRowsToReplace: existing.length, skippedRows: payload.skipped?.length || 0,
  }, null, 2))
  if (!commit) return

  await prisma.$transaction(async tx => {
    await tx.stockConsumption.deleteMany({
      where: { tenantId: tenant.id, storeId: store.id, sourceType: payload.sourceType, sourceId: { in: sourceIds } },
    })
    await tx.stockConsumption.createMany({
      data: payload.rows.map(row => ({
        tenantId: tenant.id, storeId: store.id, productId: row.productId,
        date: dateOnly(row.date), quantity: row.quantity, note: row.note,
        sourceType: payload.sourceType, sourceId: row.sourceId, createdById: creators[0].id,
      })),
    })
  }, { timeout: 60_000 })
  console.log(JSON.stringify({ ok: true, inserted: payload.rows.length, replaced: existing.length }))
}

main().then(() => prisma.$disconnect()).catch(async error => {
  console.error(error)
  await prisma.$disconnect()
  process.exit(1)
})
