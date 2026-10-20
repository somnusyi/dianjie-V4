'use client'
import { procurementDecimalProduct } from '@/lib/procurement-decimal-preview'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { apiFetch, getUser } from '@/lib/v2-auth'
import { ProcurementProgressActions } from '@/components/v2/procurement-progress-actions'
import {DocumentQualityImageButton,OrderLineQuality,LegacyQualityImagesButton} from '@/components/v2/document-quality-image'
import { procurementApprovalRequest, type ProcurementApprovalSource, type ProcurementApprovalAction } from '@/lib/procurement-approval'
import { claimResolutionCopy, settlementLineTypeLabel } from '@/lib/upstream-settlement-copy'
import { clientRequestId } from '@/lib/client-id'
import { ConfirmSheet, useConfirmSheet } from '@/components/v2/confirm-sheet'
import { SUPPLY_CHAIN_BEFORE_NAVIGATE_EVENT } from '@/components/v2/supply-chain-shell'
import { printSheet } from './print-sheet'
import { contractCopyPayload, validContractPrice } from '@/lib/upstream-contract-copy'
import {contractCopyScope,readContractCopyAttempt,persistContractCopyAttempt,clearContractCopyAttempt,copyRecoverySources,type StoredCopyOriginal} from '@/lib/contract-copy-recovery'
import {purchaseOrderOverdueText} from '@/lib/purchase-order-overdue'
import {showTableReport} from '@/lib/table-report'
import {procurementDocumentReport} from '@/lib/procurement-document-report'
import {
  currentMonthRange,
  loadCreatedRecord,
  money,
  unitPriceMoney,
  receiptReviewActionForStatus,
  shortDate,
  statusTone,
  UPSTREAM_CLAIM_STATUS_LABEL,
  UPSTREAM_ORDER_STATUS_LABEL,
  UPSTREAM_RECEIPT_STATUS_LABEL,
  UPSTREAM_SETTLEMENT_STATUS_LABEL,
} from '@/lib/upstream-procurement'

type OrderFilters = {dateField: 'createdAt' | 'expectedArrivalAt'; dateFrom: string; dateTo: string; supplierId: string; productQuery: string}
const EMPTY_ORDER_FILTERS: OrderFilters = {dateField:'createdAt',dateFrom:'',dateTo:'',supplierId:'',productQuery:''}

type Tab = 'orders' | 'receipts' | 'returns' | 'claims' | 'settlements' | 'contracts' | 'standards'
type Supplier = { id: string; no: string; name: string }
type Warehouse = { id: string; code: string; name: string }
type Source = {
  id: string
  supplierId: string
  purchaseUnit: string
  quotedUnitPrice: string | number | null
  leadTimeDays?: number
  minOrderQty: string | number
  inventoryUnitsPerPurchaseUnit: string | number
  product: { id: string; code: string; name: string; spec?: string | null; inventoryUnit?: string | null; unit: string }
}
type ContractLine = Source & {
  upstreamSourceId?: string | null
  isActive?: boolean
  productId: string
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
  standardUnitPriceSnapshot?: string | number | null
  priceStandardCurrencySnapshot?: string | null
  priceStandardTaxInclusiveSnapshot?: boolean | null
  priceStandardVersionSnapshot?: number | null
  qualityStandardId?: string | null
  qualityStandardVersionSnapshot?: number | null
  qualityCriteriaSnapshot?: Record<string, unknown> | null
}
type Order = {
  rowVersion?: number
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
  purchaseOrderLine: {
    productId: string
    productNameSnapshot: string
    productSpecSnapshot?: string | null
    unitPrice: string | number
    standardUnitPriceSnapshot?: string | number | null
    priceStandardCurrencySnapshot?: string | null
    priceStandardTaxInclusiveSnapshot?: boolean | null
    qualityStandardId?: string | null
    qualityStandardVersionSnapshot?: number | null
    qualityCriteriaSnapshot?: Record<string, unknown> | null
  }
  receiptLines?: Array<{ arrivedQty: string | number; shortageQty: string | number }>
}
type Shipment = {
  id: string
  no: string
  status: string
  supplierId: string
  purchaseOrder: { id: string; no: string; status: string; expectedArrivalAt?: string | null; currency?: string }
  lines: ShipmentLine[]
}
type Receipt = ProcurementApprovalSource & {
  id: string
  no: string
  status: string
  payableAmount: string | number
  supplier: Supplier
  purchaseOrder: { id: string; no: string; status: string; currency?: string; totalAmount?: string | number; amountWithoutTax?: string | number }
  shipment: { id: string; no: string; status: string } | null
  reviewReasons?: string[]
  postedAt?: string | null
  createdAt: string
  _count: { lines: number; claims: number }
}
type ReceiptDetail = Receipt & {
  canApprovePriceException?: boolean
  supplier: Supplier & { postReceiptClaimHours: number }
  purchaseOrder: Receipt['purchaseOrder'] & { lines: OrderLine[] }
  evidenceCompleteness?: {
    businessLicense: { status: 'COMPLETE' | 'MISSING' }
    missingCount: number
    pendingConfigurationCount: number
    blocksPosting: false
    lines: Array<{ receiptLineId: string; productName: string; status: 'PENDING_CONFIGURATION' | 'NOT_REQUIRED' | 'COMPLETE' | 'MISSING'; missingTypes: ReceiptEvidenceType[] }>
  }
  evidenceCompletenessSnapshot?: { missingCount?: number; pendingConfigurationCount?: number } | null
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
    standardUnitPriceSnapshot?: string | number | null
    priceStandardCurrencySnapshot?: string | null
    priceStandardTaxInclusiveSnapshot?: boolean | null
    priceStandardVersionSnapshot?: number | null
    qualityStandardId?: string | null
    qualityStandardVersionSnapshot?: number | null
    qualityCriteriaSnapshot?: Record<string, unknown> | null
    qualityResult?: 'PASS' | 'FAIL' | null
    qualityEvidence?: Array<{ name: string; mime: string; size: number; url?: string | null }> | null
    qualityDisposition?: string | null
    payableAmount?: string | number
    purchaseOrderLine: {
      productCodeSnapshot: string
      productNameSnapshot: string
      productSpecSnapshot?: string | null
    }
  }>
}

type ReceiptEvidenceType = 'QUARANTINE_CERTIFICATE' | 'INSPECTION_REPORT' | 'SLAUGHTER_CERTIFICATE' | 'PRODUCTION_INSPECTION_REPORT' | 'THIRD_PARTY_TEST_REPORT' | 'PESTICIDE_RESIDUE_REPORT' | 'OTHER_PRODUCT_EVIDENCE'
const RECEIPT_EVIDENCE_TYPE_LABEL: Record<ReceiptEvidenceType, string> = {
  QUARANTINE_CERTIFICATE: '检疫证明',
  INSPECTION_REPORT: '检验检测报告',
  SLAUGHTER_CERTIFICATE: '屠宰证',
  PRODUCTION_INSPECTION_REPORT: '生产检验报告',
  THIRD_PARTY_TEST_REPORT: '第三方检测报告',
  PESTICIDE_RESIDUE_REPORT: '蔬菜农残报告',
  OTHER_PRODUCT_EVIDENCE: '其他产品随货资料',
}
type ReturnableReceiptLine = {
  id: string
  acceptedQty: string | number
  returnableQuantity: string | number
  purchaseUnit: string
  unitPrice: string | number
  product: { id: string; code: string; name: string; spec?: string | null }
  receipt: { id: string; no: string; supplierId: string; warehouseId: string; postedAt?: string | null; supplier: Supplier; warehouse: Warehouse }
}
type PurchaseReturn = ProcurementApprovalSource & {
  id: string
  no: string
  status: 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'RECEIVED' | 'REJECTED' | 'CANCELLED'
  reason: string
  note?: string | null
  settlementAmount: string | number
  ledgerCostAmount: string | number
  createdAt: string
  approvedAt?: string | null
  receivedAt?: string | null
  supplier: Supplier
  warehouse: Warehouse
  lines: Array<{
    id: string
    receiptLineId: string
    purchaseQuantity: string | number
    purchaseUnit: string
    inventoryQuantity: string | number
    inventoryUnit: string
    settlementUnitPrice: string | number
    settlementAmount: string | number
    product: { id: string; code: string; name: string; spec?: string | null }
    receiptLine: { id: string; receiptId: string; receipt: { no: string } }
  }>
}
type PurchaseReturnCreateResult = { replayed: boolean; purchaseReturn: PurchaseReturn }
type RevisionSnapshot = {
  expectedArrivalAt?: string | null
  lines?: Array<{ id: string; quantity: string | number; unitPrice?: string | number }>
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
  evidence?: Array<Record<string, unknown>> | null
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

type QualityStandard = {
  id: string
  productId: string
  version: number
  title: string
  criteria: Record<string, unknown>
  effectiveAt: string
  active: boolean
  createdByName: string
  archivedAt?: string | null
  product: { id: string; code: string; name: string; spec?: string | null }
}

type PriceStandard = {
  id: string
  productId: string
  supplierId: string
  version: number
  purchaseUnit: string
  currency: string
  taxInclusive: boolean
  unitPrice: string | number
  effectiveAt: string
  active: boolean
  createdByName: string
  archivedAt?: string | null
  product: { id: string; code: string; name: string; spec?: string | null }
  supplier: Supplier
}

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'orders', label: '采购单' },
  { key: 'receipts', label: '到货验收' },
  { key: 'returns', label: '采购退货' },
  { key: 'claims', label: '到货差异' },
  { key: 'settlements', label: '月度对账' },
  { key: 'contracts', label: '合同与价格' },
  { key: 'standards', label: '价格与质量标准' },
]

const RECEIPT_REVIEW_REASON_LABEL: Record<string, string> = {
  AMOUNT_THRESHOLD: '金额达到复核阈值',
  OVER_RECEIPT: '存在超收',
  TEMPORARY_PRICE: '使用临时价',
  ABOVE_STANDARD_PRICE: '实际采购价高于标准价',
  SENSITIVE_CATEGORY: '敏感品类',
}

function qualityCriteriaText(criteria: Record<string, unknown> | null | undefined) {
  if (!criteria) return '—'
  if (typeof criteria.description === 'string') return criteria.description
  return Object.entries(criteria).map(([key, value]) => `${key}：${typeof value === 'string' ? value : JSON.stringify(value)}`).join('；')
}

function currencyAmount(value: string | number, currency = 'CNY') {
  return `${currency} ${Number(value).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 6, useGrouping: false })}`
}

function shanghaiBusinessDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

function Badge({ status, labels }: { status: string; labels: Record<string, string> }) {
  return <span className={`rounded-full px-2.5 py-1 text-micro font-medium ${statusTone(status)}`}>{labels[status] || status}</span>
}

function ActionButton({ children, onClick, disabled, tone = 'dark' }: { children: ReactNode; onClick: () => void; disabled?: boolean; tone?: 'dark' | 'light' | 'danger' }) {
  const colors = tone === 'dark' ? 'bg-gray1 text-white' : tone === 'danger' ? 'border-red-200 text-red-700' : 'border-border bg-white text-gray1'
  return (
    <button disabled={disabled} onClick={onClick} className={`rounded-lg border px-3 py-2 text-caption font-medium disabled:cursor-not-allowed disabled:opacity-40 ${colors}`}>
      {children}
    </button>
  )
}

