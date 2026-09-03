'use client'

import { Fragment, useEffect, useMemo, useState } from 'react'
import { Chip } from '@/components/v2'
import { WarehouseToolTabs } from '@/components/v2/warehouse-tool-tabs'
import { apiFetch } from '@/lib/v2-auth'
import { buildInventoryExportRows } from '@/lib/inventory-export'
import { readWarehouseViewState, useWarehouseScrollRestoration, writeWarehouseViewState } from '@/lib/warehouse-view-state'

type InventoryItem = {
  id: string
  code: string
  name: string
  spec?: string | null
  category?: string | null
  productStatus: 'PENDING_APPROVAL' | 'PENDING_DISABLE' | 'ENABLED' | 'DISABLED'
  purchaseUnit: string
  inventoryUnit: string
  purchaseToInventoryFactor: number
  unitConversionStatus: 'PENDING' | 'INFERRED' | 'VERIFIED'
  physicalQty: number
  reservedQty: number
  availableQty: number
  inventoryValue: number
  averageUnitCost: number
  shipmentAmount: number | null
  statusFlag: 'OK' | 'LOW' | 'OUT' | 'SHADOW_GAP'
}

type InboundCandidate = Pick<InventoryItem,
  'id' | 'code' | 'name' | 'spec' | 'category' | 'purchaseUnit' | 'inventoryUnit' | 'purchaseToInventoryFactor'
>

type BatchInboundRow = {
  productId: string
  purchaseQuantity: string
  unitPrice: string
  /** 行金额（价税合计）。可编辑凑整：改金额自动反算采购单价 */
  amount: string
}

type UpstreamSupplier = {
  id: string
  no: string
  name: string
}

