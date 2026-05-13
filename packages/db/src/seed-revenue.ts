/**
 * 7 日营业额种子 — 让 boss/manager Hero 的 sparkline 有真实形状
 * 给每家 ENABLED 门店写入过去 7 天的营业额（含今天），数值有波动以展示趋势
 */
import { PrismaClient } from '@prisma/client'
import dayjs from 'dayjs'

const prisma = new PrismaClient()

async function main() {
  const tenant = await prisma.tenant.findUnique({ where: { slug: 'dianjie' } })
  if (!tenant) throw new Error('tenant dianjie not found')
  const stores = await prisma.store.findMany({
    where: { tenantId: tenant.id, status: 'ENABLED' },
  })

  // 每家店的"基础日营业额"，让数据看起来差异化
  const baseByStore: Record<string, number> = {
    'DJ001': 18000,
    'DJ002': 14000,
    'DJ003': 12000,
    'DJ-DXG': 22000,
  }

  // 7 日波动系数（最早→最新），整体上扬
  const wave = [0.85, 0.92, 0.88, 1.0, 1.05, 0.95, 1.08]

  let count = 0
  for (const s of stores) {
    const base = baseByStore[s.no] ?? 15000
    for (let i = 0; i < 7; i++) {
      // 用本地日期组件构造 UTC 午夜，避免 +8 时区写入时把当天回退一天
      const local = dayjs().subtract(6 - i, 'day')
      const date = new Date(Date.UTC(local.year(), local.month(), local.date()))
      const amount = Math.round(base * wave[i])
      await prisma.revenueRecord.upsert({
        where: { storeId_date: { storeId: s.id, date } },
        update: { amount },
        create: { storeId: s.id, date, amount, source: 'seed', rawData: {} },
      })
      count++
    }
  }
  console.log(`✅ 写入 ${count} 条 revenueRecord（${stores.length} 店 × 7 天）`)
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
