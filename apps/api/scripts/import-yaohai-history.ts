/**
 * 瑶海店历史收银数据导入。
 *
 * 默认只做 dry-run；仅在显式传 --commit 时写库。
 * 直连 Prisma 导入是为了避免调用 /api/dishes/sales 时触发历史库存扣减，
 * 也不调用 /api/revenue，因此不会生成历史凭证。
 *
 * Usage:
 *   DATABASE_URL=... pnpm --filter @dianjie/api exec tsx scripts/import-yaohai-history.ts payload.json
 *   DATABASE_URL=... pnpm --filter @dianjie/api exec tsx scripts/import-yaohai-history.ts payload.json --commit
 *   # 仅本地预览库：将生产导入包定向到 PREVIEW_TENANT_SLUG
 *   DATABASE_URL=... pnpm --filter @dianjie/api exec tsx scripts/import-yaohai-history.ts payload.json --tenant=yaohai-test
 */
import 'dotenv/config'
import fs from 'node:fs/promises'
import { prisma } from '@dianjie/db'

type RevenueRow = {
  date: string
  grossAmount: number
  discountAmount: number
  netRevenue: number
  orders: number
  diners: number
  tables: number
  channelGroups: Record<string, number>
  channelDetails: Record<string, number>
  [key: string]: unknown
}

type DishSaleRow = {
  date: string
  name: string
  externalCodes: string[]
  specs: string[]
  units: string[]
  categories: string[]
  subcategories: string[]
  quantity: number
  grossAmount: number
  discountAmount: number
  netIncome: number
  lineCount: number
  uniqueOrders: number
  returns: { quantity: number; grossAmount: number; lineCount: number; uniqueOrders: number }
}

type Payload = {
  version: number
  importPolicy: {
    targetTenantSlug: string
    targetStoreName: string
    source: string
    inventoryBackfill: boolean
    generateVouchers: boolean
  }
  sourceFiles: Record<string, { fileName: string; sha256: string }>
  totals: Record<string, number | string | null>
  validations: Record<string, boolean>
  revenue: RevenueRow[]
  dishSales: DishSaleRow[]
  dishReturns: Array<{
    date: string
    name: string
    externalCodes: string[]
    quantity: number
    grossAmount: number
    lineCount: number
    uniqueOrders: number
  }>
}

function dateOnly(value: string) {
  return new Date(`${value}T00:00:00.000Z`)
}

function asJson<T extends object>(value: T) {
  return JSON.parse(JSON.stringify(value))
}

function targetTenantSlug(args: string[], payload: Payload) {
  const override = args.find((arg) => arg.startsWith('--tenant='))?.slice('--tenant='.length)
  if (!override) return payload.importPolicy.targetTenantSlug

  // 导入包默认指向真实租户。租户覆盖只为隔离本地预览提供，避免任何非预览环境改写目标。
  if (process.env.PREVIEW_MODE !== 'true') {
    throw new Error('--tenant 仅允许在 PREVIEW_MODE=true 的本地预览环境使用')
  }
  const previewTenant = process.env.PREVIEW_TENANT_SLUG
  if (!previewTenant || override !== previewTenant) {
    throw new Error(`--tenant 必须等于 PREVIEW_TENANT_SLUG (${previewTenant || '未设置'})`)
  }
  return override
}