type InventoryResponse = {
  warehouse: {
    id: string
    code: string
    name: string
    inventoryMode: 'OFF' | 'SHADOW' | 'STRICT'
    inventoryActivatedAt?: string | null
  }
  summary: {
    inventoryMode: 'OFF' | 'SHADOW' | 'STRICT'
    totalSku: number
    physicalSku: number
    negativeSku: number
    totalValue: number
    activeReservations: number
    movementCount: number
    strictActivated: boolean
  }
  scope: InventoryScope
  scopeCounts: {
    stockSku: number
    bomMappingSku: number
    unitReviewSku: number
  }
  items: InventoryItem[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}

type InventoryScope = 'stock' | 'bom-mapping' | 'unit-review'

type Movement = {
  id: string
  type: string
  physicalDelta: number
  reservedDelta: number
  valueDelta: number
  physicalAfter: number
  reservedAfter: number
  inventoryUnit: string
  effectiveAt: string
  note?: string | null
  sourceName?: string | null
  product: { id: string; code: string; name: string }
  reversed?: boolean
}

type LedgerAudit = {
  readyForStrict: boolean
  blockerCount: number
  warningCount: number
  checkedSku: number
  issues: Array<{ code: string; productId: string; message: string }>
}

type ShadowReconcilePage = {
  scanned: number
  failures: unknown[]
  nextCursor?: string | null
}

const MOVEMENT_LABEL: Record<string, string> = {
  OPENING_BALANCE: '期初建账',
  MANUAL_INBOUND: '手工入库',
  ORDER_RESERVED: '门店订单预占',
  ORDER_RELEASED: '订单预占释放',
  ORDER_OUTBOUND: '门店订单出库',
  ADJUSTMENT: '盘点调整',
  LOSS: '仓库报损',
  REVERSAL: '冲销',
}

function defaultEffectiveAt() {
  const date = new Date()
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

function newIdempotencyKey() {
  return globalThis.crypto?.randomUUID?.() || `manual-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function money(value: number) {
  return `¥${Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function qty(value: number, digits = 3) {
  return Number(value || 0).toLocaleString('zh-CN', { maximumFractionDigits: digits })
}

function conversionText(item: InventoryItem) {
  if (item.unitConversionStatus === 'PENDING') return '尚未配置'
  if (item.purchaseUnit === item.inventoryUnit && item.purchaseToInventoryFactor === 1) return '同单位计存'
  return `1 ${item.purchaseUnit} = ${qty(item.purchaseToInventoryFactor, 6)} ${item.inventoryUnit}`
}

function conversionNote(item: InventoryItem) {
  if (item.unitConversionStatus === 'VERIFIED') return '已核验'
  if (item.unitConversionStatus === 'INFERRED') return '系统推定，待人工确认'
  return '不能用于真实入库和成本计算'
}

// 可搜索的供应商选择器 — 供应商多了以后下拉翻找容易选错，输入编号/名称即筛
function SupplierCombobox({ suppliers, value, onChange }: {
  suppliers: UpstreamSupplier[]
  value: string
  onChange: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [kw, setKw] = useState('')
  const selected = suppliers.find(s => s.id === value)
  const keyword = kw.trim().toLowerCase()
  const filtered = keyword
    ? suppliers.filter(s => `${s.no} ${s.name}`.toLowerCase().includes(keyword))
    : suppliers
  return (
    <div className="relative">
      <input
        value={open ? kw : (selected ? `${selected.no} · ${selected.name}` : '')}
        placeholder="输入编号 / 名称搜索供应商"
        onFocus={() => { setOpen(true); setKw('') }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={event => { setKw(event.target.value); setOpen(true) }}
        onKeyDown={event => {
          if (event.key === 'Escape') setOpen(false)
          if (event.key === 'Enter' && open && filtered.length > 0) { event.preventDefault(); onChange(filtered[0].id); setOpen(false) }
        }}
        className="h-11 w-full rounded-cta border border-border bg-white px-3 pr-8"
      />
      {selected && !open && (
        <button type="button" aria-label="清除供应商" onClick={() => onChange('')}
          className="absolute right-2 top-1/2 -translate-y-1/2 px-1 text-h2 text-gray3 hover:text-ink">×</button>
      )}
      {open && (
        <div className="absolute z-30 mt-1 max-h-56 w-full overflow-auto rounded-card border border-border bg-white shadow-lg">
          {filtered.map(s => (
            <button key={s.id} type="button" onMouseDown={event => event.preventDefault()}
              onClick={() => { onChange(s.id); setOpen(false) }}
              className={`block w-full px-3 py-2 text-left text-caption hover:bg-bg ${s.id === value ? 'bg-bg font-semibold' : ''}`}>
              {s.no} · {s.name}
            </button>
          ))}
          {filtered.length === 0 && <div className="px-3 py-3 text-caption text-gray3">没有匹配的供应商</div>}
        </div>
      )}
    </div>
  )
}

export default function InternalSupplyChainInventoryPage() {
  const [data, setData] = useState<InventoryResponse | null>(null)
  const [movements, setMovements] = useState<Movement[]>([])
  const [audit, setAudit] = useState<LedgerAudit | null>(null)
  const [q, setQ] = useState('')
  const [productStatus, setProductStatus] = useState('ALL')
  const [stockStatus, setStockStatus] = useState('')
  const [exporting, setExporting] = useState(false)
  const [loading, setLoading] = useState(true)
  const [scope, setScope] = useState<InventoryScope>('stock')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [inboundOpen, setInboundOpen] = useState(false)
  const [batchOpen, setBatchOpen] = useState(false)
  const [batchCandidates, setBatchCandidates] = useState<InboundCandidate[]>([])
  const [batchSearch, setBatchSearch] = useState('')
  const [checkedCandidateIds, setCheckedCandidateIds] = useState<string[]>([])
  const [batchRows, setBatchRows] = useState<BatchInboundRow[]>([])
  const [batchEffectiveAt, setBatchEffectiveAt] = useState(defaultEffectiveAt)
  const [batchSupplierId, setBatchSupplierId] = useState('')
  const [batchNote, setBatchNote] = useState('采购到货批量入库')
  const [batchKey, setBatchKey] = useState(newIdempotencyKey)
  const [batchLoading, setBatchLoading] = useState(false)
  const [productId, setProductId] = useState('')
  const [purchaseQuantity, setPurchaseQuantity] = useState('')
  const [totalAmount, setTotalAmount] = useState('')
  const [effectiveAt, setEffectiveAt] = useState(defaultEffectiveAt)
  const [supplierId, setSupplierId] = useState('')
  const [note, setNote] = useState('采购到货手工入库')
  const [batchNo, setBatchNo] = useState('')
  const [manufactureDate, setManufactureDate] = useState('')
  const [expiryDate, setExpiryDate] = useState('')
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey)
  const [submitting, setSubmitting] = useState(false)
  const [countOpen, setCountOpen] = useState(false)
  const [countProductId, setCountProductId] = useState('')
  const [countedQuantity, setCountedQuantity] = useState('')
  const [countedValue, setCountedValue] = useState('')
  const [countEffectiveAt, setCountEffectiveAt] = useState(defaultEffectiveAt)
  const [countNote, setCountNote] = useState('总仓现场实盘校准')
  const [countKey, setCountKey] = useState(newIdempotencyKey)
  const [suppliers, setSuppliers] = useState<UpstreamSupplier[]>([])
  const [gateWarnings, setGateWarnings] = useState<string[]>([])
  const [verifyingId, setVerifyingId] = useState('')

  // 单位待核验：人工确认换算关系后放行入库（只提交状态，后端原样保留四单位口径）
  async function verifyUnitConversion(item: InventoryItem) {
    const mapping = conversionText(item)
    if (!window.confirm(`确认「${item.name}」的换算关系：${mapping}？\n核验通过后该商品才能入库记账；换算不对请点「前往商品管理」改好再核验。`)) return
    setVerifyingId(item.id)
    setError('')
    try {
      await apiFetch(`/api/products/${item.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ unitConversionStatus: 'VERIFIED' }),
      })
      setNotice(`「${item.name}」换算已核验（${mapping}），现在可以入库了`)
      await load(scope)
    } catch (reason: any) {
      setError(String(reason?.message || reason))
    } finally {
      setVerifyingId('')
    }
  }

  async function load(requestedScope: InventoryScope = scope) {
    setLoading(true)
    setError('')
    setData(current => current ? { ...current, scope: requestedScope, items: [] } : current)
    try {
      const params = new URLSearchParams({ scope: requestedScope, productStatus, page: '1', pageSize: '500' })
      if (q.trim()) params.set('q', q.trim())
      const [inventory, recent, ledgerAudit] = await Promise.all([
        apiFetch<InventoryResponse>(`/api/warehouse-inventory?${params}`),
        apiFetch<Movement[]>('/api/warehouse-inventory/movements?limit=50'),
        apiFetch<LedgerAudit>('/api/warehouse-inventory/audit'),
      ])
      if (inventory.totalPages > 1) {
        const remaining = await Promise.all(Array.from({ length: inventory.totalPages - 1 }, (_, index) => {
          params.set('page', String(index + 2))
          return apiFetch<InventoryResponse>(`/api/warehouse-inventory?${params}`)
        }))
        inventory.items = [...inventory.items, ...remaining.flatMap(result => result.items)]
      }
      setData(inventory)
      setMovements(recent || [])
      setAudit(ledgerAudit)
    } catch (reason: any) {
      setError(String(reason?.message || reason))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load(scope) }, [scope, productStatus, q])

  useEffect(() => {
    const saved = readWarehouseViewState('warehouse-inventory-view', { q: '', productStatus: 'ALL', stockStatus: '', scope: 'stock' })
    setQ(saved.q)
    setProductStatus(saved.productStatus)
    setStockStatus(saved.stockStatus)
    setScope(saved.scope as InventoryScope)
  }, [])

  useEffect(() => {
    writeWarehouseViewState('warehouse-inventory-view', { q, productStatus, stockStatus, scope })
  }, [q, productStatus, stockStatus, scope])
  useWarehouseScrollRestoration('warehouse-inventory-view')

  useEffect(() => {
    apiFetch<UpstreamSupplier[]>('/api/suppliers?businessScope=WAREHOUSE_UPSTREAM')
      .then(rows => setSuppliers(Array.isArray(rows) ? rows : []))
      .catch(() => setSuppliers([]))
  }, [])

  const items = data?.items || []
  const selectedProduct = items.find(item => item.id === productId)
  const countedProduct = items.find(item => item.id === countProductId)
  const normalizedQuantity = selectedProduct && Number(purchaseQuantity) > 0
    ? Number(purchaseQuantity) * selectedProduct.purchaseToInventoryFactor
    : 0
  const unitCost = normalizedQuantity > 0 && Number(totalAmount) > 0
    ? Number(totalAmount) / normalizedQuantity
    : 0
  const visible = useMemo(() => {
    const term = q.trim().toLowerCase()
    return items.filter(item => {
      if (term && ![item.code, item.name, item.spec, item.category].some(value => String(value || '').toLowerCase().includes(term))) return false
      return !stockStatus || item.statusFlag === stockStatus
    })
  }, [items, q, stockStatus])
  const filteredBatchCandidates = useMemo(() => {
    const term = batchSearch.trim().toLowerCase()
    const rows = term
      ? batchCandidates.filter(item => [item.code, item.name, item.spec, item.category]
        .some(value => String(value || '').toLowerCase().includes(term)))
      : batchCandidates
    return rows.filter(item => !batchRows.some(row => row.productId === item.id))
  }, [batchCandidates, batchRows, batchSearch])
  const batchTotal = batchRows.reduce((sum, row) => {
    const lineAmount = Number(row.amount)
    return sum + (Number.isFinite(lineAmount) ? lineAmount : 0)
  }, 0)

  function resetFilters() {
    setQ('')
    setProductStatus('ALL')
    setStockStatus('')
  }

  async function exportInventory() {
    setExporting(true)
    setError('')
    try {
      const all: InventoryItem[] = []
      let page = 1
      let totalPages = 1
      do {
        const params = new URLSearchParams({ scope, productStatus, page: String(page), pageSize: '500' })
        if (q.trim()) params.set('q', q.trim())
        const result = await apiFetch<InventoryResponse>(`/api/warehouse-inventory?${params}`)
        all.push(...result.items)
        totalPages = result.totalPages
        page += 1
      } while (page <= totalPages)
      const rows = buildInventoryExportRows(all, stockStatus)
      const XLSX = await import('xlsx')
      const sheet = XLSX.utils.json_to_sheet(rows)
      const book = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(book, sheet, '实时库存')
      XLSX.writeFile(book, `实时库存查询表-${new Date().toISOString().slice(0, 10)}.xlsx`)
      setNotice(`已导出 ${rows.length} 条当前筛选结果`)
    } catch (reason: any) {
      setError(`导出失败：${String(reason?.message || reason)}`)
    } finally {
      setExporting(false)
    }
  }

  function openInbound() {
    setInboundOpen(true)
    setProductId('')
    setPurchaseQuantity('')
    setTotalAmount('')
    setEffectiveAt(defaultEffectiveAt())
    setSupplierId('')
    setNote('采购到货手工入库')
    setBatchNo('')
    setManufactureDate('')
    setExpiryDate('')
    setIdempotencyKey(newIdempotencyKey())
    setError('')
  }

  async function openBatchInbound() {
    setBatchOpen(true)
    setBatchCandidates([])
    setBatchSearch('')
    setCheckedCandidateIds([])
    setBatchRows([])
    setBatchEffectiveAt(defaultEffectiveAt())
    setBatchSupplierId('')
    setBatchNote('采购到货批量入库')
    setBatchKey(newIdempotencyKey())
    setBatchLoading(true)
    setError('')
    try {
      const result = await apiFetch<{ items: InboundCandidate[] }>('/api/warehouse-inventory/inbound-candidates?limit=500')
      setBatchCandidates(result.items || [])
    } catch (reason: any) {
      setError(String(reason?.message || reason))
      setBatchOpen(false)
    } finally {
      setBatchLoading(false)
    }
  }

  // 勾选面板批量添加：一次把多个勾选项变成入库行，跳过已在单内的商品
  function toggleCandidate(id: string) {
    setCheckedCandidateIds(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id])
  }

  function toggleAllFilteredCandidates() {
    const filteredIds = filteredBatchCandidates.map(item => item.id)
    const allChecked = filteredIds.length > 0 && filteredIds.every(id => checkedCandidateIds.includes(id))
    setCheckedCandidateIds(current => allChecked
      ? current.filter(id => !filteredIds.includes(id))
      : Array.from(new Set([...current, ...filteredIds])))
  }

  function addCheckedBatchRows() {
    const checked = new Set(checkedCandidateIds)
    const additions = batchCandidates.filter(item => checked.has(item.id) && !batchRows.some(row => row.productId === item.id))
    if (additions.length === 0) return
    setBatchRows(rows => [...rows, ...additions.map(item => ({ productId: item.id, purchaseQuantity: '', unitPrice: '', amount: '' }))])
    setCheckedCandidateIds([])
    setBatchSearch('')
  }

  // 入库行内键盘导航：数字输入框不可靠支持 selectionStart，方向键直接按表格单元格移动。
  function gridCellKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    const key = event.key
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(key)) return
    const cell = event.currentTarget
    const row = Number(cell.dataset.gridR)
    const col = Number(cell.dataset.gridC)
    let nextRow = row
    let nextCol = col
    if (key === 'ArrowUp') nextRow = row - 1
    else if (key === 'ArrowDown' || key === 'Enter') nextRow = row + 1
    else if (key === 'ArrowLeft') nextCol = col - 1
    else if (key === 'ArrowRight') nextCol = col + 1
    const next = cell.closest('table')?.querySelector(`input[data-grid-r="${nextRow}"][data-grid-c="${nextCol}"]`) as HTMLInputElement | null
    if (!next) return
    event.preventDefault()
    next.focus()
    next.select()
  }

  // 数量/单价/金额三列联动：改数量或单价 → 重算金额；改金额（凑整）→ 反算单价。
  // 提交时以后端认可的行金额（totalAmount）为准，保证台账金额与录入完全一致。
  function updateBatchRow(productId: string, field: 'purchaseQuantity' | 'unitPrice' | 'amount', value: string) {
    setBatchRows(rows => rows.map(row => {
      if (row.productId !== productId) return row
      const next = { ...row, [field]: value }
      const qtyValue = Number(next.purchaseQuantity)
      const priceValue = Number(next.unitPrice)
      const amountValue = Number(next.amount)
      if (field === 'purchaseQuantity' || field === 'unitPrice') {
        next.amount = qtyValue > 0 && priceValue > 0 ? (qtyValue * priceValue).toFixed(2) : ''
      } else if (field === 'amount') {
        next.unitPrice = qtyValue > 0 && amountValue > 0 ? (amountValue / qtyValue).toFixed(6) : next.unitPrice
      }
      return next
    }))
  }

  async function submitBatchInbound() {
    if (batchRows.length === 0) {
      setError('请至少添加一个入库商品')
      return
    }
    if (!batchSupplierId) {
      setError('请选择供货供应商；没有档案请先在供应商管理新建')
      return
    }
    const invalid = batchRows.find(row => Number(row.purchaseQuantity) <= 0 || Number(row.amount) <= 0)
    if (invalid) {
      const product = batchCandidates.find(item => item.id === invalid.productId)
      setError(`${product?.name || '入库商品'}的数量和金额必须大于0（改金额会自动反算单价）`)
      return
    }
    setSubmitting(true)
    setError('')
    setGateWarnings([])
    try {
      const result = await apiFetch<{ replayed: boolean; count: number; totalAmount: number; gateWarnings?: string[] }>('/api/warehouse-inventory/batch-manual-inbound', {
        method: 'POST',
        body: JSON.stringify({
          items: batchRows.map(row => ({
            productId: row.productId,
            purchaseQuantity: Number(row.purchaseQuantity),
            unitPrice: Number(row.unitPrice),
            totalAmount: Number(row.amount),
          })),
          effectiveAt: new Date(batchEffectiveAt).toISOString(),
          idempotencyKey: batchKey,
          supplierId: batchSupplierId,
          note: batchNote.trim() || null,
        }),
      })
      setBatchOpen(false)
      setGateWarnings(result.gateWarnings || [])
      setNotice(result.replayed
        ? '该批量入库单已经处理，本次未重复入账'
        : `批量入库成功：${result.count} 种商品，合计 ${money(result.totalAmount)}，已整单原子记账`)
      await load('stock')
    } catch (reason: any) {
      setError(String(reason?.message || reason))
    } finally {
      setSubmitting(false)
    }
  }

  async function inbound() {
    if (!selectedProduct || Number(purchaseQuantity) <= 0 || Number(totalAmount) <= 0) {
      setError('请选择商品，并填写大于0的采购数量和入库总金额')
      return
    }
    if (!supplierId) {
      setError('请选择供货供应商；没有档案请先在供应商管理新建')
      return
    }
    if (selectedProduct.unitConversionStatus !== 'VERIFIED') {
      setError('该商品四单位换算尚未核验，不能记真实入库')
      return
    }
    if (expiryDate && manufactureDate && expiryDate < manufactureDate) {
      setError('到期日期不能早于生产日期')
      return
    }
    setSubmitting(true)
    setError('')
    setGateWarnings([])
    try {
      const result = await apiFetch<{ replayed: boolean; gateWarnings?: string[] }>('/api/warehouse-inventory/manual-inbound', {
        method: 'POST',
        body: JSON.stringify({
          productId,
          purchaseQuantity: Number(purchaseQuantity),
          totalAmount: Number(totalAmount),
          effectiveAt: new Date(effectiveAt).toISOString(),
          idempotencyKey,
          supplierId,
          note: note.trim() || null,
          batchNo: batchNo.trim() || null,
          manufactureDate: manufactureDate || null,
          expiryDate: expiryDate || null,
        }),
      })
      setInboundOpen(false)
      setGateWarnings(result.gateWarnings || [])
      setNotice(result.replayed ? '该入库请求已处理，本次返回原结果，没有重复入账' : '手工入库成功：数量、成本、批次和流水已原子记入总仓影子账')
      await load()
    } catch (reason: any) {
      setError(String(reason?.message || reason))
    } finally {
      setSubmitting(false)
    }
  }

  async function reverseInbound(movement: Movement) {
    const reason = globalThis.prompt?.('请输入冲销原因（原流水会永久保留）：')?.trim()
    if (!reason) return
    setError('')
    try {
      const result = await apiFetch<{ replayed: boolean }>(`/api/warehouse-inventory/movements/${movement.id}/reverse`, {
        method: 'POST',
        body: JSON.stringify({ reason, idempotencyKey: newIdempotencyKey() }),
      })
      setNotice(result.replayed ? '该冲销请求已处理，本次未重复记账' : '手工入库已追加反向流水；原流水仍完整保留')
      await load()
    } catch (reasonValue: any) {
      setError(String(reasonValue?.message || reasonValue))
    }
  }

  function openCount() {
    setCountOpen(true)
    setCountProductId('')
    setCountedQuantity('')
    setCountedValue('')
    setCountEffectiveAt(defaultEffectiveAt())
    setCountNote('总仓现场实盘校准')
    setCountKey(newIdempotencyKey())
    setError('')
  }

  async function recordCount() {
    if (!countedProduct || Number(countedQuantity) < 0 || Number(countedValue) < 0) {
      setError('请选择商品，并填写不小于0的实盘数量和库存金额')
      return
    }
    if (countedProduct.unitConversionStatus !== 'VERIFIED') {
      setError('该商品四单位换算尚未核验，不能执行实盘建账')
      return
    }
    if (Number(countedQuantity) === 0 && Number(countedValue) !== 0) {
      setError('实盘数量为0时库存金额必须为0')
      return
    }
    if (Number(countedQuantity) > 0 && Number(countedValue) <= 0) {
      setError('有实盘库存时必须填写大于0的库存金额')
      return
    }
    setSubmitting(true)
    setError('')
    try {
      const result = await apiFetch<{ replayed: boolean }>('/api/warehouse-inventory/physical-count', {
        method: 'POST',
        body: JSON.stringify({
          productId: countProductId,
          countedInventoryQuantity: Number(countedQuantity),
          countedInventoryValue: Number(countedValue),
          effectiveAt: new Date(countEffectiveAt).toISOString(),
          idempotencyKey: countKey,
          note: countNote.trim(),
        }),
      })
      setCountOpen(false)
      setNotice(result.replayed ? '该实盘请求已处理，本次未重复记账' : '该 SKU 已按实盘绝对数量和金额校准；需覆盖全部启用 SKU 后才可能进入严格库存')
      await load()
    } catch (reason: any) {
      setError(String(reason?.message || reason))
    } finally {
      setSubmitting(false)
    }
  }

  async function reconcileShadow() {
    setSubmitting(true)
    setError('')
    try {
      let cursor: string | null = null
      let scanned = 0
      let failureCount = 0
      do {
        const result: ShadowReconcilePage = await apiFetch<ShadowReconcilePage>('/api/warehouse-inventory/reconcile-shadow', {
          method: 'POST', body: JSON.stringify({ limit: 500, cursor }),
        })
        scanned += result.scanned
        failureCount += result.failures.length
        cursor = result.nextCursor || null
      } while (cursor)
      setNotice(`影子账补记完成：完整扫描 ${scanned} 张总仓订单，失败 ${failureCount} 张${failureCount ? '，请查看操作日志' : ''}`)
      await load()
    } catch (reason: any) {
      setError(String(reason?.message || reason))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen bg-bg px-4 py-5 lg:px-8 lg:py-7">
      <WarehouseToolTabs />
      <header className="flex flex-col gap-4 border-b border-border pb-5 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <Chip tone={data?.summary.inventoryMode === 'STRICT' ? 'green' : 'amber'}>
              {data?.summary.inventoryMode === 'STRICT' ? '正式库存' : data?.summary.inventoryMode === 'SHADOW' ? '影子账观察期' : '库存投影未启用'}
            </Chip>
            <span className="text-caption text-gray3">总仓维度 · 不按供应商拆库存</span>
          </div>
          <h1 className="text-h1">总仓库存</h1>
          <p className="mt-1 text-caption text-gray2">入库、预占、出库都按库存单位记账；当前发货动作就是实际离仓时点。</p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-micro text-gray3">商品搜索</span>
            <input value={q} onChange={event => setQ(event.target.value)} placeholder="名称 / 编码 / 分类 / 规格" className="h-10 min-w-64 rounded-cta border border-border bg-white px-3 text-body" />
          </label>
          <label className="flex flex-col gap-1"><span className="text-micro text-gray3">商品状态</span><select value={productStatus} onChange={event => setProductStatus(event.target.value)} className="h-10 rounded-cta border border-border bg-white px-3 text-body"><option value="ALL">全部状态</option><option value="ENABLED">启用</option><option value="DISABLED">停用</option><option value="PENDING_APPROVAL">待启用审核</option><option value="PENDING_DISABLE">待停用审核</option></select></label>
          <label className="flex flex-col gap-1"><span className="text-micro text-gray3">库存状态</span><select value={stockStatus} onChange={event => setStockStatus(event.target.value)} className="h-10 rounded-cta border border-border bg-white px-3 text-body"><option value="">全部</option><option value="OK">正常</option><option value="LOW">偏低</option><option value="OUT">缺货</option><option value="SHADOW_GAP">待实盘缺口</option></select></label>
          <button type="button" onClick={resetFilters} className="h-10 rounded-cta border border-border bg-white px-4 text-button text-gray2">重置</button>
          <button onClick={exportInventory} disabled={exporting} className="h-10 rounded-cta border border-border bg-white px-4 text-button text-gray2 disabled:opacity-40">{exporting ? '导出中…' : '导出 Excel'}</button>
          {scope === 'stock' && <>
            <button onClick={openCount} className="h-10 rounded-cta border border-accent bg-white px-4 text-button text-accent">单SKU实盘校准</button>
            {data?.summary.inventoryMode === 'SHADOW' && <button onClick={reconcileShadow} disabled={submitting} className="h-10 rounded-cta border border-border bg-white px-4 text-button text-gray2 disabled:opacity-40">补记影子差异</button>}
            <button onClick={openInbound} className="h-10 rounded-cta border border-accent bg-white px-4 text-button text-accent">单条入库</button>
            <button onClick={openBatchInbound} className="h-10 rounded-cta bg-accent px-4 text-button text-white">+ 批量入库</button>
          </>}
        </div>
      </header>

      {error && <div className="mt-4 rounded-card border border-red/30 bg-red-bg p-3 text-caption text-red-fg">{error}</div>}
      {notice && <div className="mt-4 rounded-card border border-green/30 bg-green/10 p-3 text-caption text-green-fg">{notice}</div>}
      {gateWarnings.length > 0 && <div className="mt-4 rounded-card border border-amber/40 bg-amber/10 p-3 text-caption text-amber-fg">
        <b>入库闸口警告（已放行）：</b>以下商品未绑定该供应商的供货关系，建议在「供货关系」页补齐——{gateWarnings.join('；')}
      </div>}
      {data?.summary.inventoryMode === 'SHADOW' && (
        <div className="mt-4 rounded-card border border-amber/30 bg-amber/10 p-4 text-caption text-gray2">
          <b>当前处于影子账观察期。</b>系统记录真实单位的入库、预占和发货，但暂不因余额不足阻断原有履约。由于8月1日后的历史流水不完整，必须在下一次总仓实盘建立新期初并通过对账后，才能切换为严格库存。
        </div>
      )}
      {data?.summary.inventoryMode === 'OFF' && (
        <div className="mt-4 rounded-card border border-gray3/30 bg-bg p-4 text-caption text-gray2">
          <b>当前总仓订单投影未启用。</b>可先核验四单位和准备实盘数据；订单接单、取消、发货不会写入新账。完成指定租户发布检查后再显式启用 SHADOW。
        </div>
      )}
      {audit && (
        <div className={`mt-4 rounded-card border p-4 text-caption ${audit.readyForStrict ? 'border-green/30 bg-green/10 text-green-fg' : 'border-amber/30 bg-amber/10 text-gray2'}`}>
          <b>库存四账审计：{audit.readyForStrict ? '通过' : `${audit.blockerCount} 项待处理`}</b>
          <span className="ml-2">已核对 {audit.checkedSku} 个 SKU 的余额、流水、活动预占和批次。</span>
          {!audit.readyForStrict && audit.issues[0] && <span className="ml-2">首项：{audit.issues[0].message}</span>}
        </div>
      )}

      <section className="grid gap-3 py-5 sm:grid-cols-2 xl:grid-cols-6">
        <Metric label="仓库" value={data?.warehouse.name || '总仓'} />
        <Metric label="商品数" value={String(data?.summary.totalSku ?? '—')} />
        <Metric label="有库存SKU" value={String(data?.summary.physicalSku ?? '—')} />
        <Metric label="活动预占" value={String(data?.summary.activeReservations ?? '—')} />
        <Metric label="影子缺口SKU" value={String(data?.summary.negativeSku ?? '—')} tone={data?.summary.negativeSku ? 'text-red-fg' : ''} />
        <Metric label="影子库存金额" value={data ? money(data.summary.totalValue) : '—'} />
      </section>

      <section className="grid gap-4 2xl:grid-cols-[minmax(0,2fr)_minmax(380px,1fr)]">
        <div className="overflow-hidden rounded-card border border-border bg-white">
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-h2">{scope === 'stock' ? '库存明细' : scope === 'bom-mapping' ? '待采购映射' : '单位待核验'}</h2>
            <p className="text-micro text-gray3">{loading ? '加载中…' : `${visible.length} 个商品`}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button onClick={() => setScope('stock')} className={`rounded-full px-3 py-1.5 text-button ${scope === 'stock' ? 'bg-ink text-white' : 'bg-bg text-gray2'}`}>库存商品 {data?.scopeCounts.stockSku ?? '—'}</button>
              <button onClick={() => setScope('bom-mapping')} className={`rounded-full px-3 py-1.5 text-button ${scope === 'bom-mapping' ? 'bg-ink text-white' : 'bg-bg text-gray2'}`}>待采购映射 {data?.scopeCounts.bomMappingSku ?? '—'}</button>
              <button onClick={() => setScope('unit-review')} className={`rounded-full px-3 py-1.5 text-button ${scope === 'unit-review' ? 'bg-ink text-white' : 'bg-bg text-gray2'}`}>单位待核验 {data?.scopeCounts.unitReviewSku ?? '—'}</button>
            </div>
          </div>
          <div className="max-h-[680px] overflow-auto">
            {scope === 'stock' ? <table className="w-full min-w-[1180px] text-left text-caption">
              <thead className="sticky top-0 bg-bg text-gray3"><tr><th className="px-4 py-3">商品</th><th className="px-4 py-3">采购规格</th><th className="px-4 py-3">库存单位</th><th className="px-4 py-3">换算关系</th><th className="px-4 py-3 text-right">物理</th><th className="px-4 py-3 text-right">预占</th><th className="px-4 py-3 text-right">可用</th><th className="px-4 py-3 text-right">金额</th><th className="px-4 py-3">状态</th></tr></thead>
              <tbody className="divide-y divide-border">
                {visible.map(item => <tr key={item.id}>
                  <td className="px-4 py-3"><b>{item.name}</b><div className="text-micro text-gray3">{item.code} · {item.category || '未分类'} · {item.spec || '—'}</div></td>
                  <td className="px-4 py-3"><b>{item.purchaseUnit}</b><div className="text-micro text-gray3">{item.spec || '无包装规格'}</div></td>
                  <td className="px-4 py-3"><b>{item.inventoryUnit}</b><div className="text-micro text-gray3">库存、预占与成本计量</div></td>
                  <td className="px-4 py-3"><b>{conversionText(item)}</b><div className={`text-micro ${item.unitConversionStatus === 'VERIFIED' ? 'text-green-fg' : 'text-red-fg'}`}>{conversionNote(item)}</div></td>
                  <td className="px-4 py-3 text-right font-num">{qty(item.physicalQty)} {item.inventoryUnit}</td>
                  <td className="px-4 py-3 text-right font-num text-gray2">{qty(item.reservedQty)}</td>
                  <td className="px-4 py-3 text-right font-num">{qty(item.availableQty)}</td>
                  <td className="px-4 py-3 text-right"><b>{money(item.inventoryValue)}</b><div className="text-micro text-gray3">均价 {money(item.averageUnitCost)}/{item.inventoryUnit}</div></td>
                  <td className="px-4 py-3"><Chip tone={item.statusFlag === 'SHADOW_GAP' || item.statusFlag === 'OUT' ? 'red' : item.statusFlag === 'LOW' ? 'orange' : 'green'}>{item.statusFlag === 'SHADOW_GAP' ? '待实盘缺口' : item.statusFlag === 'OUT' ? '缺货' : item.statusFlag === 'LOW' ? '偏低' : '正常'}</Chip></td>
                </tr>)}
              </tbody>
            </table> : <table className="w-full min-w-[820px] text-left text-caption">
              <thead className="sticky top-0 bg-bg text-gray3"><tr><th className="px-4 py-3">商品</th><th className="px-4 py-3">当前临时单位</th><th className="px-4 py-3">待处理事项</th><th className="px-4 py-3">处理入口</th></tr></thead>
              <tbody className="divide-y divide-border">
                {visible.map(item => <tr key={item.id}>
                  <td className="px-4 py-3"><b>{item.name}</b><div className="text-micro text-gray3">{item.code} · {item.category || '未分类'}</div></td>
                  <td className="px-4 py-3"><b>采购：{item.purchaseUnit}</b><div className="text-micro text-gray3">库存：{item.inventoryUnit} · 当前仅为占位单位</div></td>
                  <td className="px-4 py-3"><b>{scope === 'bom-mapping' ? '关联真实采购 SKU' : '确认采购、库存及换算关系'}</b><div className="text-micro text-red-fg">完成前不进入库存账</div></td>
                  <td className="px-4 py-3">
                    {scope === 'unit-review' && item.unitConversionStatus !== 'VERIFIED' && (
                      <button onClick={() => verifyUnitConversion(item)} disabled={verifyingId === item.id}
                        className="mr-3 rounded-cta bg-accent px-3 py-1.5 text-button text-white disabled:opacity-40">
                        {verifyingId === item.id ? '核验中…' : `确认 ${conversionText(item)}`}
                      </button>
                    )}
                    <a href="/v2/supply-chain/products" className="text-button text-accent underline">前往商品管理</a>
                  </td>
                </tr>)}
              </tbody>
            </table>}
            {!loading && visible.length === 0 && <div className="py-12 text-center text-caption text-gray3">暂无匹配商品</div>}
          </div>
        </div>

        <div className="overflow-hidden rounded-card border border-border bg-white">
          <div className="border-b border-border px-4 py-3"><h2 className="text-h2">最近流水</h2><p className="text-micro text-gray3">按业务发生时间排序 · 原单可追溯</p></div>
          <ul className="max-h-[680px] divide-y divide-border overflow-auto">
            {movements.map(movement => <li key={movement.id} className="px-4 py-3">
              <div className="flex items-center gap-2"><b className="min-w-0 flex-1 truncate text-body">{movement.product.name}</b><span className={`font-num text-button ${movement.physicalDelta > 0 ? 'text-green-fg' : movement.physicalDelta < 0 ? 'text-red-fg' : 'text-gray2'}`}>{movement.physicalDelta > 0 ? '+' : ''}{qty(movement.physicalDelta)} {movement.inventoryUnit}</span></div>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 text-micro text-gray3"><span>{MOVEMENT_LABEL[movement.type] || movement.type}</span>{movement.reservedDelta !== 0 && <span>预占 {movement.reservedDelta > 0 ? '+' : ''}{qty(movement.reservedDelta)}</span>}<span>余 {qty(movement.physicalAfter)}</span><span>{new Date(movement.effectiveAt).toLocaleString('zh-CN')}</span>{movement.type === 'MANUAL_INBOUND' && (movement.reversed ? <span className="text-red-fg">已冲销</span> : <button onClick={() => reverseInbound(movement)} className="text-accent underline">冲销</button>)}</div>
              {(movement.note || movement.sourceName) && <p className="mt-1 text-micro text-gray2">{movement.sourceName ? `来源：${movement.sourceName}` : ''}{movement.sourceName && movement.note ? ' · ' : ''}{movement.note}</p>}
            </li>)}
            {!loading && movements.length === 0 && <li className="py-12 text-center text-caption text-gray3">影子账暂无流水</li>}
          </ul>
        </div>
      </section>

      {batchOpen && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setBatchOpen(false)}>
        <div className="max-h-[94vh] w-full max-w-6xl overflow-auto rounded-card bg-white p-5 shadow-xl" onClick={event => event.stopPropagation()}>
          <div className="flex items-start justify-between gap-4"><div><h2 className="text-h2">总仓批量入库</h2><p className="mt-1 text-micro text-gray3">一张入库单可添加多种商品；整单原子提交，任意一行失败都不会部分入账。</p></div><button onClick={() => setBatchOpen(false)} className="px-2 text-h2 text-gray3">×</button></div>
          <div className="mt-4 rounded-card border border-border bg-bg p-4">
            <div className="grid gap-3 lg:grid-cols-[minmax(220px,1fr)_auto] lg:items-end">
              <label><span className="mb-1 block text-micro text-gray3">搜索商品（勾选后批量添加）</span><input value={batchSearch} onChange={event => setBatchSearch(event.target.value)} placeholder="名称 / 编码 / 规格" className="h-11 w-full rounded-cta border border-border bg-white px-3" /></label>
              <button onClick={addCheckedBatchRows} disabled={checkedCandidateIds.length === 0} className="h-11 rounded-cta bg-ink px-5 text-button text-white disabled:opacity-40">{checkedCandidateIds.length ? `添加选中商品 · ${checkedCandidateIds.length} 种` : '添加选中商品'}</button>
            </div>
            <div className="mt-3 max-h-60 overflow-auto rounded-cta border border-border bg-white">
              {batchLoading ? <div className="px-3 py-4 text-center text-caption text-gray3">正在加载…</div>
                : filteredBatchCandidates.length === 0 ? <div className="px-3 py-4 text-center text-caption text-gray3">没有可添加的已核验商品</div>
                : <>
                  <label className="sticky top-0 flex items-center gap-2 border-b border-border bg-white px-3 py-2 text-caption">
                    <input type="checkbox" aria-label="全选当前筛选结果"
                      checked={filteredBatchCandidates.length > 0 && filteredBatchCandidates.every(item => checkedCandidateIds.includes(item.id))}
                      onChange={toggleAllFilteredCandidates} />
                    <b>全选当前筛选</b><span className="text-micro text-gray3">{filteredBatchCandidates.length} 种可添加</span>
                  </label>
                  {filteredBatchCandidates.map((item, index) => {
                    const prevCategory = index > 0 ? filteredBatchCandidates[index - 1].category : null
                    return <Fragment key={item.id}>
                      {item.category !== prevCategory && <div className="bg-bg px-3 py-1 text-micro text-gray3">{item.category || '未分类'}</div>}
                      <label className="flex cursor-pointer items-center gap-2 px-3 py-2 text-caption hover:bg-bg">
                        <input type="checkbox" aria-label={`选择${item.name}`}
                          checked={checkedCandidateIds.includes(item.id)}
                          onChange={() => toggleCandidate(item.id)} />
                        <span className="min-w-0 flex-1 truncate"><b>{item.name}</b><span className="ml-2 text-micro text-gray3">{item.code} · {item.spec || '无规格'}</span></span>
                        <span className="text-micro text-gray3">采购单位 {item.purchaseUnit}</span>
                      </label>
                    </Fragment>
                  })}
                </>}
            </div>
          </div>

          <div className="mt-4 overflow-auto rounded-card border border-border">
            <table className="w-full min-w-[920px] text-left text-caption">
              <thead className="bg-bg text-gray3"><tr><th className="px-3 py-3">序号</th><th className="px-3 py-3">商品</th><th className="px-3 py-3">采购单位</th><th className="px-3 py-3 text-right">数量</th><th className="px-3 py-3 text-right">采购单价</th><th className="px-3 py-3 text-right">金额</th><th className="px-3 py-3">换算预览</th><th className="px-3 py-3"></th></tr></thead>
              <tbody className="divide-y divide-border">
                {batchRows.map((row, index) => {
                  const product = batchCandidates.find(item => item.id === row.productId)!
                  const purchaseQuantity = Number(row.purchaseQuantity) || 0
                  return <tr key={row.productId}>
                    <td className="px-3 py-3 font-num text-gray3">{index + 1}</td>
                    <td className="px-3 py-3"><b>{product.name}</b><div className="text-micro text-gray3">{product.code} · {product.spec || '无规格'}</div></td>
                    <td className="px-3 py-3"><b>{product.purchaseUnit}</b></td>
                    <td className="px-3 py-3"><input aria-label={`${product.name}采购数量`} type="number" min="0.000001" step="0.001" value={row.purchaseQuantity} onChange={event => updateBatchRow(row.productId, 'purchaseQuantity', event.target.value)} data-grid-r={index} data-grid-c={0} onKeyDown={gridCellKeyDown} className="h-10 w-28 rounded-cta border border-border px-2 text-right font-num" /></td>
                    <td className="px-3 py-3"><div className="flex items-center justify-end gap-1"><span>¥</span><input aria-label={`${product.name}采购单价`} type="number" min="0.0001" step="0.01" value={row.unitPrice} onChange={event => updateBatchRow(row.productId, 'unitPrice', event.target.value)} data-grid-r={index} data-grid-c={1} onKeyDown={gridCellKeyDown} className="h-10 w-28 rounded-cta border border-border px-2 text-right font-num" /></div></td>
                    <td className="px-3 py-3"><div className="flex items-center justify-end gap-1"><span>¥</span><input aria-label={`${product.name}行金额`} type="number" min="0.01" step="0.01" value={row.amount} onChange={event => updateBatchRow(row.productId, 'amount', event.target.value)} data-grid-r={index} data-grid-c={2} onKeyDown={gridCellKeyDown} className="h-10 w-28 rounded-cta border border-border px-2 text-right font-num" /></div></td>
                    <td className="px-3 py-3"><b>{qty(purchaseQuantity)} {product.purchaseUnit} = {qty(purchaseQuantity * product.purchaseToInventoryFactor, 6)} {product.inventoryUnit}</b><div className="text-micro text-green-fg">已核验换算</div></td>
                    <td className="px-3 py-3"><button onClick={() => setBatchRows(rows => rows.filter(item => item.productId !== row.productId))} className="text-button text-red-fg">移除</button></td>
                  </tr>
                })}
              </tbody>
              <tfoot className="border-t border-border bg-bg"><tr><td colSpan={4} className="px-3 py-3 text-right text-gray2">合计 {batchRows.length} 种商品</td><td className="px-3 py-3 text-right text-gray2">总金额</td><td className="px-3 py-3 text-right font-num text-h2">{money(batchTotal)}</td><td colSpan={2}></td></tr></tfoot>
            </table>
            {!batchRows.length && <div className="py-10 text-center text-caption text-gray3">请从上方搜索并添加本次入库商品</div>}
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <label><span className="mb-1 block text-micro text-gray3">实际入库时间 *</span><input type="datetime-local" value={batchEffectiveAt} onChange={event => setBatchEffectiveAt(event.target.value)} className="h-11 w-full rounded-cta border border-border px-3" /></label>
            <label><span className="mb-1 block text-micro text-gray3">供货供应商 *</span><SupplierCombobox suppliers={suppliers} value={batchSupplierId} onChange={setBatchSupplierId} /></label>
            <label><span className="mb-1 block text-micro text-gray3">整单备注</span><input value={batchNote} maxLength={240} onChange={event => setBatchNote(event.target.value)} className="h-11 w-full rounded-cta border border-border px-3" /></label>
          </div>
          <div className="mt-4 flex items-center justify-between gap-4"><p className="text-micro text-gray3">只显示四单位已经核验的商品，避免箱、件、kg 等错误换算进入正式库存。</p><button onClick={submitBatchInbound} disabled={submitting || batchRows.length === 0} className="h-11 min-w-52 rounded-cta bg-accent px-6 text-button text-white disabled:opacity-40">{submitting ? '正在整单记账…' : `确认批量入库 · ${money(batchTotal)}`}</button></div>
        </div>
      </div>}

      {inboundOpen && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setInboundOpen(false)}>
        <div className="max-h-[90vh] w-full max-w-2xl overflow-auto rounded-card bg-white p-5 shadow-xl" onClick={event => event.stopPropagation()}>
          <div className="flex items-center justify-between"><div><h2 className="text-h2">总仓单条手工入库</h2><p className="mt-1 text-micro text-gray3">必须选择上游供应商；未绑定供货关系的商品会给出警告但允许放行。</p></div><button onClick={() => setInboundOpen(false)} className="px-2 text-h2 text-gray3">×</button></div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="sm:col-span-2"><span className="mb-1 block text-micro text-gray3">商品 *</span><select aria-label="入库商品" value={productId} onChange={event => setProductId(event.target.value)} className="h-11 w-full rounded-cta border border-border px-3"><option value="">请选择</option>{items.map(item => <option key={item.id} value={item.id}>{item.code} · {item.name} · 采购单位 {item.purchaseUnit}</option>)}</select></label>
            <label><span className="mb-1 block text-micro text-gray3">采购入库数量（{selectedProduct?.purchaseUnit || '采购单位'}）*</span><input type="number" min="0.000001" step="0.001" value={purchaseQuantity} onChange={event => setPurchaseQuantity(event.target.value)} className="h-11 w-full rounded-cta border border-border px-3" /></label>
            <label><span className="mb-1 block text-micro text-gray3">入库总金额（元）*</span><input type="number" min="0.01" step="0.01" value={totalAmount} onChange={event => setTotalAmount(event.target.value)} className="h-11 w-full rounded-cta border border-border px-3" /></label>
            {selectedProduct && <div className="sm:col-span-2 rounded-card border border-blue/20 bg-blue/5 p-3 text-caption text-gray2">入库单位指供应商交货/仓库收货时使用的采购单位。本次：<b>{qty(Number(purchaseQuantity))} {selectedProduct.purchaseUnit} × {qty(selectedProduct.purchaseToInventoryFactor, 6)} = {qty(normalizedQuantity, 6)} {selectedProduct.inventoryUnit}</b>{unitCost > 0 && <>，库存单位成本约 <b>{money(unitCost)}/{selectedProduct.inventoryUnit}</b></>}。</div>}
            <label><span className="mb-1 block text-micro text-gray3">实际入库时间 *</span><input type="datetime-local" value={effectiveAt} onChange={event => setEffectiveAt(event.target.value)} className="h-11 w-full rounded-cta border border-border px-3" /></label>
            <label><span className="mb-1 block text-micro text-gray3">供货供应商 *</span><SupplierCombobox suppliers={suppliers} value={supplierId} onChange={setSupplierId} /></label>
            <label><span className="mb-1 block text-micro text-gray3">批次号（可选）</span><input value={batchNo} maxLength={80} onChange={event => setBatchNo(event.target.value)} placeholder="留空自动生成" className="h-11 w-full rounded-cta border border-border px-3" /></label>
            <label><span className="mb-1 block text-micro text-gray3">入库说明</span><input value={note} maxLength={240} onChange={event => setNote(event.target.value)} className="h-11 w-full rounded-cta border border-border px-3" /></label>
            <label><span className="mb-1 block text-micro text-gray3">生产日期（可选）</span><input type="date" value={manufactureDate} onChange={event => setManufactureDate(event.target.value)} className="h-11 w-full rounded-cta border border-border px-3" /></label>
            <label><span className="mb-1 block text-micro text-gray3">到期日期（可选）</span><input type="date" value={expiryDate} onChange={event => setExpiryDate(event.target.value)} className="h-11 w-full rounded-cta border border-border px-3" /></label>
          </div>
          <button onClick={inbound} disabled={submitting} className="mt-4 h-11 w-full rounded-cta bg-accent text-button text-white disabled:opacity-40">{submitting ? '正在原子记账…' : '确认手工入库'}</button>
        </div>
      </div>}
      {countOpen && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setCountOpen(false)}>
        <div className="w-full max-w-2xl rounded-card bg-white p-5 shadow-xl" onClick={event => event.stopPropagation()}>
          <div className="flex items-center justify-between"><div><h2 className="text-h2">单 SKU 实盘校准</h2><p className="mt-1 text-micro text-gray3">填写现场实盘的绝对数量与库存金额；影子期历史保留，系统追加期初/调整流水并重建该 SKU 批次。</p></div><button onClick={() => setCountOpen(false)} className="px-2 text-h2 text-gray3">×</button></div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="sm:col-span-2"><span className="mb-1 block text-micro text-gray3">商品 *</span><select value={countProductId} onChange={event => setCountProductId(event.target.value)} className="h-11 w-full rounded-cta border border-border px-3"><option value="">请选择</option>{items.map(item => <option key={item.id} value={item.id}>{item.code} · {item.name} · 库存单位 {item.inventoryUnit}</option>)}</select></label>
            <label><span className="mb-1 block text-micro text-gray3">实盘数量（{countedProduct?.inventoryUnit || '库存单位'}）*</span><input type="number" min="0" step="0.001" value={countedQuantity} onChange={event => setCountedQuantity(event.target.value)} className="h-11 w-full rounded-cta border border-border px-3" /></label>
            <label><span className="mb-1 block text-micro text-gray3">实盘库存金额（元）*</span><input type="number" min="0" step="0.01" value={countedValue} onChange={event => setCountedValue(event.target.value)} className="h-11 w-full rounded-cta border border-border px-3" /></label>
            {countedProduct && <div className="sm:col-span-2 rounded-card border border-amber/20 bg-amber/5 p-3 text-caption text-gray2">当前账面 <b>{qty(countedProduct.physicalQty)} {countedProduct.inventoryUnit}</b>，本次实盘 <b>{qty(Number(countedQuantity))} {countedProduct.inventoryUnit}</b>，数量调整 <b>{Number(countedQuantity) - countedProduct.physicalQty >= 0 ? '+' : ''}{qty(Number(countedQuantity) - countedProduct.physicalQty)}</b>。盘为零也必须明确提交 0 数量、0 金额。</div>}
            <label><span className="mb-1 block text-micro text-gray3">实盘时点 *</span><input type="datetime-local" value={countEffectiveAt} onChange={event => setCountEffectiveAt(event.target.value)} className="h-11 w-full rounded-cta border border-border px-3" /></label>
            <label><span className="mb-1 block text-micro text-gray3">实盘说明 *</span><input value={countNote} maxLength={240} onChange={event => setCountNote(event.target.value)} className="h-11 w-full rounded-cta border border-border px-3" /></label>
          </div>
          <div className="mt-4 rounded-card bg-bg p-3 text-micro text-gray3">这一步不会自动切换严格库存。只有全部启用 SKU（含零库存）都完成实盘、四单位均已核验且四账审计无阻断项，才具备后续切换评审条件。</div>
          <button onClick={recordCount} disabled={submitting} className="mt-4 h-11 w-full rounded-cta bg-accent text-button text-white disabled:opacity-40">{submitting ? '正在校准…' : '确认实盘校准'}</button>
        </div>
      </div>}
    </div>
  )
}

function Metric({ label, value, tone = '' }: { label: string; value: string; tone?: string }) {
  return <div className="rounded-card border border-border bg-white p-4"><div className="text-caption text-gray3">{label}</div><div className={`mt-1 font-num text-h1 ${tone}`}>{value}</div></div>
}
