/**
 * 供应商 · 送货单 (打印 / 导出 PDF)
 *
 * A4 纵向, 自动适配打印, 浏览器自带"另存为 PDF"即可导出.
 * 路由: /v2/supplier/orders/[id]/delivery-note
 *
 * 内容: 抬头(供应商) + 收货方(门店地址) + 订单元数据 + 商品明细表 + 合计大写 + 签字栏
 */
'use client'
import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { apiFetch, getUser } from '@/lib/v2-auth'
import dayjs from 'dayjs'
import {
  applySingleOrderPreview,
  parseSingleOrderPreviewPayload,
  singleOrderServerSignature,
  SINGLE_DELIVERY_NOTE_PREVIEW_INDEX_PREFIX,
  SINGLE_DELIVERY_NOTE_PREVIEW_PREFIX,
  type SingleDeliveryNotePreviewPayload,
} from '@/lib/single-delivery-note-preview'
import { parseOperationGroupDeliveryNoteProjection } from '@/lib/operation-group-delivery-note-preview'

type Order = {
  id: string; no: string; status: string
  rowVersion?: number
  purchaseOrderNo?: string
  purchaseOrderTotalAmount?: string
  totalAmount: string
  costAmount?: string | null
  expectedDate: string; createdAt: string
  shippedAt: string | null
  shippedNote: string | null
  note: string | null
  store: { id: string; name: string; no: string; address?: string | null
           managerName?: string | null; phone?: string | null }
  consignee?: { name?: string | null; phone?: string | null }  // 收货人 = 门店指定(厨师长), 后端已回退店长
  supplier: { id: string; name: string; contactName?: string | null; contactPhone?: string | null }
  createdBy: { id: string; name: string }
  shippedBy: { id: string; name: string } | null
  items: { id: string; quantity: string; shippedQty: string | null; unitPrice: string; amount: string; costAmount?: string | null
           product?: { name: string; spec: string | null; unit: string; code: string } }[]
  deliveries?: { id: string; no: string; status: string; rowVersion?: number; actualTotalAmount: string; costAmount?: string | null; note?: string | null; createdAt?: string | null; shippedAt?: string | null; deliveredAt?: string | null
    items: { id: string; orderedQtySnapshot: string; shippedQty: string; unitPriceSnapshot: string; amount: string; costAmount?: string | null
      product?: { name: string; spec: string | null; unit: string; code: string } }[]
    receipt?: { id: string } | null
  }[]
}

/**
 * 集合送货单接口只增加了集合元数据和聚合商品；单笔送货单仍走上面的
 * 原始 Order 结构。这里把接口字段保持得稍微宽松一点，兼容金额/数量
 * 由 API 以 number 或 decimal string 返回的两种情况。
 */
type OperationGroupMember = {
  id: string
  no: string
  rowVersion: number
  deliveryNo?: string | null
  deliveryNos?: string[]
  createdAt: string
  submittedAt?: string | null
  expectedDate?: string | null
  status?: string | null
  store?: Partial<Order['store']> | null
  supplier?: Partial<Order['supplier']> | null
  createdBy?: Partial<Order['createdBy']> | null
  consignee?: Order['consignee'] | null
  shippedAt?: string | null
  shippedBy?: Order['shippedBy']
  note?: string | null
  shippedNote?: string | null
  deliverySummaries?: Array<{
    id: string
    rowVersion: number
    status?: string | null
    hasReceipt?: boolean
  }>
  shipmentDraft?: {
    id: string
    rowVersion: number
    status: 'DRAFT'
  } | null
}

type OperationGroupItem = {
  id?: string
  productId?: string | null
  name?: string | null
  spec?: string | null
  unit?: string | null
  quantity?: number | string | null
  shippedQty?: number | string | null
  unitPrice?: number | string | null
  amount?: number | string | null
  costAmount?: number | string | null
  product?: { id?: string; name?: string | null; spec?: string | null; unit?: string | null; code?: string | null } | null
}

type OperationGroupResponse = {
  group: {
    id: string
    storeId: string
    supplierId: string
    expectedDate: string
    memberOrderIds: string[]
    memberOrderNos: string[]
    memberCount: number
  }
  source?: 'pending' | 'accepted'
  orders: OperationGroupMember[]
  mergedItems: OperationGroupItem[]
  totals?: { quantity?: number | string | null; amount?: number | string | null; costAmount?: number | string | null }
}

type OperationGroupPreviewPayload = {
  schemaVersion: 2
  groupId: string
  ownerUserId: string
  tenantKey: string
  createdAt: number
  expiresAt: number
  serverSignature: string
  draftRows: unknown[]
  items: OperationGroupItem[]
  totals: { quantity: number; amount: number }
}

const GROUP_DELIVERY_NOTE_PREVIEW_PREFIX = 'dianjie:operation-group-print-preview:'
const GROUP_DELIVERY_NOTE_PREVIEW_INDEX_PREFIX = 'dianjie:operation-group-print-preview-latest:'
const GROUP_DELIVERY_NOTE_PREVIEW_TTL_MS = 30 * 60 * 1000

type OperationGroupPreview = Pick<OperationGroupPreviewPayload, 'items' | 'totals' | 'serverSignature'> & {
  storageKey: string
  token: string
}

type SingleOrderPreview = Pick<SingleDeliveryNotePreviewPayload, 'items' | 'totalAmount' | 'serverSignature'> & {
  storageKey: string
  token: string
}

type ShipmentDraftSignature = { id: string; rowVersion: number }

function tenantKeyFromLocalStorage() {
  if (typeof window === 'undefined') return ''
  try {
    const tenant = JSON.parse(window.localStorage.getItem('tenant') || '{}')
    return String(tenant?.id || tenant?.slug || '')
  } catch {
    return ''
  }
}

function deliveryNotePreviewRequested() {
  if (typeof window === 'undefined') return false
  return Boolean(new URLSearchParams(window.location.search).get('preview'))
}

function singleOrderPreviewToken() {
  if (typeof window === 'undefined') return ''
  const token = new URLSearchParams(window.location.search).get('preview') || ''
  return /^[0-9a-f-]{36}$/i.test(token) ? token : ''
}

function removeSingleOrderPreview(orderId: string, token: string, storageKey: string) {
  if (typeof window === 'undefined') return
  window.sessionStorage.removeItem(storageKey)
  const latestKey = `${SINGLE_DELIVERY_NOTE_PREVIEW_INDEX_PREFIX}${orderId}`
  if (window.sessionStorage.getItem(latestKey) === token) window.sessionStorage.removeItem(latestKey)
}

