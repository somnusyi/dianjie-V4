import { prisma } from '@dianjie/db'
import { createMeituanClient, MeituanRateLimitError } from './client'
import { parseOrderListResponse, parseRefundOrderListResponse } from './parser'
import type { DomainOrder, DomainRefundOrder } from './parser'

const ORG_ID = Number(process.env.MEITUAN_ORG_ID || 0)

export interface SyncReport {
  pages: number
  orders: number
  refunds: number
  failures: { apiPath: string; code: string; traceId?: string }[]
  durationMs: number
}

// ════════════════════════════════════════════════════════════════
// 主路：拉店内订单 (queryTimeType 由调用方指定)
// ════════════════════════════════════════════════════════════════
export interface SyncInstoreParams {
  correlationId: string
  since: Date
  until: Date
  queryTimeType: 1 | 2 | 3 | 4
  statusList?: number[]
  sortField?: 1 | 2
  sort?: 1 | 2
}

export async function syncInstoreOrders(p: SyncInstoreParams): Promise<SyncReport> {
  const client = createMeituanClient()
  const startedAt = Date.now()
  const apiPath = '/rms/pos/api/v2/poi/orders/instore/query'
  const report: SyncReport = { pages: 0, orders: 0, refunds: 0, failures: [], durationMs: 0 }

  let rateLimited = false
  let pageNo = 1
  while (true) {
    let resp
    try {
      resp = await client.fetchInstoreOrders({
        orgId: ORG_ID,
        req: {
          queryTimeType: p.queryTimeType,
          beginTime: p.since.getTime(),
          endTime: p.until.getTime(),
          pageNo,
          pageSize: 50,
          statusList: p.statusList,
          sortField: p.sortField,
          sort: p.sort,
        },
        correlationId: p.correlationId,
      })
    } catch (e: any) {
      if (e instanceof MeituanRateLimitError) {
        // 限流 → 中断本次 sync, 等下次 cron
        report.failures.push({ apiPath, code: e.responseCode })
        rateLimited = true
        break
      }
      report.failures.push({ apiPath, code: e?.responseCode || 'TRANSPORT', traceId: e?.traceId })
      throw e   // cursor 不推进, Sentry 已上报
    }

    const parsed = parseOrderListResponse(resp)
    await upsertOrdersPage(parsed.orders, { callLogContext: p.correlationId })
    report.pages++
    report.orders += parsed.orders.length

    if (pageNo >= parsed.totalPageCount || parsed.orders.length === 0) break
    pageNo++
  }

  // 推进 cursor（仅在完整成功时）
  if (!rateLimited) {
    await prisma.meituanSyncCursor.upsert({
      where: { apiPath_orgId: { apiPath, orgId: ORG_ID } },
      create: {
        apiPath, orgId: ORG_ID,
        lastSyncedAt: p.until, lastSuccessAt: new Date(),
      },
      update: {
        lastSyncedAt: p.until, lastSuccessAt: new Date(),
        consecutiveFailures: 0, lastErrorAt: null, lastErrorCode: null,
      },
    })
  }

  report.durationMs = Date.now() - startedAt
  return report
}

// ════════════════════════════════════════════════════════════════
// 退单：拉 reverse orders
// ════════════════════════════════════════════════════════════════
export interface SyncReverseParams {
  correlationId: string
  since: Date
  until: Date
}

