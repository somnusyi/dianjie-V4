'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Chip } from '@/components/v2'
import { ConfirmSheet, useConfirmSheet } from '@/components/v2/confirm-sheet'
import { FriendlyError, SkeletonCard } from '@/components/v2/skeleton'
import { SUPPLY_CHAIN_BEFORE_NAVIGATE_EVENT } from '@/components/v2/supply-chain-shell'
import { apiFetch, getUser } from '@/lib/v2-auth'
import {
  makeRequestKey,
  replenishmentNextStep,
  replenishmentStatusLabel,
  replenishmentStatusTone,
  type ReplenishmentOrder,
} from '@/lib/replenishment-orders'

type Store = { id: string; no: string; name: string }
type Supplier = { id: string; no?: string; name: string }
type Product = {
  id: string; code: string; name: string; spec?: string | null; status: string
  supplierId?: string | null; orderUnit?: string | null; unit?: string | null; price: number | string
  snapshotOnly?: boolean
}
type Line = { productId: string; quantity: string }
type Form = { storeId: string; supplierId: string; expectedDate: string; note: string; lines: Line[] }
type PriceChange = { productId: string; productName: string; oldPrice: string; newPrice: string; delta: string }

function initialForm(order?: ReplenishmentOrder | null): Form {
  return {
    storeId: order?.storeId || '', supplierId: order?.supplierId || '',
    expectedDate: order?.expectedDate?.slice(0, 10) || '', note: order?.note || '',
    lines: order?.items.map(item => ({ productId: item.productId, quantity: String(item.quantity) })) || [],
  }
}

function asList<T>(value: T[] | { items?: T[] }) { return Array.isArray(value) ? value : value.items || [] }
function money(value: unknown) { return Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }

