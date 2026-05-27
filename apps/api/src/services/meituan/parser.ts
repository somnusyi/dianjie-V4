import type {
  MeituanResponse, MtRawOrder, MtRawOrderBase, MtRawItem, MtRawPayment,
  MtRawRefundOrder, InstoreOrderListData, ReverseOrderListData,
} from './types'

// ════════════════════════════════════════════════════════════════
// 解析后的"域模型"（落 DB 用，扁平 + 类型严格）
// ════════════════════════════════════════════════════════════════

export type Channel = 'INSTORE' | 'WAIMAI_MT' | 'WAIMAI_ELE' | 'SELF' | 'UNKNOWN'

export interface DomainOrder {
  mtOrderId: string
  orderNo: string
  vendorOrderId?: string
  orgId: number
  poiId: number
  channel: Channel
  businessTime: Date
  orderTime?: Date
  checkoutTime?: Date
  refundTime?: Date
  cancelTime?: Date
  syncTime?: Date
  status: number
  statusName?: string
  refundStatus?: number
  makeStatus?: number
  isPartRefund: boolean
  payed: number
  receivable: number
  amount: number
  discount: number
  income: number
  serviceFee: number
  taxAmt: number
  taxExcludedAmt?: number
  keepAmount: number
  oddment: number
  source?: number
  sourceName?: string
  businessType?: number
  businessTypeName?: string
  typeName?: string
  customerCount: number
  cashier?: number
  cashierName?: string
  cashierNo?: string
  tableId?: number
  tableComment?: string
  unionType: number
  parentOrderNo?: string
  rawPayload: MtRawOrder
  items: DomainItem[]
  payments: DomainPayment[]
}

export interface DomainItem {
  mtSkuId: string
  mtSkuNo?: string
  mtSpuId?: string
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
  income: number
  discountAmount: number
  isCombo: number
  comboAddPrice?: number
  parentItemNo?: string
  itemNo?: string
  serialNo?: number
  cateId?: number
  departmentOrgId?: number
  departmentOrgName?: string
  present: boolean
  promotion: boolean
  retreat: boolean
  status?: number
  attrs?: string
  newAttrs?: unknown
  taxRate?: string
  taxAmt?: number
  taxExcludedAmt?: number
  comment?: string
  rawPayload: MtRawItem
}

export interface DomainPayment {
  payType: number
  payTypeName: string
  payDetailType?: number
  payed: number
  discountAmount: number
  income: number
  debtAccount: number
  tradeNo?: string
  payNo?: string
  relatedPayNo?: string
  refundTradeNo?: string
  refundReason?: string
  refundWay?: number
  refundTime?: Date
  merchantNo?: string
  merchantType?: number
  dealTitle?: string
  status?: number
  type?: number
  manual?: number
  remarks?: string
  rawPayload: MtRawPayment
}

export interface DomainRefundOrder {
  mtRefundId: string
  mtOrderId: string
  orgId: number
  poiId: number
  status: number
  statusName?: string
  refundAmount: number
  refundTime?: Date
  businessTime?: Date
  rawPayload: MtRawRefundOrder
}

// ════════════════════════════════════════════════════════════════
// 工具
// ════════════════════════════════════════════════════════════════
const toStr = (v: number | string | undefined | null): string => v == null ? '' : String(v)
const toMsDate = (v: number | undefined | null): Date | undefined =>
  v && v > 0 ? new Date(v) : undefined
const toDateOnly = (v: string | undefined | null): Date => {
  if (!v) return new Date(NaN)
  // "yyyy-MM-dd" 当作 UTC 0 点处理, 防时区漂移
  return new Date(`${v}T00:00:00.000Z`)
}

export function resolveChannel(orderBase: MtRawOrderBase, payList?: MtRawPayment[]): Channel {
  if (orderBase.typeName === '堂食') return 'INSTORE'
  if (orderBase.typeName === '外卖') {
    const names = (payList || []).map(p => p.payTypeName)
    if (names.some(n => n.includes('美团外卖'))) return 'WAIMAI_MT'
    if (names.some(n => n.includes('饿了么'))) return 'WAIMAI_ELE'
    if (names.some(n => n.includes('自营'))) return 'SELF'
    return 'UNKNOWN'
  }
  return 'UNKNOWN'
}

// ════════════════════════════════════════════════════════════════
// 主解析器
// ════════════════════════════════════════════════════════════════
export interface ParsedOrderList {
  orders: DomainOrder[]
  total: number
  pageNo: number
  pageSize: number
  totalPageCount: number
}

export function parseOrderListResponse(resp: MeituanResponse<InstoreOrderListData>): ParsedOrderList {
  const data = resp.data
  if (!data) return { orders: [], total: 0, pageNo: 1, pageSize: 0, totalPageCount: 0 }
  return {
    orders: (data.orderList || []).map(parseOneOrder),
    total: data.total ?? 0,
    pageNo: data.pageNo ?? 1,
    pageSize: data.pageSize ?? 0,
    totalPageCount: data.totalPageCount ?? 0,
  }
}

