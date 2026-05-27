import { prisma } from '@dianjie/db'
import { Prisma } from '@dianjie/db'

export interface ProcessReport {
  processed: number
  skippedNoStore: number
  skippedNoChange: number
  errors: { mtOrderId: string; reason: string }[]
}

const BATCH_LIMIT = 1000

/**
 * 把 mt_orders 中 processed=false 的行写入 RevenueRecord (增量)
 * 失败粒度 = 单笔订单 (不影响其他订单)
 */
export async function processPendingOrders(): Promise<ProcessReport> {
  const report: ProcessReport = { processed: 0, skippedNoStore: 0, skippedNoChange: 0, errors: [] }

  const pending = await prisma.mtOrder.findMany({
    where: { processed: false },
    take: BATCH_LIMIT,
    orderBy: { businessTime: 'asc' },
  })

  for (const mtOrder of pending) {
    try {
      // 没 storeId 跳过 (poiId 未在 V4 Store 中映射)
      if (!mtOrder.storeId) {
        await prisma.mtOrder.update({
          where: { id: mtOrder.id },
          data: { processError: 'storeId 未解析 (poiId 与 V4 Store 无映射), 跳过 RevenueRecord 写入' },
        })
        report.skippedNoStore++
        continue
      }

      // 简化: 直接用 mtOrder.payed (这是美团结账后的实收, 已扣过退款)
      // 极端 (全单取消 status=600) 用 0 — 取消单不计营收
      const newAmount = mtOrder.status === 600 ? 0 : mtOrder.payed
      const delta = newAmount - mtOrder.processedAmount

      if (delta === 0) {
        await prisma.mtOrder.update({
          where: { id: mtOrder.id },
          data: { processed: true, processedAt: new Date(), processError: null },
        })
        report.skippedNoChange++
        continue
      }

      const storeId = mtOrder.storeId

      await prisma.$transaction(async (tx) => {
        const existing = await tx.revenueRecord.findUnique({
          where: { storeId_date: { storeId, date: mtOrder.businessTime } },
        })

        // 首次遇到 source='manual' → 归零 + 改 source, 旧值进 rawData
        if (existing && existing.source === 'manual') {
          await tx.revenueRecord.update({
            where: { id: existing.id },
            data: {
              amount: 0,
              source: 'meituan',
              rawData: {
                ...((existing.rawData as object) ?? {}),
                replacedManual: {
                  previousAmount: Number(existing.amount),
                  replacedAt: new Date().toISOString(),
                  reason: 'auto-overwrite by meituan sync',
                },
              },
            },
          })
        }

        const yuanDelta = new Prisma.Decimal(delta).div(100)
        const record = await tx.revenueRecord.upsert({
          where: { storeId_date: { storeId, date: mtOrder.businessTime } },
          create: {
            storeId,
            date: mtOrder.businessTime,
            amount: yuanDelta,
            source: 'meituan',
          },
          update: {
            amount: { increment: yuanDelta },
            source: 'meituan',
          },
        })

        await tx.mtOrder.update({
          where: { id: mtOrder.id },
          data: {
            processed: true,
            processedAt: new Date(),
            processedAmount: newAmount,
            revenueRecordId: record.id,
            processError: null,
          },
        })
      })

      report.processed++
    } catch (e: any) {
      const msg = e?.message || String(e)
      await prisma.mtOrder.update({
        where: { id: mtOrder.id },
        data: { processError: msg.slice(0, 1000) },
      }).catch(() => {})  // update 错就吞, processor 继续跑其他订单
      report.errors.push({ mtOrderId: mtOrder.mtOrderId, reason: msg })
    }
  }

  return report
}