function readSingleOrderPreview(orderId: string): SingleOrderPreview | null {
  if (typeof window === 'undefined') return null
  const token = singleOrderPreviewToken()
  if (!token) return null
  const storageKey = `${SINGLE_DELIVERY_NOTE_PREVIEW_PREFIX}${orderId}:${token}`
  const discard = () => removeSingleOrderPreview(orderId, token, storageKey)
  try {
    const raw = window.sessionStorage.getItem(storageKey)
    if (!raw) {
      discard()
      return null
    }
    const ownerUserId = String(getUser()?.id || '')
    const tenantKey = tenantKeyFromLocalStorage()
    const payload = parseSingleOrderPreviewPayload({ raw, orderId, ownerUserId, tenantKey })
    if (!payload) {
      discard()
      return null
    }
    return {
      items: payload.items,
      totalAmount: payload.totalAmount,
      serverSignature: payload.serverSignature,
      storageKey,
      token,
    }
  } catch {
    discard()
    return null
  }
}

function verifySingleOrderPreview(data: Order, orderId: string): SingleOrderPreview | null {
  const preview = readSingleOrderPreview(orderId)
  if (!preview) return null
  if (singleOrderServerSignature(data) !== preview.serverSignature) {
    removeSingleOrderPreview(orderId, preview.token, preview.storageKey)
    return null
  }
  return preview
}

function operationGroupPreviewToken() {
  if (typeof window === 'undefined') return ''
  const token = new URLSearchParams(window.location.search).get('preview') || ''
  return /^[0-9a-f-]{36}$/i.test(token) ? token : ''
}

function removeOperationGroupPreview(groupId: string, token: string, storageKey: string) {
  if (typeof window === 'undefined') return
  window.sessionStorage.removeItem(storageKey)
  const latestKey = `${GROUP_DELIVERY_NOTE_PREVIEW_INDEX_PREFIX}${groupId}`
  if (window.sessionStorage.getItem(latestKey) === token) window.sessionStorage.removeItem(latestKey)
}

/**
 * The group detail page can contain valid edits that have not been saved yet.
 * Its delivery-note link stores the current display rows in this tab's
 * sessionStorage and puts an unguessable short token in the URL. A preview is
 * overlaid only while its owner, tenant, lifetime and complete server version
 * signature still match; otherwise the document stays entirely server-backed.
 */
function readOperationGroupPreview(groupId: string): OperationGroupPreview | null {
  if (typeof window === 'undefined') return null
  const token = operationGroupPreviewToken()
  if (!token) return null
  const storageKey = `${GROUP_DELIVERY_NOTE_PREVIEW_PREFIX}${groupId}:${token}`
  const discard = () => removeOperationGroupPreview(groupId, token, storageKey)
  try {
    const raw = window.sessionStorage.getItem(storageKey)
    if (!raw) {
      discard()
      return null
    }
    const payload = JSON.parse(raw) as Partial<OperationGroupPreviewPayload>
    const ownerUserId = String(getUser()?.id || '')
    const tenantKey = tenantKeyFromLocalStorage()
    const createdAt = Number(payload.createdAt)
    const expiresAt = Number(payload.expiresAt)
    const now = Date.now()
    if (payload.schemaVersion !== 2 || payload.groupId !== groupId
      || !ownerUserId || payload.ownerUserId !== ownerUserId
      || !tenantKey || payload.tenantKey !== tenantKey
      || !Number.isFinite(createdAt) || !Number.isFinite(expiresAt)
      || createdAt <= 0 || createdAt > now || expiresAt <= now
      || expiresAt - createdAt !== GROUP_DELIVERY_NOTE_PREVIEW_TTL_MS
      || typeof payload.serverSignature !== 'string' || !payload.serverSignature
      || !Array.isArray(payload.draftRows) || !Array.isArray(payload.items)) {
      discard()
      return null
    }
    const projection = parseOperationGroupDeliveryNoteProjection({
      draftRows: payload.draftRows,
      items: payload.items,
      totals: payload.totals,
    })
    if (!projection) {
      discard()
      return null
    }
    return {
      items: projection.items,
      totals: projection.totals,
      serverSignature: payload.serverSignature,
      storageKey,
      token,
    }
  } catch {
    discard()
    return null
  }
}

function operationGroupServerSignature(
  data: OperationGroupResponse,
  shipmentDrafts: Record<string, ShipmentDraftSignature | null>,
) {
  return JSON.stringify([...data.orders]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(order => {
      const draft = shipmentDrafts[order.id] || null
      const deliverySummaries = [...(order.deliverySummaries || [])]
        .filter(delivery => delivery.status !== 'DRAFT')
        .sort((a, b) => a.id.localeCompare(b.id))
        .map(delivery => [
          delivery.id,
          Number(delivery.rowVersion),
          String(delivery.status || ''),
          Boolean(delivery.hasReceipt),
        ])
      return [
        order.id,
        Number(order.rowVersion),
        String(order.status || ''),
        draft ? [draft.id, Number(draft.rowVersion)] : null,
        deliverySummaries,
      ]
    }))
}

async function verifyOperationGroupPreview(data: OperationGroupResponse, groupId: string) {
  const preview = readOperationGroupPreview(groupId)
  if (!preview) return null
  const shipmentDrafts = Object.fromEntries(data.orders.map(member => [
    member.id,
    member.status === 'CONFIRMED' && member.shipmentDraft
      ? { id: member.shipmentDraft.id, rowVersion: Number(member.shipmentDraft.rowVersion) }
      : null,
  ])) as Record<string, ShipmentDraftSignature | null>
  if (operationGroupServerSignature(data, shipmentDrafts) !== preview.serverSignature) {
    removeOperationGroupPreview(groupId, preview.token, preview.storageKey)
    return null
  }
  return preview
}

function applyOperationGroupPreview(data: OperationGroupResponse, preview: OperationGroupPreview): OperationGroupResponse {
  return {
    ...data,
    mergedItems: preview.items,
    totals: {
      ...(data.totals || {}),
      quantity: preview.totals.quantity,
      amount: preview.totals.amount,
    },
  }
}

type NormalizedOperationGroup = {
  order: Order
  members: Array<Pick<OperationGroupMember, 'id' | 'no' | 'deliveryNo' | 'deliveryNos' | 'createdAt' | 'submittedAt'>>
}

type DeliveryNoteDocument = {
  order: Order
  members: NormalizedOperationGroup['members'] | null
}

function decimalText(value: number | string | null | undefined, fallback = '0') {
  return value == null || value === '' ? fallback : String(value)
}

