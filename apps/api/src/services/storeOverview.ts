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

// 订货运行看板：进行中的状态轨道（不含草稿/已完成/已取消）
const RUNBOARD_RUNNING_STATUSES = ['SUBMITTED', 'CONFIRMED', 'DELIVERING', 'PENDING_CONFIRM'] as const

export type StoreOrderRunboardResult = {
  date: string
  todayOrders: {
    count: number
    itemCount: number
    totalAmount: string
  }
  latestOrder: {
    id: string
    no: string
    status: string
    createdAt: string
  } | null
  statusBreakdown: {
    SUBMITTED: number
    CONFIRMED: number
    DELIVERING: number
    PENDING_CONFIRM: number
    RECEIVED: number
    COMPLETED: number
    CANCELLED: number
    inProgress: number
  }
  overdue: {
    count: number
    orders: Array<{
      id: string
      no: string
      status: string
      createdAt: string
      expectedDate: string
      itemCount: number
      totalAmount: string
      overdueDays: number
    }>
  }
}

/**
 * 订货单金额统一取「订货金额」冻结口径：currentOrderAmount（已批准修订）优先，
 * 回退 originalTotalAmount（首次提交），最后才是遗留 totalAmount。不得混用实发/实收/应付。
 */
function orderFrozenAmount(order: {
  currentOrderAmount: Prisma.Decimal | null
  originalTotalAmount: Prisma.Decimal | null
  totalAmount: Prisma.Decimal | null
}): Prisma.Decimal {
  return order.currentOrderAmount ?? order.originalTotalAmount ?? order.totalAmount ?? new Prisma.Decimal(0)
}

/**
 * 门店订货运行看板（只读聚合）。
 *
 * - 今日订货：中国时区当日创建、非 DRAFT、非 CANCELLED 的订货单。
 * - 逾期：预计到货日早于今天、且仍处于进行中状态轨道的订货单
 *   （草稿未提交给供应商，不进入运行轨道；已完成/已取消不视为异常）。
 */
export async function getStoreOrderRunboard(
  tenantId: string,
  storeId: string,
): Promise<StoreOrderRunboardResult> {
  const date = chinaBusinessDate()
  const dayStart = new Date(`${date}T00:00:00+08:00`)
  const dayEnd = new Date(`${date}T23:59:59.999+08:00`)
  const activeItemCount = { select: { items: { where: { isActive: true } } } }

  const [todayOrders, latestOrder, statusGroups, overdueOrders] = await Promise.all([
    prisma.purchaseOrder.findMany({
      where: {
        tenantId,
        storeId,
        status: { notIn: ['DRAFT', 'CANCELLED'] },
        createdAt: { gte: dayStart, lte: dayEnd },
      },
      select: {
        id: true,
        no: true,
        status: true,
        createdAt: true,
        currentOrderAmount: true,
        originalTotalAmount: true,
        totalAmount: true,
        _count: activeItemCount,
      },
    }),
    prisma.purchaseOrder.findFirst({
      where: { tenantId, storeId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, no: true, status: true, createdAt: true },
    }),
    prisma.purchaseOrder.groupBy({
      by: ['status'],
      where: { tenantId, storeId },
      _count: { _all: true },
    }),
    prisma.purchaseOrder.findMany({
      where: {
        tenantId,
        storeId,
        status: { in: [...RUNBOARD_RUNNING_STATUSES] },
        expectedDate: { lt: dayStart },
      },
      orderBy: [{ expectedDate: 'asc' }, { createdAt: 'desc' }],
      select: {
        id: true,
        no: true,
        status: true,
        createdAt: true,
        expectedDate: true,
        currentOrderAmount: true,
        originalTotalAmount: true,
        totalAmount: true,
        _count: activeItemCount,
      },
    }),
  ])

  const statusCounts = new Map(statusGroups.map(group => [group.status, group._count._all]))
  const statusBreakdown: StoreOrderRunboardResult['statusBreakdown'] = {
    SUBMITTED: statusCounts.get('SUBMITTED') ?? 0,
    CONFIRMED: statusCounts.get('CONFIRMED') ?? 0,
    DELIVERING: statusCounts.get('DELIVERING') ?? 0,
    PENDING_CONFIRM: statusCounts.get('PENDING_CONFIRM') ?? 0,
    RECEIVED: statusCounts.get('RECEIVED') ?? 0,
    COMPLETED: statusCounts.get('COMPLETED') ?? 0,
    CANCELLED: statusCounts.get('CANCELLED') ?? 0,
    inProgress: (statusCounts.get('SUBMITTED') ?? 0)
      + (statusCounts.get('CONFIRMED') ?? 0)
      + (statusCounts.get('DELIVERING') ?? 0)
      + (statusCounts.get('PENDING_CONFIRM') ?? 0),
  }

  const todaySummary = todayOrders.reduce((acc, order) => ({
    itemCount: acc.itemCount + order._count.items,
    totalAmount: acc.totalAmount.add(orderFrozenAmount(order)),
  }), { itemCount: 0, totalAmount: new Prisma.Decimal(0) })

  return {
    date,
    todayOrders: {
      count: todayOrders.length,
      itemCount: todaySummary.itemCount,
      totalAmount: todaySummary.totalAmount.toFixed(2),
    },
    latestOrder: latestOrder
      ? {
          id: latestOrder.id,
          no: latestOrder.no,
          status: latestOrder.status,
          createdAt: latestOrder.createdAt.toISOString(),
        }
      : null,
    statusBreakdown,
    overdue: {
      count: overdueOrders.length,
      orders: overdueOrders.map(order => {
        const expectedDate = order.expectedDate.toISOString().slice(0, 10)
        return {
          id: order.id,
          no: order.no,
          status: order.status,
          createdAt: order.createdAt.toISOString(),
          expectedDate,
          itemCount: order._count.items,
          totalAmount: orderFrozenAmount(order).toFixed(2),
          overdueDays: dayjs(date).diff(dayjs(expectedDate), 'day'),
        }
      }),
    },
  }
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
