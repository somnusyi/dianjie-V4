import { Prisma, prisma } from '@dianjie/db'
import dayjs from 'dayjs'
import { estimatedStoreInventory } from './storeInventory'

export type StoreOverviewResult = {
  orderCount: number
  orderStatusBreakdown: {
    SUBMITTED: number
    CONFIRMED: number
    DELIVERING: number
    inProgress: number
  }
  validReceiptCount: number
  inventoryProductCount: number
  lowStockCount: number
  consumptionCount30d: number
}

export type ConsumptionRankingDimension = 'PRODUCT' | 'CATEGORY'

export type StoreConsumptionRankingResult = {
  dimension: ConsumptionRankingDimension
  days: 7 | 30 | 90
  startDate: string
  endDate: string
  totalAmount: number
  top10Amount: number
  top10Coverage: number
  recordCount: number
  pricedRecordCount: number
  unpricedRecordCount: number
  items: Array<{
    id: string
    name: string
    code: string | null
    category: string
    amount: number
    share: number
    recordCount: number
    pricedRecordCount: number
  }>
}

type ConsumptionRankingSummaryRow = {
  totalAmount: Prisma.Decimal | number | string
  recordCount: number | bigint
  pricedRecordCount: number | bigint
}

type ConsumptionRankingRow = {
  id: string
  name: string
  code: string | null
  category: string
  amount: Prisma.Decimal | number | string
  recordCount: number | bigint
  pricedRecordCount: number | bigint
}

function chinaBusinessDate() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

/**
 * 门店消耗金额排行榜。
 *
 * 金额只使用 StockConsumption.costAmountSnapshot；没有冻结成本的历史行只进入
 * unpricedRecordCount，不允许用当前商品价格反推历史金额。
 */
export async function getStoreConsumptionRanking(
  tenantId: string,
  storeId: string,
  days: 7 | 30 | 90,
  dimension: ConsumptionRankingDimension,
): Promise<StoreConsumptionRankingResult> {
  const endDate = chinaBusinessDate()
  const startDate = dayjs(endDate).subtract(days - 1, 'day').format('YYYY-MM-DD')
  const baseWhere = Prisma.sql`
    FROM "stock_consumptions" sc
    INNER JOIN "products" p
      ON p."id" = sc."productId"
     AND p."tenantId" = sc."tenantId"
    WHERE sc."tenantId" = ${tenantId}
      AND sc."storeId" = ${storeId}
      AND sc."date" >= CAST(${startDate} AS date)
      AND sc."date" <= CAST(${endDate} AS date)
      AND sc."voidedAt" IS NULL
  `

  const rankingQuery = dimension === 'PRODUCT'
    ? Prisma.sql`
        SELECT
          p."id" AS "id",
          p."name" AS "name",
          p."code" AS "code",
          COALESCE(NULLIF(BTRIM(p."category"), ''), '未分类') AS "category",
          COALESCE(SUM(sc."costAmountSnapshot"), 0) AS "amount",
          COUNT(*)::int AS "recordCount",
          COUNT(sc."costAmountSnapshot")::int AS "pricedRecordCount"
        ${baseWhere}
        GROUP BY p."id", p."name", p."code", p."category"
        HAVING COALESCE(SUM(sc."costAmountSnapshot"), 0) > 0
        ORDER BY "amount" DESC, p."name" ASC, p."id" ASC
        LIMIT 10
      `
    : Prisma.sql`
        SELECT
          COALESCE(NULLIF(BTRIM(p."category"), ''), '未分类') AS "id",
          COALESCE(NULLIF(BTRIM(p."category"), ''), '未分类') AS "name",
          NULL::text AS "code",
          COALESCE(NULLIF(BTRIM(p."category"), ''), '未分类') AS "category",
          COALESCE(SUM(sc."costAmountSnapshot"), 0) AS "amount",
          COUNT(*)::int AS "recordCount",
          COUNT(sc."costAmountSnapshot")::int AS "pricedRecordCount"
        ${baseWhere}
        GROUP BY COALESCE(NULLIF(BTRIM(p."category"), ''), '未分类')
        HAVING COALESCE(SUM(sc."costAmountSnapshot"), 0) > 0
        ORDER BY "amount" DESC, "name" ASC
        LIMIT 10
      `

  const [summaryRows, rankingRows] = await Promise.all([
    prisma.$queryRaw<ConsumptionRankingSummaryRow[]>(Prisma.sql`
      SELECT
        COALESCE(SUM(sc."costAmountSnapshot"), 0) AS "totalAmount",
        COUNT(*)::int AS "recordCount",
        COUNT(sc."costAmountSnapshot")::int AS "pricedRecordCount"
      ${baseWhere}
    `),
    prisma.$queryRaw<ConsumptionRankingRow[]>(rankingQuery),
  ])

  const summary = summaryRows[0] || {
    totalAmount: 0,
    recordCount: 0,
    pricedRecordCount: 0,
  }
  const totalAmount = Number(summary.totalAmount || 0)
  const recordCount = Number(summary.recordCount || 0)
  const pricedRecordCount = Number(summary.pricedRecordCount || 0)
  const items = rankingRows.map(row => {
    const amount = Number(row.amount || 0)
    return {
      id: row.id,
      name: row.name,
      code: row.code,
      category: row.category,
      amount,
      share: totalAmount > 0 ? amount / totalAmount : 0,
      recordCount: Number(row.recordCount || 0),
      pricedRecordCount: Number(row.pricedRecordCount || 0),
    }
  })
  const top10Amount = items.reduce((sum, item) => sum + item.amount, 0)

  return {
    dimension,
    days,
    startDate,
    endDate,
    totalAmount,
    top10Amount,
    top10Coverage: totalAmount > 0 ? top10Amount / totalAmount : 0,
    recordCount,
    pricedRecordCount,
    unpricedRecordCount: Math.max(0, recordCount - pricedRecordCount),
    items,
  }
}

export async function getStoreOverview(tenantId: string, storeId: string): Promise<StoreOverviewResult> {
  const thirtyDaysAgo = dayjs().subtract(30, 'days').startOf('day').toDate()

  const [
    submittedCount,
    confirmedCount,
    deliveringCount,
    validReceiptCount,
    consumptionCount30d,
    inventory,
  ] = await Promise.all([
    prisma.purchaseOrder.count({
      where: { tenantId, storeId, status: 'SUBMITTED' },
    }),
    prisma.purchaseOrder.count({
      where: { tenantId, storeId, status: 'CONFIRMED' },
    }),
    prisma.purchaseOrder.count({
      where: { tenantId, storeId, status: 'DELIVERING' },
    }),
    prisma.receipt.count({
      where: { tenantId, storeId, status: { notIn: ['VOID', 'REJECTED'] } },
    }),
    prisma.stockConsumption.count({
      where: { tenantId, storeId, voidedAt: null, date: { gte: thirtyDaysAgo } },
    }),
    estimatedStoreInventory(tenantId, storeId),
  ])

  const inProgress = submittedCount + confirmedCount + deliveringCount

  return {
    orderCount: inProgress,
    orderStatusBreakdown: {
      SUBMITTED: submittedCount,
      CONFIRMED: confirmedCount,
      DELIVERING: deliveringCount,
      inProgress,
    },
    validReceiptCount,
    inventoryProductCount: inventory.summary.itemCount,
    lowStockCount: inventory.summary.lowStockCount,
    consumptionCount30d,
  }
}
