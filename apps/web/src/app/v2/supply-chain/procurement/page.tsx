'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { apiFetch } from '@/lib/v2-auth'
import { claimResolutionCopy, settlementLineTypeLabel } from '@/lib/upstream-settlement-copy'
import { clientRequestId } from '@/lib/client-id'
import { ConfirmSheet, useConfirmSheet } from '@/components/v2/confirm-sheet'
import {
  currentMonthRange,
  money,
  shortDate,
  statusTone,
  UPSTREAM_CLAIM_STATUS_LABEL,
  UPSTREAM_ORDER_STATUS_LABEL,
  UPSTREAM_RECEIPT_STATUS_LABEL,
  UPSTREAM_SETTLEMENT_STATUS_LABEL,
} from '@/lib/upstream-procurement'

type Tab = 'orders' | 'receipts' | 'claims' | 'settlements' | 'contracts'
type Supplier = { id: string; no: string; name: string }
type Warehouse = { id: string; code: string; name: string }
type Source = {
  id: string
  supplierId: string
  purchaseUnit: string
  quotedUnitPrice: string | number | null
  minOrderQty: string | number
  inventoryUnitsPerPurchaseUnit: string | number
  product: { id: string; code: string; name: string; spec?: string | null; inventoryUnit?: string | null; unit: string }
}
type ContractLine = Source & {
  productNameSnapshot: string
  productCodeSnapshot: string
  productSpecSnapshot?: string | null
  supplierSkuSnapshot?: string | null
  inventoryUnit: string
  unitPrice: string | number
  taxRate: string | number
  minOrderQty: string | number
  packageMultiple: string | number
  leadTimeDays: number
  shortTolerancePct: string | number
  overTolerancePct: string | number
  startsAt: string
  endsAt?: string | null
}
type Contract = {
  id: string
  supplierId: string
  contractNo: string
  version: number
  title: string
  status: string
  startsAt: string
  endsAt?: string | null
  settlementCycle: string
  settlementDays: number
  taxInclusive: boolean
  defaultTaxRate?: string | number | null
  currency: string
  paymentMethod?: string | null
  discrepancyRule?: unknown
  attachments?: unknown
  supplier: Supplier
  lines: ContractLine[]
}
type OrderLine = {
  id: string
  productNameSnapshot: string
  productSpecSnapshot?: string | null
  purchaseUnit: string
  orderedQty: string | number
  confirmedQty?: string | number | null
  shippedQty: string | number
  receivedQty: string | number
  unitPrice: string | number
}
type Order = {
  id: string
  no: string
  status: string
  supplierId: string
  supplier: Supplier
  warehouse: Warehouse
  expectedArrivalAt?: string | null
  currency?: string
  taxInclusive?: boolean
  amountWithoutTax?: string | number
  taxAmount?: string | number
  totalAmount: string | number
  note?: string | null
  hasTemporaryPrice: boolean
  lines?: OrderLine[]
  revisions?: Array<{
    id: string
    status: string
    revisionNo: number
    reason: string
    beforeSnapshot?: RevisionSnapshot
    afterSnapshot?: RevisionSnapshot
    reviewNote?: string | null
  }>
  _count?: { lines: number; shipments: number; receipts: number }
}
type ShipmentLine = {
  id: string
  purchaseOrderLineId: string
  shippedQty: string | number
  purchaseUnit: string
  purchaseOrderLine: { productNameSnapshot: string; productSpecSnapshot?: string | null }
  receiptLines?: Array<{ arrivedQty: string | number; shortageQty: string | number }>
}
type Shipment = {
  id: string
  no: string
  status: string
  supplierId: string
  purchaseOrder: { id: string; no: string; status: string; expectedArrivalAt?: string | null }
  lines: ShipmentLine[]
}
type Receipt = {
  id: string
  no: string
  status: string
  payableAmount: string | number
  supplier: Supplier
  purchaseOrder: { id: string; no: string; status: string; totalAmount?: string | number; amountWithoutTax?: string | number }
  shipment: { id: string; no: string; status: string }
  reviewReasons?: string[]
  postedAt?: string | null
  createdAt: string
  _count: { lines: number; claims: number }
}
type ReceiptDetail = Receipt & {
  supplier: Supplier & { postReceiptClaimHours: number }
  purchaseOrder: Receipt['purchaseOrder'] & { lines: OrderLine[] }
  lines: Array<{
    id: string
    purchaseOrderLineId: string
    arrivedQty?: string | number
    acceptedQty: string | number
    shortageQty?: string | number
    damagedQty?: string | number
    rejectedQty?: string | number
    purchaseUnit: string
    unitPrice?: string | number
    payableAmount?: string | number
    purchaseOrderLine: {
      productCodeSnapshot: string
      productNameSnapshot: string
      productSpecSnapshot?: string | null
    }
  }>
}
type RevisionSnapshot = {
  expectedArrivalAt?: string | null
  lines?: Array<{ id: string; quantity: string | number }>
}
type Claim = {
  id: string
  no: string
  type: string
  status: string
  claimedAmount: string | number
  resolvedAmount?: string | number | null
  description: string
  supplierResponse?: string | null
  responsibility?: string | null
  resolution?: string | null
  supplierId: string
  purchaseOrder: { id: string; no: string }
  receipt: { id: string; no: string; postedAt?: string | null }
  lines: Array<{ id: string; affectedQty: string | number; purchaseUnit: string; product: { code: string; name: string } }>
}
type Statement = {
  id: string
  no: string
  status: string
  supplierId: string
  supplier: Supplier
  periodStart: string
  periodEnd: string
  receiptAmount: string | number
  deductionAmount: string | number
  payableAmount: string | number
  version: number
  _count: { lines: number; invoiceAllocations: number }
}
type StatementDetail = Statement & {
  lines: Array<{
    id: string
    sourceType: string
    sourceNo: string
    businessDate: string
    description: string
    originalAmount: string | number
    adjustmentAmount: string | number
    payableAmount: string | number
    receiptLine?: { receipt?: { id: string; no: string; purchaseOrder?: { id: string; no: string } } } | null
    claim?: { id: string; no: string; purchaseOrder?: { id: string; no: string }; receipt?: { id: string; no: string } } | null
  }>
}

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'orders', label: '采购单' },
  { key: 'receipts', label: '到货验收' },
  { key: 'claims', label: '到货差异' },
  { key: 'settlements', label: '月度对账' },
  { key: 'contracts', label: '合同与价格' },
]

function Badge({ status, labels }: { status: string; labels: Record<string, string> }) {
  return <span className={`rounded-full px-2.5 py-1 text-micro font-medium ${statusTone(status)}`}>{labels[status] || status}</span>
}

function ActionButton({ children, onClick, disabled, tone = 'dark' }: { children: ReactNode; onClick: () => void; disabled?: boolean; tone?: 'dark' | 'light' | 'danger' }) {
  const colors = tone === 'dark' ? 'bg-gray1 text-white' : tone === 'danger' ? 'border-red-200 text-red-700' : 'border-border bg-white text-gray1'
  return <button disabled={disabled} onClick={onClick} className={`rounded-lg border px-3 py-2 text-caption font-medium disabled:cursor-not-allowed disabled:opacity-40 ${colors}`}>{children}</button>
}