export default function UpstreamProcurementPage() {
  const [tab, setTab] = useState<Tab>('orders')
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get('tab') as Tab | null
    if (TABS.some(item => item.key === requested)) setTab(requested!)
  }, [])
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [noticeAction, setNoticeAction] = useState<{
    label: string
    run: () => void
  } | null>(null)
  const [revisionRejectConfirm, openRevisionRejectConfirm] = useConfirmSheet()
  const [actionConfirm, openActionConfirm] = useConfirmSheet()
  const [orders, setOrders] = useState<Order[]>([])
  const [orderFilterDraft, setOrderFilterDraft] = useState<OrderFilters>(EMPTY_ORDER_FILTERS)
  const [orderFilters, setOrderFilters] = useState<OrderFilters>(EMPTY_ORDER_FILTERS)
  const [orderPage, setOrderPage] = useState(1)
  const [orderTotal, setOrderTotal] = useState(0)
  const orderListRequestRef = useRef(0)
  const loadAllRequestRef = useRef(0)
  const [shipments, setShipments] = useState<Shipment[]>([])
  const [receipts, setReceipts] = useState<Receipt[]>([])
  const [purchaseReturns, setPurchaseReturns] = useState<PurchaseReturn[]>([])
  const [claims, setClaims] = useState<Claim[]>([])
  const [statements, setStatements] = useState<Statement[]>([])
  const [contracts, setContracts] = useState<Contract[]>([])
  const [qualityStandards, setQualityStandards] = useState<QualityStandard[]>([])
  const [priceStandards, setPriceStandards] = useState<PriceStandard[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [sources, setSources] = useState<Source[]>([])
  const [contractSupplierId, setContractSupplierId] = useState('')
  const [contractSupplierQuery, setContractSupplierQuery] = useState('')
  const [contractCopy, setContractCopy] = useState<Contract | null>(null)
  const [contractCopyLoading, setContractCopyLoading] = useState(false)
  const [contractCopyPending, setContractCopyPending] = useState(false)
  const contractCopyEpoch = useRef(0)
  const contractCopyBusy = useRef(false)
  const contractCopyAttempt = useRef<{ body: string; key: string } | null>(null)
  const contractCopyKey = useRef(clientRequestId())
  const [contractCopyRecoveryBlocked,setContractCopyRecoveryBlocked]=useState(false)
  const contractCopyCacheScope=useRef<string|null>(null)
  const [showContractForm, setShowContractForm] = useState(false)
  const [showOrderForm, setShowOrderForm] = useState(false)
  const [contractForm, setContractForm] = useState({
    contractNo: '',
    title: '',
    startsAt: shanghaiBusinessDate(),
  })
  const [sourcePrices, setSourcePrices] = useState<Record<string, string>>({})
  const [orderSupplierId, setOrderSupplierId] = useState('')
  const [orderContractId, setOrderContractId] = useState('')
  const [orderWarehouseId, setOrderWarehouseId] = useState('')
  const [orderArrival, setOrderArrival] = useState('')
  const [orderQuantities, setOrderQuantities] = useState<Record<string, string>>({})
  const [orderProductQuery, setOrderProductQuery] = useState('')
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
  const [viewingPurchaseReturn, setViewingPurchaseReturn] = useState<PurchaseReturn | null>(null)
  const [quickContractFromOrder, setQuickContractFromOrder] = useState(false)
  const deepLinkOpened = useRef(false)
  const orderRequestKeyRef = useRef(clientRequestId())
  const approvalRequestsRef = useRef<Record<string, string>>({})
  const approvalBusyRef = useRef(false)
  const postClaimRequestKeysRef = useRef<Record<string, string>>({})
  const contractRequestKeyRef = useRef(clientRequestId())
  const qualityStandardRequestKeyRef = useRef(clientRequestId())
  const priceStandardRequestKeyRef = useRef(clientRequestId())
  const sourceRequestRef = useRef(0)
  const month = useMemo(() => currentMonthRange(), [])
  const [settlementForm, setSettlementForm] = useState({
    supplierId: '',
    periodStart: month.start,
    periodEnd: month.end,
  })
  const [qualityStandardForm, setQualityStandardForm] = useState({
    productId: '',
    title: '',
    criteria: '',
    effectiveAt: shanghaiBusinessDate(),
  })
  const [priceScopeKey, setPriceScopeKey] = useState('')
  const [priceStandardForm, setPriceStandardForm] = useState({
    unitPrice: '',
    effectiveAt: shanghaiBusinessDate(),
  })
  const standardScopes = useMemo(() => {
    const seen = new Set<string>()
    return contracts.flatMap((contract) => contract.lines.map((line) => ({
      key: `${contract.supplierId}|${line.productId}|${line.purchaseUnit}|${contract.currency}|${contract.taxInclusive}`,
      supplierId: contract.supplierId,
      supplierName: contract.supplier.name,
      productId: line.productId,
      productCode: line.productCodeSnapshot,
      productName: line.productNameSnapshot,
      productSpec: line.productSpecSnapshot,
      purchaseUnit: line.purchaseUnit,
      currency: contract.currency,
      taxInclusive: contract.taxInclusive,
    }))).filter((scope) => {
      if (seen.has(scope.key)) return false
      seen.add(scope.key)
      return true
    })
  }, [contracts])
  const standardProducts = useMemo(() => {
    const seen = new Set<string>()
    return standardScopes.filter((scope) => {
      if (seen.has(scope.productId)) return false
      seen.add(scope.productId)
      return true
    })
  }, [standardScopes])

  const loadOrders = useCallback(async () => {
    const request = ++orderListRequestRef.current
    const query = new URLSearchParams({paginated:'true', page:String(orderPage), pageSize:'20', dateField:orderFilters.dateField})
    for (const key of ['dateFrom','dateTo','supplierId','productQuery'] as const) if (orderFilters[key].trim()) query.set(key, orderFilters[key].trim())
    const result = await apiFetch<{items:Order[];total:number}>(`/api/upstream/purchase-orders?${query}`)
    if (request !== orderListRequestRef.current) return
    setOrders(result.items)
    setOrderTotal(result.total)
    if (orderPage > 1 && orderPage > Math.max(1, Math.ceil(result.total / 20))) setOrderPage(Math.max(1, Math.ceil(result.total / 20)))
  }, [orderPage, orderFilters])

  const loadAll = useCallback(async () => {
    const request = ++loadAllRequestRef.current
    setLoading(true)
    setError(null)
    try {
      const [, shipmentRows, receiptRows, returnRows, claimRows, statementRows, contractRows, qualityRows, priceRows, setup] = await Promise.all([
        loadOrders(),
        apiFetch<Shipment[]>('/api/upstream/shipments'),
        apiFetch<Receipt[]>('/api/upstream/receipts'),
        apiFetch<PurchaseReturn[]>('/api/upstream/purchase-returns'),
        apiFetch<Claim[]>('/api/upstream/arrival-claims'),
        apiFetch<Statement[]>('/api/upstream/settlement-statements'),
        apiFetch<Contract[]>('/api/upstream/contracts'),
        apiFetch<QualityStandard[]>('/api/upstream/quality-standards?includeArchived=1'),
        apiFetch<PriceStandard[]>('/api/upstream/price-standards?includeArchived=1'),
        apiFetch<{ suppliers: Supplier[]; warehouses: Warehouse[] }>('/api/upstream/setup-options'),
      ])
      if (request !== loadAllRequestRef.current) return
      setShipments(shipmentRows)
      setReceipts(receiptRows)
      setPurchaseReturns(returnRows)
      setClaims(claimRows)
      setStatements(statementRows)
      setContracts(contractRows)
      setQualityStandards(qualityRows)
      setPriceStandards(priceRows)
      setSuppliers(setup.suppliers)
      setWarehouses(setup.warehouses)
      setOrderWarehouseId((value) => value || setup.warehouses[0]?.id || '')
      setOrderSupplierId((value) => value || setup.suppliers[0]?.id || '')
      setSettlementForm((value) => ({
        ...value,
        supplierId: value.supplierId || setup.suppliers[0]?.id || '',
      }))
    } catch (reason: any) {
      if (request !== loadAllRequestRef.current) return
      setOrders([])
      setOrderTotal(0)
      setError(reason?.message || '上游采购数据加载失败')
    } finally {
      if (request === loadAllRequestRef.current) setLoading(false)
    }
  }, [loadOrders])

  useEffect(() => {
    void loadAll()
  }, [loadAll])

  useEffect(() => {
    if (loading || deepLinkOpened.current) return
    const query = new URLSearchParams(window.location.search)
    const orderId = query.get('order') || query.get('orderId')
    const receiptId = query.get('receipt') || query.get('receiptId')
    const returnId = query.get('return') || query.get('returnId')
    const claimId = query.get('claim') || query.get('claimId')
    const statementId = query.get('statement') || query.get('statementId')
    const contractId = query.get('contract') || query.get('contractId')
    if (!orderId && !receiptId && !returnId && !claimId && !statementId && !contractId) return

    deepLinkOpened.current = true
    if (orderId) {
      setTab('orders')
      void openOrderDetail({ id: orderId })
      return
    }
    if (receiptId) {
      const receipt = receipts.find((item) => item.id === receiptId)
      setTab('receipts')
      void openReceiptDetail({ id: receiptId }, receiptReviewActionForStatus(receipt?.status || ''))
      return
    }
    if (returnId) {
      setTab('returns')
      void apiFetch<PurchaseReturn>(`/api/upstream/purchase-returns/${returnId}`).then(setViewingPurchaseReturn).catch((reason: any) => setError(reason?.message || '采购退货单加载失败'))
      return
    }
    if (claimId) {
      focusRecord('claims', `arrival-claim-${claimId}`)
      return
    }
    if (statementId) {
      setTab('settlements')
      void openStatementDetail({ id: statementId } as Statement)
      return
    }
    if (contractId) {
      setTab('contracts')
      const row = contracts.find((item) => item.id === contractId)
      if (row) setViewingContract(row)
      else setError('未找到链接对应的合同')
    }
  }, [loading])

  useEffect(() => {
    const dirty = showOrderForm || showContractForm
      || Boolean(qualityStandardForm.productId || qualityStandardForm.title || qualityStandardForm.criteria)
      || Boolean(priceScopeKey || priceStandardForm.unitPrice)
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    const warnInternalNavigation = (event: Event) => {
      event.preventDefault()
      const proceed = (event as CustomEvent<{ proceed?: () => void }>).detail?.proceed
      openActionConfirm({
        title: '放弃未提交的内容？',
        body: '当前页面有尚未提交的采购、价格或质量验收内容。离开后将不会保留。',
        confirmLabel: '放弃并离开',
        tone: 'danger',
        onConfirm: () => proceed?.(),
      })
    }
    window.addEventListener('beforeunload', warn)
    window.addEventListener(SUPPLY_CHAIN_BEFORE_NAVIGATE_EVENT, warnInternalNavigation)
    return () => {
      window.removeEventListener('beforeunload', warn)
      window.removeEventListener(SUPPLY_CHAIN_BEFORE_NAVIGATE_EVENT, warnInternalNavigation)
    }
  }, [showOrderForm, showContractForm, qualityStandardForm, priceScopeKey, priceStandardForm.unitPrice, openActionConfirm])

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

  async function run<T>(key: string, task: () => Promise<T>, success: string, onSuccess?: (result: T) => void | Promise<void>, rethrow = false) {
    setWorking(key)
    setError(null)
    setNotice(null)
    setNoticeAction(null)
    try {
      const result = await task()
      setNotice(success)
      await loadAll()
      await onSuccess?.(result)
      if (!onSuccess && key === 'generate-statement' && result && typeof result === 'object' && 'id' in result) {
        const statement = result as unknown as Statement
        focusRecord('settlements', `statement-${statement.id}`)
        setNoticeAction({
          label: '查看对账单',
          run: () => void openStatementDetail(statement),
        })
      }
      return true
    } catch (reason: any) {
      const message = reason?.message || '操作失败'
      setError(message)
      if (rethrow) throw new Error(message)
      return false
    } finally {
      setWorking(null)
    }
  }

  useEffect(() => () => { contractCopyEpoch.current += 1 }, [])

  function currentContractCopyScope(){
    try{return contractCopyScope(JSON.parse(localStorage.getItem('tenant')||'null')?.id,getUser()?.id)}catch{return null}
  }
  useEffect(()=>{
    const scope=currentContractCopyScope()
    if(!scope)return
    let recovered:ReturnType<typeof readContractCopyAttempt>
    try{recovered=readContractCopyAttempt(sessionStorage,scope)}catch{setContractCopyRecoveryBlocked(true);setError('浏览器存储不可用，请允许本页存储后核对原合同');return}
    if(recovered.status==='empty')return
    if(recovered.status==='blocked'){setContractCopyRecoveryBlocked(true);setError(recovered.message);return}
    const attempt=recovered.attempt,original=attempt.original as unknown as Contract,payload=JSON.parse(attempt.body)
    contractCopyEpoch.current+=1
    contractCopyCacheScope.current=scope
    contractCopyAttempt.current={key:attempt.key,body:attempt.body}
    contractCopyKey.current=attempt.key
    setContractCopy(original)
    setContractCopyPending(true)
    setContractCopyLoading(false)
    setContractSupplierId(original.supplierId)
    setContractSupplierQuery('')
    setContractForm({contractNo:original.contractNo,title:original.title,startsAt:shanghaiBusinessDate(new Date(original.startsAt))})
    setSources(copyRecoverySources(attempt.original).map((source,index)=>({...source,quotedUnitPrice:null,product:{...source.product,code:original.lines[index].productCodeSnapshot,name:original.lines[index].productNameSnapshot,spec:original.lines[index].productSpecSnapshot}})))
    setSourcePrices(Object.fromEntries(payload.lines.map((line:{upstreamSourceId:string;unitPrice:number})=>[line.upstreamSourceId,String(line.unitPrice)])))
    setShowContractForm(true)
    setTab('contracts')
    setNotice('已恢复原合同创建请求，请核对并重试；价格已锁定，不会重复创建版本')
  },[])


  function toggleContractForm() {
    if (working === 'create-contract' || contractCopyBusy.current || contractCopyRecoveryBlocked) return
    if (contractCopyAttempt.current) {
      setError('新版合同创建结果待核对，请先重试原创建请求，不能关闭后重复创建')
      return
    }
    const close = () => { if (contractCopyBusy.current || contractCopyAttempt.current) { setError('请先核对原创建请求，再关闭表单'); return }
      contractCopyEpoch.current += 1
      sourceRequestRef.current += 1
      if (contractCopy) {
        setContractCopy(null)
        setSources([])
        setSourcePrices({})
        setContractSupplierId('')
        setContractForm({ contractNo: '', title: '', startsAt: shanghaiBusinessDate() })
      }
      setContractCopyLoading(false)
      setError(null)
      setShowContractForm(value => !value)
    }
    if (showContractForm && contractCopy) {
      openActionConfirm({ title: '放弃本次合同改价？', body: '原合同和旧订单不会改变。', confirmLabel: '放弃修改', tone: 'danger', onConfirm: close })
    } else close()
  }

  async function openContractCopy(original: Contract) {
    if (working || showContractForm || showOrderForm || contractCopyBusy.current || contractCopyAttempt.current || contractCopyRecoveryBlocked) return
    const epoch = ++contractCopyEpoch.current
    const request = ++sourceRequestRef.current
    contractCopyKey.current = clientRequestId()
    contractCopyAttempt.current = null
    setContractCopyPending(false)
    setContractCopy(original)
    setContractCopyLoading(true)
    setContractSupplierId(original.supplierId)
    setContractSupplierQuery('')
    setContractForm({ contractNo: original.contractNo, title: original.title, startsAt: shanghaiBusinessDate(new Date(original.startsAt)) })
    setSources([])
    setSourcePrices({})
    setShowContractForm(true)
    setError(null)
    try {
      const setup = await apiFetch<{ sources: Source[] }>(`/api/upstream/setup-options?supplierId=${encodeURIComponent(original.supplierId)}`)
      if (epoch !== contractCopyEpoch.current || request !== sourceRequestRef.current) return
      const prices = Object.fromEntries(original.lines.map(line => [line.upstreamSourceId || '', String(line.unitPrice)]))
      contractCopyPayload(original, setup.sources, prices, contractCopyKey.current)
      const selected = original.lines.map(line => setup.sources.find(source => source.id === line.upstreamSourceId)!)
      setSources(selected)
      setSourcePrices(prices)
    } catch (reason: any) {
      if (epoch === contractCopyEpoch.current) setError(reason?.message || '原合同条款核对失败，未生成新版本')
    } finally {
      if (epoch === contractCopyEpoch.current) setContractCopyLoading(false)
    }
  }

  async function createContractCopy() {
    if (!contractCopy || contractCopyLoading || contractCopyBusy.current || contractCopyRecoveryBlocked) return
    const epoch = contractCopyEpoch.current
    let body: string
    try {
      body = contractCopyAttempt.current?.body || JSON.stringify(contractCopyPayload(contractCopy, sources, sourcePrices, contractCopyKey.current))
    } catch (reason: any) { setError(reason.message); return }
    const cacheScope=currentContractCopyScope()
    if(!cacheScope||contractCopyCacheScope.current&&contractCopyCacheScope.current!==cacheScope){setError('账号范围已变化，请重新登录原账号核对合同创建请求');return}
    const persisted={body,key:contractCopyKey.current,original:contractCopy as unknown as StoredCopyOriginal}
    try{persistContractCopyAttempt(sessionStorage,cacheScope,persisted)}catch(reason:any){setError(reason.message);return}
    contractCopyCacheScope.current=cacheScope
    contractCopyBusy.current = true
    contractCopyAttempt.current = { body, key: contractCopyKey.current }
    setContractCopyPending(true)
    const succeeded = await run('create-contract', async () => {
      try {
        return await apiFetch<Pick<Contract, 'id' | 'contractNo' | 'title'>>('/api/upstream/contracts', { method: 'POST', body })
      } catch (reason: any) {
        // A definite 4xx rejection did not create a contract; network/5xx results retain the original request.
        if (reason?.status >= 400 && reason?.status < 500 && reason.status !== 408 && reason.status !== 429) {
          clearContractCopyAttempt(sessionStorage,cacheScope,persisted)
          if(epoch===contractCopyEpoch.current&&currentContractCopyScope()===cacheScope){contractCopyAttempt.current = null;setContractCopyPending(false)}
        }
        throw reason
      }
    }, '新版合同草稿已创建；启用后只影响新订单，旧订单保持原价', async created => {
      clearContractCopyAttempt(sessionStorage,cacheScope,persisted)
      if (epoch !== contractCopyEpoch.current || currentContractCopyScope()!==cacheScope) return
      contractCopyAttempt.current = null
      setContractCopyPending(false)
      const loaded = await loadCreatedRecord(created.id, () => apiFetch<Contract[]>('/api/upstream/contracts'))
      if (epoch !== contractCopyEpoch.current) return
      if (loaded) { setContracts(loaded.rows); setViewingContract(loaded.record); focusRecord('contracts', `contract-${created.id}`) }
      setNoticeAction({ label: '启用新版合同', run: () => confirmContractActivation(created) })
    })
    contractCopyBusy.current = false
    if (succeeded && epoch === contractCopyEpoch.current && currentContractCopyScope()===cacheScope) {
      setShowContractForm(false)
      setContractCopy(null)
      setSources([])
      setSourcePrices({})
      setContractSupplierId('')
      setContractForm({ contractNo: '', title: '', startsAt: shanghaiBusinessDate() })
    }
  }

  async function loadSources(supplierId: string) {
    const requestId = ++sourceRequestRef.current
    setContractSupplierId(supplierId)
    setSources([])
    setSourcePrices({})
    if (!supplierId) return
    try {
      const setup = await apiFetch<{ sources: Source[] }>(`/api/upstream/setup-options?supplierId=${encodeURIComponent(supplierId)}`)
      if (requestId !== sourceRequestRef.current) return
      setSources(setup.sources)
      setSourcePrices(Object.fromEntries(setup.sources.map((source) => [source.id, source.quotedUnitPrice == null ? '' : String(source.quotedUnitPrice)])))
    } catch (reason: any) {
      if (requestId !== sourceRequestRef.current) return
      setError(reason?.message || '采购来源加载失败')
    }
  }

  function focusRecord(targetTab: Tab, elementId: string) {
    setTab(targetTab)
    requestAnimationFrame(() => document.getElementById(elementId)?.scrollIntoView({ behavior: 'smooth', block: 'center' }))
  }

  function confirmContractActivation(contract: Pick<Contract, 'id' | 'contractNo' | 'title'>) {
    openRevisionRejectConfirm({
      title: '确认启用合同？',
      body: `${contract.contractNo} · ${contract.title}\n请确认合同价格和单位换算无误。`,
      confirmLabel: '启用合同',
      tone: 'primary',
      onConfirm: async () => {
        const succeeded = await run(
          contract.id,
          () =>
            apiFetch(`/api/upstream/contracts/${contract.id}/activate`, {
              method: 'POST',
            }),
          '合同已启用'
        )
        if (!succeeded) throw new Error('合同启用失败，请查看页面提示')
      },
    })
  }

  async function createContract() {
    if(contractCopyRecoveryBlocked){setError('请先核对浏览器保留的合同创建记录，不能另建合同');return}
    if (contractCopy) return createContractCopy()
    // 填了但无效 (负数/非数字) 的单价不能静默丢弃, 必须点名提示
    const invalidPriced = sources.filter((source) => {
      const raw = (sourcePrices[source.id] || '').trim()
      return raw !== '' && !validContractPrice(raw)
    })
    if (invalidPriced.length > 0) {
      setError(`以下商品的单价无效，未纳入合同：${invalidPriced.map((source) => source.product.name).join('、')}。请填写大于 0、最多六位小数的价格，或清空后重试。`)
      return
    }
    const lines = sources
      .filter((source) => Number(sourcePrices[source.id]) > 0)
      .map((source) => ({
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
    const succeeded = await run(
      'create-contract',
      () =>
        apiFetch<Pick<Contract, 'id' | 'contractNo' | 'title'>>('/api/upstream/contracts', {
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
            idempotencyKey: contractRequestKeyRef.current,
            lines,
          }),
        }),
      '合同草稿已创建，可直接启用',
      async (created) => {
        contractRequestKeyRef.current = clientRequestId()
        const loaded = await loadCreatedRecord(created.id, () => apiFetch<Contract[]>('/api/upstream/contracts'))
        if (loaded) {
          const contract = loaded.record
          setContracts(loaded.rows)
          if (!quickContractFromOrder) focusRecord('contracts', `contract-${contract.id}`)
          setViewingContract(contract)
          setNoticeAction({
            label: '启用合同',
            run: () => confirmContractActivation(contract),
          })
        } else {
          if (!quickContractFromOrder) setTab('contracts')
          setNotice('合同草稿已创建；详情暂未刷新，请刷新后查看，不要重复提交')
          setNoticeAction({ label: '刷新合同', run: () => void loadAll() })
        }
      }
    )
    if (succeeded) {
      setShowContractForm(false)
      setQuickContractFromOrder(false)
    }
  }

  const activeContracts = useMemo(() => contracts.filter((contract) => contract.status === 'ACTIVE'), [contracts])
  const supplierActiveContracts = useMemo(() => activeContracts.filter((contract) => contract.supplierId === orderSupplierId), [activeContracts, orderSupplierId])
  const selectedOrderContract = supplierActiveContracts.find((contract) => contract.id === orderContractId)

  useEffect(() => {
    if (!showOrderForm) return
    if (supplierActiveContracts.length === 1) {
      if (orderContractId !== supplierActiveContracts[0].id) selectOrderContract(supplierActiveContracts[0].id)
      return
    }
    if (!supplierActiveContracts.some((contract) => contract.id === orderContractId)) {
      setOrderContractId('')
      setOrderQuantities({})
    }
  }, [showOrderForm, supplierActiveContracts, orderContractId])

  function selectOrderContract(id: string) {
    setOrderContractId(id)
    setOrderQuantities({})
    setOrderProductQuery('')
  }

  function addOrderProduct(line: ContractLine) {
    const minimum = Math.max(Number(line.minOrderQty || 1), Number(line.packageMultiple || 1))
    const multiple = Math.max(Number(line.packageMultiple || 1), 0.000001)
    setOrderQuantities(current => Object.hasOwn(current, line.id) ? current : {
      ...current, [line.id]: String(Math.ceil(minimum / multiple) * multiple),
    })
    setOrderProductQuery('')
  }

  async function openQuickContract() {
    if (!orderSupplierId) {
      setError('请先选择供应商')
      return
    }
    const supplier = suppliers.find((item) => item.id === orderSupplierId)
    const dateKey = shanghaiBusinessDate().replaceAll('-', '')
    setContractForm({
      contractNo: `KJ${dateKey}-${supplier?.no || 'SUP'}`,
      title: `${supplier?.name || '供应商'}长期供货框架`,
      startsAt: shanghaiBusinessDate(),
    })
    setQuickContractFromOrder(true)
    await loadSources(orderSupplierId)
  }

  function openNewOrderForm() {
    setOrderQuantities({})
    setOrderProductQuery('')
    setShowOrderForm(true)
    setTab('orders')
  }

  async function createOrder() {
    if (!selectedOrderContract || !orderWarehouseId) return setError('请选择已生效合同和收货总仓')
    const lines = selectedOrderContract.lines
      .filter((line) => Number(orderQuantities[line.id]) > 0)
      .map((line) => ({
        contractLineId: line.id,
        quantity: Number(orderQuantities[line.id]),
      }))
    if (!lines.length) return setError('至少填写一个商品的采购数量')
    const succeeded = await run(
      'create-order',
      () =>
        apiFetch<Pick<Order, 'id'>>('/api/upstream/purchase-orders', {
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
        }),
      '采购单草稿已创建',
      async (created) => {
        focusRecord('orders', `order-${created.id}`)
        await openOrderDetail(created)
        setNoticeAction({
          label: '查看采购单',
          run: () => void openOrderDetail(created),
        })
      }
    )
    if (succeeded) {
      orderRequestKeyRef.current = clientRequestId()
      setShowOrderForm(false)
    }
  }

  function rejectPurchaseReturn(row: PurchaseReturn) {
    openActionConfirm({
      title: `驳回退货单 ${row.no}`,
      body: '驳回后不会扣减库存，申请人会看到驳回原因。',
      confirmLabel: '确认驳回', tone: 'danger', withInput: true, inputRequired: true,
      inputPlaceholder: '请输入驳回原因',
      onConfirm: async reason => {
        if (!reason) throw new Error('请填写驳回原因')
        await run(
          `reject-return-${row.id}`,
          () => apiFetch(`/api/upstream/purchase-returns/${row.id}/reject`, { method: 'POST', body: JSON.stringify({ reason }) }),
          '采购退货已驳回，未扣减库存', undefined, true
        )
      },
    })
  }

  function cancelPurchaseReturn(row: PurchaseReturn) {
    openActionConfirm({
      title: `取消退货单 ${row.no}`,
      body: '取消后不会扣减库存，单据保留审计记录。',
      confirmLabel: '确认取消', tone: 'danger', withInput: true, inputRequired: true,
      inputPlaceholder: '请输入取消原因',
      onConfirm: async reason => {
        if (!reason) throw new Error('请填写取消原因')
        await run(
          `cancel-return-${row.id}`,
          () => apiFetch(`/api/upstream/purchase-returns/${row.id}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) }),
          '采购退货已取消，未扣减库存', undefined, true
        )
      },
    })
  }

  async function openOrderDetail(order: Pick<Order, 'id'>, mode: 'view' | 'revision' = 'view', preserveTab = false) {
    setError(null)
    try {
      const detail = await apiFetch<Order>(`/api/upstream/purchase-orders/${order.id}`)
      if (mode === 'revision') {
        if (!detail.revisions?.some((item) => item.status === 'PENDING')) throw new Error('未找到待审核改单')
        setReviewingRevisionOrder(detail)
        setViewingOrder(null)
      } else {
        setViewingOrder(detail)
        setReviewingRevisionOrder(null)
      }
      setViewingReceipt(null)
      setViewingPurchaseReturn(null)
      setViewingStatement(null)
      if (!preserveTab && tab !== 'claims') setTab('orders')
    } catch (reason: any) {
      setError(reason?.message || '采购单明细加载失败')
    }
  }

  async function openReceiptDetail(receipt: Pick<Receipt, 'id'>, action: 'confirm' | 'review' | null = null, preserveTab = false) {
    setError(null)
    try {
      const detail = await apiFetch<ReceiptDetail>(`/api/upstream/receipts/${receipt.id}`)
      setViewingOrder(null)
      setViewingPurchaseReturn(null)
      setViewingReceipt(detail)
      setReceiptReviewAction(action)
      if (!preserveTab && tab !== 'claims') setTab('receipts')
    } catch (reason: any) {
      setError(reason?.message || '收货单明细加载失败')
    }
  }

  function confirmProcurementProgress(kind: 'RECEIPT' | 'RETURN', row: ProcurementApprovalSource & { no: string }, action: ProcurementApprovalAction) {
    if (working || approvalBusyRef.current) return
    const label = { save: '保存', submit: '提交', audit: '审核', unconfirm: '反审核', review: '复审' }[action]
    openActionConfirm({
      title: `${label}单据 ${row.no}`,
      body: action === 'review' ? '由另一名供应链人员完成复审后，实际增减库存并锁定业务字段。复审结束后不能取消复审。' : '本次只改变审批进度，不增减库存；实际库存变更在复审完成时生效。',
      confirmLabel: label, tone: action === 'review' ? 'danger' : 'primary',
      onConfirm: async () => {
        if (approvalBusyRef.current) return
        approvalBusyRef.current = true
        const key = `${kind}:${row.id}:${action}:${row.approvalVersion}:${row.sourceVersion ?? row.rowVersion}`
        try {
          const requestId = approvalRequestsRef.current[key] ||= clientRequestId()
          const body = procurementApprovalRequest(row, requestId)
          await run(key, () => apiFetch(`/api/upstream/${kind === 'RECEIPT' ? 'receipts' : 'purchase-returns'}/${row.id}/approval/${action}`, { method: 'POST', body: JSON.stringify(body) }), `${label}成功${action === 'review' ? '，库存已生效' : '，库存未改变'}`, async () => {
            delete approvalRequestsRef.current[key]
            if (kind === 'RECEIPT' && viewingReceipt?.id === row.id) await openReceiptDetail(row, null, true)
            if (kind === 'RETURN' && viewingPurchaseReturn?.id === row.id) setViewingPurchaseReturn(await apiFetch<PurchaseReturn>(`/api/upstream/purchase-returns/${row.id}`))
          }, true)
        } finally { approvalBusyRef.current = false }
      },
    })
  }

  async function createQualityStandard() {
    if (!qualityStandardForm.productId || !qualityStandardForm.title.trim() || !qualityStandardForm.criteria.trim()) {
      return setError('请选择商品并填写标准名称和验收条件')
    }
    const succeeded = await run(
      'create-quality-standard',
      () => apiFetch('/api/upstream/quality-standards', {
        method: 'POST',
        body: JSON.stringify({
          productId: qualityStandardForm.productId,
          title: qualityStandardForm.title.trim(),
          criteria: { description: qualityStandardForm.criteria.trim() },
          effectiveAt: `${qualityStandardForm.effectiveAt}T00:00:00.000Z`,
          requestKey: qualityStandardRequestKeyRef.current,
        }),
      }),
      '质量验收标准已更新',
    )
    if (succeeded) {
      qualityStandardRequestKeyRef.current = clientRequestId()
      setQualityStandardForm((current) => ({ ...current, title: '', criteria: '' }))
    }
  }

  async function createPriceStandard() {
    const scope = standardScopes.find((item) => item.key === priceScopeKey)
    if (!scope || !priceStandardForm.unitPrice || Number(priceStandardForm.unitPrice) <= 0) return setError('请选择供货关系并填写大于0的标准价')
    const succeeded = await run(
      'create-price-standard',
      () => apiFetch('/api/upstream/price-standards', {
        method: 'POST',
        body: JSON.stringify({
          productId: scope.productId,
          supplierId: scope.supplierId,
          purchaseUnit: scope.purchaseUnit,
          currency: scope.currency,
          taxInclusive: scope.taxInclusive,
          unitPrice: Number(priceStandardForm.unitPrice),
          effectiveAt: `${priceStandardForm.effectiveAt}T00:00:00.000Z`,
          requestKey: priceStandardRequestKeyRef.current,
        }),
      }),
      '标准采购价已更新',
    )
    if (succeeded) {
      priceStandardRequestKeyRef.current = clientRequestId()
      setPriceStandardForm((current) => ({ ...current, unitPrice: '' }))
    }
  }

  function deactivateStandard(kind: 'quality' | 'price', standard: QualityStandard | PriceStandard) {
    const requestKey = clientRequestId()
    openActionConfirm({
      title: kind === 'quality' ? '停用质量验收标准' : '停用标准采购价',
      body: '停用只影响之后新建的采购单，历史单据仍保留当时冻结的标准版本。',
      confirmLabel: '确认停用',
      tone: 'danger',
      withInput: true,
      inputRequired: true,
      inputPlaceholder: '请填写停用原因',
      onConfirm: async (reason) => {
        if (!reason) throw new Error('请填写停用原因')
        await run(
          `deactivate-${kind}-${standard.id}`,
          () => apiFetch(`/api/upstream/${kind === 'quality' ? 'quality' : 'price'}-standards/${standard.id}/deactivate`, {
            method: 'POST',
            body: JSON.stringify({ expectedVersion: standard.version, reason, requestKey }),
          }),
          '标准已停用',
          undefined,
          true,
        )
      },
    })
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
      setPostClaimQuantities(Object.fromEntries(detail.purchaseOrder.lines.map((line) => [line.id, '0'])))
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
      setPostClaimEvidence((current) => [...current, { url: uploaded.url, name: file.name }].slice(0, 4))
    } catch (reason: any) {
      setError(reason?.message || '证据上传失败')
    } finally {
      setUploadingEvidence(false)
    }
  }

  async function submitPostReceiptClaim() {
    if (!claimingReceipt) return
    const receiptLineByOrderLine = new Map(claimingReceipt.lines.map((line) => [line.purchaseOrderLineId, line]))
    const lines = claimingReceipt.purchaseOrder.lines
      .map((line) => ({
        purchaseOrderLineId: line.id,
        receiptLineId: receiptLineByOrderLine.get(line.id)?.id,
        affectedQty: Number(postClaimQuantities[line.id] || 0),
      }))
      .filter((line) => line.affectedQty > 0)
    if (!postClaimDescription.trim()) return setError('请说明拆包后发现的异常')
    if (!lines.length) return setError('至少填写一个商品的异常数量')
    if (!postClaimEvidence.length) return setError('请至少上传一张图片或一个视频作为证据')
    const receiptId = claimingReceipt.id
    const succeeded = await run(
      `post-claim-${receiptId}`,
      () =>
        apiFetch(`/api/upstream/receipts/${receiptId}/post-receipt-claims`, {
          method: 'POST',
          body: JSON.stringify({
            idempotencyKey: postClaimRequestKeysRef.current[receiptId] || (postClaimRequestKeysRef.current[receiptId] = clientRequestId()),
            type: postClaimType,
            description: postClaimDescription.trim(),
            evidence: postClaimEvidence.map((item) => ({
              url: item.url,
              name: item.name,
            })),
            lines,
          }),
        }),
      '收货后异常已补报，等待供应商确认'
    )
    if (succeeded) {
      delete postClaimRequestKeysRef.current[receiptId]
      setClaimingReceipt(null)
      setPostClaimEvidence([])
      setTab('claims')
    }
  }

  async function reviewRevision(order: Order, decision: 'ACCEPT' | 'REJECT', note?: string) {
    const detail = order.revisions?.some((item) => item.status === 'PENDING') ? order : await apiFetch<Order>(`/api/upstream/purchase-orders/${order.id}`)
    const revision = detail.revisions?.find((item) => item.status === 'PENDING')
    if (!revision) throw new Error('未找到待审核改单')
    return apiFetch(`/api/upstream/purchase-orders/${order.id}/revisions/${revision.id}/review`, {
      method: 'POST',
      body: JSON.stringify({ decision, rowVersion: detail.rowVersion, ...(note ? { note } : {}) }),
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

  function reverseReceipt(receipt: Receipt) {
    openActionConfirm({
      title: `整单冲销收货单 ${receipt.no}`,
      body: '库存、金额和采购进度都会恢复；系统追加反向记录，操作不可删除。',
      confirmLabel: '确认冲销', tone: 'danger', withInput: true, inputRequired: true,
      inputPlaceholder: '请输入至少2个字的冲销原因，例如：重复收货、录入错误',
      onConfirm: async reason => {
        if (!reason || reason.trim().length < 2) throw new Error('冲销原因至少填写 2 个字符')
        await run(
          `reverse-${receipt.id}`,
          () => apiFetch(`/api/upstream/receipts/${receipt.id}/reverse`, {
            method: 'POST', body: JSON.stringify({ reason: reason.trim(), idempotencyKey: clientRequestId() }),
          }),
          '收货单已冲销，库存与采购进度已恢复', undefined, true
        )
      },
    })
  }

  const pendingReceiptCount = receipts.filter((item) => ['DRAFT', 'INSPECTING', 'PENDING_REVIEW'].includes(item.status)).length
  const pendingClaimCount = claims.filter((item) => item.status !== 'RESOLVED' && item.status !== 'CANCELLED').length
  const pendingOrderCount = orders.filter((item) => !['RECEIVED', 'SETTLED', 'CANCELLED'].includes(item.status)).length

  return (
    <div className="min-h-screen bg-bg px-4 py-5 lg:px-8 lg:py-7">
      <style jsx global>{`
        .input {
          width: 100%;
          border: 1px solid #ddd6c9;
          border-radius: 12px;
          background: #fff;
          padding: 10px 12px;
          color: #29231d;
          outline: none;
        }
        .input:focus {
          border-color: #c96f32;
          box-shadow: 0 0 0 3px rgba(201, 111, 50, 0.12);
        }
        @media print {
          body[data-procurement-printing="true"] > :not([data-print-clone="true"]) { display: none !important; }
          body[data-procurement-printing="true"] > [data-print-clone="true"] {
            display: block !important;
            width: 100% !important;
            border: 0 !important;
            box-shadow: none !important;
          }
          [data-print-clone="true"] [data-print-hidden] { display: none !important; }
        }
      `}</style>
      <header className="mx-auto max-w-[1440px] border-b border-border pb-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="mb-2 text-caption text-gray3">内部管理 · 全部送达总仓 · 独立上游采购链路</div>
            <h1 className="text-h1">上游采购与供应商协同</h1>
            <p className="mt-1 text-caption text-gray2">合同价下单 → 供应商接单/改单 → 发货 → 总仓验收 → 差异 → 月结</p>
          </div>
          <div className="flex gap-2">
            <ActionButton tone="light" onClick={() => void loadAll()} disabled={loading}>
              刷新
            </ActionButton>
            <ActionButton
              onClick={openNewOrderForm}
            >
              新建采购单
            </ActionButton>
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
        {notice && (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-green/20 bg-green/10 px-4 py-3 text-caption text-green">
            <span>{notice}</span>
            {noticeAction && (
              <button type="button" onClick={noticeAction.run} className="rounded-lg border border-green/30 bg-white px-3 py-1.5 text-button text-green">
                {noticeAction.label}
              </button>
            )}
          </div>
        )}
        <div className="mb-5 flex gap-2 overflow-x-auto">
          {TABS.map((item) => (
            <button
              key={item.key}
              onClick={() => setTab(item.key)}
              className={`whitespace-nowrap rounded-full px-4 py-2 text-button ${tab === item.key ? 'bg-gray1 text-white' : 'border border-border bg-white text-gray2'}`}
            >
              {item.label}
            </button>
          ))}
        </div>

        {viewingPurchaseReturn && (
          <div className="mb-4">
            <Panel title={`采购退货单明细 · ${viewingPurchaseReturn.no}`} onClose={() => setViewingPurchaseReturn(null)} onPrint={()=>showTableReport(procurementDocumentReport('RETURN',viewingPurchaseReturn))}>
              <div className="grid gap-2 rounded-xl bg-bg p-3 text-caption sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <span className="text-gray3">供应商</span>
                  <div>{viewingPurchaseReturn.supplier.name}</div>
                </div>
                <div>
                  <span className="text-gray3">退货总仓</span>
                  <div>{viewingPurchaseReturn.warehouse.name}</div>
                </div>
                <div>
                  <span className="text-gray3">退货原因</span>
                  <div>{viewingPurchaseReturn.reason}</div>
                </div>
                <div>
                  <span className="text-gray3">退货金额</span>
                  <div>{money(viewingPurchaseReturn.settlementAmount)}</div>
                </div>
              </div>
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-left text-caption">
                  <thead>
                    <tr className="border-b">
                      <th className="p-2">原收货单</th>
                      <th className="p-2">商品</th>
                      <th className="p-2">规格</th>
                      <th className="p-2">退货数量</th>
                      <th className="p-2">单位</th>
                      <th className="p-2">单价</th>
                      <th className="p-2">金额</th>
                    <th className="p-2">质检</th></tr>
                  </thead>
                  <tbody>
                    {viewingPurchaseReturn.lines.map((line) => (
                      <tr key={line.id} className="border-b border-border">
                        <td className="p-2">{line.receiptLine.receipt.no}</td>
                        <td className="p-2">
                          <b>{line.product.name}</b>
                        </td>
                        <td className="p-2">{line.product.spec || '—'}</td>
                        <td className="p-2">{String(line.purchaseQuantity)}</td>
                        <td className="p-2">{line.purchaseUnit}</td>
                        <td className="p-2">{unitPriceMoney(line.settlementUnitPrice)}</td>
                        <td className="p-2">{money(line.settlementAmount)}</td><td className="p-2"><DocumentQualityImageButton kind="BATCH" sourceId={`R:${line.receiptLineId}`}/></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-4 rounded-xl border border-border p-3">
                <p className="mb-3 text-caption text-gray2">审核只改变进度；另一名供应链人员复审后才出库。</p>
                <ProcurementProgressActions kind="RETURN" row={viewingPurchaseReturn} role={getUser()?.role || ''} busy={Boolean(working)} onAction={action => confirmProcurementProgress('RETURN', viewingPurchaseReturn, action)} />
              <LegacyQualityImagesButton kind="RETURN" sourceId={viewingPurchaseReturn.id} />
              </div>
            </Panel>
          </div>
        )}

        {viewingOrder && (
          <div className="mb-4">
            <Panel title={`采购单明细 · ${viewingOrder.no}`} onClose={() => setViewingOrder(null)}>
              <div className="grid gap-2 rounded-xl bg-bg p-3 text-caption sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <span className="text-gray3">供应商</span>
                  <div>{viewingOrder.supplier.name}</div>
                </div>
                <div>
                  <span className="text-gray3">收货总仓</span>
                  <div>{viewingOrder.warehouse.name}</div>
                </div>
                <div>
                  <span className="text-gray3">期望到货</span>
                  <div>{shortDate(viewingOrder.expectedArrivalAt)}</div>
                </div>
                <div>
                  <span className="text-gray3">订单金额</span>
                  <div>{money(viewingOrder.totalAmount)}</div>
                </div>
              </div>

              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-left text-caption">
                  <thead>
                    <tr className="border-b">
                      <th className="p-2">商品</th>
                      <th className="p-2">规格</th>
                      <th className="p-2">采购单位</th>
                      <th className="p-2">订单数量</th>
                      <th className="p-2">已发数量</th>
                      <th className="p-2">已收数量</th>
                      <th className="p-2">单价</th>
                      <th className="p-2">小计</th>
                    <th className="p-2">质检</th></tr>
                  </thead>
                  <tbody>
                    {(viewingOrder.lines || []).map((line) => {
                      const quantity = Number(line.confirmedQty ?? line.orderedQty)
                      return (
                        <tr key={line.id} className="border-b border-border">
                          <td className="p-2">
                            <b>{line.productNameSnapshot}</b>
                          </td>
                          <td className="p-2">{line.productSpecSnapshot || '—'}</td>
                          <td className="p-2">{line.purchaseUnit}</td>
                          <td className="p-2">{quantity}</td>
                          <td className="p-2">{String(line.shippedQty)}</td>
                          <td className="p-2">{String(line.receivedQty)}</td>
                          <td className="p-2">{unitPriceMoney(line.unitPrice)}</td>
                          <td className="p-2">{money(quantity * Number(line.unitPrice))}</td><td className="p-2"><OrderLineQuality orderId={viewingOrder.id} lineId={line.id}/></td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </Panel>
          </div>
        )}

        {viewingReceipt && (
          <div className="mb-4">
            <Panel
              title={`收货单明细 · ${viewingReceipt.no}`}
              onPrint={()=>showTableReport(procurementDocumentReport('RECEIPT',viewingReceipt))}
              onClose={() => {
                setViewingReceipt(null)
                setReceiptReviewAction(null)
              }}
            >
              <div className="grid gap-2 rounded-xl bg-bg p-3 text-caption sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <span className="text-gray3">采购单</span>
                  <div>
                    <button
                      type="button"
                      className="font-medium underline decoration-dotted underline-offset-2"
                      aria-label={`查看采购单 ${viewingReceipt.purchaseOrder.no} 全部内容`}
                      onClick={() => void openOrderDetail(viewingReceipt.purchaseOrder)}
                    >
                      {viewingReceipt.purchaseOrder.no}
                    </button>
                  </div>
                </div>
                <div>
                  <span className="text-gray3">采购单金额</span>
                  <div>
                    <b>{viewingReceipt.purchaseOrder.totalAmount == null ? '—' : money(viewingReceipt.purchaseOrder.totalAmount)}</b>
                  </div>
                </div>
                <div>
                  <span className="text-gray3">发货单</span>
                  <div>{viewingReceipt.shipment?.no || '—'}</div>
                </div>
                <div>
                  <span className="text-gray3">本次应付</span>
                  <div>
                    <b>{money(viewingReceipt.payableAmount)}</b>
                  </div>
                </div>
              </div>
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-left text-caption">
                  <thead>
                    <tr className="border-b">
                      <th className="p-2">商品</th>
                      <th className="p-2">规格</th>
                      <th className="p-2">标准价 / 实际价</th>
                      <th className="p-2">质量标准 / 结果</th>
                      <th className="p-2">实到</th>
                      <th className="p-2">合格</th>
                      <th className="p-2">短缺</th>
                      <th className="p-2">破损</th>
                      <th className="p-2">拒收</th>
                      <th className="p-2">单位</th>
                      <th className="p-2">应付</th>
                    <th className="p-2">质检</th></tr>
                  </thead>
                  <tbody>
                    {viewingReceipt.lines.map((line) => (
                      <tr key={line.id} className="border-b border-border">
                        <td className="p-2">
                          <b>{line.purchaseOrderLine.productNameSnapshot}</b>
                        </td>
                        <td className="p-2">{line.purchaseOrderLine.productSpecSnapshot || line.purchaseOrderLine.productCodeSnapshot}</td>
                        <td className="p-2 whitespace-nowrap">
                          <div>{line.standardUnitPriceSnapshot == null ? '未配标准价' : `标准 ${currencyAmount(line.standardUnitPriceSnapshot, line.priceStandardCurrencySnapshot || 'CNY')}`}</div>
                          <div className={line.standardUnitPriceSnapshot != null && Number(line.unitPrice) > Number(line.standardUnitPriceSnapshot) ? 'font-medium text-red-600' : 'text-gray2'}>实际 {line.unitPrice == null ? '—' : currencyAmount(line.unitPrice, line.priceStandardCurrencySnapshot || viewingReceipt.purchaseOrder.currency || 'CNY')}</div>
                        </td>
                        <td className="p-2 min-w-48">
                          {line.qualityStandardId ? (
                            <>
                              <div>v{line.qualityStandardVersionSnapshot} · {line.qualityResult === 'PASS' ? '合格' : line.qualityResult === 'FAIL' ? '不合格' : '未填'}</div>
                              <div className="text-micro text-gray3">{qualityCriteriaText(line.qualityCriteriaSnapshot)}</div>
                              {line.qualityDisposition && <div className="text-micro text-gray2">处置：{line.qualityDisposition}</div>}
                              {line.qualityEvidence?.length ? (
                                <div className="mt-1 space-y-1 text-micro">
                                  {line.qualityEvidence.map((file, index) => file.url ? (
                                    <a key={`${file.name}-${index}`} href={file.url} target="_blank" rel="noreferrer" className="block text-accent underline">证据{index + 1}：{file.name}</a>
                                  ) : <div key={`${file.name}-${index}`} className="text-red-600">证据{index + 1}：{file.name}（暂时无法打开）</div>)}
                                </div>
                              ) : null}
                            </>
                          ) : <span className="text-gray3">未配质量标准</span>}
                        </td>
                        <td className="p-2">{String(line.arrivedQty ?? '—')}</td>
                        <td className="p-2">{String(line.acceptedQty)}</td>
                        <td className="p-2">{String(line.shortageQty ?? 0)}</td>
                        <td className="p-2">{String(line.damagedQty ?? 0)}</td>
                        <td className="p-2">{String(line.rejectedQty ?? 0)}</td>
                        <td className="p-2">{line.purchaseUnit}</td>
                        <td className="p-2">{line.payableAmount == null ? '—' : money(line.payableAmount)}</td><td className="p-2"><DocumentQualityImageButton kind="BATCH" sourceId={`R:${line.id}`}/></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {viewingReceipt.reviewReasons?.length ? (
                <div className="mt-3 rounded-lg border border-amber/30 bg-amber/10 p-3 text-caption">
                  <b>复核原因：</b>
                  {viewingReceipt.reviewReasons.map((reason) => RECEIPT_REVIEW_REASON_LABEL[reason] || reason).join('、')}
                </div>
              ) : null}
              {viewingReceipt.evidenceCompleteness && (
                <div className={`mt-3 rounded-lg border p-3 text-caption ${viewingReceipt.evidenceCompleteness.missingCount || viewingReceipt.evidenceCompleteness.pendingConfigurationCount ? 'border-amber/30 bg-amber/10' : 'border-green-fg/20 bg-green-bg'}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2"><div><b>来货资料：</b>营业执照 {viewingReceipt.evidenceCompleteness.businessLicense.status === 'COMPLETE' ? '已有' : '缺失'} · 缺件 {viewingReceipt.evidenceCompleteness.missingCount} 项 · 商品规则待配置 {viewingReceipt.evidenceCompleteness.pendingConfigurationCount} 项。<span className="ml-1">只提示，不阻断验收或入库。</span></div><a href={`/v2/supply-chain/suppliers/${encodeURIComponent(viewingReceipt.supplier.id)}/evidence?receiptId=${encodeURIComponent(viewingReceipt.id)}`} className="text-button text-accent">查看/补齐本次资料 →</a></div>
                  {viewingReceipt.evidenceCompleteness.lines.some(line => line.status === 'MISSING' || line.status === 'PENDING_CONFIGURATION') && <div className="mt-2 space-y-1 text-micro text-amber-fg">{viewingReceipt.evidenceCompleteness.lines.filter(line => line.status === 'MISSING' || line.status === 'PENDING_CONFIGURATION').map(line => <div key={line.receiptLineId}>{line.productName}：{line.status === 'PENDING_CONFIGURATION' ? '所需资料类型待配置' : `尚缺 ${line.missingTypes.map(type => RECEIPT_EVIDENCE_TYPE_LABEL[type]).join('、')}`}</div>)}</div>}
                  {viewingReceipt.status === 'POSTED' && viewingReceipt.evidenceCompletenessSnapshot && <div className="mt-1 text-micro text-gray3">过账时快照：缺 {viewingReceipt.evidenceCompletenessSnapshot.missingCount || 0} 项，待配置 {viewingReceipt.evidenceCompletenessSnapshot.pendingConfigurationCount || 0} 项；后续补录不改写快照。</div>}
                </div>
              )}
              <div className="mt-4 rounded-xl border border-border p-3">
                <p className="mb-3 text-caption text-gray2">提交、审核不改变库存，复审后才生效；超标准价不能验收入库。</p>
                <ProcurementProgressActions kind="RECEIPT" row={viewingReceipt} role={getUser()?.role || ''} busy={Boolean(working)} onAction={action => confirmProcurementProgress('RECEIPT', viewingReceipt, action)} />
              <LegacyQualityImagesButton kind="RECEIPT" sourceId={viewingReceipt.id} />
              </div>
            </Panel>
          </div>
        )}

        {loading ? <div className="rounded-2xl border border-border bg-white p-10 text-center text-gray3">正在加载采购数据…</div> : null}

        {!loading && tab === 'orders' && (
          <section className="space-y-4">
            {reviewingRevisionOrder &&
              (() => {
                const revision = reviewingRevisionOrder.revisions?.find((item) => item.status === 'PENDING')
                const rows = revision ? revisionComparison(reviewingRevisionOrder, revision) : []
                return (
                  <Panel title={`改单审核 · ${reviewingRevisionOrder.no}`} onClose={() => setReviewingRevisionOrder(null)}>
                    {revision && (
                      <>
                        <div className="rounded-xl border border-amber/30 bg-amber/10 p-3 text-caption">
                          <b>第 {revision.revisionNo} 次改单</b>
                          <span className="ml-2 text-gray2">{revision.reason}</span>
                          <div className="mt-1 text-gray3">请先核对以下修改内容，再接受或驳回。金额为数量×单价；批准仅影响本单，不回写合同或其他订单。</div>
                        </div>
                        <div className="mt-4 overflow-x-auto">
                          <table className="w-full text-left text-caption">
                            <thead>
                              <tr className="border-b">
                                <th className="p-2">商品</th>
                                <th className="p-2">原数量</th>
                                <th className="p-2">新数量</th>
                                <th className="p-2">变化</th>
                                <th className="p-2">单位</th>
                                <th className="p-2">原单价</th><th className="p-2">申请单价</th><th className="p-2">原金额</th><th className="p-2">申请金额</th>
                              </tr>
                            </thead>
                            <tbody>
                              {rows.map((row) => (
                                <tr key={row.id} className={`border-b border-border ${row.changed ? 'bg-amber/5' : ''}`}>
                                  <td className="p-2">
                                    <b>{row.name}</b>
                                    <div className="text-gray3">{row.spec || '—'}</div>
                                  </td>
                                  <td className="p-2">{row.before}</td>
                                  <td className="p-2">{row.after}</td>
                                  <td className={`p-2 ${row.delta !== 0 ? 'font-medium text-red-700' : 'text-gray3'}`}>
                                    {row.delta > 0 ? '+' : ''}
                                    {row.delta}
                                  </td>
                                  <td className="p-2">{row.unit}</td>
                                  <td className="p-2">{row.beforePrice} 元/{row.unit}</td><td className="p-2">{row.afterPrice} 元/{row.unit}</td><td className="p-2">{row.beforeAmount}</td><td className="p-2">{row.afterAmount}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        {revision.beforeSnapshot?.expectedArrivalAt !== revision.afterSnapshot?.expectedArrivalAt && (
                          <p className="mt-3 rounded-lg bg-bg p-3 text-caption">
                            期望到货日：
                            {shortDate(revision.beforeSnapshot?.expectedArrivalAt)} → {shortDate(revision.afterSnapshot?.expectedArrivalAt)}
                          </p>
                        )}
                        <div className="mt-4 flex justify-end gap-2">
                          <ActionButton tone="danger" onClick={() => rejectRevisionWithReason(reviewingRevisionOrder)} disabled={working === reviewingRevisionOrder.id}>
                            驳回改单
                          </ActionButton>
                          <ActionButton
                            onClick={() =>
                              void run(reviewingRevisionOrder.id, () => reviewRevision(reviewingRevisionOrder, 'ACCEPT'), '改单已接受').then((succeeded) => {
                                if (succeeded) setReviewingRevisionOrder(null)
                              })
                            }
                            disabled={working === reviewingRevisionOrder.id}
                          >
                            确认接受改单
                          </ActionButton>
                        </div>
                      </>
                    )}
                  </Panel>
                )
              })()}
            {showOrderForm && (
              <Panel
                title="新建采购单"
                onClose={() => {
                  setShowOrderForm(false)
                  setQuickContractFromOrder(false)
                }}
              >
                <div className="grid gap-3 md:grid-cols-4">
                  <Field label="供应商">
                    <select
                      value={orderSupplierId}
                      onChange={(event) => {
                        setOrderSupplierId(event.target.value)
                        setOrderContractId('')
                        setOrderQuantities({})
                        setOrderProductQuery('')
                        setQuickContractFromOrder(false)
                      }}
                      className="input"
                    >
                      <option value="">请选择</option>
                      {suppliers.map((supplier) => (
                        <option key={supplier.id} value={supplier.id}>
                          {supplier.no} · {supplier.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {supplierActiveContracts.length > 1 ? (
                    <Field label="已生效合同（多份请选）">
                      <select value={orderContractId} onChange={(event) => selectOrderContract(event.target.value)} className="input">
                        <option value="">请选择</option>
                        {supplierActiveContracts.map((contract) => (
                          <option key={contract.id} value={contract.id}>
                            {contract.contractNo} · {contract.title}
                          </option>
                        ))}
                      </select>
                    </Field>
                  ) : supplierActiveContracts.length === 1 ? (
                    <Field label="已自动带出合同">
                      <div className="input bg-bg">
                        <b>{supplierActiveContracts[0].contractNo}</b> · {supplierActiveContracts[0].title}
                      </div>
                    </Field>
                  ) : (
                    <div className="rounded-xl border border-amber/30 bg-amber/10 p-3 text-caption">
                      <b>该供应商暂无生效合同</b>
                      <button type="button" onClick={() => void openQuickContract()} className="mt-1 block text-button text-accent underline">
                        快速建合同
                      </button>
                    </div>
                  )}
                  <Field label="收货总仓">
                    <select value={orderWarehouseId} onChange={(event) => setOrderWarehouseId(event.target.value)} className="input">
                      <option value="">请选择</option>
                      {warehouses.map((warehouse) => (
                        <option key={warehouse.id} value={warehouse.id}>
                          {warehouse.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="期望到货日">
                    <input type="date" value={orderArrival} onChange={(event) => setOrderArrival(event.target.value)} className="input" />
                  </Field>
                </div>
                {selectedOrderContract && (
                  <section className="mt-4 space-y-3" aria-label="采购商品选择">
                    <input type="search" aria-label="搜索采购商品" placeholder="搜索商品名称、编码或规格，点击添加" className="input" value={orderProductQuery} onChange={event => setOrderProductQuery(event.target.value)} />
                    {orderProductQuery.trim() && <div className="max-h-64 overflow-auto rounded-xl border border-border" aria-label="采购商品搜索结果">
                      {selectedOrderContract.lines.filter(line => `${line.productNameSnapshot} ${line.productCodeSnapshot} ${line.productSpecSnapshot || ''}`.toLowerCase().includes(orderProductQuery.trim().toLowerCase())).slice(0, 30).map(line => <div key={line.id} className="flex items-center justify-between gap-3 border-b border-border p-3">
                        <div><b>{line.productNameSnapshot}</b><div className="text-gray3">{line.productCodeSnapshot} · {line.productSpecSnapshot || '—'} · {unitPriceMoney(line.unitPrice)} / {line.purchaseUnit}</div></div>
                        <button type="button" aria-label={`添加采购商品 ${line.productNameSnapshot}`} disabled={Object.hasOwn(orderQuantities, line.id)} onClick={() => addOrderProduct(line)} className="shrink-0 rounded-lg border border-border px-3 py-2 disabled:opacity-40">{Object.hasOwn(orderQuantities, line.id) ? '已添加' : '添加'}</button>
                      </div>)}
                      {!selectedOrderContract.lines.some(line => `${line.productNameSnapshot} ${line.productCodeSnapshot} ${line.productSpecSnapshot || ''}`.toLowerCase().includes(orderProductQuery.trim().toLowerCase())) && <p className="p-3 text-gray3">该合同没有符合条件的商品</p>}
                      <p className="p-2 text-micro text-gray3">每次显示前30项，可继续输入名称或编码缩小范围。</p>
                    </div>}
                    <div className="overflow-x-auto"><table className="w-full text-left text-caption">
                      <thead><tr className="border-b"><th className="p-2">序号</th><th className="p-2">商品</th><th className="p-2">合同价</th><th className="p-2">采购数量</th><th className="p-2">操作</th></tr></thead>
                      <tbody>
                        {selectedOrderContract.lines.filter(line => Object.hasOwn(orderQuantities, line.id)).map((line, index) => <tr key={line.id} className="border-b border-border">
                          <td className="p-2">{index + 1}</td><td className="p-2"><b>{line.productNameSnapshot}</b><div className="text-gray3">{line.productCodeSnapshot} · {line.productSpecSnapshot || '—'} · {line.purchaseUnit}</div></td>
                          <td className="p-2">{unitPriceMoney(line.unitPrice)} / {line.purchaseUnit}</td>
                          <td className="p-2"><input type="number" onWheel={event => event.currentTarget.blur()} aria-label={`${line.productNameSnapshot}采购数量`} min="0" step="any" value={orderQuantities[line.id] || ''} onChange={event => setOrderQuantities(current => ({...current, [line.id]: event.target.value}))} className="input max-w-36" /></td>
                          <td className="p-2"><button type="button" aria-label={`移除采购商品 ${line.productNameSnapshot}`} onClick={() => setOrderQuantities(current => { const next = {...current}; delete next[line.id]; return next })} className="text-red-fg">移除</button></td>
                        </tr>)}
                        {Object.keys(orderQuantities).length === 0 && <tr><td colSpan={5} className="p-5 text-center text-gray3">尚未添加商品，请先搜索要采购的商品。</td></tr>}
                      </tbody>
                    </table></div>
                  </section>
                )}
                <div className="mt-4 flex justify-end">
                  <ActionButton onClick={() => void createOrder()} disabled={working === 'create-order' || !selectedOrderContract}>
                    保存采购单草稿
                  </ActionButton>
                </div>
              </Panel>
            )}
            {showOrderForm && quickContractFromOrder && (
              <Panel title="快速建合同（供应商与现行供货价已带出）" onClose={() => setQuickContractFromOrder(false)}>
                <div className="grid gap-3 md:grid-cols-3">
                  <Field label="合同编号">
                    <input
                      className="input"
                      value={contractForm.contractNo}
                      onChange={(event) =>
                        setContractForm((value) => ({
                          ...value,
                          contractNo: event.target.value,
                        }))
                      }
                    />
                  </Field>
                  <Field label="合同名称">
                    <input
                      className="input"
                      value={contractForm.title}
                      onChange={(event) =>
                        setContractForm((value) => ({
                          ...value,
                          title: event.target.value,
                        }))
                      }
                    />
                  </Field>
                  <Field label="生效日">
                    <input
                      className="input"
                      type="date"
                      value={contractForm.startsAt}
                      onChange={(event) =>
                        setContractForm((value) => ({
                          ...value,
                          startsAt: event.target.value,
                        }))
                      }
                    />
                  </Field>
                </div>
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full text-caption">
                    <thead>
                      <tr className="border-b text-left">
                        <th className="p-2">商品</th>
                        <th className="p-2">采购单位</th>
                        <th className="p-2">当前供货价</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sources.map((source) => (
                        <tr key={source.id} className="border-b border-border">
                          <td className="p-2">
                            <b>{source.product.name}</b>
                            <div className="text-gray3">
                              {source.product.code} · {source.product.spec || '—'}
                            </div>
                          </td>
                          <td className="p-2">{source.purchaseUnit}</td>
                          <td className="p-2">
                            <input
                              className="input w-40"
                              aria-label={`${source.product.name}合同单价`}
                              type="number"
                              onWheel={event => event.currentTarget.blur()}
                              min="0"
                              step="0.01"
                              value={sourcePrices[source.id] || ''}
                              onChange={(event) =>
                                setSourcePrices((value) => ({
                                  ...value,
                                  [source.id]: event.target.value,
                                }))
                              }
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {sources.length === 0 && (
                    <p className="p-4 text-caption text-gray3">
                      暂无可采购供货关系，
                      <a href="/v2/supply-chain/products" className="text-accent underline">
                        去商品管理维护供应商与价格
                      </a>
                      。
                    </p>
                  )}
                </div>
                <div className="mt-4 flex justify-end">
                  <ActionButton onClick={() => void createContract()} disabled={working === 'create-contract'}>
                    保存合同草稿
                  </ActionButton>
                </div>
              </Panel>
            )}
            <section aria-label="采购单筛选" className="rounded-xl border border-border bg-white p-3">
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
                <Field label="日期口径"><select aria-label="采购日期口径" className="input" value={orderFilterDraft.dateField} onChange={event => setOrderFilterDraft(current => ({...current,dateField:event.target.value as OrderFilters['dateField']}))}><option value="createdAt">下单日</option><option value="expectedArrivalAt">到货日</option></select></Field>
                <Field label="开始日期"><input aria-label="采购开始日期" type="date" className="input" value={orderFilterDraft.dateFrom} onChange={event => setOrderFilterDraft(current => ({...current,dateFrom:event.target.value}))} /></Field>
                <Field label="结束日期"><input aria-label="采购结束日期" type="date" className="input" value={orderFilterDraft.dateTo} onChange={event => setOrderFilterDraft(current => ({...current,dateTo:event.target.value}))} /></Field>
                <Field label="供应商"><select aria-label="筛选采购供应商" className="input" value={orderFilterDraft.supplierId} onChange={event => setOrderFilterDraft(current => ({...current,supplierId:event.target.value}))}><option value="">全部供应商</option>{suppliers.map(supplier => <option key={supplier.id} value={supplier.id}>{supplier.no} · {supplier.name}</option>)}</select></Field>
                <Field label="商品"><input aria-label="筛选采购商品" type="search" className="input" placeholder="商品名称 / 编码" value={orderFilterDraft.productQuery} onChange={event => setOrderFilterDraft(current => ({...current,productQuery:event.target.value}))} onKeyDown={event => {if(event.key==='Enter'){setOrderPage(1);setOrderFilters({...orderFilterDraft})}}} /></Field>
                <div className="flex items-end gap-2"><button type="button" className="rounded-lg bg-ink px-4 py-2 text-white" onClick={() => {setOrderPage(1);setOrderFilters({...orderFilterDraft})}}>查询</button><button type="button" className="rounded-lg border border-border px-4 py-2" onClick={() => {setOrderFilterDraft(EMPTY_ORDER_FILTERS);setOrderFilters(EMPTY_ORDER_FILTERS);setOrderPage(1)}}>重置</button></div>
              </div>
              <p className="mt-2 text-micro text-gray3">按上海日期查询 · 共 {orderTotal} 张采购单</p>
            </section>
            {orders.length === 0 ? (
              <Empty text={Object.entries(orderFilters).some(([key,value])=>key!=='dateField'&&value.trim())?'没有符合筛选条件的采购单':'还没有上游采购单'} actionLabel="新建采购单" onAction={openNewOrderForm} />
            ) : (
              orders.map((order, index) => (
                <article id={`order-${order.id}`} key={order.id} className="rounded-2xl border border-border bg-white p-4 shadow-sm">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span aria-label="采购单序号" className="mr-2 font-num text-gray3">{(orderPage - 1) * 20 + index + 1}</span>
                        <button type="button" onClick={() => void openOrderDetail(order)} className="text-h3 underline decoration-dotted underline-offset-4" aria-label={`查看采购单 ${order.no} 明细`}>
                          {order.no}
                        </button>
                        <Badge status={order.status} labels={UPSTREAM_ORDER_STATUS_LABEL} />
                        {order.hasTemporaryPrice && <span className="rounded-full bg-red-50 px-2 py-1 text-micro text-red-700">临时价</span>}
                        {purchaseOrderOverdueText(order) && <span className="rounded-full bg-red-50 px-2 py-1 text-micro font-semibold text-red-700">{purchaseOrderOverdueText(order)}</span>}
                      </div>
                      <p className="mt-1 text-caption text-gray2">
                        {order.supplier.name} → {order.warehouse.name} · {order._count?.lines || 0} 项 · 到货 {shortDate(order.expectedArrivalAt)}
                      </p>
                    </div>
                    <div className="text-right">
                      <div className="text-h3">{money(order.totalAmount)}</div>
                      <div className="mt-2 flex flex-wrap justify-end gap-2">
                        {order.status === 'DRAFT' && (
                          <ActionButton
                            onClick={() => void run(order.id, () => apiFetch(`/api/upstream/purchase-orders/${order.id}/submit-for-approval`, { method: 'POST' }), '采购单已提交内部审核')}
                            disabled={working === order.id}
                          >
                            提交审核
                          </ActionButton>
                        )}
                        {order.status === 'PENDING_APPROVAL' && (
                          <ActionButton
                            onClick={() => openActionConfirm({
                              title: `审核并发送采购单 ${order.no}`,
                              body: '请确认合同、价格和数量无误。确认后采购单会发送给供应商。',
                              confirmLabel: '确认并发送', tone: 'primary',
                              onConfirm: async () => {
                                await run(order.id, () => apiFetch(`/api/upstream/purchase-orders/${order.id}/approve-and-send`, { method: 'POST' }), '采购单已发送供应商', undefined, true)
                              },
                            })}
                            disabled={working === order.id}
                          >
                            审核并发送
                          </ActionButton>
                        )}
                        {order.status === 'CHANGE_PROPOSED' && (
                          <ActionButton onClick={() => void openOrderDetail(order, 'revision')} disabled={working === order.id}>
                            查看改单内容
                          </ActionButton>
                        )}
                      </div>
                    </div>
                  </div>
                </article>
              ))
            )}
            <div className="flex items-center justify-end gap-3 text-caption" aria-label="采购单分页"><button type="button" disabled={orderPage<=1} onClick={() => setOrderPage(page => page-1)} className="rounded-lg border border-border px-3 py-2 disabled:opacity-40">上一页</button><span>第 {orderPage} / {Math.max(1,Math.ceil(orderTotal/20))} 页 · 每页20条</span><button type="button" disabled={orderPage*20>=orderTotal} onClick={() => setOrderPage(page => page+1)} className="rounded-lg border border-border px-3 py-2 disabled:opacity-40">下一页</button></div>
            <div className="rounded-2xl border border-border bg-white p-4">
              <h2 className="text-h3">供应商发货动态</h2>
              <div className="mt-3 space-y-2">
                {shipments.length === 0 ? (
                  <p className="text-caption text-gray3">暂无发货单</p>
                ) : (
                  shipments.map((shipment) => (
                    <div key={shipment.id} className="flex flex-col gap-2 rounded-xl bg-bg p-3 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <b>{shipment.no}</b>
                        <p className="text-caption text-gray2">
                          采购单 {shipment.purchaseOrder.no} · {shipment.lines.length} 项 · {shipment.status}
                        </p>
                      </div>
                      <div className="overflow-x-auto"><table className="text-caption"><thead><tr><th className="p-2">商品</th><th className="p-2">数量 / 单位</th><th className="p-2">质检</th></tr></thead><tbody>{shipment.lines.map(line=><tr key={line.id}><td className="p-2">{line.purchaseOrderLine.productNameSnapshot}</td><td className="p-2">{line.shippedQty} {line.purchaseUnit}</td><td className="p-2"><DocumentQualityImageButton kind="BATCH" sourceId={`S:${line.id}`}/></td></tr>)}</tbody></table></div>
                      {['SHIPPED', 'PARTIALLY_RECEIVED'].includes(shipment.status) && !shipmentFullyInspected(shipment) && <a className="rounded-lg border border-accent px-3 py-2 text-accent" href={`/v2/supply-chain/procurement/receipts/new?shipment=${encodeURIComponent(shipment.id)}`}>登记到货</a>}
                    </div>
                  ))
                )}
              </div>
            </div>
          </section>
        )}

        {!loading && tab === 'receipts' && (
          <section className="space-y-3">
            {claimingReceipt && (
              <Panel title={`收货后补报异常 · ${claimingReceipt.no}`} onClose={() => setClaimingReceipt(null)}>
                <p className="mb-3 text-caption text-gray2">
                  页面保留原采购单 {claimingReceipt.purchaseOrder.no} 的全部商品。少发可从未收数量中补报；收货后破损只能从本次合格入库数量中补报。原收货记录不会被修改，补报时限为入库后{' '}
                  {claimingReceipt.supplier.postReceiptClaimHours} 小时。
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="异常类型">
                    <select
                      className="input"
                      value={postClaimType}
                      onChange={(event) => {
                        setPostClaimType(event.target.value as 'SHORTAGE' | 'POST_RECEIPT_DAMAGE')
                        setPostClaimQuantities(Object.fromEntries(claimingReceipt.purchaseOrder.lines.map((line) => [line.id, '0'])))
                      }}
                    >
                      <option value="SHORTAGE">少发 / 未收到</option>
                      <option value="POST_RECEIPT_DAMAGE">收货后破损 / 品质异常</option>
                    </select>
                  </Field>
                  <Field label="异常说明">
                    <textarea
                      className="input min-h-20"
                      value={postClaimDescription}
                      onChange={(event) => setPostClaimDescription(event.target.value)}
                      placeholder="说明发现时间、异常表现和处理情况"
                    />
                  </Field>
                </div>
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full text-caption">
                    <thead>
                      <tr className="border-b text-left">
                        <th className="p-2">商品</th>
                        <th className="p-2">原订购</th>
                        <th className="p-2">已收</th>
                        <th className="p-2">本次合格</th>
                        <th className="p-2">可补报上限</th>
                        <th className="p-2">本次异常数量</th>
                      </tr>
                    </thead>
                    <tbody>
                      {claimingReceipt.purchaseOrder.lines.map((orderLine) => {
                        const receiptLine = claimingReceipt.lines.find((line) => line.purchaseOrderLineId === orderLine.id)
                        const target = Number(orderLine.confirmedQty ?? orderLine.orderedQty)
                        const maximum = postClaimType === 'SHORTAGE' ? Math.max(0, target - Number(orderLine.receivedQty || 0)) : Number(receiptLine?.acceptedQty || 0)
                        return (
                          <tr key={orderLine.id} className="border-b border-border">
                            <td className="p-2">
                              <b>{orderLine.productNameSnapshot}</b>
                              <div className="text-gray3">{orderLine.productSpecSnapshot || '—'}</div>
                            </td>
                            <td className="p-2">
                              {String(target)} {orderLine.purchaseUnit}
                            </td>
                            <td className="p-2">
                              {String(orderLine.receivedQty)} {orderLine.purchaseUnit}
                            </td>
                            <td className="p-2">
                              {String(receiptLine?.acceptedQty || 0)} {orderLine.purchaseUnit}
                            </td>
                            <td className="p-2">
                              {String(maximum)} {orderLine.purchaseUnit}
                            </td>
                            <td className="p-2">
                              <input
                                type="number"
                              onWheel={event => event.currentTarget.blur()}
                                min="0"
                                max={maximum}
                                step="any"
                                disabled={maximum <= 0}
                                className="input w-32 disabled:cursor-not-allowed disabled:bg-bg"
                                value={postClaimQuantities[orderLine.id] || ''}
                                onChange={(event) =>
                                  setPostClaimQuantities((current) => ({
                                    ...current,
                                    [orderLine.id]: event.target.value,
                                  }))
                                }
                              />
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="mt-4">
                  <span className="mb-1 block text-micro text-gray3">图片/视频证据（必填，最多 4 个）</span>
                  <div className="flex flex-wrap items-center gap-2">
                    {postClaimEvidence.map((item, index) => (
                      <span key={`${item.url}-${index}`} className="rounded-lg bg-bg px-3 py-2 text-caption">
                        {item.name}
                        <button className="ml-2 text-red-700" onClick={() => setPostClaimEvidence((current) => current.filter((_, currentIndex) => currentIndex !== index))}>
                          删除
                        </button>
                      </span>
                    ))}
                    <label className="cursor-pointer rounded-lg border border-dashed border-border px-3 py-2 text-caption text-gray2">
                      {uploadingEvidence ? '上传中…' : '上传证据'}
                      <input
                        type="file"
                        accept="image/*,video/*"
                        className="hidden"
                        disabled={uploadingEvidence || postClaimEvidence.length >= 4}
                        onChange={(event) => {
                          const file = event.target.files?.[0]
                          event.target.value = ''
                          if (file) void uploadPostClaimEvidence(file)
                        }}
                      />
                    </label>
                  </div>
                </div>
                <div className="mt-4 flex justify-end">
                  <ActionButton onClick={() => void submitPostReceiptClaim()} disabled={working === `post-claim-${claimingReceipt.id}` || uploadingEvidence}>
                    提交补报
                  </ActionButton>
                </div>
              </Panel>
            )}
            {receipts.length === 0 ? (
              <Empty text="暂无待验收单据" />
            ) : (
              receipts.map((receipt) => (
                <article key={receipt.id} className="rounded-2xl border border-border bg-white p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void openReceiptDetail(receipt)}
                          className="text-h3 underline decoration-dotted underline-offset-4"
                          aria-label={`查看收货单 ${receipt.no} 明细`}
                        >
                          {receipt.no}
                        </button>
                        <Badge status={receipt.status} labels={UPSTREAM_RECEIPT_STATUS_LABEL} />
                      </div>
                      <p className="mt-1 text-caption text-gray2">
                        {receipt.supplier.name} · 采购单 <b>{receipt.purchaseOrder.no}</b> · 发货单 {receipt.shipment?.no || '—'}
                      </p>
                      <p className="mt-1 text-caption text-gray3">
                        {receipt._count.lines} 项 · 采购单金额 <b>{receipt.purchaseOrder.totalAmount == null ? '—' : money(receipt.purchaseOrder.totalAmount)}</b> · 本次应付{' '}
                        <b>{money(receipt.payableAmount)}</b>
                        {receipt.reviewReasons?.length ? ` · 复核：${receipt.reviewReasons.join('、')}` : ''}
                      </p>
                      {receipt.status === 'POSTED' && receipt._count.claims > 0 && <p className="mt-1 text-micro text-amber-fg">已关联差异单，不能整单冲销；如库存有误请走实盘调整。</p>}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <a
                        href={`/v2/supply-chain/suppliers/${encodeURIComponent(receipt.supplier.id)}/evidence?receiptId=${encodeURIComponent(receipt.id)}`}
                        className="rounded-lg border border-accent bg-white px-3 py-2 text-caption font-medium text-accent"
                      >
                        {receipt.status === 'POSTED' ? '查看来货证明' : '维护来货证明'}
                      </a>
                      <ProcurementProgressActions kind="RECEIPT" row={receipt} role={getUser()?.role || ''} busy={Boolean(working)} onAction={action => confirmProcurementProgress('RECEIPT', receipt, action)} />

                      {receipt.status === 'POSTED' && (
                        <ActionButton tone="light" onClick={() => void openPostReceiptClaim(receipt)}>
                          收货后补报异常
                        </ActionButton>
                      )}
                      {receipt.status === 'POSTED' && receipt._count.claims === 0 && (
                        <ActionButton tone="danger" onClick={() => void reverseReceipt(receipt)} disabled={working === `reverse-${receipt.id}`}>
                          冲销收货
                        </ActionButton>
                      )}
                    </div>
                  </div>
                </article>
              ))
            )}
          </section>
        )}

        {!loading && tab === 'returns' && (
          <section className="space-y-4">
            <div className="flex justify-end">
              <a className="rounded-lg border border-border bg-white px-4 py-2" href="/v2/supply-chain/procurement/returns/new">新建采购退货</a>
            </div>
            {purchaseReturns.length === 0 ? (
              <Empty text="暂无采购退货单" />
            ) : (
              purchaseReturns.map((row) => (
                <article key={row.id} className="rounded-2xl border border-border bg-white p-4">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <b className="text-h3">{row.no}</b>
                        <Badge
                          status={row.status}
                          labels={{
                            DRAFT: '草稿',
                            PENDING_APPROVAL: '待审核',
                            APPROVED: '已出库',
                            RECEIVED: '供应商已收货',
                            REJECTED: '已驳回',
                            CANCELLED: '已取消',
                          }}
                        />
                        <span className="text-caption text-red-700">退货金额 {money(row.settlementAmount)}</span>
                      </div>
                      <p className="mt-1 text-caption text-gray2">
                        {row.supplier.name} · {row.warehouse.name} · {row.reason}
                      </p>
                      <ul className="mt-2 text-caption text-gray2">
                        {row.lines.map((line) => (
                          <li key={line.id}>
                            · 原收货单 {line.receiptLine.receipt.no} · {line.product.name} {String(line.purchaseQuantity)} {line.purchaseUnit} · {money(line.settlementAmount)}
                          </li>
                        ))}
                      </ul>
                      {['APPROVED', 'RECEIVED'].includes(row.status) && (
                        <p className="mt-2 text-micro text-gray3">
                          实际库存成本 {money(row.ledgerCostAmount)} · 审批出库 {shortDate(row.approvedAt)}
                          {row.receivedAt ? ` · 供应商签收 ${shortDate(row.receivedAt)}` : ''}
                        </p>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <ProcurementProgressActions kind="RETURN" row={row} role={getUser()?.role || ''} busy={Boolean(working)} onAction={action => confirmProcurementProgress('RETURN', row, action)} />

                      {row.status === 'APPROVED' && (
                        <ActionButton
                          onClick={() => openActionConfirm({
                            title: `登记退货单 ${row.no} 实际收货`,
                            body: '仅在供应商已实际收到退货货物后确认。',
                            confirmLabel: '确认已收货', tone: 'primary',
                            onConfirm: async () => {
                              await run(`receive-return-${row.id}`, () => apiFetch(`/api/upstream/purchase-returns/${row.id}/receive`, { method: 'POST', body: '{}' }), '已登记供应商实际收货', undefined, true)
                            },
                          })}
                          disabled={working === `receive-return-${row.id}`}
                        >
                          登记供应商实收
                        </ActionButton>
                      )}
                    </div>
                  </div>
                </article>
              ))
            )}
          </section>
        )}

        {!loading && tab === 'claims' && (
          <section className="space-y-3">
            {claims.length === 0 ? (
              <Empty text="暂无到货差异" />
            ) : (
              claims.map((claim) => {
                const resolutionCopy = claimResolutionCopy(claim.type, money(claim.claimedAmount))
                return (
                  <article key={claim.id} id={`arrival-claim-${claim.id}`} data-print-sheet className="rounded-2xl border border-border bg-white p-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <b className="text-h3">{claim.no}</b>
                          <Badge status={claim.status} labels={UPSTREAM_CLAIM_STATUS_LABEL} />
                          <span className="text-caption text-red-700">{money(claim.claimedAmount)}</span>
                        </div>
                        <p className="mt-2 text-caption text-gray1">{claim.description}</p>
                        <div className="mt-2 flex flex-wrap gap-2 text-caption">
                          <button
                            type="button"
                            onClick={() => void openOrderDetail(claim.purchaseOrder)}
                            className="rounded-lg border border-border bg-bg px-2 py-1 underline decoration-dotted underline-offset-2"
                          >
                            采购单 {claim.purchaseOrder.no}
                          </button>
                          <button
                            type="button"
                            onClick={() => void openReceiptDetail(claim.receipt)}
                            className="rounded-lg border border-border bg-bg px-2 py-1 underline decoration-dotted underline-offset-2"
                          >
                            收货单 {claim.receipt.no}
                          </button>
                        </div>
                        <ul className="mt-2 text-caption text-gray2">
                          {claim.lines.map((line) => (
                            <li key={line.id}>
                              · {line.product.name} {String(line.affectedQty)} {line.purchaseUnit}
                            </li>
                          ))}
                        </ul>
                        {claim.evidence && claim.evidence.length > 0 && (
                          <div className="mt-2 text-caption text-gray2">
                            <b>举证材料：</b>
                            <span className="ml-1 inline-flex flex-wrap gap-2">
                              {claim.evidence.map((item, index) => {
                                const evidence = claimEvidence(item, index)
                                return evidence.url ? (
                                  <a key={`${evidence.url}-${index}`} href={evidence.url} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                                    {evidence.name}
                                  </a>
                                ) : (
                                  <span key={`evidence-${index}`}>{evidence.name}</span>
                                )
                              })}
                            </span>
                          </div>
                        )}
                        {claim.supplierResponse && <p className="mt-2 rounded-lg bg-bg p-2 text-caption text-gray2">供应商回复：{claim.supplierResponse}</p>}
                        {claim.responsibility && (
                          <p className="mt-1 text-micro text-gray3">
                            处理结果：{claim.responsibility} · {claim.resolution || '待定'}
                            {claim.resolvedAmount != null ? ` · ${money(claim.resolvedAmount)}` : ''}
                          </p>
                        )}
                      </div>
                      <div className="flex gap-2" data-print-hidden>
                        <PrintButton printId={`arrival-claim-${claim.id}`} />
                        {claim.status === 'SUPPLIER_REJECTED' && (
                          <ActionButton
                            tone="danger"
                            onClick={() => void run(claim.id, () => apiFetch(`/api/upstream/arrival-claims/${claim.id}/start-arbitration`, { method: 'POST' }), '差异已进入仲裁')}
                            disabled={working === claim.id}
                          >
                            转仲裁
                          </ActionButton>
                        )}
                        {['SUPPLIER_ACCEPTED', 'AUTO_ACCEPTED', 'ARBITRATION'].includes(claim.status) && (
                          <ActionButton
                            onClick={() => openActionConfirm({
                              title: resolutionCopy.button,
                              body: resolutionCopy.confirmation,
                              confirmLabel: '确认办结', tone: 'primary',
                              onConfirm: async () => {
                                await run(
                                  claim.id,
                                  () => apiFetch(`/api/upstream/arrival-claims/${claim.id}/resolve`, {
                                    method: 'POST',
                                    body: JSON.stringify({ responsibility: 'SUPPLIER', resolution: 'DEDUCTION', resolvedAmount: Number(claim.claimedAmount) }),
                                  }),
                                  '差异已办结并进入对账', undefined, true
                                )
                              },
                            })}
                            disabled={working === claim.id}
                          >
                            {resolutionCopy.button}
                          </ActionButton>
                        )}
                      </div>
                    </div>
                  </article>
                )
              })
            )}
          </section>
        )}

        {!loading && tab === 'settlements' && (
          <section className="space-y-4">
            {viewingStatement && (
              <Panel title={`对账单明细 · ${viewingStatement.no}`} onClose={() => setViewingStatement(null)} printId={`statement-${viewingStatement.id}`}>
                <div className="rounded-xl bg-bg p-3 text-caption">
                  {viewingStatement.supplier.name} · {shortDate(viewingStatement.periodStart)}—{shortDate(viewingStatement.periodEnd)} · 应付 <b>{money(viewingStatement.payableAmount)}</b>
                </div>
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full text-left text-caption">
                    <thead>
                      <tr className="border-b">
                        <th className="p-2">日期</th>
                        <th className="p-2">来源</th>
                        <th className="p-2">采购单</th>
                        <th className="p-2">收货/差异单</th>
                        <th className="p-2">说明</th>
                        <th className="p-2">原金额</th>
                        <th className="p-2">调整</th>
                        <th className="p-2">应付</th>
                      </tr>
                    </thead>
                    <tbody>
                      {viewingStatement.lines.map((line) => {
                        const purchaseOrder = line.receiptLine?.receipt?.purchaseOrder || line.claim?.purchaseOrder
                        const receipt = line.receiptLine?.receipt || line.claim?.receipt
                        return (
                          <tr key={line.id} className="border-b border-border">
                            <td className="p-2">{shortDate(line.businessDate)}</td>
                            <td className="p-2">{settlementLineTypeLabel(line.sourceType, line.adjustmentAmount)}</td>
                            <td className="p-2">
                              {purchaseOrder ? (
                                <button type="button" className="underline decoration-dotted" onClick={() => void openOrderDetail(purchaseOrder)}>
                                  {purchaseOrder.no}
                                </button>
                              ) : (
                                '—'
                              )}
                            </td>
                            <td className="p-2">
                              <div className="flex flex-col items-start gap-1">
                                {receipt ? (
                                  <button type="button" className="underline decoration-dotted" onClick={() => void openReceiptDetail(receipt)}>
                                    收货单 {receipt.no}
                                  </button>
                                ) : null}
                                {line.claim ? (
                                  <button
                                    type="button"
                                    className="underline decoration-dotted"
                                    onClick={() => {
                                      setViewingStatement(null)
                                      focusRecord('claims', `arrival-claim-${line.claim!.id}`)
                                    }}
                                  >
                                    差异单 {line.claim.no}
                                  </button>
                                ) : !receipt ? (
                                  <span>{line.sourceNo}</span>
                                ) : null}
                              </div>
                            </td>
                            <td className="p-2">{line.description}</td>
                            <td className="p-2">{money(line.originalAmount)}</td>
                            <td className="p-2">{money(line.adjustmentAmount)}</td>
                            <td className="p-2">
                              <b>{money(line.payableAmount)}</b>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </Panel>
            )}
            <Panel title="生成月度对账单">
              <div className="grid gap-3 sm:grid-cols-4">
                <Field label="供应商">
                  <select
                    className="input"
                    value={settlementForm.supplierId}
                    onChange={(event) =>
                      setSettlementForm((value) => ({
                        ...value,
                        supplierId: event.target.value,
                      }))
                    }
                  >
                    {suppliers.map((supplier) => (
                      <option key={supplier.id} value={supplier.id}>
                        {supplier.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="开始日期">
                  <input
                    className="input"
                    type="date"
                    value={settlementForm.periodStart}
                    onChange={(event) =>
                      setSettlementForm((value) => ({
                        ...value,
                        periodStart: event.target.value,
                      }))
                    }
                  />
                </Field>
                <Field label="结束日期">
                  <input
                    className="input"
                    type="date"
                    value={settlementForm.periodEnd}
                    onChange={(event) =>
                      setSettlementForm((value) => ({
                        ...value,
                        periodEnd: event.target.value,
                      }))
                    }
                  />
                </Field>
                <div className="flex items-end">
                  <ActionButton
                    onClick={() =>
                      void run(
                        'generate-statement',
                        () =>
                          apiFetch('/api/upstream/settlement-statements/generate', {
                            method: 'POST',
                            body: JSON.stringify(settlementForm),
                          }),
                        '对账单已生成'
                      )
                    }
                    disabled={working === 'generate-statement'}
                  >
                    生成对账单
                  </ActionButton>
                </div>
              </div>
            </Panel>
            {statements.length === 0 ? (
              <Empty text="暂无对账单" />
            ) : (
              statements.map((statement) => (
                <article id={`statement-${statement.id}`} key={statement.id} className="rounded-2xl border border-border bg-white p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <button type="button" onClick={() => void openStatementDetail(statement)} className="text-h3 underline decoration-dotted underline-offset-4">
                          {statement.no}
                        </button>
                        <Badge status={statement.status} labels={UPSTREAM_SETTLEMENT_STATUS_LABEL} />
                      </div>
                      <p className="mt-1 text-caption text-gray2">
                        {statement.supplier.name} · {shortDate(statement.periodStart)}—{shortDate(statement.periodEnd)} · V{statement.version}
                      </p>
                      <p className="mt-1 text-caption text-gray3">
                        收货 {money(statement.receiptAmount)} · 扣款 {money(statement.deductionAmount)} · 应付 <b>{money(statement.payableAmount)}</b>
                      </p>
                      {statement.status === 'CONFIRMED' && <p className="mt-1 text-micro text-amber-fg">供应商已确认，已通知财务，等待锁定。</p>}
                    </div>
                    <div className="flex gap-2">
                      {statement.status === 'DRAFT' || statement.status === 'DISPUTED' ? (
                        <ActionButton
                          onClick={() => void run(statement.id, () => apiFetch(`/api/upstream/settlement-statements/${statement.id}/send`, { method: 'POST' }), '对账单已发送供应商')}
                          disabled={working === statement.id}
                        >
                          发送供应商
                        </ActionButton>
                      ) : null}
                    </div>
                  </div>
                </article>
              ))
            )}
          </section>
        )}

        {!loading && tab === 'standards' && (
          <section className="space-y-4">
            <div className="rounded-2xl border border-amber/30 bg-amber/10 p-4 text-caption text-gray1">
              <b>使用顺序：</b>先维护商品与供应商的供货关系，再按采购单位、币种和含税口径配标准价；质量标准按商品维护。新采购单会冻结当时版本，之后修改不会篡改历史。
            </div>
            <div className="grid gap-4 xl:grid-cols-2">
              <Panel title="新版本·商品质量验收标准">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="商品">
                    <select className="input" value={qualityStandardForm.productId} onChange={(event) => setQualityStandardForm((current) => ({ ...current, productId: event.target.value }))}>
                      <option value="">请选择商品</option>
                      {standardProducts.map((item) => <option key={item.productId} value={item.productId}>{item.productName} · {item.productSpec || item.productCode}</option>)}
                    </select>
                  </Field>
                  <Field label="标准名称">
                    <input className="input" value={qualityStandardForm.title} onChange={(event) => setQualityStandardForm((current) => ({ ...current, title: event.target.value }))} placeholder="例如：黑牛肝菌到货验收标准" />
                  </Field>
                  <Field label="验收条件">
                    <textarea className="input min-h-24" value={qualityStandardForm.criteria} onChange={(event) => setQualityStandardForm((current) => ({ ...current, criteria: event.target.value }))} placeholder="填写外观、新鲜度、大小、气味、不可接收情形等" />
                  </Field>
                  <Field label="生效日">
                    <input className="input" type="date" max={shanghaiBusinessDate()} value={qualityStandardForm.effectiveAt} onChange={(event) => setQualityStandardForm((current) => ({ ...current, effectiveAt: event.target.value }))} />
                  </Field>
                </div>
                <div className="mt-4 flex justify-end"><ActionButton onClick={() => void createQualityStandard()} disabled={working === 'create-quality-standard'}>保存新版本</ActionButton></div>
              </Panel>
              <Panel title="新版本·标准采购价">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="供应商 / 商品 / 采购单位">
                    <select className="input" value={priceScopeKey} onChange={(event) => setPriceScopeKey(event.target.value)}>
                      <option value="">请选择已有供货关系</option>
                      {standardScopes.map((scope) => <option key={scope.key} value={scope.key}>{scope.supplierName} · {scope.productName} · {scope.purchaseUnit} · {scope.currency} · {scope.taxInclusive ? '含税' : '不含税'}</option>)}
                    </select>
                  </Field>
                  <Field label="标准单价">
                    <input className="input" type="number" min="0.000001" step="0.000001" value={priceStandardForm.unitPrice} onChange={(event) => setPriceStandardForm((current) => ({ ...current, unitPrice: event.target.value }))} />
                  </Field>
                  <Field label="生效日">
                    <input className="input" type="date" max={shanghaiBusinessDate()} value={priceStandardForm.effectiveAt} onChange={(event) => setPriceStandardForm((current) => ({ ...current, effectiveAt: event.target.value }))} />
                  </Field>
                </div>
                <div className="mt-4 flex justify-end"><ActionButton onClick={() => void createPriceStandard()} disabled={working === 'create-price-standard'}>保存新版本</ActionButton></div>
              </Panel>
            </div>

            <Panel title="质量标准·当前与历史">
              <div className="overflow-x-auto"><table className="w-full text-left text-caption"><thead><tr className="border-b"><th className="p-2">商品</th><th className="p-2">版本</th><th className="p-2">名称 / 条件</th><th className="p-2">生效日</th><th className="p-2">状态</th><th className="p-2">操作</th></tr></thead><tbody>
                {qualityStandards.map((standard) => <tr key={standard.id} className="border-b border-border"><td className="p-2"><b>{standard.product.name}</b><div className="text-gray3">{standard.product.spec || standard.product.code}</div></td><td className="p-2">v{standard.version}</td><td className="p-2"><b>{standard.title}</b><div className="text-gray3">{qualityCriteriaText(standard.criteria)}</div></td><td className="p-2">{shortDate(standard.effectiveAt)}</td><td className="p-2">{standard.active ? <span className="text-green-700">启用中</span> : <span className="text-gray3">历史版本</span>}</td><td className="p-2">{standard.active ? <ActionButton tone="danger" onClick={() => deactivateStandard('quality', standard)}>停用</ActionButton> : '—'}</td></tr>)}
              </tbody></table></div>
            </Panel>

            <Panel title="价格标准·当前与历史">
              <div className="overflow-x-auto"><table className="w-full text-left text-caption"><thead><tr className="border-b"><th className="p-2">供应商</th><th className="p-2">商品</th><th className="p-2">版本</th><th className="p-2">口径</th><th className="p-2">标准价</th><th className="p-2">状态</th><th className="p-2">操作</th></tr></thead><tbody>
                {priceStandards.map((standard) => <tr key={standard.id} className="border-b border-border"><td className="p-2">{standard.supplier.name}</td><td className="p-2"><b>{standard.product.name}</b><div className="text-gray3">{standard.product.spec || standard.product.code}</div></td><td className="p-2">v{standard.version}</td><td className="p-2">{standard.purchaseUnit} · {standard.currency} · {standard.taxInclusive ? '含税' : '不含税'}</td><td className="p-2"><b>{currencyAmount(standard.unitPrice, standard.currency)}</b></td><td className="p-2">{standard.active ? <span className="text-green-700">启用中</span> : <span className="text-gray3">历史版本</span>}</td><td className="p-2">{standard.active ? <ActionButton tone="danger" onClick={() => deactivateStandard('price', standard)}>停用</ActionButton> : '—'}</td></tr>)}
              </tbody></table></div>
            </Panel>
          </section>
        )}

        {!loading && tab === 'contracts' && (
          <section className="space-y-4">
            {viewingContract && (
              <Panel title={`合同内容 · ${viewingContract.title}`} onClose={() => setViewingContract(null)} printId={`contract-${viewingContract.id}`}>
                <div className="grid gap-2 rounded-xl bg-bg p-3 text-caption sm:grid-cols-2 lg:grid-cols-4">
                  <div>
                    <span className="text-gray3">合同编号</span>
                    <div>{viewingContract.contractNo}</div>
                  </div>
                  <div>
                    <span className="text-gray3">供应商</span>
                    <div>{viewingContract.supplier.name}</div>
                  </div>
                  <div>
                    <span className="text-gray3">版本 / 状态</span>
                    <div>
                      V{viewingContract.version} ·{' '}
                      {{
                        DRAFT: '草稿',
                        ACTIVE: '生效中',
                        TERMINATED: '已终止',
                      }[viewingContract.status] || viewingContract.status}
                    </div>
                  </div>
                  <div>
                    <span className="text-gray3">有效期</span>
                    <div>
                      {shortDate(viewingContract.startsAt)} — {viewingContract.endsAt ? shortDate(viewingContract.endsAt) : '长期'}
                    </div>
                  </div>
                  <div>
                    <span className="text-gray3">结算方式</span>
                    <div>{contractSettlementText(viewingContract)}</div>
                  </div>
                  <div>
                    <span className="text-gray3">价格口径</span>
                    <div>{viewingContract.taxInclusive ? '含税价' : '不含税价'}</div>
                  </div>
                  <div>
                    <span className="text-gray3">币种</span>
                    <div>{viewingContract.currency}</div>
                  </div>
                  <div>
                    <span className="text-gray3">付款方式</span>
                    <div>{viewingContract.paymentMethod || '—'}</div>
                  </div>
                </div>
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full text-left text-caption">
                    <thead>
                      <tr className="border-b">
                        <th className="p-2">商品</th>
                        <th className="p-2">编码</th>
                        <th className="p-2">规格</th>
                        <th className="p-2">供应商编码</th>
                        <th className="p-2">采购单位</th>
                        <th className="p-2">库存换算</th>
                        <th className="p-2">合同单价</th>
                        <th className="p-2">税率</th>
                        <th className="p-2">起订量</th>
                        <th className="p-2">包装倍数</th>
                        <th className="p-2">交期</th>
                        <th className="p-2">短/溢装</th>
                      </tr>
                    </thead>
                    <tbody>
                      {viewingContract.lines.map((line) => (
                        <tr key={line.id} className="border-b border-border">
                          <td className="p-2">
                            <b>{line.productNameSnapshot}</b>
                          </td>
                          <td className="p-2">{line.productCodeSnapshot}</td>
                          <td className="p-2">{line.productSpecSnapshot || '—'}</td>
                          <td className="p-2">{line.supplierSkuSnapshot || '—'}</td>
                          <td className="p-2">{line.purchaseUnit}</td>
                          <td className="p-2">
                            1 {line.purchaseUnit} = {String(line.inventoryUnitsPerPurchaseUnit)} {line.inventoryUnit}
                          </td>
                          <td className="p-2">
                            <b>{unitPriceMoney(line.unitPrice)}</b>
                          </td>
                          <td className="p-2">{formatPercent(line.taxRate)}</td>
                          <td className="p-2">{String(line.minOrderQty)}</td>
                          <td className="p-2">{String(line.packageMultiple)}</td>
                          <td className="p-2">{line.leadTimeDays} 天</td>
                          <td className="p-2">
                            {formatPercent(line.shortTolerancePct)} / {formatPercent(line.overTolerancePct)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Panel>
            )}
            <div className="flex justify-end">
              {contractCopyRecoveryBlocked&&<p role="alert" className="text-red-700">合同创建恢复记录无法读取，请先核对已有合同，不要重新创建。</p>}
              <ActionButton onClick={toggleContractForm} disabled={working === 'create-contract' || contractCopyRecoveryBlocked}>{showContractForm ? '收起' : '新建合同'}</ActionButton>
            </div>
            {showContractForm && (
              <Panel title={contractCopy ? `复制合同 V${contractCopy.version} 为新版草稿` : '新建月结合同'}>
                {contractCopy && <div className="mb-3 rounded-xl border border-amber/30 bg-amber/10 p-3 text-caption">
                  仅修改下列商品价格；供应商、编号、结算、币种、税率、起止日期、容差及附件等原条款全部保留。
                  原有效期：{shortDate(contractCopy.startsAt)} 至 {shortDate(contractCopy.endsAt)}；不自动延长已过期合同。
                  保存仅建草稿，供应链启用新版后只影响新订单，旧订单不改。
                  {contractCopyLoading && <p>正在核对原供货关系与单位换算…</p>}
                  {contractCopyPending && <p>创建结果待核对：价格已锁定，请重试原创建请求，不要另建合同。</p>}
                </div>}
                <div className="grid gap-3 md:grid-cols-4">
                  <Field label="供应商">
                    <input type="search" aria-label="搜索合同供应商" disabled={Boolean(contractCopy)} placeholder="输入供应商名称或编号" value={contractSupplierQuery} onChange={event => setContractSupplierQuery(event.target.value)} className="input mb-2" />
                    <select aria-label="合同供应商" disabled={Boolean(contractCopy)} className="input" value={contractSupplierId} onChange={(event) => void loadSources(event.target.value)}>
                      <option value="">请选择</option>
                      {suppliers.filter(supplier => supplier.id === contractSupplierId || `${supplier.no} ${supplier.name}`.toLowerCase().includes(contractSupplierQuery.trim().toLowerCase())).map((supplier) => (
                        <option key={supplier.id} value={supplier.id}>
                          {supplier.no} · {supplier.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="合同编号">
                    <input
                      className="input"
                      disabled={Boolean(contractCopy)}
                      value={contractForm.contractNo}
                      onChange={(event) =>
                        setContractForm((value) => ({
                          ...value,
                          contractNo: event.target.value,
                        }))
                      }
                      placeholder="例如 HT202609-01"
                    />
                  </Field>
                  <Field label="合同名称">
                    <input
                      className="input"
                      disabled={Boolean(contractCopy)}
                      value={contractForm.title}
                      onChange={(event) =>
                        setContractForm((value) => ({
                          ...value,
                          title: event.target.value,
                        }))
                      }
                      placeholder="例如 2026年食材供货合同"
                    />
                  </Field>
                  <Field label="生效日">
                    <input
                      className="input"
                      type="date"
                      disabled={Boolean(contractCopy)}
                      value={contractForm.startsAt}
                      onChange={(event) =>
                        setContractForm((value) => ({
                          ...value,
                          startsAt: event.target.value,
                        }))
                      }
                    />
                  </Field>
                </div>
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full text-caption">
                    <thead>
                      <tr className="border-b text-left">
                        <th className="p-2">商品</th>
                        <th className="p-2">采购单位</th>
                        <th className="p-2">库存换算</th>
                        <th className="p-2">{contractCopy ? `${contractCopy.taxInclusive ? '含税' : '不含税'}单价（全部保留）` : '含税单价（留空不纳入）'}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sources.map((source) => (
                        <tr key={source.id} className="border-b border-border">
                          <td className="p-2">
                            <b>{source.product.name}</b>
                            <div className="text-gray3">
                              {source.product.code} · {source.product.spec || '—'}
                            </div>
                          </td>
                          <td className="p-2">{source.purchaseUnit}</td>
                          <td className="p-2">
                            1 {source.purchaseUnit} = {String(source.inventoryUnitsPerPurchaseUnit)} {source.product.inventoryUnit || source.product.unit}
                          </td>
                          <td className="p-2">
                            <input
                              className="input w-36"
                              aria-label={`${source.product.name}合同单价`}
                              disabled={contractCopyPending}
                              type="number"
                              onWheel={event => event.currentTarget.blur()}
                              min="0"
                              step="0.01"
                              value={sourcePrices[source.id] || ''}
                              onChange={(event) =>
                                setSourcePrices((value) => ({
                                  ...value,
                                  [source.id]: event.target.value,
                                }))
                              }
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {contractSupplierId && sources.length === 0 && (
                    <p className="p-4 text-caption text-gray3">
                      该供应商尚未绑定可采购商品，
                      <a href="/v2/supply-chain/suppliers" className="text-accent underline">
                        去供应商管理维护供货商品与价格
                      </a>
                      。
                    </p>
                  )}
                </div>
                <div className="mt-4 flex justify-end">
                  <ActionButton onClick={() => void createContract()} disabled={working === 'create-contract' || contractCopyLoading || Boolean(contractCopy && sources.length === 0)}>
                    {contractCopyPending ? '核对并重试原创建' : contractCopy ? '保存新版合同草稿' : '保存合同草稿'}
                  </ActionButton>
                </div>
              </Panel>
            )}
            {contracts.length === 0 ? (
              <Empty text="暂无合同" />
            ) : (
              contracts.map((contract) => (
                <article id={`contract-${contract.id}`} key={contract.id} className="rounded-2xl border border-border bg-white p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setViewingContract(contract)}
                          className="text-left text-h3 underline decoration-dotted underline-offset-4"
                          aria-label={`查看合同 ${contract.title} 内容`}
                        >
                          {contract.contractNo} · {contract.title}
                        </button>
                        <Badge
                          status={contract.status}
                          labels={{
                            DRAFT: '草稿',
                            ACTIVE: '生效中',
                            TERMINATED: '已终止',
                          }}
                        />
                      </div>
                      <p className="mt-1 text-caption text-gray2">
                        {contract.supplier.name} · V{contract.version} · {contract.lines.length} 个商品 · {shortDate(contract.startsAt)} 起
                      </p>
                    </div>
                    <div className="flex gap-2">
                      {contract.status === 'ACTIVE' && <ActionButton onClick={() => void openContractCopy(contract)} disabled={Boolean(working) || showContractForm || showOrderForm || contractCopyRecoveryBlocked}>复制新版改价</ActionButton>}
                      {contract.status === 'DRAFT' && (
                        <ActionButton onClick={() => confirmContractActivation(contract)} disabled={working === contract.id}>
                          启用合同
                        </ActionButton>
                      )}
                    </div>
                  </div>
                </article>
              ))
            )}
          </section>
        )}
      </main>
      <ConfirmSheet {...revisionRejectConfirm} />
      <ConfirmSheet {...actionConfirm} />
    </div>
  )
}

function shipmentFullyInspected(shipment: Shipment): boolean {
  // 每一行发货数量的「实到+短少」都已入账, 视为收完 — 不再显示「登记到货」
  return (
    shipment.lines.length > 0 &&
    shipment.lines.every((line) => {
      const inspected = (line.receiptLines || []).reduce((sum, item) => sum + Number(item.arrivedQty) + Number(item.shortageQty), 0)
      return inspected + 0.000001 >= Number(line.shippedQty)
    })
  )
}


function revisionComparison(order: Order, revision: NonNullable<Order['revisions']>[number]) {
  const before = new Map((revision.beforeSnapshot?.lines || []).map((line) => [line.id, Number(line.quantity)]))
  const after = new Map((revision.afterSnapshot?.lines || []).map((line) => [line.id, Number(line.quantity)]))
  return (order.lines || []).map((line) => {
    const beforeQuantity = before.get(line.id) ?? Number(line.orderedQty)
    const afterQuantity = after.get(line.id) ?? beforeQuantity
    const beforePrice = String(revision.beforeSnapshot?.lines?.find(row => row.id === line.id)?.unitPrice ?? line.unitPrice)
    const afterPrice = String(revision.afterSnapshot?.lines?.find(row => row.id === line.id)?.unitPrice ?? beforePrice)
    return {
      id: line.id,
      name: line.productNameSnapshot,
      spec: line.productSpecSnapshot,
      unit: line.purchaseUnit,
      before: beforeQuantity,
      after: afterQuantity,
      delta: Number((afterQuantity - beforeQuantity).toFixed(6)),
      beforePrice, afterPrice,
      beforeAmount: procurementDecimalProduct(String(beforeQuantity), beforePrice),
      afterAmount: procurementDecimalProduct(String(afterQuantity), afterPrice),
      changed: Math.abs(afterQuantity - beforeQuantity) > 0.000001 || Number(beforePrice) !== Number(afterPrice),
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
  const cycle =
    (
      {
        MONTHLY: '月结',
        FIXED_DAYS: '固定账期',
        WEEKLY: '周结',
        ON_DELIVERY: '货到结算',
      } as Record<string, string>
    )[contract.settlementCycle] || contract.settlementCycle
  return contract.settlementDays > 0 ? `${cycle} · ${contract.settlementDays} 天` : cycle
}

function Summary({ label, value, danger }: { label: string; value: number; danger?: boolean }) {
  return (
    <div className="rounded-2xl border border-border bg-white p-4">
      <div className="text-caption text-gray3">{label}</div>
      <div className={`mt-1 text-[28px] font-bold ${danger ? 'text-red-700' : 'text-gray1'}`}>{value}</div>
    </div>
  )
}

function Empty({ text, actionLabel, onAction }: { text: string; actionLabel?: string; onAction?: () => void }) {
  const next = (
    {
      还没有上游采购单: { label: '先建立合同', href: '?tab=contracts' },
      暂无待验收单据: { label: '查看采购与发货', href: '?tab=orders' },
      暂无采购退货单: { label: '查看已入账收货', href: '?tab=receipts' },
      暂无到货差异: { label: '查看收货单', href: '?tab=receipts' },
      暂无对账单: { label: '在上方生成对账单', href: '?tab=settlements' },
      暂无合同: {
        label: '先维护商品供货关系',
        href: '/v2/supply-chain/products',
      },
    } as Record<string, { label: string; href: string }>
  )[text]
  return (
    <div className="rounded-2xl border border-dashed border-border bg-white p-10 text-center text-caption text-gray3">
      <p>{text}</p>
      {actionLabel && onAction ? (
        <button type="button" onClick={onAction} className="mt-3 text-button text-accent hover:underline">
          {actionLabel}
        </button>
      ) : (
        next && (
          <a href={next.href} className="mt-3 inline-block text-button text-accent hover:underline">
            {next.label}
          </a>
        )
      )}
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-micro text-gray3">{label}</span>
      {children}
    </label>
  )
}

function claimEvidence(item: Record<string, unknown>, index: number) {
  const rawUrl = typeof item.url === 'string' ? item.url.trim() : ''
  const url = rawUrl.startsWith('/') || /^https?:\/\//i.test(rawUrl) ? rawUrl : ''
  const rawName = typeof item.name === 'string' ? item.name.trim() : ''
  return { name: rawName || `举证 ${index + 1}`, url }
}

function PrintButton({ printId }: { printId: string }) {
  return (
    <button type="button" onClick={() => printSheet(printId)} className="rounded-lg border border-border bg-white px-3 py-1.5 text-button text-gray2">
      打印 / 保存 PDF
    </button>
  )
}

function Panel({ title, children, onClose, printId,onPrint }: { title: string; children: ReactNode; onClose?: () => void; printId?: string;onPrint?:()=>void }) {
  return (
    <div id={printId} data-print-sheet={printId ? true : undefined} className="rounded-2xl border border-amber/30 bg-white p-4 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-h3">{title}</h2>
        <div className="flex items-center gap-2" data-print-hidden>
          {onPrint?<button type="button" onClick={onPrint} className="rounded-lg border border-border bg-white px-3 py-1.5 text-button text-gray2">打印 / 保存 PDF</button>:printId&&<PrintButton printId={printId}/> }
          {onClose && (
            <button onClick={onClose} className="text-caption text-gray3">
              关闭
            </button>
          )}
        </div>
      </div>
      {children}
    </div>
  )
}