export async function syncReverseOrders(p: SyncReverseParams): Promise<SyncReport> {
  const client = createMeituanClient()
  const startedAt = Date.now()
  const apiPath = '/rms/pos/api/v1/poi/reverse/orders/search'
  const report: SyncReport = { pages: 0, orders: 0, refunds: 0, failures: [], durationMs: 0 }

  let rateLimited = false
  let pageNo = 1
  while (true) {
    let resp
    try {
      resp = await client.fetchReverseOrders({
        orgId: ORG_ID,
        req: {
          queryTimeType: 1,             // 退单接口只支持 1（营业日）
          beginTime: p.since.getTime(),
          endTime: p.until.getTime(),
          pageNo,
          pageSize: 50,
        },
        correlationId: p.correlationId,
      })
    } catch (e: any) {
      if (e instanceof MeituanRateLimitError) {
        report.failures.push({ apiPath, code: e.responseCode })
        rateLimited = true
        break
      }
      report.failures.push({ apiPath, code: e?.responseCode || 'TRANSPORT', traceId: e?.traceId })
      throw e
    }

    const parsed = parseRefundOrderListResponse(resp)
    await upsertRefundsPage(parsed.refunds, p.correlationId)
    report.pages++
    report.refunds += parsed.refunds.length

    if (pageNo >= parsed.totalPageCount || parsed.refunds.length === 0) break
    pageNo++
  }

  if (!rateLimited) {
    await prisma.meituanSyncCursor.upsert({
      where: { apiPath_orgId: { apiPath, orgId: ORG_ID } },
      create: { apiPath, orgId: ORG_ID, lastSyncedAt: p.until, lastSuccessAt: new Date() },
      update: { lastSyncedAt: p.until, lastSuccessAt: new Date(), consecutiveFailures: 0 },
    })
  }

  report.durationMs = Date.now() - startedAt
  return report
}