export default function UpstreamProcurementPage() {
  const [tab, setTab] = useState<Tab>('orders')
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [revisionRejectConfirm, openRevisionRejectConfirm] = useConfirmSheet()
  const [orders, setOrders] = useState<Order[]>([])
  const [shipments, setShipments] = useState<Shipment[]>([])
  const [receipts, setReceipts] = useState<Receipt[]>([])
  const [claims, setClaims] = useState<Claim[]>([])
  const [statements, setStatements] = useState<Statement[]>([])
  const [contracts, setContracts] = useState<Contract[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [sources, setSources] = useState<Source[]>([])
  const [contractSupplierId, setContractSupplierId] = useState('')
  const [showContractForm, setShowContractForm] = useState(false)
  const [showOrderForm, setShowOrderForm] = useState(false)
  const [contractForm, setContractForm] = useState({ contractNo: '', title: '', startsAt: new Date().toISOString().slice(0, 10) })
  const [sourcePrices, setSourcePrices] = useState<Record<string, string>>({})
  const [orderContractId, setOrderContractId] = useState('')
  const [orderWarehouseId, setOrderWarehouseId] = useState('')
  const [orderArrival, setOrderArrival] = useState('')
  const [orderQuantities, setOrderQuantities] = useState<Record<string, string>>({})
  const [receiving, setReceiving] = useState<Shipment | null>(null)
  const [receiptLines, setReceiptLines] = useState<Record<string, { arrived: string; accepted: string; damaged: string; rejected: string }>>({})
  const [claimingReceipt, setClaimingReceipt] = useState<ReceiptDetail | null>(null)
  const [postClaimType, setPostClaimType] = useState<'SHORTAGE' | 'POST_RECEIPT_DAMAGE'>('POST_RECEIPT_DAMAGE')
  const [postClaimDescription, setPostClaimDescription] = useState('')
  const [postClaimQuantities, setPostClaimQuantities] = useState<Record<string, string>>({})
  const [postClaimEvidence, setPostClaimEvidence] = useState<Array<{ url: string; name: string }>>([])
  const [uploadingEvidence, setUploadingEvidence] = useState(false)
  const [viewingOrder, setViewingOrder] = useState<Order | null>(null)
  const [reviewingRevisionOrder, setReviewingRevisionOrder] = useState<Order | null>(null)
  const [viewingReceipt, setViewingReceipt] = useState<ReceiptDetail | null>(null)
  const [receiptReviewAction, setReceiptReviewAction] = useState<'confirm' | 'review' | null>(null)
  const [viewingStatement, setViewingStatement] = useState<StatementDetail | null>(null)
  const [viewingContract, setViewingContract] = useState<Contract | null>(null)
  const orderRequestKeyRef = useRef(clientRequestId())
  const receiptRequestKeysRef = useRef<Record<string, string>>({})
  const postClaimRequestKeysRef = useRef<Record<string, string>>({})
  const month = useMemo(() => currentMonthRange(), [])
  const [settlementForm, setSettlementForm] = useState({ supplierId: '', periodStart: month.start, periodEnd: month.end })

  const loadAll = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [orderRows, shipmentRows, receiptRows, claimRows, statementRows, contractRows, setup] = await Promise.all([
        apiFetch<Order[]>('/api/upstream/purchase-orders'),
        apiFetch<Shipment[]>('/api/upstream/shipments'),
        apiFetch<Receipt[]>('/api/upstream/receipts'),
        apiFetch<Claim[]>('/api/upstream/arrival-claims'),
        apiFetch<Statement[]>('/api/upstream/settlement-statements'),
        apiFetch<Contract[]>('/api/upstream/contracts'),
        apiFetch<{ suppliers: Supplier[]; warehouses: Warehouse[] }>('/api/upstream/setup-options'),
      ])
      setOrders(orderRows)
      setShipments(shipmentRows)
      setReceipts(receiptRows)
      setClaims(claimRows)
      setStatements(statementRows)
      setContracts(contractRows)
      setSuppliers(setup.suppliers)
      setWarehouses(setup.warehouses)
      setOrderWarehouseId(value => value || setup.warehouses[0]?.id || '')
      setSettlementForm(value => ({ ...value, supplierId: value.supplierId || setup.suppliers[0]?.id || '' }))
    } catch (reason: any) {
      setError(reason?.message || '上游采购数据加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void loadAll() }, [loadAll])

  // 单据状态会被他人推进: 回到本页(切Tab/解锁/切回浏览器)自动刷新, 避免看到旧状态误判
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') void loadAll()
    }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [loadAll])

  async function run(key: string, task: () => Promise<unknown>, success: string) {
    setWorking(key)
    setError(null)
    setNotice(null)
    try {
      await task()
      setNotice(success)
      await loadAll()
      return true
    } catch (reason: any) {
      setError(reason?.message || '操作失败')
      return false
    } finally {
      setWorking(null)
    }
  }

  async function loadSources(supplierId: string) {
    setContractSupplierId(supplierId)
    setSources([])
    setSourcePrices({})
    if (!supplierId) return
    try {
      const setup = await apiFetch<{ sources: Source[] }>(`/api/upstream/setup-options?supplierId=${encodeURIComponent(supplierId)}`)
      setSources(setup.sources)
      setSourcePrices(Object.fromEntries(setup.sources.map(source => [source.id, source.quotedUnitPrice == null ? '' : String(source.quotedUnitPrice)])))
    } catch (reason: any) {
      setError(reason?.message || '采购来源加载失败')
    }
  }

  async function createContract() {
    // 填了但无效 (负数/非数字) 的单价不能静默丢弃, 必须点名提示
    const invalidPriced = sources.filter(source => {
      const raw = (sourcePrices[source.id] || '').trim()
      return raw !== '' && !(Number(raw) > 0)
    })
    if (invalidPriced.length > 0) {
      setError(`以下商品的单价无效，未纳入合同：${invalidPriced.map(source => source.product.name).join('、')}。请改为大于 0 的价格，或清空后重试。`)
      return
    }
    const lines = sources.filter(source => Number(sourcePrices[source.id]) > 0).map(source => ({
      upstreamSourceId: source.id,
      unitPrice: Number(sourcePrices[source.id]),
      packageMultiple: 1,
      shortTolerancePct: 0,
      overTolerancePct: 0,
    }))
    if (!contractSupplierId || !contractForm.contractNo.trim() || !contractForm.title.trim() || lines.length === 0) {
      setError('请填写合同编号、名称，并为至少一个商品填写有效单价')
      return
    }
    const succeeded = await run('create-contract', () => apiFetch('/api/upstream/contracts', {
      method: 'POST',
      body: JSON.stringify({
        supplierId: contractSupplierId,
        contractNo: contractForm.contractNo.trim(),
        title: contractForm.title.trim(),
        startsAt: contractForm.startsAt,
        settlementCycle: 'MONTHLY',
        settlementDays: 0,
        taxInclusive: true,
        currency: 'CNY',
        lines,
      }),
    }), '合同草稿已创建，请确认后启用')
    if (succeeded) setShowContractForm(false)
  }

  const activeContracts = contracts.filter(contract => contract.status === 'ACTIVE')
  const selectedOrderContract = activeContracts.find(contract => contract.id === orderContractId)

  function selectOrderContract(id: string) {
    setOrderContractId(id)
    const contract = activeContracts.find(item => item.id === id)
    setOrderQuantities(Object.fromEntries((contract?.lines || []).map(line => {
      const minimum = Math.max(Number(line.minOrderQty || 1), Number(line.packageMultiple || 1))
      const multiple = Math.max(Number(line.packageMultiple || 1), 0.000001)
      return [line.id, String(Math.ceil(minimum / multiple) * multiple)]
    })))
  }

  async function createOrder() {
    if (!selectedOrderContract || !orderWarehouseId) return setError('请选择已生效合同和收货总仓')
    const lines = selectedOrderContract.lines.filter(line => Number(orderQuantities[line.id]) > 0).map(line => ({ contractLineId: line.id, quantity: Number(orderQuantities[line.id]) }))
    if (!lines.length) return setError('至少填写一个商品的采购数量')
    const succeeded = await run('create-order', () => apiFetch('/api/upstream/purchase-orders', {
      method: 'POST',
      body: JSON.stringify({
        supplierId: selectedOrderContract.supplierId,
        warehouseId: orderWarehouseId,
        contractId: selectedOrderContract.id,
        expectedArrivalAt: orderArrival || undefined,
        origin: 'MANUAL',
        idempotencyKey: orderRequestKeyRef.current,
        lines,
      }),
    }), '采购单草稿已创建')
    if (succeeded) {
      orderRequestKeyRef.current = clientRequestId()
      setShowOrderForm(false)
    }
  }

  function openReceipt(shipment: Shipment) {
    setReceiving(shipment)
    setTab('receipts')
    setReceiptLines(Object.fromEntries(shipment.lines.map(line => [line.id, {
      arrived: String(line.shippedQty),
      accepted: String(line.shippedQty),
      damaged: '0',
      rejected: '0',
    }])))
    receiptRequestKeysRef.current[shipment.id] ||= clientRequestId()
  }

  async function createReceipt() {
    if (!receiving) return
    const shipmentId = receiving.id
    const succeeded = await run(`receive-${shipmentId}`, () => apiFetch(`/api/upstream/shipments/${shipmentId}/receipts`, {
      method: 'POST',
      body: JSON.stringify({
        finalForShipment: true,
        idempotencyKey: receiptRequestKeysRef.current[shipmentId] || (receiptRequestKeysRef.current[shipmentId] = clientRequestId()),
        lines: receiving.lines.map(line => ({
          shipmentLineId: line.id,
          arrivedQty: Number(receiptLines[line.id]?.arrived || 0),
          acceptedQty: Number(receiptLines[line.id]?.accepted || 0),
          damagedQty: Number(receiptLines[line.id]?.damaged || 0),
          rejectedQty: Number(receiptLines[line.id]?.rejected || 0),
        })),
      }),
    }), '收货单已生成，请开始验收并确认入库')
    if (succeeded) {
      delete receiptRequestKeysRef.current[shipmentId]
      setReceiving(null)
      setTab('receipts')
    }
  }

  async function openOrderDetail(order: Pick<Order, 'id'>, mode: 'view' | 'revision' = 'view') {
    setError(null)
    try {
      const detail = await apiFetch<Order>(`/api/upstream/purchase-orders/${order.id}`)
      if (mode === 'revision') {
        if (!detail.revisions?.some(item => item.status === 'PENDING')) throw new Error('未找到待审核改单')
        setReviewingRevisionOrder(detail)
        setViewingOrder(null)
      } else {
        setViewingOrder(detail)
        setReviewingRevisionOrder(null)
      }
      setViewingReceipt(null)
      setViewingStatement(null)
      setTab('orders')
    } catch (reason: any) {
      setError(reason?.message || '采购单明细加载失败')
    }
  }

  async function openReceiptDetail(receipt: Pick<Receipt, 'id'>, action: 'confirm' | 'review' | null = null) {
    setError(null)
    try {
      const detail = await apiFetch<ReceiptDetail>(`/api/upstream/receipts/${receipt.id}`)
      setViewingReceipt(detail)
      setReceiptReviewAction(action)
      setTab('receipts')
    } catch (reason: any) {
      setError(reason?.message || '收货单明细加载失败')
    }
  }

  async function submitReceiptReview() {
    if (!viewingReceipt || !receiptReviewAction) return
    const receipt = viewingReceipt
    const endpoint = receiptReviewAction === 'confirm' ? 'confirm' : 'review-and-post'
    const success = receiptReviewAction === 'confirm' ? '验收已确认' : '复核通过，库存已入账'
    const succeeded = await run(receipt.id, () => apiFetch(`/api/upstream/receipts/${receipt.id}/${endpoint}`, { method: 'POST' }), success)
    if (succeeded) {
      setViewingReceipt(null)
      setReceiptReviewAction(null)
    }
  }

  async function openStatementDetail(statement: Statement) {
    setError(null)
    try {
      setViewingStatement(await apiFetch<StatementDetail>(`/api/upstream/settlement-statements/${statement.id}`))
    } catch (reason: any) {
      setError(reason?.message || '对账单明细加载失败')
    }
  }

  async function openPostReceiptClaim(receipt: Receipt) {
    setError(null)
    try {
      const detail = await apiFetch<ReceiptDetail>(`/api/upstream/receipts/${receipt.id}`)
      setClaimingReceipt(detail)
      setPostClaimType('POST_RECEIPT_DAMAGE')
      setPostClaimDescription('')
      setPostClaimEvidence([])
      setPostClaimQuantities(Object.fromEntries(detail.purchaseOrder.lines.map(line => [line.id, '0'])))
      postClaimRequestKeysRef.current[receipt.id] ||= clientRequestId()
    } catch (reason: any) {
      setError(reason?.message || '收货单明细加载失败')
    }
  }

  async function uploadPostClaimEvidence(file: File) {
    if (postClaimEvidence.length >= 4) return setError('补报证据最多上传 4 个文件')
    setUploadingEvidence(true)
    setError(null)
    try {
      const form = new FormData()
      form.append('file', file)
      const uploaded = await apiFetch<{ url: string }>('/api/upload?category=loss-claims', { method: 'POST', body: form })
      setPostClaimEvidence(current => [...current, { url: uploaded.url, name: file.name }].slice(0, 4))
    } catch (reason: any) {
      setError(reason?.message || '证据上传失败')
    } finally {
      setUploadingEvidence(false)
    }
  }

  async function submitPostReceiptClaim() {
    if (!claimingReceipt) return
    const receiptLineByOrderLine = new Map(claimingReceipt.lines.map(line => [line.purchaseOrderLineId, line]))
    const lines = claimingReceipt.purchaseOrder.lines
      .map(line => ({
        purchaseOrderLineId: line.id,
        receiptLineId: receiptLineByOrderLine.get(line.id)?.id,
        affectedQty: Number(postClaimQuantities[line.id] || 0),
      }))
      .filter(line => line.affectedQty > 0)
    if (!postClaimDescription.trim()) return setError('请说明拆包后发现的异常')
    if (!lines.length) return setError('至少填写一个商品的异常数量')
    if (!postClaimEvidence.length) return setError('请至少上传一张图片或一个视频作为证据')
    const receiptId = claimingReceipt.id
    const succeeded = await run(`post-claim-${receiptId}`, () => apiFetch(`/api/upstream/receipts/${receiptId}/post-receipt-claims`, {
      method: 'POST',
      body: JSON.stringify({
        idempotencyKey: postClaimRequestKeysRef.current[receiptId] || (postClaimRequestKeysRef.current[receiptId] = clientRequestId()),
        type: postClaimType,
        description: postClaimDescription.trim(),
        evidence: postClaimEvidence.map(item => ({ url: item.url, name: item.name })),
        lines,
      }),
    }), '收货后异常已补报，等待供应商确认')
    if (succeeded) {
      delete postClaimRequestKeysRef.current[receiptId]
      setClaimingReceipt(null)
      setPostClaimEvidence([])
      setTab('claims')
    }
  }

  async function reviewRevision(order: Order, decision: 'ACCEPT' | 'REJECT', note?: string) {
    const detail = order.revisions?.some(item => item.status === 'PENDING')
      ? order
      : await apiFetch<Order>(`/api/upstream/purchase-orders/${order.id}`)
    const revision = detail.revisions?.find(item => item.status === 'PENDING')
    if (!revision) throw new Error('未找到待审核改单')
    return apiFetch(`/api/upstream/purchase-orders/${order.id}/revisions/${revision.id}/review`, {
      method: 'POST', body: JSON.stringify({ decision, ...(note ? { note } : {}) }),
    })
  }

  function rejectRevisionWithReason(order: Order) {
    openRevisionRejectConfirm({
      title: `驳回改单 ${order.no}?`,
      body: '驳回后采购单回到「已提交供应商」状态，供应商会看到你填写的理由。',
      confirmLabel: '确认驳回',
      tone: 'danger',
      withInput: true,
      inputRequired: true,
      inputPlaceholder: '驳回理由 (必填, 供应商可见)',
      onConfirm: async (reason) => {
        if (!reason) return
        const succeeded = await run(order.id, () => reviewRevision(order, 'REJECT', reason), '改单已驳回')
        if (succeeded) setReviewingRevisionOrder(null)
      },
    })
  }

  async function reverseReceipt(receipt: Receipt) {
    const reason = window.prompt('请输入冲销原因（例如：重复收货、录入错误）')?.trim()
    if (!reason) return
    if (reason.length < 2) return setError('冲销原因至少填写 2 个字符')
    if (!window.confirm(`确认整单冲销收货单 ${receipt.no}？库存、金额和采购进度都会恢复，且操作不可删除。`)) return
    await run(`reverse-${receipt.id}`, () => apiFetch(`/api/upstream/receipts/${receipt.id}/reverse`, {
      method: 'POST',
      body: JSON.stringify({ reason, idempotencyKey: clientRequestId() }),
    }), '收货单已冲销，库存与采购进度已恢复')
  }

  const pendingReceiptCount = receipts.filter(item => ['DRAFT', 'INSPECTING', 'PENDING_REVIEW'].includes(item.status)).length
  const pendingClaimCount = claims.filter(item => item.status !== 'RESOLVED' && item.status !== 'CANCELLED').length
  const pendingOrderCount = orders.filter(item => !['RECEIVED', 'SETTLED', 'CANCELLED'].includes(item.status)).length

  return (
    <div className="min-h-screen bg-bg px-4 py-5 lg:px-8 lg:py-7">
      <style jsx global>{`.input{width:100%;border:1px solid #ddd6c9;border-radius:12px;background:#fff;padding:10px 12px;color:#29231d;outline:none}.input:focus{border-color:#c96f32;box-shadow:0 0 0 3px rgba(201,111,50,.12)}`}</style>
      <header className="mx-auto max-w-[1440px] border-b border-border pb-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="mb-2 text-caption text-gray3">内部管理 · 全部送达总仓 · 独立上游采购链路</div>
            <h1 className="text-h1">上游采购与供应商协同</h1>
            <p className="mt-1 text-caption text-gray2">合同价下单 → 供应商接单/改单 → 发货 → 总仓验收 → 差异 → 月结</p>
          </div>
          <div className="flex gap-2">
            <ActionButton tone="light" onClick={() => void loadAll()} disabled={loading}>刷新</ActionButton>
            <ActionButton onClick={() => { setShowOrderForm(true); setTab('orders') }}>新建采购单</ActionButton>
          </div>
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          <Summary label="进行中采购" value={pendingOrderCount} />
          <Summary label="待验收入库" value={pendingReceiptCount} danger={pendingReceiptCount > 0} />
          <Summary label="待处理差异" value={pendingClaimCount} danger={pendingClaimCount > 0} />
        </div>
      </header>

      <main className="mx-auto max-w-[1440px] py-5">
        {error && <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-caption text-red-700">{error}</div>}
        {notice && <div className="mb-4 rounded-xl border border-green/20 bg-green/10 px-4 py-3 text-caption text-green">{notice}</div>}
        <div className="mb-5 flex gap-2 overflow-x-auto">
          {TABS.map(item => <button key={item.key} onClick={() => setTab(item.key)} className={`whitespace-nowrap rounded-full px-4 py-2 text-button ${tab === item.key ? 'bg-gray1 text-white' : 'border border-border bg-white text-gray2'}`}>{item.label}</button>)}
        </div>

        {loading ? <div className="rounded-2xl border border-border bg-white p-10 text-center text-gray3">正在加载采购数据…</div> : null}

        {!loading && tab === 'orders' && <section className="space-y-4">
          {viewingOrder && <Panel title={`采购单明细 · ${viewingOrder.no}`} onClose={() => setViewingOrder(null)}>
            <div className="grid gap-2 rounded-xl bg-bg p-3 text-caption sm:grid-cols-2 lg:grid-cols-4">
              <div><span className="text-gray3">供应商</span><div>{viewingOrder.supplier.name}</div></div>
              <div><span className="text-gray3">收货总仓</span><div>{viewingOrder.warehouse.name}</div></div>
              <div><span className="text-gray3">期望到货</span><div>{shortDate(viewingOrder.expectedArrivalAt)}</div></div>
              <div><span className="text-gray3">订单金额</span><div>{money(viewingOrder.totalAmount)}</div></div>
            </div>
            <div className="mt-4 overflow-x-auto"><table className="w-full text-left text-caption"><thead><tr className="border-b"><th className="p-2">商品</th><th className="p-2">规格</th><th className="p-2">采购单位</th><th className="p-2">订单数量</th><th className="p-2">已发数量</th><th className="p-2">已收数量</th><th className="p-2">单价</th><th className="p-2">小计</th></tr></thead><tbody>{(viewingOrder.lines || []).map(line => { const quantity = Number(line.confirmedQty ?? line.orderedQty); return <tr key={line.id} className="border-b border-border"><td className="p-2"><b>{line.productNameSnapshot}</b></td><td className="p-2">{line.productSpecSnapshot || '—'}</td><td className="p-2">{line.purchaseUnit}</td><td className="p-2">{quantity}</td><td className="p-2">{String(line.shippedQty)}</td><td className="p-2">{String(line.receivedQty)}</td><td className="p-2">{money(line.unitPrice)}</td><td className="p-2">{money(quantity * Number(line.unitPrice))}</td></tr> })}</tbody></table></div>
          </Panel>}
          {reviewingRevisionOrder && (() => {
            const revision = reviewingRevisionOrder.revisions?.find(item => item.status === 'PENDING')
            const rows = revision ? revisionComparison(reviewingRevisionOrder, revision) : []
            return <Panel title={`改单审核 · ${reviewingRevisionOrder.no}`} onClose={() => setReviewingRevisionOrder(null)}>
              {revision && <><div className="rounded-xl border border-amber/30 bg-amber/10 p-3 text-caption"><b>第 {revision.revisionNo} 次改单</b><span className="ml-2 text-gray2">{revision.reason}</span><div className="mt-1 text-gray3">请先核对以下修改内容，再接受或驳回。</div></div><div className="mt-4 overflow-x-auto"><table className="w-full text-left text-caption"><thead><tr className="border-b"><th className="p-2">商品</th><th className="p-2">原数量</th><th className="p-2">新数量</th><th className="p-2">变化</th><th className="p-2">单位</th></tr></thead><tbody>{rows.map(row => <tr key={row.id} className={`border-b border-border ${row.changed ? 'bg-amber/5' : ''}`}><td className="p-2"><b>{row.name}</b><div className="text-gray3">{row.spec || '—'}</div></td><td className="p-2">{row.before}</td><td className="p-2">{row.after}</td><td className={`p-2 ${row.delta !== 0 ? 'font-medium text-red-700' : 'text-gray3'}`}>{row.delta > 0 ? '+' : ''}{row.delta}</td><td className="p-2">{row.unit}</td></tr>)}</tbody></table></div>{revision.beforeSnapshot?.expectedArrivalAt !== revision.afterSnapshot?.expectedArrivalAt && <p className="mt-3 rounded-lg bg-bg p-3 text-caption">期望到货日：{shortDate(revision.beforeSnapshot?.expectedArrivalAt)} → {shortDate(revision.afterSnapshot?.expectedArrivalAt)}</p>}<div className="mt-4 flex justify-end gap-2"><ActionButton tone="danger" onClick={() => rejectRevisionWithReason(reviewingRevisionOrder)} disabled={working === reviewingRevisionOrder.id}>驳回改单</ActionButton><ActionButton onClick={() => void run(reviewingRevisionOrder.id, () => reviewRevision(reviewingRevisionOrder, 'ACCEPT'), '改单已接受').then(succeeded => { if (succeeded) setReviewingRevisionOrder(null) })} disabled={working === reviewingRevisionOrder.id}>确认接受改单</ActionButton></div></>}
            </Panel>
          })()}
          {showOrderForm && <Panel title="新建采购单" onClose={() => setShowOrderForm(false)}>
            <div className="grid gap-3 md:grid-cols-3">
              <Field label="已生效合同"><select value={orderContractId} onChange={event => selectOrderContract(event.target.value)} className="input"><option value="">请选择</option>{activeContracts.map(contract => <option key={contract.id} value={contract.id}>{contract.supplier.name} · {contract.title}</option>)}</select></Field>
              <Field label="收货总仓"><select value={orderWarehouseId} onChange={event => setOrderWarehouseId(event.target.value)} className="input"><option value="">请选择</option>{warehouses.map(warehouse => <option key={warehouse.id} value={warehouse.id}>{warehouse.name}</option>)}</select></Field>
              <Field label="期望到货日"><input type="date" value={orderArrival} onChange={event => setOrderArrival(event.target.value)} className="input" /></Field>
            </div>
            {selectedOrderContract && <div className="mt-4 overflow-x-auto"><table className="w-full text-left text-caption"><thead><tr className="border-b"><th className="p-2">商品</th><th className="p-2">合同价</th><th className="p-2">采购数量</th></tr></thead><tbody>{selectedOrderContract.lines.map(line => <tr key={line.id} className="border-b border-border"><td className="p-2"><b>{line.productNameSnapshot}</b><div className="text-gray3">{line.productSpecSnapshot || '—'} · {line.purchaseUnit}</div></td><td className="p-2">{money(line.unitPrice)}</td><td className="p-2"><input type="number" min="0" step="any" value={orderQuantities[line.id] || ''} onChange={event => setOrderQuantities(value => ({ ...value, [line.id]: event.target.value }))} className="input max-w-36" /></td></tr>)}</tbody></table></div>}
            <div className="mt-4 flex justify-end"><ActionButton onClick={() => void createOrder()} disabled={working === 'create-order'}>保存采购单草稿</ActionButton></div>
          </Panel>}
          {orders.length === 0 ? <Empty text="还没有上游采购单，请先建立合同并下单" /> : orders.map(order => <article key={order.id} className="rounded-2xl border border-border bg-white p-4 shadow-sm">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div><div className="flex flex-wrap items-center gap-2"><button type="button" onClick={() => void openOrderDetail(order)} className="text-h3 underline decoration-dotted underline-offset-4" aria-label={`查看采购单 ${order.no} 明细`}>{order.no}</button><Badge status={order.status} labels={UPSTREAM_ORDER_STATUS_LABEL} />{order.hasTemporaryPrice && <span className="rounded-full bg-red-50 px-2 py-1 text-micro text-red-700">临时价</span>}</div><p className="mt-1 text-caption text-gray2">{order.supplier.name} → {order.warehouse.name} · {order._count?.lines || 0} 项 · 到货 {shortDate(order.expectedArrivalAt)}</p></div>
              <div className="text-right"><div className="text-h3">{money(order.totalAmount)}</div><div className="mt-2 flex flex-wrap justify-end gap-2">
                {order.status === 'DRAFT' && <ActionButton onClick={() => void run(order.id, () => apiFetch(`/api/upstream/purchase-orders/${order.id}/submit-for-approval`, { method: 'POST' }), '采购单已提交内部审核')} disabled={working === order.id}>提交审核</ActionButton>}
                {order.status === 'PENDING_APPROVAL' && <ActionButton onClick={() => window.confirm('确认合同、价格和数量无误并发送供应商？') && void run(order.id, () => apiFetch(`/api/upstream/purchase-orders/${order.id}/approve-and-send`, { method: 'POST' }), '采购单已发送供应商')} disabled={working === order.id}>审核并发送</ActionButton>}
                {order.status === 'CHANGE_PROPOSED' && <ActionButton onClick={() => void openOrderDetail(order, 'revision')} disabled={working === order.id}>查看改单内容</ActionButton>}
              </div></div>
            </div>
          </article>)}
          <div className="rounded-2xl border border-border bg-white p-4"><h2 className="text-h3">供应商发货动态</h2><div className="mt-3 space-y-2">{shipments.length === 0 ? <p className="text-caption text-gray3">暂无发货单</p> : shipments.map(shipment => <div key={shipment.id} className="flex flex-col gap-2 rounded-xl bg-bg p-3 sm:flex-row sm:items-center sm:justify-between"><div><b>{shipment.no}</b><p className="text-caption text-gray2">采购单 {shipment.purchaseOrder.no} · {shipment.lines.length} 项 · {shipment.status}</p></div>{['SHIPPED', 'PARTIALLY_RECEIVED'].includes(shipment.status) && !shipmentFullyInspected(shipment) && <ActionButton onClick={() => openReceipt(shipment)}>登记到货</ActionButton>}</div>)}</div></div>
        </section>}

        {!loading && tab === 'receipts' && <section className="space-y-3">
          {viewingReceipt && <Panel title={`收货单明细 · ${viewingReceipt.no}`} onClose={() => { setViewingReceipt(null); setReceiptReviewAction(null) }}>
            <div className="grid gap-2 rounded-xl bg-bg p-3 text-caption sm:grid-cols-2 lg:grid-cols-4">
              <div><span className="text-gray3">采购单</span><div><button type="button" className="font-medium underline decoration-dotted underline-offset-2" aria-label={`查看采购单 ${viewingReceipt.purchaseOrder.no} 全部内容`} onClick={() => void openOrderDetail(viewingReceipt.purchaseOrder)}>{viewingReceipt.purchaseOrder.no}</button></div></div>
              <div><span className="text-gray3">采购单金额</span><div><b>{viewingReceipt.purchaseOrder.totalAmount == null ? '—' : money(viewingReceipt.purchaseOrder.totalAmount)}</b></div></div>
              <div><span className="text-gray3">发货单</span><div>{viewingReceipt.shipment.no}</div></div>
              <div><span className="text-gray3">本次应付</span><div><b>{money(viewingReceipt.payableAmount)}</b></div></div>
            </div>
            <div className="mt-4 overflow-x-auto"><table className="w-full text-left text-caption"><thead><tr className="border-b"><th className="p-2">商品</th><th className="p-2">规格</th><th className="p-2">实到</th><th className="p-2">合格</th><th className="p-2">短缺</th><th className="p-2">破损</th><th className="p-2">拒收</th><th className="p-2">单位</th><th className="p-2">应付</th></tr></thead><tbody>{viewingReceipt.lines.map(line => <tr key={line.id} className="border-b border-border"><td className="p-2"><b>{line.purchaseOrderLine.productNameSnapshot}</b></td><td className="p-2">{line.purchaseOrderLine.productSpecSnapshot || line.purchaseOrderLine.productCodeSnapshot}</td><td className="p-2">{String(line.arrivedQty ?? '—')}</td><td className="p-2">{String(line.acceptedQty)}</td><td className="p-2">{String(line.shortageQty ?? 0)}</td><td className="p-2">{String(line.damagedQty ?? 0)}</td><td className="p-2">{String(line.rejectedQty ?? 0)}</td><td className="p-2">{line.purchaseUnit}</td><td className="p-2">{line.payableAmount == null ? '—' : money(line.payableAmount)}</td></tr>)}</tbody></table></div>
            {viewingReceipt.reviewReasons?.length ? <div className="mt-3 rounded-lg border border-amber/30 bg-amber/10 p-3 text-caption"><b>复核原因：</b>{viewingReceipt.reviewReasons.join('、')}</div> : null}
            {receiptReviewAction && <div className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-border p-3"><p className="text-caption text-gray2">请确认采购单、发货单、金额及全部商品明细均已核对。</p><ActionButton onClick={() => void submitReceiptReview()} disabled={working === viewingReceipt.id}>{receiptReviewAction === 'confirm' ? '确认验收并提交' : '确认复核并入库'}</ActionButton></div>}
          </Panel>}
          {receiving && <Panel title={`登记到货 · ${receiving.no}`} onClose={() => setReceiving(null)}><p className="mb-3 text-caption text-gray2">请按现场实际填写。合格数量会形成总仓库存，破损/拒收/短缺会自动生成差异单。</p><div className="overflow-x-auto"><table className="w-full text-caption"><thead><tr className="border-b text-left"><th className="p-2">商品</th><th className="p-2">发货</th><th className="p-2">实到</th><th className="p-2">合格</th><th className="p-2">破损</th><th className="p-2">拒收</th></tr></thead><tbody>{receiving.lines.map(line => <tr key={line.id} className="border-b border-border"><td className="p-2"><b>{line.purchaseOrderLine.productNameSnapshot}</b><div className="text-gray3">{line.purchaseOrderLine.productSpecSnapshot || '—'}</div></td><td className="p-2">{String(line.shippedQty)} {line.purchaseUnit}</td>{(['arrived', 'accepted', 'damaged', 'rejected'] as const).map(field => <td key={field} className="p-2"><input type="number" min="0" step="any" className="input w-24" value={receiptLines[line.id]?.[field] || ''} onChange={event => setReceiptLines(value => ({ ...value, [line.id]: { ...value[line.id], [field]: event.target.value } }))} /></td>)}</tr>)}</tbody></table></div><div className="mt-4 flex justify-end"><ActionButton onClick={() => void createReceipt()} disabled={working === `receive-${receiving.id}`}>生成收货单</ActionButton></div></Panel>}
          {claimingReceipt && <Panel title={`收货后补报异常 · ${claimingReceipt.no}`} onClose={() => setClaimingReceipt(null)}>
            <p className="mb-3 text-caption text-gray2">
              页面保留原采购单 {claimingReceipt.purchaseOrder.no} 的全部商品。少发可从未收数量中补报；收货后破损只能从本次合格入库数量中补报。原收货记录不会被修改，补报时限为入库后 {claimingReceipt.supplier.postReceiptClaimHours} 小时。
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="异常类型">
                <select
                  className="input"
                  value={postClaimType}
                  onChange={event => {
                    setPostClaimType(event.target.value as 'SHORTAGE' | 'POST_RECEIPT_DAMAGE')
                    setPostClaimQuantities(Object.fromEntries(claimingReceipt.purchaseOrder.lines.map(line => [line.id, '0'])))
                  }}
                >
                  <option value="SHORTAGE">少发 / 未收到</option>
                  <option value="POST_RECEIPT_DAMAGE">收货后破损 / 品质异常</option>
                </select>
              </Field>
              <Field label="异常说明">
                <textarea className="input min-h-20" value={postClaimDescription} onChange={event => setPostClaimDescription(event.target.value)} placeholder="说明发现时间、异常表现和处理情况" />
              </Field>
            </div>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-caption">
                <thead><tr className="border-b text-left"><th className="p-2">商品</th><th className="p-2">原订购</th><th className="p-2">已收</th><th className="p-2">本次合格</th><th className="p-2">可补报上限</th><th className="p-2">本次异常数量</th></tr></thead>
                <tbody>{claimingReceipt.purchaseOrder.lines.map(orderLine => {
                  const receiptLine = claimingReceipt.lines.find(line => line.purchaseOrderLineId === orderLine.id)
                  const target = Number(orderLine.confirmedQty ?? orderLine.orderedQty)
                  const maximum = postClaimType === 'SHORTAGE'
                    ? Math.max(0, target - Number(orderLine.receivedQty || 0))
                    : Number(receiptLine?.acceptedQty || 0)
                  return <tr key={orderLine.id} className="border-b border-border">
                    <td className="p-2"><b>{orderLine.productNameSnapshot}</b><div className="text-gray3">{orderLine.productSpecSnapshot || '—'}</div></td>
                    <td className="p-2">{String(target)} {orderLine.purchaseUnit}</td>
                    <td className="p-2">{String(orderLine.receivedQty)} {orderLine.purchaseUnit}</td>
                    <td className="p-2">{String(receiptLine?.acceptedQty || 0)} {orderLine.purchaseUnit}</td>
                    <td className="p-2">{String(maximum)} {orderLine.purchaseUnit}</td>
                    <td className="p-2"><input type="number" min="0" max={maximum} step="any" disabled={maximum <= 0} className="input w-32 disabled:cursor-not-allowed disabled:bg-bg" value={postClaimQuantities[orderLine.id] || ''} onChange={event => setPostClaimQuantities(current => ({ ...current, [orderLine.id]: event.target.value }))} /></td>
                  </tr>
                })}</tbody>
              </table>
            </div>
            <div className="mt-4"><span className="mb-1 block text-micro text-gray3">图片/视频证据（必填，最多 4 个）</span><div className="flex flex-wrap items-center gap-2">{postClaimEvidence.map((item, index) => <span key={`${item.url}-${index}`} className="rounded-lg bg-bg px-3 py-2 text-caption">{item.name}<button className="ml-2 text-red-700" onClick={() => setPostClaimEvidence(current => current.filter((_, currentIndex) => currentIndex !== index))}>删除</button></span>)}<label className="cursor-pointer rounded-lg border border-dashed border-border px-3 py-2 text-caption text-gray2">{uploadingEvidence ? '上传中…' : '上传证据'}<input type="file" accept="image/*,video/*" className="hidden" disabled={uploadingEvidence || postClaimEvidence.length >= 4} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void uploadPostClaimEvidence(file) }} /></label></div></div>
            <div className="mt-4 flex justify-end"><ActionButton onClick={() => void submitPostReceiptClaim()} disabled={working === `post-claim-${claimingReceipt.id}` || uploadingEvidence}>提交补报</ActionButton></div>
          </Panel>}
          {receipts.length === 0 ? <Empty text="暂无待验收单据" /> : receipts.map(receipt => <article key={receipt.id} className="rounded-2xl border border-border bg-white p-4"><div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><div className="flex items-center gap-2"><button type="button" onClick={() => void openReceiptDetail(receipt)} className="text-h3 underline decoration-dotted underline-offset-4" aria-label={`查看收货单 ${receipt.no} 明细`}>{receipt.no}</button><Badge status={receipt.status} labels={UPSTREAM_RECEIPT_STATUS_LABEL} /></div><p className="mt-1 text-caption text-gray2">{receipt.supplier.name} · 采购单 <b>{receipt.purchaseOrder.no}</b> · 发货单 {receipt.shipment.no}</p><p className="mt-1 text-caption text-gray3">{receipt._count.lines} 项 · 采购单金额 <b>{receipt.purchaseOrder.totalAmount == null ? '—' : money(receipt.purchaseOrder.totalAmount)}</b> · 本次应付 <b>{money(receipt.payableAmount)}</b>{receipt.reviewReasons?.length ? ` · 复核：${receipt.reviewReasons.join('、')}` : ''}</p>{receipt.status === 'POSTED' && receipt._count.claims > 0 && <p className="mt-1 text-micro text-amber-fg">已关联差异单，不能整单冲销；如库存有误请走实盘调整。</p>}</div><div className="flex flex-wrap gap-2">{receipt.status === 'DRAFT' && <ActionButton onClick={() => void run(receipt.id, () => apiFetch(`/api/upstream/receipts/${receipt.id}/start-inspection`, { method: 'POST' }), '已开始验收')} disabled={working === receipt.id}>开始验收</ActionButton>}{receipt.status === 'INSPECTING' && <ActionButton onClick={() => void openReceiptDetail(receipt, 'confirm')} disabled={working === receipt.id}>查看明细并验收</ActionButton>}{receipt.status === 'PENDING_REVIEW' && <ActionButton onClick={() => void openReceiptDetail(receipt, 'review')} disabled={working === receipt.id}>查看明细并复核</ActionButton>}{receipt.status === 'POSTED' && <ActionButton tone="light" onClick={() => void openPostReceiptClaim(receipt)}>收货后补报异常</ActionButton>}{receipt.status === 'POSTED' && receipt._count.claims === 0 && <ActionButton tone="danger" onClick={() => void reverseReceipt(receipt)} disabled={working === `reverse-${receipt.id}`}>冲销收货</ActionButton>}</div></div></article>)}
        </section>}

        {!loading && tab === 'claims' && <section className="space-y-3">{claims.length === 0 ? <Empty text="暂无到货差异" /> : claims.map(claim => { const resolutionCopy = claimResolutionCopy(claim.type, money(claim.claimedAmount)); return <article key={claim.id} className="rounded-2xl border border-border bg-white p-4"><div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div><div className="flex flex-wrap items-center gap-2"><b className="text-h3">{claim.no}</b><Badge status={claim.status} labels={UPSTREAM_CLAIM_STATUS_LABEL} /><span className="text-caption text-red-700">{money(claim.claimedAmount)}</span></div><p className="mt-2 text-caption text-gray1">{claim.description}</p><div className="mt-2 flex flex-wrap gap-2 text-caption"><button type="button" onClick={() => void openOrderDetail(claim.purchaseOrder)} className="rounded-lg border border-border bg-bg px-2 py-1 underline decoration-dotted underline-offset-2">采购单 {claim.purchaseOrder.no}</button><button type="button" onClick={() => void openReceiptDetail(claim.receipt)} className="rounded-lg border border-border bg-bg px-2 py-1 underline decoration-dotted underline-offset-2">收货单 {claim.receipt.no}</button></div><ul className="mt-2 text-caption text-gray2">{claim.lines.map(line => <li key={line.id}>· {line.product.name} {String(line.affectedQty)} {line.purchaseUnit}</li>)}</ul>{claim.supplierResponse && <p className="mt-2 rounded-lg bg-bg p-2 text-caption text-gray2">供应商回复：{claim.supplierResponse}</p>}{claim.responsibility && <p className="mt-1 text-micro text-gray3">处理结果：{claim.responsibility} · {claim.resolution || '待定'}{claim.resolvedAmount != null ? ` · ${money(claim.resolvedAmount)}` : ''}</p>}</div><div className="flex gap-2">{claim.status === 'SUPPLIER_REJECTED' && <ActionButton tone="danger" onClick={() => void run(claim.id, () => apiFetch(`/api/upstream/arrival-claims/${claim.id}/start-arbitration`, { method: 'POST' }), '差异已进入仲裁')} disabled={working === claim.id}>转仲裁</ActionButton>}{['SUPPLIER_ACCEPTED', 'AUTO_ACCEPTED', 'ARBITRATION'].includes(claim.status) && <ActionButton onClick={() => window.confirm(resolutionCopy.confirmation) && void run(claim.id, () => apiFetch(`/api/upstream/arrival-claims/${claim.id}/resolve`, { method: 'POST', body: JSON.stringify({ responsibility: 'SUPPLIER', resolution: 'DEDUCTION', resolvedAmount: Number(claim.claimedAmount) }) }), '差异已办结并进入对账')} disabled={working === claim.id}>{resolutionCopy.button}</ActionButton>}</div></div></article> })}</section>}

        {!loading && tab === 'settlements' && <section className="space-y-4">
          {viewingStatement && <Panel title={`对账单明细 · ${viewingStatement.no}`} onClose={() => setViewingStatement(null)}>
            <div className="rounded-xl bg-bg p-3 text-caption">{viewingStatement.supplier.name} · {shortDate(viewingStatement.periodStart)}—{shortDate(viewingStatement.periodEnd)} · 应付 <b>{money(viewingStatement.payableAmount)}</b></div>
            <div className="mt-4 overflow-x-auto"><table className="w-full text-left text-caption"><thead><tr className="border-b"><th className="p-2">日期</th><th className="p-2">来源</th><th className="p-2">采购单</th><th className="p-2">收货/差异单</th><th className="p-2">说明</th><th className="p-2">原金额</th><th className="p-2">调整</th><th className="p-2">应付</th></tr></thead><tbody>{viewingStatement.lines.map(line => {
              const purchaseOrder = line.receiptLine?.receipt?.purchaseOrder || line.claim?.purchaseOrder
              const receipt = line.receiptLine?.receipt || line.claim?.receipt
              return <tr key={line.id} className="border-b border-border"><td className="p-2">{shortDate(line.businessDate)}</td><td className="p-2">{settlementLineTypeLabel(line.sourceType, line.adjustmentAmount)}</td><td className="p-2">{purchaseOrder ? <button type="button" className="underline decoration-dotted" onClick={() => void openOrderDetail(purchaseOrder)}>{purchaseOrder.no}</button> : '—'}</td><td className="p-2"><div className="flex flex-col items-start gap-1">{receipt ? <button type="button" className="underline decoration-dotted" onClick={() => void openReceiptDetail(receipt)}>收货单 {receipt.no}</button> : null}{line.claim ? <button type="button" className="underline decoration-dotted" onClick={() => { setViewingStatement(null); setTab('claims') }}>差异单 {line.claim.no}</button> : !receipt ? <span>{line.sourceNo}</span> : null}</div></td><td className="p-2">{line.description}</td><td className="p-2">{money(line.originalAmount)}</td><td className="p-2">{money(line.adjustmentAmount)}</td><td className="p-2"><b>{money(line.payableAmount)}</b></td></tr>
            })}</tbody></table></div>
          </Panel>}
          <Panel title="生成月度对账单"><div className="grid gap-3 sm:grid-cols-4"><Field label="供应商"><select className="input" value={settlementForm.supplierId} onChange={event => setSettlementForm(value => ({ ...value, supplierId: event.target.value }))}>{suppliers.map(supplier => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}</select></Field><Field label="开始日期"><input className="input" type="date" value={settlementForm.periodStart} onChange={event => setSettlementForm(value => ({ ...value, periodStart: event.target.value }))} /></Field><Field label="结束日期"><input className="input" type="date" value={settlementForm.periodEnd} onChange={event => setSettlementForm(value => ({ ...value, periodEnd: event.target.value }))} /></Field><div className="flex items-end"><ActionButton onClick={() => void run('generate-statement', () => apiFetch('/api/upstream/settlement-statements/generate', { method: 'POST', body: JSON.stringify(settlementForm) }), '对账单已生成')} disabled={working === 'generate-statement'}>生成对账单</ActionButton></div></div></Panel>
          {statements.length === 0 ? <Empty text="暂无对账单" /> : statements.map(statement => <article key={statement.id} className="rounded-2xl border border-border bg-white p-4"><div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><div className="flex items-center gap-2"><button type="button" onClick={() => void openStatementDetail(statement)} className="text-h3 underline decoration-dotted underline-offset-4">{statement.no}</button><Badge status={statement.status} labels={UPSTREAM_SETTLEMENT_STATUS_LABEL} /></div><p className="mt-1 text-caption text-gray2">{statement.supplier.name} · {shortDate(statement.periodStart)}—{shortDate(statement.periodEnd)} · V{statement.version}</p><p className="mt-1 text-caption text-gray3">收货 {money(statement.receiptAmount)} · 扣款 {money(statement.deductionAmount)} · 应付 <b>{money(statement.payableAmount)}</b></p>{statement.status === 'CONFIRMED' && <p className="mt-1 text-micro text-amber-fg">供应商已确认，等待财务锁定。</p>}</div><div className="flex gap-2"><ActionButton tone="light" onClick={() => void openStatementDetail(statement)}>查看来源明细</ActionButton>{statement.status === 'DRAFT' || statement.status === 'DISPUTED' ? <ActionButton onClick={() => void run(statement.id, () => apiFetch(`/api/upstream/settlement-statements/${statement.id}/send`, { method: 'POST' }), '对账单已发送供应商')} disabled={working === statement.id}>发送供应商</ActionButton> : null}</div></div></article>)}
        </section>}

        {!loading && tab === 'contracts' && <section className="space-y-4">{viewingContract && <Panel title={`合同内容 · ${viewingContract.title}`} onClose={() => setViewingContract(null)}><div className="grid gap-2 rounded-xl bg-bg p-3 text-caption sm:grid-cols-2 lg:grid-cols-4"><div><span className="text-gray3">合同编号</span><div>{viewingContract.contractNo}</div></div><div><span className="text-gray3">供应商</span><div>{viewingContract.supplier.name}</div></div><div><span className="text-gray3">版本 / 状态</span><div>V{viewingContract.version} · {{ DRAFT: '草稿', ACTIVE: '生效中', TERMINATED: '已终止' }[viewingContract.status] || viewingContract.status}</div></div><div><span className="text-gray3">有效期</span><div>{shortDate(viewingContract.startsAt)} — {viewingContract.endsAt ? shortDate(viewingContract.endsAt) : '长期'}</div></div><div><span className="text-gray3">结算方式</span><div>{contractSettlementText(viewingContract)}</div></div><div><span className="text-gray3">价格口径</span><div>{viewingContract.taxInclusive ? '含税价' : '不含税价'}</div></div><div><span className="text-gray3">币种</span><div>{viewingContract.currency}</div></div><div><span className="text-gray3">付款方式</span><div>{viewingContract.paymentMethod || '—'}</div></div></div><div className="mt-4 overflow-x-auto"><table className="w-full text-left text-caption"><thead><tr className="border-b"><th className="p-2">商品</th><th className="p-2">编码</th><th className="p-2">规格</th><th className="p-2">供应商编码</th><th className="p-2">采购单位</th><th className="p-2">库存换算</th><th className="p-2">合同单价</th><th className="p-2">税率</th><th className="p-2">起订量</th><th className="p-2">包装倍数</th><th className="p-2">交期</th><th className="p-2">短/溢装</th></tr></thead><tbody>{viewingContract.lines.map(line => <tr key={line.id} className="border-b border-border"><td className="p-2"><b>{line.productNameSnapshot}</b></td><td className="p-2">{line.productCodeSnapshot}</td><td className="p-2">{line.productSpecSnapshot || '—'}</td><td className="p-2">{line.supplierSkuSnapshot || '—'}</td><td className="p-2">{line.purchaseUnit}</td><td className="p-2">1 {line.purchaseUnit} = {String(line.inventoryUnitsPerPurchaseUnit)} {line.inventoryUnit}</td><td className="p-2"><b>{money(line.unitPrice)}</b></td><td className="p-2">{formatPercent(line.taxRate)}</td><td className="p-2">{String(line.minOrderQty)}</td><td className="p-2">{String(line.packageMultiple)}</td><td className="p-2">{line.leadTimeDays} 天</td><td className="p-2">{formatPercent(line.shortTolerancePct)} / {formatPercent(line.overTolerancePct)}</td></tr>)}</tbody></table></div></Panel>}<div className="flex justify-end"><ActionButton onClick={() => setShowContractForm(value => !value)}>{showContractForm ? '收起' : '新建合同'}</ActionButton></div>{showContractForm && <Panel title="新建月结合同"><div className="grid gap-3 md:grid-cols-4"><Field label="供应商"><select className="input" value={contractSupplierId} onChange={event => void loadSources(event.target.value)}><option value="">请选择</option>{suppliers.map(supplier => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}</select></Field><Field label="合同编号"><input className="input" value={contractForm.contractNo} onChange={event => setContractForm(value => ({ ...value, contractNo: event.target.value }))} placeholder="例如 HT202609-01" /></Field><Field label="合同名称"><input className="input" value={contractForm.title} onChange={event => setContractForm(value => ({ ...value, title: event.target.value }))} placeholder="例如 2026年食材供货合同" /></Field><Field label="生效日"><input className="input" type="date" value={contractForm.startsAt} onChange={event => setContractForm(value => ({ ...value, startsAt: event.target.value }))} /></Field></div><div className="mt-4 overflow-x-auto"><table className="w-full text-caption"><thead><tr className="border-b text-left"><th className="p-2">商品</th><th className="p-2">采购单位</th><th className="p-2">库存换算</th><th className="p-2">含税单价（留空不纳入）</th></tr></thead><tbody>{sources.map(source => <tr key={source.id} className="border-b border-border"><td className="p-2"><b>{source.product.name}</b><div className="text-gray3">{source.product.code} · {source.product.spec || '—'}</div></td><td className="p-2">{source.purchaseUnit}</td><td className="p-2">1 {source.purchaseUnit} = {String(source.inventoryUnitsPerPurchaseUnit)} {source.product.inventoryUnit || source.product.unit}</td><td className="p-2"><input className="input w-36" type="number" min="0" step="0.01" value={sourcePrices[source.id] || ''} onChange={event => setSourcePrices(value => ({ ...value, [source.id]: event.target.value }))} /></td></tr>)}</tbody></table>{contractSupplierId && sources.length === 0 && <p className="p-4 text-caption text-gray3">该供应商尚未绑定可采购商品，请先在“商品管理”维护商品供应商。</p>}</div><div className="mt-4 flex justify-end"><ActionButton onClick={() => void createContract()} disabled={working === 'create-contract'}>保存合同草稿</ActionButton></div></Panel>}{contracts.length === 0 ? <Empty text="暂无合同" /> : contracts.map(contract => <article key={contract.id} className="rounded-2xl border border-border bg-white p-4"><div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><div className="flex items-center gap-2"><button type="button" onClick={() => setViewingContract(contract)} className="text-left text-h3 underline decoration-dotted underline-offset-4" aria-label={`查看合同 ${contract.title} 内容`}>{contract.contractNo} · {contract.title}</button><Badge status={contract.status} labels={{ DRAFT: '草稿', ACTIVE: '生效中', TERMINATED: '已终止' }} /></div><p className="mt-1 text-caption text-gray2">{contract.supplier.name} · V{contract.version} · {contract.lines.length} 个商品 · {shortDate(contract.startsAt)} 起</p></div><div className="flex gap-2"><ActionButton tone="light" onClick={() => setViewingContract(contract)}>查看合同内容</ActionButton>{contract.status === 'DRAFT' && <ActionButton onClick={() => window.confirm('确认合同价格及换算无误并正式启用？') && void run(contract.id, () => apiFetch(`/api/upstream/contracts/${contract.id}/activate`, { method: 'POST' }), '合同已启用')} disabled={working === contract.id}>启用合同</ActionButton>}</div></div></article>)}</section>}
      </main>
      <ConfirmSheet {...revisionRejectConfirm} />
    </div>
  )
}

function shipmentFullyInspected(shipment: Shipment): boolean {
  // 每一行发货数量的「实到+短少」都已入账, 视为收完 — 不再显示「登记到货」
  return shipment.lines.length > 0 && shipment.lines.every(line => {
    const inspected = (line.receiptLines || []).reduce((sum, item) => sum + Number(item.arrivedQty) + Number(item.shortageQty), 0)
    return inspected + 0.000001 >= Number(line.shippedQty)
  })
}

function revisionComparison(order: Order, revision: NonNullable<Order['revisions']>[number]) {
  const before = new Map((revision.beforeSnapshot?.lines || []).map(line => [line.id, Number(line.quantity)]))
  const after = new Map((revision.afterSnapshot?.lines || []).map(line => [line.id, Number(line.quantity)]))
  return (order.lines || []).map(line => {
    const beforeQuantity = before.get(line.id) ?? Number(line.orderedQty)
    const afterQuantity = after.get(line.id) ?? beforeQuantity
    return {
      id: line.id,
      name: line.productNameSnapshot,
      spec: line.productSpecSnapshot,
      unit: line.purchaseUnit,
      before: beforeQuantity,
      after: afterQuantity,
      delta: Number((afterQuantity - beforeQuantity).toFixed(6)),
      changed: Math.abs(afterQuantity - beforeQuantity) > 0.000001,
    }
  })
}

function formatPercent(value: string | number | null | undefined) {
  if (value == null || value === '') return '—'
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return '—'
  return `${Number((numeric * 100).toFixed(4))}%`
}

function contractSettlementText(contract: Contract) {
  const cycle = ({ MONTHLY: '月结', FIXED_DAYS: '固定账期', WEEKLY: '周结', ON_DELIVERY: '货到结算' } as Record<string, string>)[contract.settlementCycle] || contract.settlementCycle
  return contract.settlementDays > 0 ? `${cycle} · ${contract.settlementDays} 天` : cycle
}

function Summary({ label, value, danger }: { label: string; value: number; danger?: boolean }) {
  return <div className="rounded-2xl border border-border bg-white p-4"><div className="text-caption text-gray3">{label}</div><div className={`mt-1 text-[28px] font-bold ${danger ? 'text-red-700' : 'text-gray1'}`}>{value}</div></div>
}

function Empty({ text }: { text: string }) {
  return <div className="rounded-2xl border border-dashed border-border bg-white p-10 text-center text-caption text-gray3">{text}</div>
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block"><span className="mb-1 block text-micro text-gray3">{label}</span>{children}</label>
}

function Panel({ title, children, onClose }: { title: string; children: ReactNode; onClose?: () => void }) {
  return <div className="rounded-2xl border border-amber/30 bg-white p-4 shadow-sm"><div className="mb-4 flex items-center justify-between"><h2 className="text-h3">{title}</h2>{onClose && <button onClick={onClose} className="text-caption text-gray3">关闭</button>}</div>{children}</div>
}