export function ReplenishmentOrderEditor({ orderId }: { orderId?: string }) {
  const router = useRouter()
  const [order, setOrder] = useState<ReplenishmentOrder | null>(null)
  const [form, setForm] = useState<Form>(initialForm())
  const [baseline, setBaseline] = useState(JSON.stringify(initialForm()))
  const [stores, setStores] = useState<Store[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [productSearch, setProductSearch] = useState('')
  const [loading, setLoading] = useState(Boolean(orderId))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [conflict, setConflict] = useState(false)
  const [priceConflict, setPriceConflict] = useState(false)
  const [priceChanges, setPriceChanges] = useState<PriceChange[]>([])
  const [notice, setNotice] = useState('')
  const [cancelOpen, setCancelOpen] = useState(false)
  const [cancelReason, setCancelReason] = useState('')
  const [leaveConfirm, openLeaveConfirm] = useConfirmSheet()
  const leavePromptOpenRef = useRef(false)
  const formRef = useRef(form)
  const dirtyRef = useRef(false)
  const role = getUser()?.role || ''
  const canWrite = ['SUPPLY_CHAIN', 'ADMIN', 'SUPER_ADMIN'].includes(role)
  const editable = !order || order.displayStatus === 'DRAFT'
  const dirty = editable && JSON.stringify(form) !== baseline
  formRef.current = form
  dirtyRef.current = dirty

  const requestLeave = useCallback((proceed: () => void) => {
    if (!dirtyRef.current) {
      proceed()
      return
    }
    if (leavePromptOpenRef.current) return
    leavePromptOpenRef.current = true
    openLeaveConfirm({
      title: '放弃未保存的补货草稿？',
      body: '当前修改尚未保存，离开后将无法恢复。',
      confirmLabel: '放弃并离开',
      tone: 'danger',
      onCancel: () => { leavePromptOpenRef.current = false },
      onConfirm: () => {
        leavePromptOpenRef.current = false
        dirtyRef.current = false
        setBaseline(JSON.stringify(formRef.current))
        proceed()
      },
    })
  }, [openLeaveConfirm])

  function loadOrder() {
    if (!orderId) return
    setLoading(true); setError(''); setConflict(false); setPriceConflict(false); setPriceChanges([])
    apiFetch<ReplenishmentOrder>(`/api/replenishment-orders/${orderId}`)
      .then(result => {
        setOrder(result)
        const next = initialForm(result)
        setForm(next); setBaseline(JSON.stringify(next))
      })
      .catch(reason => setError(String(reason?.message || reason)))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    Promise.all([
      apiFetch<Store[] | { items: Store[] }>('/api/stores'),
      apiFetch<Supplier[]>('/api/suppliers?status=ENABLED'),
    ]).then(([storeRows, supplierRows]) => {
      setStores(asList(storeRows)); setSuppliers(asList(supplierRows))
    }).catch(reason => setError(String(reason?.message || reason)))
    loadOrder()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId])

  useEffect(() => {
    if (!form.supplierId) { setProducts([]); return }
    apiFetch<Product[] | { items: Product[] }>(`/api/products?supplierId=${encodeURIComponent(form.supplierId)}&status=ENABLED&page=1&pageSize=2000`)
      .then(result => setProducts(asList(result)))
      .catch(reason => setError(String(reason?.message || reason)))
  }, [form.supplierId])

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirtyRef.current) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', warn)
    return () => { window.removeEventListener('beforeunload', warn) }
  }, [])

  useEffect(() => {
    const protectSupplyChainNavigation = (event: Event) => {
      if (!dirtyRef.current) return
      event.preventDefault()
      const proceed = (event as CustomEvent<{ proceed?: () => void }>).detail?.proceed
      requestLeave(() => proceed?.())
    }
    window.addEventListener(SUPPLY_CHAIN_BEFORE_NAVIGATE_EVENT, protectSupplyChainNavigation)
    return () => window.removeEventListener(SUPPLY_CHAIN_BEFORE_NAVIGATE_EVENT, protectSupplyChainNavigation)
  }, [requestLeave])

  const lineByProduct = useMemo(() => new Map(form.lines.map(line => [line.productId, line])), [form.lines])
  const displayedProducts = useMemo(() => {
    const term = productSearch.trim().toLowerCase()
    const currentIds = new Set(products.map(product => product.id))
    const frozenMissing: Product[] = (order?.items || [])
      .filter(item => !currentIds.has(item.productId))
      .map(item => ({
        id: item.productId, code: item.productCodeSnapshot || '无编码', name: item.productNameSnapshot,
        spec: item.productSpecSnapshot, status: 'UNAVAILABLE', supplierId: order?.supplierId,
        orderUnit: item.orderUnitSnapshot, unit: item.orderUnitSnapshot, price: item.unitPrice,
        snapshotOnly: true,
      }))
    const source: Product[] = editable ? [...frozenMissing, ...products] : (order?.items || []).map(item => ({
      id: item.productId, code: item.productCodeSnapshot || '无编码', name: item.productNameSnapshot,
      spec: item.productSpecSnapshot, status: 'SNAPSHOT', supplierId: order?.supplierId,
      orderUnit: item.orderUnitSnapshot, unit: item.orderUnitSnapshot, price: item.unitPrice,
    }))
    return source.filter(product => !term || [product.name, product.code, product.spec].some(value => String(value || '').toLowerCase().includes(term)))
  }, [products, productSearch, order, editable])
  const frozenItemByProduct = useMemo(() => new Map((order?.items || []).map(item => [item.productId, item])), [order])
  const hasUnavailableLines = editable && (order?.items || []).some(item =>
    lineByProduct.has(item.productId) && !products.some(product => product.id === item.productId),
  )

  function update(changes: Partial<Form>) { setForm(current => ({ ...current, ...changes })) }
  function setQuantity(productId: string, quantity: string) {
    setForm(current => {
      const next = current.lines.filter(line => line.productId !== productId)
      if (quantity !== '') next.push({ productId, quantity })
      return { ...current, lines: next }
    })
  }
  function valid() {
    if (!form.storeId || !form.supplierId || !form.expectedDate) return '请依次选择门店、供应商和期望到货日'
    if (!form.lines.length || form.lines.some(line => !(Number(line.quantity) > 0))) return '请至少填写一项大于 0 的补货数量'
    return ''
  }
  function confirmLeave(href: string) {
    requestLeave(() => router.push(href))
  }

  async function saveDraft() {
    const invalid = valid(); if (invalid) { setError(invalid); return null }
    setSaving(true); setError(''); setConflict(false); setPriceConflict(false); setNotice('')
    const common = { storeId: form.storeId, supplierId: form.supplierId, expectedDate: form.expectedDate, note: form.note.trim(), items: form.lines.map(line => ({ productId: line.productId, quantity: Number(line.quantity) })) }
    try {
      const saved = order
        ? await apiFetch<ReplenishmentOrder>(`/api/replenishment-orders/${order.id}`, { method: 'PATCH', body: JSON.stringify({ ...common, rowVersion: order.rowVersion, requestKey: makeRequestKey('edit') }) })
        : await apiFetch<ReplenishmentOrder>('/api/replenishment-orders', { method: 'POST', body: JSON.stringify({ ...common, idempotencyKey: makeRequestKey('create') }) })
      setOrder(saved); const next = initialForm(saved); setForm(next); setBaseline(JSON.stringify(next)); setPriceChanges([]); setNotice('草稿已保存，单价已冻结，请核对后提交。')
      if (!orderId) router.replace(`/v2/supply-chain/replenishment-orders/${saved.id}`)
      return saved
    } catch (reason: any) {
      const message = String(reason?.message || reason)
      setError(message); setConflict(reason?.status === 409); setPriceConflict(false); setPriceChanges([]); return null
    } finally { setSaving(false) }
  }

  async function act(action: 'submit' | 'accept') {
    if (!order) return
    setSaving(true); setError(''); setConflict(false); setPriceConflict(false); setNotice('')
    try {
      await apiFetch(`/api/replenishment-orders/${order.id}/${action}`, { method: 'POST', body: JSON.stringify({ requestKey: makeRequestKey(action) }) })
      setNotice(action === 'submit' ? '补货单已提交，等待供应链接单。' : '接单成功，已生成正式订货单并进入履约。')
      loadOrder()
    } catch (reason: any) {
      const message = String(reason?.message || reason)
      const changes = Array.isArray(reason?.data?.changedItems) ? reason.data.changedItems : []
      const isPriceConflict = reason?.status === 409 && reason?.data?.code === 'REPLENISHMENT_PRICE_CHANGED' && changes.length > 0
      setError(message); setConflict(reason?.status === 409); setPriceConflict(isPriceConflict); setPriceChanges(isPriceConflict ? changes : [])
    }
    finally { setSaving(false) }
  }

  async function cancelOrder() {
    if (!order || cancelReason.trim().length < 2) { setError('请填写至少 2 个字的取消原因'); return }
    setSaving(true); setError(''); setConflict(false)
    try {
      await apiFetch(`/api/replenishment-orders/${order.id}/cancel`, { method: 'POST', body: JSON.stringify({ reason: cancelReason.trim(), requestKey: makeRequestKey('cancel') }) })
      setCancelOpen(false); setCancelReason(''); setNotice('补货单已取消。'); loadOrder()
    } catch (reason: any) { setError(String(reason?.message || reason)); setConflict(reason?.status === 409) }
    finally { setSaving(false) }
  }

  if (loading) return <div className="space-y-3 p-4 lg:p-8">{[1, 2, 3].map(item => <SkeletonCard key={item} />)}</div>
  if (orderId && !order) return <div className="p-4 lg:p-8"><FriendlyError message={error || '补货单不存在'} onRetry={loadOrder} /></div>
  const status = order?.displayStatus
  const next = order ? replenishmentNextStep(order) : null

  return <div className="min-h-screen bg-bg px-4 py-5 pb-28 lg:px-8 lg:py-7">
    <header className="mx-auto flex max-w-[1120px] items-start justify-between gap-3 border-b border-border pb-5">
      <div><button type="button" onClick={() => confirmLeave('/v2/supply-chain/replenishment-orders')} className="mb-2 text-caption text-gray2">‹ 返回门店补货单</button><div className="flex flex-wrap items-center gap-2">{status && <Chip tone={replenishmentStatusTone(status)}>{replenishmentStatusLabel(status)}</Chip>}<span className="text-caption text-gray3">独立补货 · 不调整原订货单</span></div><h1 className="mt-2 text-h1">{order ? order.no : '新建门店补货单'}</h1></div>
      {order && <span className="text-caption text-gray3">创建人：{order.createdBy.name}</span>}
    </header>
    <main className="mx-auto max-w-[1120px] py-5">
      {notice && <div role="status" className="mb-4 rounded-xl border border-green/30 bg-green-bg px-4 py-3 text-caption text-green-fg">{notice}</div>}
      {error && <div role="alert" className="mb-4 rounded-xl border border-red/30 bg-red-bg px-4 py-3 text-caption text-red"><b>{error}</b>{conflict && !priceConflict && <button type="button" onClick={loadOrder} className="ml-3 underline">刷新最新数据</button>}</div>}

      {priceConflict && <section role="dialog" aria-modal="true" aria-labelledby="price-change-title" className="mb-5 rounded-card border border-amber/40 bg-amber/10 p-4 lg:p-5"><h2 id="price-change-title" className="text-h2">提交前价格发生变化</h2><p className="mt-1 text-caption text-gray2">请逐项核对涨价或降价。只有确认后才会改写草稿冻结单价；暂不更新不会写入。</p><div className="mt-3 divide-y divide-border rounded-xl border border-border bg-white">{priceChanges.map(change => { const delta = Number(change.delta); return <div key={change.productId} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 px-3 py-3 text-caption"><b>{change.productName}</b><div className="text-right font-num"><span>¥{change.oldPrice} → ¥{change.newPrice}</span><span className={`ml-2 font-semibold ${delta > 0 ? 'text-red' : 'text-green-fg'}`}>{delta > 0 ? `涨 ¥${Math.abs(delta).toFixed(2)}` : `降 ¥${Math.abs(delta).toFixed(2)}`}</span></div></div> })}</div><div className="mt-4 flex justify-end gap-2"><button type="button" onClick={() => { setPriceConflict(false); setPriceChanges([]); setError('') }} className="rounded-cta border border-border bg-white px-4 py-2 text-button">暂不更新</button><button type="button" disabled={saving} onClick={saveDraft} className="rounded-cta bg-ink px-4 py-2 text-button text-white">确认新价格并保存</button></div></section>}

      {status === 'EXCEPTION' && <section id="exception" className="mb-5 rounded-card border border-red/30 bg-red-bg p-4"><h2 className="text-h2 text-red">履约异常待处理</h2><p className="mt-1 text-caption text-gray2">正式订单已取消或履约关联不完整，不能继续生成配送。请先核对正式订单，再由供应链负责人处理。</p><div className="mt-3 flex flex-wrap gap-2">{order?.fulfillment?.purchaseOrderId && <Link href={`/v2/supply-chain/fulfillment/${order.fulfillment.purchaseOrderId}`} className="rounded-cta bg-ink px-4 py-2 text-button text-white">查看异常订单</Link>}<button type="button" onClick={loadOrder} className="rounded-cta border border-border bg-white px-4 py-2 text-button">重新核对状态</button></div></section>}

      <section className="rounded-card border border-border bg-white p-4 lg:p-6"><h2 className="text-h2">补货信息</h2><p className="mt-1 text-micro text-gray3">填写顺序：门店 → 供应商 → 期望到货 → 商品数量与冻结单价 → 备注</p>
        <div className="mt-5 grid gap-4 md:grid-cols-3">
          <label className="text-caption text-gray2">门店 *<select disabled={!editable || !canWrite} value={form.storeId} onChange={event => update({ storeId: event.target.value })} className="mt-1 w-full rounded-xl border border-border bg-white px-3 py-3 text-body text-ink disabled:bg-bg"><option value="">请选择门店</option>{stores.map(store => <option key={store.id} value={store.id}>{store.no} · {store.name}</option>)}</select></label>
          <label className="text-caption text-gray2">供应商 *<select disabled={!editable || !canWrite} value={form.supplierId} onChange={event => update({ supplierId: event.target.value, lines: [] })} className="mt-1 w-full rounded-xl border border-border bg-white px-3 py-3 text-body text-ink disabled:bg-bg"><option value="">请选择门店履约供应商</option>{suppliers.map(supplier => <option key={supplier.id} value={supplier.id}>{supplier.no ? `${supplier.no} · ` : ''}{supplier.name}</option>)}</select></label>
          <label className="text-caption text-gray2">期望到货日 *<input disabled={!editable || !canWrite} type="date" value={form.expectedDate} onChange={event => update({ expectedDate: event.target.value })} className="mt-1 w-full rounded-xl border border-border bg-white px-3 py-3 text-body text-ink disabled:bg-bg" /></label>
        </div>
      </section>

      <section className="mt-4 rounded-card border border-border bg-white p-4 lg:p-6"><div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between"><div><h2 className="text-h2">补货商品</h2><p className="mt-1 text-micro text-gray3">保存草稿时冻结单价；若提交前价格变化，系统会要求重新保存确认。</p></div>{editable && canWrite && <input aria-label="搜索商品" value={productSearch} onChange={event => setProductSearch(event.target.value)} placeholder="搜索名称 / 编码 / 规格" className="rounded-xl border border-border px-3 py-2.5 text-body" />}</div>
        {!form.supplierId && <p className="mt-5 rounded-xl bg-bg p-4 text-caption text-gray3">请先选择供应商，再添加该供应商可履约的商品。</p>}
        {form.supplierId && <div className="mt-4 space-y-2">
          {displayedProducts.map(product => {
            const line = lineByProduct.get(product.id); const frozen = frozenItemByProduct.get(product.id)
            const unit = frozen?.orderUnitSnapshot || product.orderUnit || product.unit || '件'
            const price = frozen?.unitPrice
            return <div key={product.id} className={`grid gap-3 rounded-xl border p-3 ${line ? 'border-amber/50 bg-amber/5' : 'border-border'} md:grid-cols-[minmax(0,1fr)_9rem_7rem_8rem] md:items-center`}>
              <div><div className="flex flex-wrap items-center gap-2"><b className="text-body">{product.name}</b>{product.snapshotOnly && <Chip tone="red">当前不可供货</Chip>}</div><p className="mt-1 text-micro text-gray3">{product.code} · {product.spec || '无规格'}{product.snapshotOnly ? ' · 请移除后再提交' : ''}</p></div>
              <label className="text-micro text-gray3">补货数量<input disabled={!editable || !canWrite} inputMode="decimal" type="number" min="0" step="0.01" value={line?.quantity || ''} onChange={event => setQuantity(product.id, event.target.value)} className="mt-1 w-full rounded-lg border border-border bg-white px-3 py-2 text-right font-num text-body disabled:bg-bg" /></label>
              <div className="text-right"><span className="block text-micro text-gray3">单位</span><b className="font-num text-body">{unit}</b></div>
              <div className="text-right"><span className="block text-micro text-gray3">冻结单价</span><b className="font-num text-body">{frozen ? `¥${money(price)}` : '保存后确认'}</b>{line && <span className="mt-1 block text-micro text-gray3">金额 {frozen ? `¥${money(Number(line.quantity) * Number(price || 0))}` : '保存后计算'}</span>}</div>
            </div>
          })}
          {displayedProducts.length === 0 && <p className="rounded-xl bg-bg p-4 text-caption text-gray3">没有可添加的商品，请检查供应商供货范围。</p>}
        </div>}
      </section>

      <section className="mt-4 rounded-card border border-border bg-white p-4 lg:p-6"><label className="text-caption text-gray2">备注<textarea disabled={!editable || !canWrite} maxLength={500} value={form.note} onChange={event => update({ note: event.target.value })} placeholder="说明额外补货原因，不用于调整原订货单" className="mt-1 min-h-24 w-full rounded-xl border border-border bg-white px-3 py-3 text-body text-ink disabled:bg-bg" /></label></section>

      {order && <section className="mt-4 rounded-card border border-border bg-white p-4 lg:p-6"><h2 className="text-h2">单据进度</h2><dl className="mt-3 grid gap-3 text-caption md:grid-cols-3"><div><dt className="text-gray3">来源</dt><dd>供应链代门店</dd></div><div><dt className="text-gray3">补货金额</dt><dd className="font-num">¥{money(order.totalAmount)}</dd></div><div><dt className="text-gray3">正式订单</dt><dd>{order.fulfillment?.purchaseOrder?.no || '尚未生成'}</dd></div></dl></section>}
    </main>

    {canWrite && <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-white/95 px-4 py-3 backdrop-blur lg:left-64"><div className="mx-auto flex max-w-[1120px] flex-wrap items-center justify-end gap-2">
      {order && ['DRAFT', 'SUBMITTED'].includes(order.displayStatus) && <button disabled={saving} onClick={() => setCancelOpen(true)} className="rounded-cta border border-red/30 bg-white px-4 py-2.5 text-button text-red">取消补货单</button>}
      {editable && !priceConflict && <button disabled={saving || (!dirty && Boolean(order))} onClick={saveDraft} className="rounded-cta border border-border bg-white px-4 py-2.5 text-button disabled:opacity-40">{saving ? '保存中…' : '保存草稿'}</button>}
      {order?.displayStatus === 'DRAFT' && <button disabled={saving || dirty || priceConflict || hasUnavailableLines} title={hasUnavailableLines ? '请先移除当前不可供货商品' : dirty || priceConflict ? '请先保存并确认冻结单价' : undefined} onClick={() => act('submit')} className="rounded-cta bg-ink px-5 py-2.5 text-button text-white disabled:opacity-40">提交补货单</button>}
      {order?.displayStatus === 'SUBMITTED' && <button disabled={saving} onClick={() => act('accept')} className="rounded-cta bg-ink px-5 py-2.5 text-button text-white">接单并生成正式订单</button>}
      {order && !['DRAFT', 'SUBMITTED', 'CANCELLED', 'EXCEPTION'].includes(order.displayStatus) && next && <Link href={next.href} className="rounded-cta bg-ink px-5 py-2.5 text-button text-white">{next.label}</Link>}
    </div></div>}

    {cancelOpen && <div role="dialog" aria-modal="true" aria-labelledby="cancel-title" className="fixed inset-0 z-50 flex items-end justify-center bg-black/35 p-4 md:items-center"><div className="w-full max-w-md rounded-card bg-white p-5"><h2 id="cancel-title" className="text-h2">确认取消补货单？</h2><p className="mt-1 text-caption text-gray2">取消后不能继续提交。已生成正式订单的补货单不能在这里取消。</p><textarea autoFocus value={cancelReason} onChange={event => setCancelReason(event.target.value)} placeholder="填写取消原因（至少 2 个字）" className="mt-4 min-h-24 w-full rounded-xl border border-border p-3 text-body" /><div className="mt-4 flex justify-end gap-2"><button onClick={() => setCancelOpen(false)} className="rounded-cta border border-border px-4 py-2 text-button">返回</button><button disabled={saving || cancelReason.trim().length < 2} onClick={cancelOrder} className="rounded-cta bg-red px-4 py-2 text-button text-white disabled:opacity-40">确认取消</button></div></div></div>}
    <ConfirmSheet {...leaveConfirm} />
  </div>
}