async function main() {
  const args = process.argv.slice(2)
  const payloadPath = args.find((arg) => !arg.startsWith('--'))
  const commit = args.includes('--commit')
  if (!payloadPath) throw new Error('请传入 payload.json 路径')
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL 未设置')

  const payload = JSON.parse(await fs.readFile(payloadPath, 'utf8')) as Payload
  if (payload.version !== 1) throw new Error(`不支持的 payload version: ${payload.version}`)
  if (!Object.values(payload.validations).every(Boolean)) throw new Error('导入包勾稽未通过')
  if (payload.importPolicy.inventoryBackfill !== false) throw new Error('必须禁止历史库存回扣')
  if (payload.importPolicy.generateVouchers !== false) throw new Error('必须禁止历史凭证生成')
  const tenantSlug = targetTenantSlug(args, payload)

  const stores = await prisma.store.findMany({
    where: {
      tenant: { slug: tenantSlug },
      OR: [
        { name: payload.importPolicy.targetStoreName },
        { name: { contains: '瑶海' } },
      ],
    },
    select: { id: true, tenantId: true, name: true, no: true },
  })
  if (stores.length !== 1) {
    throw new Error(`期望唯一瑶海门店，实际 ${stores.length} 家: ${stores.map((s) => `${s.no}:${s.name}`).join(', ')}`)
  }
  const store = stores[0]
  const start = dateOnly(String(payload.totals.startDate))
  const end = dateOnly(String(payload.totals.endDate))
  const source = payload.importPolicy.source

  const [existingRevenue, existingSales, existingDishes] = await Promise.all([
    prisma.revenueRecord.findMany({
      where: { storeId: store.id, date: { gte: start, lte: end } },
      select: { id: true, date: true, amount: true, source: true },
    }),
    prisma.dishSale.count({ where: { storeId: store.id, date: { gte: start, lte: end }, source } }),
    prisma.dish.findMany({
      where: { tenantId: store.tenantId, name: { in: [...new Set(payload.dishSales.map((row) => row.name))] } },
      select: { id: true, name: true },
    }),
  ])

  const incomingRevenue = new Map(payload.revenue.map((row) => [row.date, row]))
  const conflicts = existingRevenue.filter((record) => {
    const date = record.date.toISOString().slice(0, 10)
    const incoming = incomingRevenue.get(date)
    return incoming && (record.source !== source || Math.abs(Number(record.amount) - incoming.netRevenue) > 0.01)
  })
  const report = {
    mode: commit ? 'commit' : 'dry-run',
    store,
    targetTenantSlug: tenantSlug,
    sourceTenantSlug: payload.importPolicy.targetTenantSlug,
    dateRange: [payload.totals.startDate, payload.totals.endDate],
    totals: payload.totals,
    existingRevenueRows: existingRevenue.length,
    conflictingRevenueRows: conflicts.length,
    existingHistoricalDishSales: existingSales,
    existingDishMasters: existingDishes.length,
    newDishMasters: new Set(payload.dishSales.map((row) => row.name)).size - existingDishes.length,
    inventoryBackfill: false,
    generateVouchers: false,
  }
  console.log(JSON.stringify(report, null, 2))

  if (!commit) return
  if (conflicts.length > 0) {
    throw new Error(`存在 ${conflicts.length} 条非本导入源的营收冲突，已拒绝覆盖`)
  }

  await prisma.$transaction(async (tx) => {
    for (const row of payload.revenue) {
      const posReturns = payload.dishReturns
        .filter((item) => item.date === row.date)
        .map((item) => ({
          name: item.name,
          externalCodes: item.externalCodes,
          quantity: item.quantity,
          grossAmount: item.grossAmount,
          lineCount: item.lineCount,
          uniqueOrders: item.uniqueOrders,
        }))
      const rawData = asJson({
        importVersion: payload.version,
        sourceFiles: payload.sourceFiles,
        grossAmount: row.grossAmount,
        discountAmount: row.discountAmount,
        netRevenue: row.netRevenue,
        orders: row.orders,
        diners: row.diners,
        tables: row.tables,
        channelGroups: row.channelGroups,
        channelDetails: row.channelDetails,
        posReturns,
      })
      await tx.revenueRecord.upsert({
        where: { storeId_date: { storeId: store.id, date: dateOnly(row.date) } },
        update: { amount: row.netRevenue, source, rawData },
        create: { storeId: store.id, date: dateOnly(row.date), amount: row.netRevenue, source, rawData },
      })
    }

    const dishByName = new Map(existingDishes.map((dish) => [dish.name, dish]))
    for (const name of [...new Set(payload.dishSales.map((row) => row.name))]) {
      if (dishByName.has(name)) continue
      const rows = payload.dishSales.filter((row) => row.name === name)
      const quantity = rows.reduce((sum, row) => sum + row.quantity, 0)
      const gross = rows.reduce((sum, row) => sum + row.grossAmount, 0)
      const first = rows[0]
      const created = await tx.dish.create({
        data: {
          tenantId: store.tenantId,
          name,
          code: first.externalCodes[0] || null,
          category: first.categories[0] || null,
          unit: first.units[0] || '份',
          salePrice: quantity > 0 ? Math.round((gross / quantity) * 100) / 100 : 0,
          groupWide: false,
          storeIds: [store.id],
          description: '由瑶海店历史收银数据导入',
        },
        select: { id: true, name: true },
      })
      dishByName.set(name, created)
    }

    for (const row of payload.dishSales) {
      const dish = dishByName.get(row.name)
      if (!dish) throw new Error(`菜品映射失败: ${row.name}`)
      const rawData = asJson({
        importVersion: payload.version,
        sourceFiles: payload.sourceFiles,
        externalCodes: row.externalCodes,
        specs: row.specs,
        categories: row.categories,
        subcategories: row.subcategories,
        grossAmount: row.grossAmount,
        discountAmount: row.discountAmount,
        netIncome: row.netIncome,
        lineCount: row.lineCount,
        uniqueOrders: row.uniqueOrders,
        returns: row.returns,
        inventoryBackfill: false,
      })
      await tx.dishSale.upsert({
        where: { storeId_dishId_date_source: { storeId: store.id, dishId: dish.id, date: dateOnly(row.date), source } },
        update: { quantity: row.quantity, grossAmount: row.netIncome, rawData },
        create: {
          tenantId: store.tenantId,
          storeId: store.id,
          dishId: dish.id,
          date: dateOnly(row.date),
          quantity: row.quantity,
          grossAmount: row.netIncome,
          source,
          channel: '收银POS历史',
          rawData,
        },
      })
    }
  }, { timeout: 300_000 })

  console.log('导入完成：历史营收和菜品销量已写入，未生成库存消耗或凭证。')
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