function parseOneOrder(raw: MtRawOrder): DomainOrder {
  const b = raw.orderBase
  return {
    mtOrderId: toStr(b.id),
    orderNo: b.orderNo,
    vendorOrderId: b.vendorOrderId,
    orgId: b.orgId ?? 0,
    poiId: b.poiId ?? 0,
    channel: resolveChannel(b, raw.payList),
    businessTime: toDateOnly(b.businessTime),
    orderTime: toMsDate(b.orderTime),
    checkoutTime: toMsDate(b.checkoutTime),
    refundTime: toMsDate(b.refundTime),
    cancelTime: toMsDate(b.cancelTime),
    syncTime: toMsDate(b.syncTime),
    status: b.status,
    statusName: b.statusName,
    refundStatus: b.refundStatus,
    makeStatus: b.makeStatus,
    isPartRefund: b.isPartRefund ?? false,
    payed: b.payed ?? 0,
    receivable: b.receivable ?? 0,
    amount: b.amount ?? 0,
    discount: b.discount ?? 0,
    income: b.income ?? 0,
    serviceFee: b.serviceFee ?? 0,
    taxAmt: b.taxAmt ?? 0,
    taxExcludedAmt: b.taxExcludedAmt,
    keepAmount: b.keepAmount ?? 0,
    oddment: b.oddment ?? 0,
    source: b.source,
    sourceName: b.sourceName,
    businessType: b.businessType,
    businessTypeName: b.businessTypeName,
    typeName: b.typeName,
    customerCount: b.customerCount ?? 0,
    cashier: b.cashier,
    cashierName: b.cashierName,
    cashierNo: b.cashierNo,
    tableId: b.tableId,
    tableComment: b.tableComment,
    unionType: b.unionType ?? 0,
    parentOrderNo: b.parentOrderNo,
    rawPayload: raw,
    items: (raw.itemList || []).map(parseOneItem),
    payments: (raw.payList || []).map(parseOnePayment),
  }
}

function parseOneItem(raw: MtRawItem): DomainItem {
  return {
    mtSkuId: toStr(raw.skuId),
    mtSkuNo: raw.skuNo,
    mtSpuId: raw.spuId != null ? toStr(raw.spuId) : undefined,
    thirdSkuId: raw.thirdSkuId,
    name: raw.name,
    specs: raw.specs,
    spuName: raw.spuName,
    count: raw.count,
    price: raw.price,
    totalPrice: raw.totalPrice,
    actualPrice: raw.actualPrice,
    apportionPrice: raw.apportionPrice,
    newTotalPrice: raw.newTotalPrice,
    income: raw.income ?? 0,
    discountAmount: raw.discountAmount ?? 0,
    isCombo: raw.isCombo ?? 0,
    comboAddPrice: raw.comboAddPrice,
    parentItemNo: raw.parentItemNo,
    itemNo: raw.itemNo,
    serialNo: raw.serialNo,
    cateId: raw.cateId,
    departmentOrgId: raw.departmentOrgId,
    departmentOrgName: raw.departmentOrgName,
    present: raw.present ?? false,
    promotion: raw.promotion ?? false,
    retreat: raw.retreat ?? false,
    status: raw.status,
    attrs: raw.attrs,
    newAttrs: raw.newAttrs,
    taxRate: raw.taxRate,
    taxAmt: raw.taxAmt,
    taxExcludedAmt: raw.taxExcludedAmt,
    comment: raw.comment,
    rawPayload: raw,
  }
}

function parseOnePayment(raw: MtRawPayment): DomainPayment {
  return {
    payType: raw.payType,
    payTypeName: raw.payTypeName,
    payDetailType: raw.payDetailType,
    payed: raw.payed,
    discountAmount: raw.discountAmount ?? 0,
    income: raw.income ?? 0,
    debtAccount: raw.debtAccount ?? 0,
    tradeNo: raw.tradeNo,
    payNo: raw.payNo,
    relatedPayNo: raw.relatedPayNo,
    refundTradeNo: raw.refundTradeNo,
    refundReason: raw.refundReason,
    refundWay: raw.refundWay,
    refundTime: toMsDate(raw.refundTime),
    merchantNo: raw.merchantNo,
    merchantType: raw.merchantType,
    dealTitle: raw.dealTitle,
    status: raw.status,
    type: raw.type,
    manual: raw.manual,
    remarks: raw.remarks,
    rawPayload: raw,
  }
}

// ════════════════════════════════════════════════════════════════
// 退单解析
// ════════════════════════════════════════════════════════════════
export interface ParsedRefundOrderList {
  refunds: DomainRefundOrder[]
  total: number
  pageNo: number
  pageSize: number
  totalPageCount: number
}

export function parseRefundOrderListResponse(resp: MeituanResponse<ReverseOrderListData>): ParsedRefundOrderList {
  const data = resp.data
  if (!data) return { refunds: [], total: 0, pageNo: 1, pageSize: 0, totalPageCount: 0 }
  return {
    refunds: (data.refundOrderList || []).map(parseOneRefund),
    total: data.total ?? 0,
    pageNo: data.pageNo ?? 1,
    pageSize: data.pageSize ?? 0,
    totalPageCount: data.totalPageCount ?? 0,
  }
}

function parseOneRefund(raw: MtRawRefundOrder): DomainRefundOrder {
  return {
    mtRefundId: toStr(raw.refundId),
    mtOrderId: toStr(raw.orderId),
    orgId: raw.orgId ?? 0,
    poiId: raw.poiId ?? 0,
    status: raw.status,
    statusName: raw.statusName,
    refundAmount: raw.refundAmount,
    refundTime: toMsDate(raw.refundTime),
    businessTime: raw.businessTime ? toDateOnly(raw.businessTime) : undefined,
    rawPayload: raw,
  }
}