// ════════════════════════════════════════════════════════════════
// 单页 upsert (订单 + items + payments)
// ════════════════════════════════════════════════════════════════
async function upsertOrdersPage(orders: DomainOrder[], ctx: { callLogContext: string }): Promise<void> {
  for (const o of orders) {
    await prisma.$transaction(async (tx) => {
      // 先查旧的 payed, 用于决定要不要重置 processed
      const existing = await tx.mtOrder.findUnique({
        where: { mtOrderId: o.mtOrderId },
        select: { payed: true, processedAmount: true },
      })
      const needsReprocess = existing && existing.payed !== o.payed

      // 解析 storeId — 按 poiId 找 V4 Store (用 meituanShopId 字段做映射)
      const store = await tx.store.findFirst({
        where: { meituanShopId: String(o.poiId) },
        select: { id: true },
      })

      const data = {
        mtOrderId: o.mtOrderId,
        orderNo: o.orderNo,
        vendorOrderId: o.vendorOrderId,
        orgId: o.orgId,
        poiId: o.poiId,
        storeId: store?.id ?? null,
        channel: o.channel,
        callLogId: ctx.callLogContext,
        businessTime: o.businessTime,
        orderTime: o.orderTime,
        checkoutTime: o.checkoutTime,
        refundTime: o.refundTime,
        cancelTime: o.cancelTime,
        syncTime: o.syncTime,
        status: o.status,
        statusName: o.statusName,
        refundStatus: o.refundStatus,
        makeStatus: o.makeStatus,
        isPartRefund: o.isPartRefund,
        payed: o.payed,
        receivable: o.receivable,
        amount: o.amount,
        discount: o.discount,
        income: o.income,
        serviceFee: o.serviceFee,
        taxAmt: o.taxAmt,
        taxExcludedAmt: o.taxExcludedAmt,
        keepAmount: o.keepAmount,
        oddment: o.oddment,
        source: o.source,
        sourceName: o.sourceName,
        businessType: o.businessType,
        businessTypeName: o.businessTypeName,
        typeName: o.typeName,
        customerCount: o.customerCount,
        cashier: o.cashier,
        cashierName: o.cashierName,
        cashierNo: o.cashierNo,
        tableId: o.tableId,
        tableComment: o.tableComment,
        unionType: o.unionType,
        parentOrderNo: o.parentOrderNo,
        rawPayload: o.rawPayload as object,
      }

      await tx.mtOrder.upsert({
        where: { mtOrderId: o.mtOrderId },
        create: data,
        update: {
          ...data,
          // payed 变化时重置 processed, 让 processor 重算 RevenueRecord delta
          ...(needsReprocess ? { processed: false, processError: null } : {}),
        },
      })

      // items: 全量 replace
      await tx.mtOrderItem.deleteMany({ where: { mtOrderId: o.mtOrderId } })
      if (o.items.length) {
        await tx.mtOrderItem.createMany({
          data: o.items.map(i => ({
            mtOrderId: o.mtOrderId,
            mtSkuId: i.mtSkuId,
            mtSkuNo: i.mtSkuNo,
            mtSpuId: i.mtSpuId,
            thirdSkuId: i.thirdSkuId,
            name: i.name,
            specs: i.specs,
            spuName: i.spuName,
            count: i.count,
            price: i.price,
            totalPrice: i.totalPrice,
            actualPrice: i.actualPrice,
            apportionPrice: i.apportionPrice,
            newTotalPrice: i.newTotalPrice,
            income: i.income,
            discountAmount: i.discountAmount,
            isCombo: i.isCombo,
            comboAddPrice: i.comboAddPrice,
            parentItemNo: i.parentItemNo,
            itemNo: i.itemNo,
            serialNo: i.serialNo,
            cateId: i.cateId,
            departmentOrgId: i.departmentOrgId,
            departmentOrgName: i.departmentOrgName,
            present: i.present,
            promotion: i.promotion,
            retreat: i.retreat,
            status: i.status,
            attrs: i.attrs ?? null,
            newAttrs: (i.newAttrs ?? null) as any,
            taxRate: i.taxRate,
            taxAmt: i.taxAmt,
            taxExcludedAmt: i.taxExcludedAmt,
            comment: i.comment,
            rawPayload: i.rawPayload as object,
          })),
        })
      }

      // payments: 全量 replace
      await tx.mtOrderPayment.deleteMany({ where: { mtOrderId: o.mtOrderId } })
      if (o.payments.length) {
        await tx.mtOrderPayment.createMany({
          data: o.payments.map(p => ({
            mtOrderId: o.mtOrderId,
            payType: p.payType,
            payTypeName: p.payTypeName,
            payDetailType: p.payDetailType,
            payed: p.payed,
            discountAmount: p.discountAmount,
            income: p.income,
            debtAccount: p.debtAccount,
            tradeNo: p.tradeNo,
            payNo: p.payNo,
            relatedPayNo: p.relatedPayNo,
            refundTradeNo: p.refundTradeNo,
            refundReason: p.refundReason,
            refundWay: p.refundWay,
            refundTime: p.refundTime,
            merchantNo: p.merchantNo,
            merchantType: p.merchantType,
            dealTitle: p.dealTitle,
            status: p.status,
            type: p.type,
            manual: p.manual,
            remarks: p.remarks,
            rawPayload: p.rawPayload as object,
          })),
        })
      }
    })
  }
}

async function upsertRefundsPage(refunds: DomainRefundOrder[], correlationId: string): Promise<void> {
  for (const r of refunds) {
    await prisma.mtRefundOrder.upsert({
      where: { mtRefundId: r.mtRefundId },
      create: {
        mtRefundId: r.mtRefundId,
        mtOrderId: r.mtOrderId,
        orgId: r.orgId,
        poiId: r.poiId,
        status: r.status,
        statusName: r.statusName,
        refundAmount: r.refundAmount,
        refundTime: r.refundTime,
        businessTime: r.businessTime,
        callLogId: correlationId,
        rawPayload: r.rawPayload as object,
      },
      update: {
        status: r.status,
        statusName: r.statusName,
        refundAmount: r.refundAmount,
        refundTime: r.refundTime,
        rawPayload: r.rawPayload as object,
      },
    })

    // 标关联 MtOrder 为待重处理（兜底 processor 重算）
    await prisma.mtOrder.updateMany({
      where: { mtOrderId: r.mtOrderId },
      data: { processed: false, processError: null },
    })
  }
}