function deliveryPdfFilename(order: Pick<Order, 'store' | 'expectedDate' | 'createdAt'>) {
  const storeName = (order.store?.name || '门店').replace(/[\\/:*?"<>|]/g, '_').trim() || '门店'
  const date = dayjs(order.expectedDate || order.createdAt).format('YYYYMMDD')
  return `${storeName}-${date}-配送单.pdf`
}

function normalizeSingleOrder(data: Order): Order {
  const currentDeliveries = (data.deliveries || [])
    .filter(delivery => delivery.status !== 'DRAFT' && delivery.status !== 'CANCELLED')
  const latestFormal = currentDeliveries[currentDeliveries.length - 1]
  if (latestFormal) {
    return {
      ...data,
      purchaseOrderNo: data.no,
      purchaseOrderTotalAmount: data.totalAmount,
      no: latestFormal.no,
      totalAmount: latestFormal.actualTotalAmount,
      costAmount: latestFormal.costAmount ?? null,
      shippedAt: latestFormal.shippedAt || data.shippedAt,
      shippedNote: latestFormal.note || null,
      items: latestFormal.items.map(item => ({
        id: item.id,
        quantity: item.orderedQtySnapshot,
        shippedQty: item.shippedQty,
        unitPrice: item.unitPriceSnapshot,
        amount: item.amount,
        costAmount: item.costAmount ?? null,
        product: item.product,
      })),
    }
  }

  // The detail endpoint orders deliveries by createdAt ascending and the
  // editor uses the first DRAFT. A saved CONFIRMED-stage draft is therefore
  // also the direct/open-refresh fallback for the delivery note. Keep the PO
  // number until shipment creates a formal DO number; only the draft's exact
  // rows and actual total replace the original order snapshot.
  const shipmentDraft = data.status === 'CONFIRMED'
    ? (data.deliveries || []).find(delivery => delivery.status === 'DRAFT')
    : null
  if (!shipmentDraft) return data
  return {
    ...data,
    totalAmount: shipmentDraft.actualTotalAmount,
    costAmount: null,
    items: shipmentDraft.items.map(item => ({
      id: item.id,
      quantity: item.orderedQtySnapshot,
      shippedQty: item.shippedQty,
      unitPrice: item.unitPriceSnapshot,
      amount: item.amount,
      costAmount: null,
      product: item.product,
    })),
  }
}

function waitForDocumentPaint() {
  return new Promise<void>(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
}

/** Convert the aggregate endpoint payload into the unchanged print renderer model. */
function normalizeOperationGroup(data: OperationGroupResponse): NormalizedOperationGroup {
  const sourceOrders = (Array.isArray(data.orders) ? data.orders : [])
    .slice()
    .sort((a, b) => Date.parse(a.submittedAt || a.createdAt) - Date.parse(b.submittedAt || b.createdAt) || a.id.localeCompare(b.id))
  const first = sourceOrders[0]
  if (!first) throw new Error('集合没有可打印的原订单')

  const firstStore = first.store || {}
  const firstSupplier = first.supplier || {}
  const firstCreator = first.createdBy || {}
  const mergedItems = (Array.isArray(data.mergedItems) ? data.mergedItems : []).map((item, index) => {
    const product = item.product || {}
    const quantity = Number(item.shippedQty ?? item.quantity ?? 0)
    const unitPrice = Number(item.unitPrice ?? 0)
    const amount = item.amount == null ? (quantity * unitPrice).toFixed(2) : decimalText(item.amount)
    return {
      id: item.id || `${data.group.id}:item:${index}`,
      quantity: decimalText(item.quantity),
      shippedQty: item.shippedQty == null ? null : decimalText(item.shippedQty),
      unitPrice: decimalText(item.unitPrice),
      amount,
      costAmount: item.costAmount == null ? null : decimalText(item.costAmount),
      product: {
        name: item.name ?? product.name ?? '—',
        spec: item.spec ?? product.spec ?? null,
        unit: item.unit ?? product.unit ?? '—',
        code: product.code ?? item.productId ?? '',
      },
    }
  })

  const computedAmount = mergedItems.reduce((sum, item) => sum + Number(item.amount || 0), 0)
  const totalAmount = decimalText(data.totals?.amount, computedAmount.toFixed(2))
  const expectedDate = first.expectedDate || data.group.expectedDate
  const latestShippedAt = sourceOrders
    .map(item => item.shippedAt)
    .filter(Boolean)
    .sort((a, b) => String(b).localeCompare(String(a)))[0] || null

  const store = {
    id: firstStore.id || data.group.storeId,
    name: firstStore.name || '—',
    no: firstStore.no || '',
    address: firstStore.address || null,
    managerName: firstStore.managerName || null,
    phone: firstStore.phone || null,
  }
  const supplier = {
    id: firstSupplier.id || data.group.supplierId,
    name: firstSupplier.name || '—',
    contactName: firstSupplier.contactName || null,
    contactPhone: firstSupplier.contactPhone || null,
  }
  const createdBy = {
    id: firstCreator.id || '',
    name: firstCreator.name || '—',
  }

  return {
    order: {
      // This is a renderer-only sentinel. It is never shown as an order number;
      // the source member numbers are rendered in the metadata rows below.
      id: data.group.id,
      no: '',
      status: first.status || 'CONFIRMED',
      totalAmount,
      costAmount: data.totals?.costAmount == null ? null : decimalText(data.totals.costAmount),
      purchaseOrderTotalAmount: totalAmount,
      expectedDate,
      createdAt: first.createdAt,
      shippedAt: latestShippedAt,
      shippedNote: first.shippedNote || null,
      note: first.note || null,
      store,
      consignee: first.consignee || undefined,
      supplier,
      createdBy,
      shippedBy: first.shippedBy || null,
      items: mergedItems,
    },
    members: sourceOrders.map(item => ({
      id: item.id,
      no: item.no,
      deliveryNo: item.deliveryNo || null,
      deliveryNos: item.deliveryNos || [],
      createdAt: item.createdAt,
      submittedAt: item.submittedAt || null,
    })),
  }
}

// 阿拉伯数字 → 中文大写金额 (财务规范)
function num2cn(n: number): string {
  if (!Number.isFinite(n)) return '零元整'
  if (n === 0) return '零元整'
  const fraction = ['角', '分']
  const digit = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖']
  const unit = [['元', '万', '亿'], ['', '拾', '佰', '仟']]
  const head = n < 0 ? '负' : ''
  n = Math.abs(n)
  let s = ''
  for (let i = 0; i < fraction.length; i++) {
    s += (digit[Math.floor(n * 10 * Math.pow(10, i)) % 10] + fraction[i]).replace(/零./, '')
  }
  s = s || '整'
  let intPart = Math.floor(n).toString()
  for (let i = 0; i < unit[0].length && intPart.length > 0; i++) {
    let p = ''
    for (let j = 0; j < unit[1].length && intPart.length > 0; j++) {
      p = digit[+intPart.slice(-1)] + unit[1][j] + p
      intPart = intPart.slice(0, -1)
    }
    s = p.replace(/(零.)*零$/, '').replace(/^$/, '零') + unit[0][i] + s
  }
  return head + s.replace(/(零.)*零元/, '元').replace(/(零.)+/g, '零').replace(/^整$/, '零元整')
}

export default function DeliveryNotePrintPage() {
  const params = useParams() as any
  const router = useRouter()
  const id = String(params.id || '')
  const isOperationGroup = /^og_[a-f0-9]{24}$/.test(id)
  const canExportInternalCost = getUser()?.role === 'SUPPLY_CHAIN'
  const [order, setOrder] = useState<Order | null>(null)
  const [groupMembers, setGroupMembers] = useState<NormalizedOperationGroup['members'] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [printedAt] = useState(() => new Date())

  const [exporting, setExporting] = useState(false)
  const [exportingXlsx, setExportingXlsx] = useState(false)
  const [pdfUrl, setPdfUrl] = useState<string | null>(null)  // data URI 用于 iframe 预览 (本地)
  const [pdfBlob, setPdfBlob] = useState<Blob | null>(null)  // blob 用于 Share API / 下载
  const [ossUrl, setOssUrl] = useState<string | null>(null)  // 真 https URL (上传到 OSS 后拿到, ArkWeb / 微信都可用)
  const [uploading, setUploading] = useState(false)
  const [copied, setCopied] = useState(false)
  const refreshRequestRef = useRef(0)
  const artifactEpochRef = useRef(0)

  const fetchLatestDocument = useCallback(async (): Promise<DeliveryNoteDocument> => {
    if (isOperationGroup) {
      const data = await apiFetch<OperationGroupResponse>(`/api/orders/operation-groups/${encodeURIComponent(id)}`)
      const preview = await verifyOperationGroupPreview(data, id)
      if (deliveryNotePreviewRequested() && !preview) {
        throw new Error('送货单预览已失效，请返回商品明细重新打开')
      }
      const normalized = normalizeOperationGroup(preview ? applyOperationGroupPreview(data, preview) : data)
      return { order: normalized.order, members: normalized.members }
    }
    const data = await apiFetch<Order>(`/api/orders/${id}`)
    const preview = verifySingleOrderPreview(data, id)
    if (deliveryNotePreviewRequested() && !preview) {
      throw new Error('送货单预览已失效，请返回商品明细重新打开')
    }
    const normalized = normalizeSingleOrder(data)
    return { order: preview ? applySingleOrderPreview(normalized, preview) : normalized, members: null }
  }, [id, isOperationGroup])

  const refreshLatestDocument = useCallback(async (): Promise<DeliveryNoteDocument | null> => {
    const requestId = ++refreshRequestRef.current
    try {
      const latest = await fetchLatestDocument()
      if (requestId !== refreshRequestRef.current) return null
      // Exported files belong to one exact document snapshot. Once a newer
      // snapshot is adopted, old preview/share handles must become unusable.
      artifactEpochRef.current += 1
      setPdfUrl(null)
      setPdfBlob(null)
      setOssUrl(null)
      setUploading(false)
      setCopied(false)
      setGroupMembers(latest.members)
      setOrder(latest.order)
      setError(null)
      return latest
    } catch (e: any) {
      if (requestId === refreshRequestRef.current) setError(e.message || '加载失败')
      throw e
    }
  }, [fetchLatestDocument])

  useEffect(() => {
    setError(null)
    setOrder(null)
    setGroupMembers(null)

    const refreshWhenActive = () => { void refreshLatestDocument().catch(() => undefined) }
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') refreshWhenActive()
    }
    refreshWhenActive()
    window.addEventListener('focus', refreshWhenActive)
    document.addEventListener('visibilitychange', refreshWhenVisible)

    return () => {
      refreshRequestRef.current += 1
      window.removeEventListener('focus', refreshWhenActive)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
    }
  }, [refreshLatestDocument])

  async function refreshBeforeDocumentAction() {
    const latest = await refreshLatestDocument()
    if (!latest) throw new Error('送货单正在刷新，请重试')
    await waitForDocumentPaint()
    return latest
  }

  // 真 PDF 下载 — 用 html2canvas + jspdf, 跨平台 (含 WebView / iOS Capacitor / 鸿蒙 ArkWeb)
  async function exportPDF() {
    if (exporting) return
    setExporting(true)
    try {
      const latestDocument = await refreshBeforeDocumentAction()
      const artifactEpoch = artifactEpochRef.current
      const [{ default: html2canvas }, { default: jsPDF }] = await Promise.all([
        import('html2canvas'), import('jspdf')
      ])
      const el = document.getElementById('print-area')
      if (!el) throw new Error('未找到打印区域')
      // 3x 采样 + PNG，避免文字在导出的 PDF 中发糊或出现 JPEG 压缩块。
      const canvas = await html2canvas(el, { scale: 3, backgroundColor: '#fff', useCORS: true })
      const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' })
      const pageW = 210, pageH = 297, margin = 8
      const imgW = pageW - margin * 2
      const imgH = canvas.height * imgW / canvas.width
      const pageHContent = pageH - margin * 2

      if (imgH <= pageHContent) {
        // 单页 — 直接整张塞 (最常见)
        pdf.addImage(canvas.toDataURL('image/png'), 'PNG', margin, margin, imgW, imgH)
      } else {
        // 多页分割 — 切点必须落在行边界上, 避免把一行切两半 (拣货漏行重灾区)
        // 行位置用屏幕坐标量 (CSS px), 再按比例换算到 PDF mm
        const elRect = el.getBoundingClientRect()
        const cssToMm = imgH / elRect.height
        const rowBoundsMm = Array.from(el.querySelectorAll('tbody tr')).map(tr => {
          const r = tr.getBoundingClientRect()
          return { top: (r.top - elRect.top) * cssToMm, bottom: (r.bottom - elRect.top) * cssToMm }
        }).sort((a, b) => a.top - b.top)
        let y = 0
        while (y < imgH) {
          if (y > 0) pdf.addPage()
          let cut = Math.min(y + pageHContent, imgH)
          if (cut < imgH) {
            // 若有行被 cut 拦腰截断, 把 cut 收到该行的上沿
            const cutRow = rowBoundsMm.find(r => r.top > y && r.top < cut && r.bottom > cut)
            if (cutRow && cutRow.top > y + 10) cut = cutRow.top  // 至少留 10mm 内容, 防单行超高死循环
          }
          const remainImgH = cut - y
          const srcY = y / imgH * canvas.height
          const srcH = remainImgH / imgH * canvas.height
          const pageCanvas = document.createElement('canvas')
          pageCanvas.width = canvas.width
          pageCanvas.height = Math.ceil(srcH)
          const ctx = pageCanvas.getContext('2d')!
          ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, pageCanvas.width, pageCanvas.height)
          ctx.drawImage(canvas, 0, srcY, canvas.width, srcH, 0, 0, canvas.width, srcH)
          pdf.addImage(pageCanvas.toDataURL('image/png'), 'PNG', margin, margin, imgW, remainImgH)
          y = cut
        }
        // 页脚: 第 X 页 / 共 Y 页 — 拣货时先对页数, 少一页立刻能发现
        const pageCount = pdf.getNumberOfPages()
        for (let p = 1; p <= pageCount; p++) {
          pdf.setPage(p)
          pdf.setFontSize(9)
          pdf.setTextColor(120)
          pdf.text(`${p} / ${pageCount}`, pageW - margin, pageH - 3, { align: 'right' })
        }
      }
      // 生成 blob → 同时存 blob 和 data URL
      const blob = pdf.output('blob') as Blob
      const dataUrl = pdf.output('datauristring') as string
      if (artifactEpoch !== artifactEpochRef.current) throw new Error('送货单数据已刷新，请重新生成')
      setPdfBlob(blob)
      setPdfUrl(dataUrl)
      setOssUrl(null); setCopied(false)
      // 同时上传到 OSS 获取真 https URL — ArkWeb / 微信内置浏览器都能用
      void uploadToOss(blob, latestDocument.order, artifactEpoch)
    } catch (e: any) {
      alert('导出失败: ' + (e.message || e))
    } finally {
      setExporting(false)
    }
  }
  async function uploadToOss(blob: Blob, sourceOrder: Order, artifactEpoch: number) {
    if (artifactEpoch !== artifactEpochRef.current) return
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append('file', blob, deliveryPdfFilename(sourceOrder))
      const res = await apiFetch<{url: string}>('/api/upload?category=documents', { method: 'POST', body: fd as any })
      if (artifactEpoch === artifactEpochRef.current) setOssUrl(res.url)
    } catch (e: any) {
      // 上传失败不阻塞预览, 用户仍可用 iframe 看
      console.warn('OSS upload failed', e)
    } finally {
      if (artifactEpoch === artifactEpochRef.current) setUploading(false)
    }
  }
  async function copyOssUrl() {
    if (!ossUrl) return
    try {
      await navigator.clipboard.writeText(ossUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // 老 WebView 不支持 clipboard API, fallback 用 textarea
      const ta = document.createElement('textarea')
      ta.value = ossUrl
      document.body.appendChild(ta); ta.select()
      try { document.execCommand('copy'); setCopied(true); setTimeout(() => setCopied(false), 2000) }
      finally { document.body.removeChild(ta) }
    }
  }
  // Web Share API — 微信 / iOS Safari / 安卓 Chrome 都支持. 调起系统分享菜单 (存到文件 / 转发微信...)
  async function shareOrDownload() {
    if (!pdfBlob || !order) return
    const documentLabel = isOperationGroup ? '集合送货单' : order.no
    const filename = deliveryPdfFilename(order)
    const file = new File([pdfBlob], filename, { type: 'application/pdf' })
    // navigator.canShare 检查是否支持文件分享
    const nav = navigator as any
    if (nav.canShare && nav.canShare({ files: [file] })) {
      try {
        await nav.share({ files: [file], title: `送货单 ${documentLabel}`, text: `送货单 ${documentLabel}` })
        return
      } catch (e) { /* 用户取消, 走 fallback */ }
    }
    // Fallback 1: a[download] (PC 浏览器 / 安卓 Chrome 行得通)
    const link = document.createElement('a')
    const url = URL.createObjectURL(pdfBlob)
    link.href = url
    link.download = filename
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    setTimeout(() => URL.revokeObjectURL(url), 5000)
  }
  // 同窗口打开 PDF (走 location.href, 比 window.open 更兼容 WebView)
  function openSameTab() {
    if (pdfUrl) window.location.href = pdfUrl
  }

  // 导出 Excel — 客户(供应商)需要拿结构化数据回 ERP 或自己核算, PDF 是看的, Excel 是用的
  // 跟 PDF 并存, 不互斥
  async function exportExcel() {
    if (exportingXlsx) return
    setExportingXlsx(true)
    try {
      const latestDocument = await refreshBeforeDocumentAction()
      const exportOrder = latestDocument.order
      const exportGroupMembers = latestDocument.members
      const XLSX = await import('xlsx')
      const itemQtyLocal = (i: Order['items'][number]) => i.shippedQty != null ? Number(i.shippedQty) : Number(i.quantity)
      // Persisted and preview rows both carry the authoritative, per-line
      // half-up amount. Never recompute it with binary floating point.
      const itemAmtLocal = (i: Order['items'][number]) => i.amount != null
        ? Number(i.amount)
        : itemQtyLocal(i) * Number(i.unitPrice)
      const documentLabel = isOperationGroup ? '集合送货单' : exportOrder.no
      const totalLocal = exportOrder.items.reduce((s, i) => s + itemAmtLocal(i), 0)
      const totalQtyLocal = exportOrder.items.reduce((s, i) => s + itemQtyLocal(i), 0)
      const costTotalLocal = exportOrder.costAmount == null ? null : Number(exportOrder.costAmount)

      // 构造表格 (aoa = array of arrays)
      const aoa: any[][] = [
        [`送货单 · ${documentLabel}`, '', '', '', '', '', '', ''],
        [],
        ['供应商', exportOrder.supplier.name, '', '', '收货方', exportOrder.store.name, '', ''],
        ['供应方联系人', `${exportOrder.supplier.contactName || '—'}${exportOrder.supplier.contactPhone ? ' · ' + exportOrder.supplier.contactPhone : ''}`, '', '', '收货人', `${(exportOrder.consignee?.name ?? exportOrder.store.managerName) || '—'}${(exportOrder.consignee?.phone ?? exportOrder.store.phone) ? ' · ' + (exportOrder.consignee?.phone ?? exportOrder.store.phone) : ''}`, '', ''],
        ['收货地址', exportOrder.store.address || '—', '', '', '', '', '', ''],
        ...(isOperationGroup && exportGroupMembers && exportGroupMembers.length > 0
          ? exportGroupMembers.map(member => [
            '送货单号', member.deliveryNos?.length ? member.deliveryNos.join('、') : member.deliveryNo || member.no, '', '', '下单日期', dayjs(member.createdAt).format('YYYY-MM-DD HH:mm'), '', '',
          ])
          : [['下单时间', dayjs(exportOrder.createdAt).format('YYYY-MM-DD HH:mm'), '', '', '下单人', exportOrder.createdBy?.name || '—', '', '']]),
        ['期望到货', dayjs(exportOrder.expectedDate).format('YYYY-MM-DD'), '', '', '发货时间', exportOrder.shippedAt ? dayjs(exportOrder.shippedAt).format('YYYY-MM-DD HH:mm') : '—', '', ''],
        exportOrder.note ? ['订单备注', exportOrder.note, '', '', '', '', '', ''] : null,
        exportOrder.shippedNote ? ['发货备注', exportOrder.shippedNote, '', '', '', '', '', ''] : null,
        [],
        ['#', '品名', '规格', '单位', '数量', '单价(¥)', '发货金额(¥)', '成本金额(¥)'],
        ...exportOrder.items.map((it, i) => [
          i + 1,
          it.product?.name || '—',
          it.product?.spec || '—',
          it.product?.unit || '—',
          itemQtyLocal(it),
          Number(it.unitPrice),
          Number(itemAmtLocal(it).toFixed(2)),
          canExportInternalCost && it.costAmount != null ? Number(Number(it.costAmount).toFixed(2)) : '—',
        ]),
        ['合计', '', '', '', totalQtyLocal, '', Number(totalLocal.toFixed(2)), canExportInternalCost && costTotalLocal != null ? Number(costTotalLocal.toFixed(2)) : '—'],
        ['大写', `人民币 ${num2cn(totalLocal)}`, '', '', '', '', '', ''],
      ].filter(Boolean) as any[][]

      const ws = XLSX.utils.aoa_to_sheet(aoa)
      // 列宽
      ws['!cols'] = [
        { wch: 6 }, { wch: 30 }, { wch: 22 }, { wch: 8 },
        { wch: 12 }, { wch: 14 }, { wch: 16 }, { wch: 16 },
      ]
      // 合并标题行
      ws['!merges'] = ws['!merges'] || []
      ws['!merges'].push({ s: { r: 0, c: 0 }, e: { r: 0, c: 7 } })   // 标题横跨 8 列
      // 大写行第二列 → 第八列合并
      const lastRowIdx = aoa.length - 1
      ws['!merges'].push({ s: { r: lastRowIdx, c: 1 }, e: { r: lastRowIdx, c: 7 } })
      // 备注行 (如果有) 合并第二列横到末
      let noteRowIdx = 7   // 7=订单备注潜在位置 (前面是 7 行 + 1 空行)
      // 安全地按内容查找备注行
      aoa.forEach((row, i) => {
        if (row[0] === '订单备注' || row[0] === '发货备注' || row[0] === '收货地址') {
          ws['!merges']!.push({ s: { r: i, c: 1 }, e: { r: i, c: 7 } })
        }
      })

      // 货币列数字格式
      const headerRow = aoa.findIndex(r => r[0] === '#')
      if (headerRow >= 0) {
        for (let r = headerRow + 1; r < aoa.length - 1; r++) {
          ;['F', 'G', 'H'].forEach(col => {
            const cellRef = `${col}${r + 1}`
            if (ws[cellRef]) ws[cellRef].z = '¥#,##0.00'
          })
        }
        const totalRowIndex = aoa.findIndex(row => row[0] === '合计')
        for (const col of ['G', 'H']) {
          const cell = totalRowIndex >= 0 ? ws[`${col}${totalRowIndex + 1}`] : null
          if (cell && typeof cell.v === 'number') cell.z = '¥#,##0.00'
        }
      }

      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, '送货单')

      // 走 Blob 路线, 跨平台兼容 (Web Share API + a[download] 兜底)
      const arrayBuffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
      const blob = new Blob([arrayBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
      const filename = `送货单-${documentLabel}.xlsx`
      const file = new File([blob], filename, { type: blob.type })
      const nav = navigator as any

      // 移动端 / iOS / 安卓 Chrome — Web Share API
      if (nav.canShare && nav.canShare({ files: [file] })) {
        try {
          await nav.share({ files: [file], title: `送货单 ${documentLabel}`, text: `送货单 Excel ${documentLabel}` })
          return
        } catch (e) { /* 用户取消, 走 fallback */ }
      }
      // PC / 其他 — <a download> 直接下载
      const link = document.createElement('a')
      const url = URL.createObjectURL(blob)
      link.href = url
      link.download = filename
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      setTimeout(() => URL.revokeObjectURL(url), 5000)
    } catch (e: any) {
      alert('导出 Excel 失败: ' + (e?.message || e))
    } finally {
      setExportingXlsx(false)
    }
  }
  // 系统浏览器打印 (PC) — 在 WebView 里多半无效, 已不推荐
  async function tryPrint() {
    try {
      await refreshBeforeDocumentAction()
      if (typeof window.print === 'function') window.print()
      else alert('当前环境不支持系统打印, 请用「下载 PDF」按钮')
    } catch (e: any) {
      alert('打印前刷新失败: ' + (e?.message || e))
    }
  }

  if (error) return <div className="p-8 text-center text-red-fg">{error}</div>
  if (!order) return <div className="p-8 text-center text-gray2">加载中…</div>

  const documentLabel = isOperationGroup ? '集合送货单' : order.no
  // 送货单按实际发货量 (shippedQty) 显示, 没填则按 quantity. 合同金额已在 ship 时重算.
  const itemQty = (i: Order['items'][number]) => i.shippedQty != null ? Number(i.shippedQty) : Number(i.quantity)
  const itemAmt = (i: Order['items'][number]) => i.amount != null
    ? Number(i.amount)
    : itemQty(i) * Number(i.unitPrice)
  const total = order.items.reduce((s, i) => s + itemAmt(i), 0)
  const itemsCount = order.items.length
  const totalQty = order.items.reduce((s, i) => s + itemQty(i), 0)

  // 打印手工分页：首页要给抬头/元数据留空间所以行数少，续页多。
  // 用多个 tbody + break-before 强制分页——不让浏览器自己在表格中间找断点（会截断/丢行导致漏货）
  const PRINT_FIRST_PAGE_ROWS = 14
  const PRINT_PAGE_ROWS = 20
  const printChunks: Order['items'][] = []
  order.items.forEach((item, idx) => {
    const chunkIdx = idx < PRINT_FIRST_PAGE_ROWS ? 0 : 1 + Math.floor((idx - PRINT_FIRST_PAGE_ROWS) / PRINT_PAGE_ROWS)
    ;(printChunks[chunkIdx] = printChunks[chunkIdx] || []).push(item)
  })

  return (
    <>
      {/* 打印样式 — 纸张 + 隐藏顶栏 */}
      <style jsx global>{`
        @page { size: A4; margin: ${isOperationGroup ? '12mm 12mm 6mm 12mm' : '12mm'}; }
        @media print {
          body { background: white !important; }
          .no-print { display: none !important; }
          /* 宽度自适应打印区 — 210mm固定宽+24mm页边距会超出纸面，Chromium 溢出截断会在分页处丢行 */
          .print-page { box-shadow: none !important; margin: 0 !important; width: auto !important; min-height: 0 !important; padding: 0 !important; }
          /* 行不可跨页截断 — 防止拣货单在分页处把一行切两半导致漏货 */
          tr { page-break-inside: avoid !important; break-inside: avoid !important; }
          thead { display: table-header-group !important; }
        }
      `}</style>

      {/* 操作栏 — 屏幕显示, 打印隐藏 */}
      <div className="no-print sticky top-0 bg-bg-warm border-b border-border px-4 py-3 flex items-center gap-2 z-10">
        <button onClick={() => router.back()} className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center">‹</button>
        <span className="flex-1 text-h2 truncate">送货单 · {documentLabel}</span>
        <button onClick={exportPDF} disabled={exporting}
                className="px-4 py-2 bg-ink text-white rounded-cta text-button disabled:opacity-40">
          {exporting ? '生成中…' : '📄 生成 PDF'}
        </button>
        <button onClick={exportExcel} disabled={exportingXlsx}
                className="px-4 py-2 bg-[#1F7A4B] text-white rounded-cta text-button disabled:opacity-40"
                title="导出 Excel 文件 (.xlsx), 可在 WPS/Excel 打开后编辑">
          {exportingXlsx ? '生成中…' : '📊 导出 Excel'}
        </button>
        <button onClick={tryPrint}
                className="px-3 py-2 border border-border rounded-cta text-caption text-gray2"
                title="PC 浏览器可用 · 手机请用生成 PDF">🖨</button>
      </div>

      {/* PDF 生成完毕弹层 — iframe 预览 + 下载链接 + 新窗口打开 */}
      {pdfUrl && order && (
        <div className="no-print fixed inset-0 z-50 bg-ink/70 flex items-center justify-center p-4"
             onClick={() => setPdfUrl(null)}>
          <div className="bg-white rounded-card max-w-3xl w-full max-h-[90vh] flex flex-col"
               onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between p-3 border-b border-border">
              <span className="text-h2">送货单 PDF · {documentLabel}</span>
              <button onClick={() => setPdfUrl(null)} className="text-gray3 px-2 text-h2">×</button>
            </div>
            <iframe src={pdfUrl} className="flex-1 w-full" title="PDF 预览" />
            <div className="p-3 border-t border-border space-y-2">
              {/* OSS 真链接 — App 内 / 微信 / 任何环境都可用 */}
              {uploading && (
                <div className="text-caption text-gray3">⏳ 正在上传到云端... 上传完才能在 app 里打开</div>
              )}
              {ossUrl && (
                <div className="bg-bg rounded-cta p-2">
                  <div className="text-micro text-gray3 mb-1">PDF 公网链接 (任何浏览器 / 微信 / app 都可打开)</div>
                  <div className="flex items-center gap-2">
                    <input readOnly value={ossUrl}
                           className="flex-1 bg-white border border-border rounded px-2 py-1 text-micro text-gray2 font-mono truncate" />
                    <button onClick={copyOssUrl}
                            className="px-3 py-1 bg-accent text-white rounded-cta text-caption shrink-0">
                      {copied ? '✓ 已复制' : '复制'}
                    </button>
                  </div>
                  <div className="flex gap-2 mt-2">
                    <a href={ossUrl} target="_blank" rel="noopener"
                       className="flex-1 text-center px-3 py-2 bg-ink text-white rounded-cta text-button">
                      📂 在新窗口打开 PDF
                    </a>
                    <a href={ossUrl} download={deliveryPdfFilename(order)}
                       className="flex-1 text-center px-3 py-2 border border-border rounded-cta text-button text-gray2">
                      ⬇ 下载到本地
                    </a>
                  </div>
                  <p className="text-micro text-gray3 mt-2">📱 App 内点不开?复制链接发给自己微信,在微信里点链接 → 右上角 ⋯ → 用浏览器打开 → 即可下载/打印</p>
                </div>
              )}
              {/* 本地分享 — PC 浏览器 / iOS / 安卓 Chrome 可用 */}
              {pdfBlob && !ossUrl && !uploading && (
                <button onClick={shareOrDownload}
                        className="w-full px-4 py-2 bg-ink text-white rounded-cta text-button">📤 分享 / 下载</button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* A4 纸面 */}
      <div
        id="print-area"
        className={`print-page mx-auto my-6 bg-white shadow-md text-ink ${isOperationGroup ? 'px-10 pb-5 pt-10' : 'p-10'}`}
        style={{ width: '210mm', minHeight: isOperationGroup ? 'auto' : '297mm', fontFamily: 'system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif' }}
      >
        {/* 抬头 */}
        <div className="text-center border-b-2 border-ink pb-3">
          <div className="text-2xl font-bold tracking-widest">{order.supplier.name}</div>
          <div className="text-3xl font-bold mt-2">送 货 单</div>
          <div className="text-xs text-gray2 mt-1">DELIVERY NOTE</div>
        </div>

        {/* 顶部元数据 */}
        <table className="w-full text-sm mt-4 border-collapse">
          <tbody>
            {isOperationGroup && groupMembers && groupMembers.length > 0
              ? groupMembers.map(member => (
                <tr key={member.id}>
                  <td className="border border-gray3 px-2 py-1.5 bg-bg w-24">送货单号</td>
                  <td className="border border-gray3 px-2 py-1.5 font-mono">{member.deliveryNos?.length ? member.deliveryNos.join('、') : member.deliveryNo || member.no}</td>
                  <td className="border border-gray3 px-2 py-1.5 bg-bg w-24">下单日期</td>
                  <td className="border border-gray3 px-2 py-1.5">{dayjs(member.createdAt).format('YYYY-MM-DD HH:mm')}</td>
                </tr>
              ))
              : (
                <tr>
                  <td className="border border-gray3 px-2 py-1.5 bg-bg w-24">送货单号</td>
                  <td className="border border-gray3 px-2 py-1.5 font-mono">{order.no}</td>
                  <td className="border border-gray3 px-2 py-1.5 bg-bg w-24">下单日期</td>
                  <td className="border border-gray3 px-2 py-1.5">{dayjs(order.createdAt).format('YYYY-MM-DD HH:mm')}</td>
                </tr>
              )}
            {order.purchaseOrderNo && (
              <tr>
                <td className="border border-gray3 px-2 py-1.5 bg-bg">来源订货单</td>
                <td className="border border-gray3 px-2 py-1.5 font-mono" colSpan={3}>{order.purchaseOrderNo}</td>
              </tr>
            )}
            <tr>
              <td className="border border-gray3 px-2 py-1.5 bg-bg">收货方</td>
              <td className="border border-gray3 px-2 py-1.5" colSpan={3}>{order.store.name}</td>
            </tr>
            {order.store.address && (
              <tr>
                <td className="border border-gray3 px-2 py-1.5 bg-bg">收货地址</td>
                <td className="border border-gray3 px-2 py-1.5" colSpan={3}>{order.store.address}</td>
              </tr>
            )}
            {((order.consignee?.name ?? order.store.managerName) || (order.consignee?.phone ?? order.store.phone)) && (
              <tr>
                <td className="border border-gray3 px-2 py-1.5 bg-bg">收货人</td>
                <td className="border border-gray3 px-2 py-1.5" colSpan={3}>
                  {(order.consignee?.name ?? order.store.managerName) || '—'}{(order.consignee?.phone ?? order.store.phone) ? ` · ${order.consignee?.phone ?? order.store.phone}` : ''}
                </td>
              </tr>
            )}
            <tr>
              <td className="border border-gray3 px-2 py-1.5 bg-bg">下单人</td>
              <td className="border border-gray3 px-2 py-1.5" colSpan={3}>{order.createdBy?.name || '—'}</td>
            </tr>
            <tr>
              <td className="border border-gray3 px-2 py-1.5 bg-bg">期望到货</td>
              <td className="border border-gray3 px-2 py-1.5">{dayjs(order.expectedDate).format('YYYY-MM-DD')}</td>
              <td className="border border-gray3 px-2 py-1.5 bg-bg">发货时间</td>
              <td className="border border-gray3 px-2 py-1.5">{order.shippedAt ? dayjs(order.shippedAt).format('YYYY-MM-DD HH:mm') : '—'}</td>
            </tr>
            {(order.supplier.contactName || order.supplier.contactPhone) && (
              <tr>
                <td className="border border-gray3 px-2 py-1.5 bg-bg">供应方联系人</td>
                <td className="border border-gray3 px-2 py-1.5" colSpan={3}>
                  {order.supplier.contactName || '—'}{order.supplier.contactPhone ? ` · ${order.supplier.contactPhone}` : ''}
                </td>
              </tr>
            )}
          </tbody>
        </table>

        {/* 商品明细 */}
        <table className="w-full text-sm mt-4 border-collapse">
          <thead>
            <tr className="bg-bg">
              <th className="border border-gray3 px-2 py-1.5 w-10">#</th>
              <th className="border border-gray3 px-2 py-1.5 text-left">品名</th>
              <th className="border border-gray3 px-2 py-1.5 text-left w-32">规格</th>
              <th className="border border-gray3 px-2 py-1.5 w-12">单位</th>
              <th className="border border-gray3 px-2 py-1.5 w-16">数量</th>
              <th className="border border-gray3 px-2 py-1.5 w-20">单价(¥)</th>
              <th className="border border-gray3 px-2 py-1.5 w-24">金额(¥)</th>
            </tr>
          </thead>
          <tbody>
            {printChunks.map((chunk, chunkIdx) => {
              const startIdx = chunkIdx === 0 ? 0 : PRINT_FIRST_PAGE_ROWS + (chunkIdx - 1) * PRINT_PAGE_ROWS
              const isLastChunk = chunkIdx === printChunks.length - 1
              return (
                <Fragment
                  key={chunkIdx}
                >
                  {chunk.map((it, i) => {
                    const globalIdx = startIdx + i
                    const adj = it.shippedQty != null && Math.abs(Number(it.shippedQty) - Number(it.quantity)) > 0.0001
                    return (
                      <tr key={it.id} style={globalIdx === startIdx && chunkIdx > 0 ? { pageBreakBefore: 'always', breakBefore: 'page' } : undefined}>
                        <td className="border border-gray3 px-2 py-1.5 text-center">{globalIdx + 1}</td>
                        <td className="border border-gray3 px-2 py-1.5">{it.product?.name || '-'}</td>
                        <td className="border border-gray3 px-2 py-1.5 text-xs">{it.product?.spec || '—'}</td>
                        <td className="border border-gray3 px-2 py-1.5 text-center">{it.product?.unit || '—'}</td>
                        <td className="border border-gray3 px-2 py-1.5 text-right font-mono">
                          {itemQty(it)}
                          {adj && <span className="text-xs text-gray3 ml-1">(下单 {it.quantity})</span>}
                        </td>
                        <td className="border border-gray3 px-2 py-1.5 text-right font-mono">{Number(it.unitPrice).toFixed(2)}</td>
                        <td className="border border-gray3 px-2 py-1.5 text-right font-mono">{itemAmt(it).toFixed(2)}</td>
                      </tr>
                    )
                  })}
                  {isLastChunk && (
                    <>
                      {/* 实发金额 */}
                      <tr className="bg-bg font-semibold">
                        <td colSpan={4} className="border border-gray3 px-2 py-1.5 text-right">实发金额</td>
                        <td className="border border-gray3 px-2 py-1.5 text-right font-mono">{totalQty}</td>
                        <td className="border border-gray3 px-2 py-1.5"></td>
                        <td className="border border-gray3 px-2 py-1.5 text-right font-mono">{total.toFixed(2)}</td>
                      </tr>
                      {/* 大写 */}
                      <tr>
                        <td className="border border-gray3 px-2 py-1.5 bg-bg">大写</td>
                        <td colSpan={6} className="border border-gray3 px-2 py-1.5">人民币 {num2cn(total)}</td>
                      </tr>
                    </>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>

        {/* 备注 */}
        {(order.note || order.shippedNote) && (
          <div className="mt-4 text-sm">
            {order.note && <div>📝 订单备注: {order.note}</div>}
            {order.shippedNote && <div className="mt-1">📦 发货备注: {order.shippedNote}</div>}
          </div>
        )}

        {/* 签字栏 */}
        <div className="mt-12 grid grid-cols-2 gap-12 text-sm">
          <div>
            <div className="border-b border-ink pb-1 mb-2 h-8" />
            <div className="text-center text-gray2">送货人签字 / 日期</div>
          </div>
          <div>
            <div className="border-b border-ink pb-1 mb-2 h-8" />
            <div className="text-center text-gray2">收货人签字 / 日期</div>
          </div>
        </div>

        {/* 页脚 */}
        <div className="mt-6 pt-2 border-t border-border text-xs text-gray3 flex justify-between">
          <span>共 {itemsCount} 项商品</span>
          <span>打印时间 {dayjs(printedAt).format('YYYY-MM-DD HH:mm')}</span>
          <span>本单一式两联 · 收货方留存一联</span>
        </div>
      </div>
    </>
  )
}
