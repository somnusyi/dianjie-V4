import { z } from 'zod'

// ════════════════════════════════════════════════════════════════
// 美团 API 公共响应包装
// ════════════════════════════════════════════════════════════════
export const MeituanResponseSchema = z.object({
  code: z.string(),
  msg: z.string().optional(),
  traceId: z.union([z.string(), z.number()]).optional(),
  data: z.any().optional(),
})
export type MeituanResponse<T = unknown> = {
  code: string
  msg?: string
  traceId?: string | number
  data?: T
}

// ════════════════════════════════════════════════════════════════
// instore/query 请求 (req 子对象)
// ════════════════════════════════════════════════════════════════
export const InstoreQueryReqSchema = z.object({
  queryTimeType: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  beginTime: z.number(),       // 毫秒
  endTime: z.number(),         // 毫秒
  pageNo: z.number().int().min(1),
  pageSize: z.number().int().min(1).max(50).optional(),
  statusList: z.array(z.number().int()).optional(),
  sortField: z.union([z.literal(1), z.literal(2)]).optional(),
  sort: z.union([z.literal(1), z.literal(2)]).optional(),
})
export type InstoreQueryReq = z.infer<typeof InstoreQueryReqSchema>

// ════════════════════════════════════════════════════════════════
// reverse/orders/search 请求 (req 子对象)
// ════════════════════════════════════════════════════════════════
export const ReverseQueryReqSchema = z.object({
  queryTimeType: z.literal(1),  // 退单接口只支持 1
  beginTime: z.number(),
  endTime: z.number(),
  pageNo: z.number().int().min(1),
  pageSize: z.number().int().min(1).max(50).optional(),
  statusList: z.array(z.number().int()).optional(),
  sortField: z.union([z.literal(1), z.literal(2)]).optional(),
  sort: z.union([z.literal(1), z.literal(2)]).optional(),
  refundIdList: z.array(z.number()).optional(),
})
export type ReverseQueryReq = z.infer<typeof ReverseQueryReqSchema>

// ════════════════════════════════════════════════════════════════
// 美团返回的订单结构（只列我们 parser 真用到的字段, 完整保留 rawPayload）
// ════════════════════════════════════════════════════════════════
export interface MtRawOrderBase {
  id: number | string
  orderNo: string
  type?: number
  status: number
  statusName?: string
  payed?: number
  receivable?: number
  amount?: number
  discount?: number
  income?: number
  serviceFee?: number
  taxAmt?: number
  taxExcludedAmt?: number
  keepAmount?: number
  oddment?: number
  orderTime?: number
  checkoutTime?: number
  refundTime?: number
  cancelTime?: number
  syncTime?: number
  businessTime?: string                    // "yyyy-MM-dd"
  businessType?: number
  businessTypeName?: string
  typeName?: string
  customerCount?: number
  cashier?: number
  cashierName?: string
  cashierNo?: string
  tableId?: number
  tableComment?: string
  source?: number
  sourceName?: string
  unionType?: number
  parentOrderNo?: string
  isPartRefund?: boolean
  refundStatus?: number
  makeStatus?: number
  poiId?: number
  orgId?: number
  vendorOrderId?: string
}

export interface MtRawItem {
  orderId: number | string
  skuId: number | string
  skuNo?: string
  spuId?: number | string
  thirdSkuId?: string
  name: string
  specs?: string
  spuName?: string
  count: number
  price: number
  totalPrice: number
  actualPrice: number
  apportionPrice?: number
  newTotalPrice?: number
  income?: number
  discountAmount?: number
  isCombo?: number
  comboAddPrice?: number
  parentItemNo?: string
  itemNo?: string
  serialNo?: number
  cateId?: number
  departmentOrgId?: number
  departmentOrgName?: string
  present?: boolean
  promotion?: boolean
  retreat?: boolean
  status?: number
  attrs?: string
  newAttrs?: unknown
  taxRate?: string
  taxAmt?: number
  taxExcludedAmt?: number
  comment?: string
}

export interface MtRawPayment {
  orderId: number | string
  payType: number
  payTypeName: string
  payDetailType?: number
  payed: number
  discountAmount?: number
  income?: number
  debtAccount?: number
  tradeNo?: string
  payNo?: string
  relatedPayNo?: string
  refundTradeNo?: string
  refundReason?: string
  refundWay?: number
  refundTime?: number
  merchantNo?: string
  merchantType?: number
  dealTitle?: string
  status?: number
  type?: number
  manual?: number
  remarks?: string
}

export interface MtRawOrder {
  orderBase: MtRawOrderBase
  itemList?: MtRawItem[]
  payList?: MtRawPayment[]
  discountList?: unknown[]
  serviceFees?: unknown[]
  wm?: Record<string, unknown>
}

export interface InstoreOrderListData {
  orderList: MtRawOrder[]
  total: number
  pageNo: number
  pageSize: number
  totalPageCount: number
}

export interface MtRawRefundOrder {
  refundId: number | string
  orderId: number | string
  status: number
  statusName?: string
  refundAmount: number
  refundTime?: number
  businessTime?: string
  orgId?: number
  poiId?: number
  [k: string]: unknown
}

export interface ReverseOrderListData {
  refundOrderList: MtRawRefundOrder[]
  total: number
  pageNo: number
  pageSize: number
  totalPageCount: number
}

// ════════════════════════════════════════════════════════════════
// 公共参数（除 sign）
// ════════════════════════════════════════════════════════════════
export interface PublicParams {
  developerId: string
  businessId: string                       // "18"
  charset: string                          // "utf-8"
  version: string                          // "2"
  timestamp: string                        // 秒
  appAuthToken?: string
  biz: string                              // JSON string
}

// 错误码 retry 策略
export type RetryStrategy = false | 'once' | 'backoff' | 'inspectData'

export interface MeituanErrorMeta {
  severity: 'P0' | 'P1' | 'P2' | 'info'
  retry: RetryStrategy
  cat: 'biz' | 'auth' | 'param' | 'rate' | 'transport' | 'config' | 'unknown'
  desc: string
}
