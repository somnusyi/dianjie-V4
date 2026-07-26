import { prisma } from '@dianjie/db'
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
