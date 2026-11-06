'use client'
import { SearchableSelect } from '@/components/v2/searchable-select'
import { ResponsiveDataTable } from '@/components/v2/responsive-data-table'
import { ConfirmSheet, useConfirmSheet } from '@/components/v2/confirm-sheet'

import { useEffect, useMemo, useState } from 'react'
import { Chip } from '@/components/v2'
import { DateRangeCalendar, type DateRangeValue } from '@/components/v2/date-range-calendar'
import { apiFetch } from '@/lib/v2-auth'
import { businessDateKey } from '@/lib/business-date'

type Store = { id: string; no: string; name: string }
type Product = { id: string; code: string; name: string; inventoryUnit?: string | null }
type TransferStatus = 'PENDING' | 'SHIPPED' | 'PARTIALLY_RECEIVED' | 'RECEIVED' | 'REVOKED'
type TransferItem = { id: string; name: string; quantity: number; unit: string; cost: number; settlement: number; pendingQuantity: number; receivedQuantity: number; returnedQuantity: number; damagedQuantity: number }
type Transfer = {
  id: string
  no: string
  transferDate: string
  fromStore: Store
  toStore: Store
  status: TransferStatus
  items: TransferItem[]
  note: string
  createdAt: string
  shippedAt?: string
  receivedAt?: string
}

const FILTER_STORAGE_KEY = 'dianjie-supply-chain-store-transfer-filters-v1'

const STATUS_META: Record<TransferStatus, { label: string; tone: 'orange' | 'blue' | 'green' | 'gray' }> = {
  PENDING: { label: '待发货', tone: 'orange' },
  SHIPPED: { label: '已发货', tone: 'blue' },
  PARTIALLY_RECEIVED: { label: '差异待处理', tone: 'orange' },
  RECEIVED: { label: '已闭环', tone: 'green' },
  REVOKED: { label: '已撤回', tone: 'gray' },
}

export default function StoreTransfersPage() {
  const [confirmState, openConfirm] = useConfirmSheet()
  const [processing, setProcessing] = useState<{ row: Transfer; action: 'RECEIVE' | 'RETURN' | 'DAMAGE'; quantities: Record<string, string>; note: string; requestKey: string } | null>(null)
  const [processingError, setProcessingError] = useState('')
  function openProcessing(row: Transfer, action: 'RECEIVE' | 'RETURN' | 'DAMAGE') {
    setProcessingError('')
    setProcessing({row, action, quantities:Object.fromEntries(row.items.map(i=>[i.id, action === 'RECEIVE' ? String(i.pendingQuantity) : '0'])),note:'',requestKey:crypto.randomUUID()})
  }
  async function saveProcessing() {
    if (!processing || busy) return
    const all = processing.row.items.map(i=>({itemId:i.id,quantity:Number(processing.quantities[i.id])}))
    const items = all.filter(i=>i.quantity>0)
    if (!items.length || all.some(i=>!Number.isFinite(i.quantity) || i.quantity < 0)) {setProcessingError('请填写有效处理数量');return}
    setBusy('processing');setProcessingError('')
    try {
      await apiFetch(`/api/store-transfers/${processing.row.id}/${processing.action === 'RECEIVE' ? 'receive' : 'resolve-difference'}`, {method:'POST',body:JSON.stringify({requestKey:processing.requestKey,items,note:processing.note,...(processing.action === 'RECEIVE' ? {} : {action:processing.action})})})
      await loadTransfers();setProcessing(null)
    } catch (e:any) {setProcessingError(e.message || '处理失败，请重试')} finally {setBusy('')}
  }
  const [stores, setStores] = useState<Store[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [transfers, setTransfers] = useState<Transfer[]>([])
  const [ready, setReady] = useState(false)
  const [storeError, setStoreError] = useState('')
  const [busy, setBusy] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [dateRange, setDateRange] = useState<DateRangeValue>({ from: '', to: '' })
  const [fromStoreId, setFromStoreId] = useState('')
  const [toStoreId, setToStoreId] = useState('')
  const [status, setStatus] = useState<TransferStatus | ''>('')
  const [keyword, setKeyword] = useState('')
  const [form, setForm] = useState({ transferDate: businessDateKey(), fromStoreId: '', toStoreId: '', productId: '', quantity: '1', cost: '0', settlement: '0', note: '' })

  useEffect(() => {
    loadTransfers().finally(() => setReady(true))
    try {
      const filters = JSON.parse(sessionStorage.getItem(FILTER_STORAGE_KEY) || '{}')
      setDateRange(filters.dateRange || { from: '', to: '' })
      setFromStoreId(filters.fromStoreId || '')
      setToStoreId(filters.toStoreId || '')
      setStatus(filters.status || '')
      setKeyword(filters.keyword || '')
    } catch {
      // 旧缓存不可用时直接使用默认筛选。
    }

    let alive = true
    apiFetch<{ items: Store[] } | Store[]>('/api/stores')
      .then(data => {
        if (!alive) return
        const rows = Array.isArray(data) ? data : data.items || []
        setStores(rows.map(row => ({ id: row.id, no: row.no, name: row.name })))
      })
      .catch(reason => {
        if (alive) setStoreError(`门店列表加载失败：${String(reason?.message || reason)}`)
      })
    apiFetch<Product[]>('/api/store-transfers/products')
      .then(data => {
        if (!alive) return
        setProducts(data)
      })
      .catch(reason => {
        if (alive) setStoreError(`调拨商品加载失败：${String(reason?.message || reason)}`)
      })
    return () => { alive = false }
  }, [])

  useEffect(() => {
    if (!ready) return
    sessionStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify({ dateRange, fromStoreId, toStoreId, status, keyword }))
  }, [ready, dateRange, fromStoreId, toStoreId, status, keyword])

  const visible = useMemo(() => {
    const query = keyword.trim().toLowerCase()
    return transfers.filter(row => {
      if (dateRange.from && row.transferDate < dateRange.from) return false
      if (dateRange.to && row.transferDate > dateRange.to) return false
      if (fromStoreId && row.fromStore.id !== fromStoreId) return false
      if (toStoreId && row.toStore.id !== toStoreId) return false
      if (status && row.status !== status) return false
      if (query) {
        const haystack = [row.no, row.fromStore.no, row.fromStore.name, row.toStore.no, row.toStore.name, ...row.items.map(item => item.name)].join(' ').toLowerCase()
        if (!haystack.includes(query)) return false
      }
      return true
    })
  }, [transfers, dateRange, fromStoreId, toStoreId, status, keyword])

  function resetFilters() {
    setDateRange({ from: '', to: '' })
    setFromStoreId('')
    setToStoreId('')
    setStatus('')
    setKeyword('')
  }

  async function loadTransfers() {
    try {
      setTransfers(await apiFetch<Transfer[]>('/api/store-transfers'))
    } catch (e: any) {
      setStoreError(e.message || '调拨单加载失败')
    }
  }

  async function createTransfer() {
    setStoreError('')
    if (!form.fromStoreId || !form.toStoreId || !form.productId) {
      setStoreError('请先选择调出门店、调入门店和商品')
      return
    }
    const quantity = Number(form.quantity)
    const cost = Number(form.cost)
    const settlement = Number(form.settlement)
    if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(cost) || cost < 0 || !Number.isFinite(settlement) || settlement < 0) {
      setStoreError('数量、成本价、结算价格式不正确')
      return
    }
    setBusy('create')
    try {
      await apiFetch('/api/store-transfers', {
        method: 'POST',
        body: JSON.stringify({
          fromStoreId: form.fromStoreId,
          toStoreId: form.toStoreId,
          transferDate: form.transferDate,
          note: form.note,
          requestKey: crypto.randomUUID(),
          items: [{ productId: form.productId, quantity, cost, settlement }],
        }),
      })
      setShowCreate(false)
      setForm(current => ({ ...current, productId: '', quantity: '1', cost: '0', settlement: '0', note: '' }))
      await loadTransfers()
    } catch (e: any) {
      setStoreError(e.message || '新建调拨单失败')
    } finally {
      setBusy('')
    }
  }

  function requestStatusChange(row: Transfer, nextStatus: 'SHIPPED' | 'RECEIVED' | 'REVOKED') {
    const label = nextStatus === 'SHIPPED' ? '审核发货' : nextStatus === 'RECEIVED' ? '确认收货' : '撤回'
    openConfirm({
      title: `确认${label}调拨单？`,
      body: `调拨单 ${row.no} 将更新状态，请核对调出门店、调入门店和商品明细。`,
      confirmLabel: label,
      tone: nextStatus === 'REVOKED' ? 'danger' : 'primary',
      onConfirm: () => changeStatus(row, nextStatus, label),
    })
  }

  async function changeStatus(row: Transfer, nextStatus: 'SHIPPED' | 'RECEIVED' | 'REVOKED', label: string) {
    setBusy(`${row.id}:${nextStatus}`)
    setStoreError('')
    try {
      await apiFetch(`/api/store-transfers/${row.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: nextStatus }) })
      await loadTransfers()
    } catch (e: any) {
      const message = e.message || `${label}失败`
      setStoreError(message)
      throw new Error(message)
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="min-h-screen bg-bg px-4 py-5 lg:px-8 lg:py-7">
      <header className="mx-auto flex max-w-[1440px] flex-wrap items-end justify-between gap-3 border-b border-border pb-5">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <Chip tone="blue">门店之间</Chip>
            <span className="text-caption text-gray3">调拨登记 · 已连接后台</span>
          </div>
          <h1 className="text-h1">门店调拨单</h1>
          <p className="mt-1 text-caption text-gray2">调拨按调出门店可靠账面成本平价发货，实收才计入调入店；差异须完成退回或损坏处置。</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="rounded-cta border border-green-200 bg-green-bg px-4 py-2.5 text-caption text-green-fg">供应链审核 · 可新建、发货、收货、撤回</div>
          <button type="button" onClick={() => setShowCreate(value => !value)} className="h-11 rounded-cta bg-accent px-4 text-button text-white shadow-card">+新建调拨单</button>
        </div>
      </header>

      <main className="mx-auto max-w-[1440px]">
        {storeError && <div className="mt-4 rounded-card border border-red-fg/20 bg-red-bg px-4 py-3 text-caption text-red-fg">{storeError}</div>}

        {showCreate && <section className="mt-4 rounded-card border border-border bg-white p-4 shadow-card">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-h2">新建门店调拨单</h2>
              <p className="text-caption text-gray2">供应链审核录入一张门店间调拨；保存后状态为待发货。</p>
            </div>
            <button type="button" onClick={() => setShowCreate(false)} className="rounded-cta border border-border bg-white px-3 py-2 text-caption text-gray2">收起</button>
          </div>
          <div className="grid gap-3 md:grid-cols-4">
            <label className="flex flex-col gap-1"><span className="text-micro text-gray3">调拨日期</span><input type="date" value={form.transferDate} onChange={event => setForm({ ...form, transferDate: event.target.value })} className="h-11 rounded-cta border border-border bg-white px-3 text-body outline-none focus:border-accent" /></label>
            <FilterSelect label="调出门店" value={form.fromStoreId} onChange={value => {setForm(current=>({...current,fromStoreId:value,toStoreId:current.toStoreId===value?'':current.toStoreId}));if(form.toStoreId===value)setStoreError('调入与调出门店不能相同，请重新选择调入门店')}}>
              <option value="">请选择</option>
              {stores.map(store => <option key={store.id} value={store.id}>{store.no} · {store.name}</option>)}
            </FilterSelect>
            <FilterSelect label="调入门店" value={form.toStoreId} onChange={value => setForm({ ...form, toStoreId: value })}>
              <option value="">请选择</option>
              {stores.filter(store=>store.id!==form.fromStoreId).map(store => <option key={store.id} value={store.id}>{store.no} · {store.name}</option>)}
            </FilterSelect>
            <FilterSelect label="调拨商品" value={form.productId} onChange={value => setForm({ ...form, productId: value })}>
              <option value="">请选择</option>
              {products.map(product => <option key={product.id} value={product.id}>{product.code} · {product.name}{product.inventoryUnit ? ` / ${product.inventoryUnit}` : ''}</option>)}
            </FilterSelect>
            <NumberInput label="数量" value={form.quantity} onChange={value => setForm({ ...form, quantity: value })} />
            <p className="text-caption text-gray2">调拨价格在审核发货时按调出门店可靠成本自动冻结，两店同价。</p>
            <label className="flex flex-col gap-1"><span className="text-micro text-gray3">备注</span><input value={form.note} onChange={event => setForm({ ...form, note: event.target.value })} placeholder="可选" className="h-11 rounded-cta border border-border bg-white px-3 text-body outline-none focus:border-accent" /></label>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={() => setShowCreate(false)} className="h-10 rounded-cta border border-border bg-white px-4 text-button text-gray2">取消</button>
            <button type="button" disabled={busy === 'create'} onClick={createTransfer} className="h-10 rounded-cta bg-accent px-4 text-button text-white disabled:opacity-60">{busy === 'create' ? '保存中...' : '保存调拨单'}</button>
          </div>
        </section>}

        <section className="flex flex-wrap items-end gap-3 py-4">
          <DateRangeCalendar label="调拨日期" value={dateRange} onChange={setDateRange} />
          <FilterSelect label="调出门店" value={fromStoreId} onChange={setFromStoreId}>
            <option value="">全部门店</option>
            {stores.map(store => <option key={store.id} value={store.id}>{store.no} · {store.name}</option>)}
          </FilterSelect>
          <FilterSelect label="调入门店" value={toStoreId} onChange={setToStoreId}>
            <option value="">全部门店</option>
            {stores.map(store => <option key={store.id} value={store.id}>{store.no} · {store.name}</option>)}
          </FilterSelect>
          <FilterSelect label="状态" value={status} onChange={value => setStatus(value as TransferStatus | '')}>
            <option value="">全部状态</option>
            {(Object.entries(STATUS_META) as Array<[TransferStatus, typeof STATUS_META[TransferStatus]]>).map(([value, meta]) => <option key={value} value={value}>{meta.label}</option>)}
          </FilterSelect>
          <label className="flex min-w-60 flex-1 flex-col gap-1">
            <span className="text-micro text-gray3">调拨单号或商品</span>
            <input value={keyword} onChange={event => setKeyword(event.target.value)} placeholder="输入单号、门店或商品名称"
              className="h-11 rounded-cta border border-border bg-white px-3 text-body outline-none focus:border-accent" />
          </label>
          <button type="button" onClick={resetFilters} className="h-11 rounded-cta border border-border bg-white px-4 text-button text-gray2">重置</button>
        </section>

        <div className="overflow-hidden rounded-card border border-border bg-white">
          <div className="overflow-x-auto">
            <ResponsiveDataTable><table className="w-full min-w-[1120px] text-left text-caption">
              <thead className="bg-bg text-gray3"><tr>
                <th className="w-16 px-4 py-3">序号</th><th className="px-4 py-3">调拨单号</th><th className="px-4 py-3">调拨日期</th>
                <th className="px-4 py-3">调出门店</th><th className="px-4 py-3">调入门店</th><th className="px-4 py-3">商品明细</th>
                <th className="px-4 py-3">状态</th><th className="px-4 py-3">创建时间</th><th className="px-4 py-3 text-right">操作</th>
              </tr></thead>
              <tbody className="divide-y divide-border">
                {visible.map((row, index) => <tr key={row.id} className="hover:bg-bg/50">
                  <td className="px-4 py-4 font-num text-gray3">{index + 1}.</td>
                  <td className="whitespace-nowrap px-4 py-4 font-num font-semibold">{row.no}</td>
                  <td className="whitespace-nowrap px-4 py-4 font-num text-gray2">{row.transferDate}</td>
                  <td className="whitespace-nowrap px-4 py-4">{row.fromStore.name}<div className="text-micro text-gray3">{row.fromStore.no}</div></td>
                  <td className="whitespace-nowrap px-4 py-4">{row.toStore.name}<div className="text-micro text-gray3">{row.toStore.no}</div></td>
                  <td className="min-w-64 px-4 py-4 text-gray2">{row.items.map(item => `${item.name} 发出${item.quantity}${item.unit}／实收${item.receivedQuantity ?? 0}／退回${item.returnedQuantity ?? 0}／损坏${item.damagedQuantity ?? 0}／待处理${item.pendingQuantity ?? item.quantity}`).join('、')}</td>
                  <td className="whitespace-nowrap px-4 py-4"><Chip tone={STATUS_META[row.status]?.tone || 'gray'}>{STATUS_META[row.status]?.label || row.status}</Chip></td>
                  <td className="whitespace-nowrap px-4 py-4 font-num text-gray2">{new Date(row.createdAt).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })}</td>
                  <td className="whitespace-nowrap px-4 py-4 text-right">
                    {row.status === 'PENDING' && <div className="flex justify-end gap-2">
                      <ActionButton disabled={busy === `${row.id}:SHIPPED`} onClick={() => requestStatusChange(row, 'SHIPPED')}>审核发货</ActionButton>
                      <ActionButton disabled={busy === `${row.id}:REVOKED`} tone="gray" onClick={() => requestStatusChange(row, 'REVOKED')}>撤回</ActionButton>
                    </div>}
                    {['SHIPPED','PARTIALLY_RECEIVED'].includes(row.status) && <div className="flex justify-end gap-2"><ActionButton disabled={Boolean(busy)} onClick={() => openProcessing(row,'RECEIVE')}>登记实收</ActionButton><ActionButton disabled={Boolean(busy)} onClick={() => openProcessing(row,'RETURN')}>完好退回</ActionButton><ActionButton disabled={Boolean(busy)} onClick={() => openProcessing(row,'DAMAGE')}>损坏处置</ActionButton></div>}
                    {['RECEIVED', 'REVOKED'].includes(row.status) && <span className="text-micro text-gray3">已完成</span>}
                  </td>
                </tr>)}
                {ready && visible.length === 0 && <tr><td colSpan={9} className="px-4 py-16 text-center text-gray3">
                  {transfers.length ? '没有符合筛选条件的调拨单' : '暂无门店调拨记录'}
                </td></tr>}
              </tbody>
            </table></ResponsiveDataTable>
          </div>
          <div className="border-t border-border bg-bg px-4 py-3 text-right text-caption text-gray3">共 {visible.length} 条记录</div>
        </div>
      </main>
      {processing && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"><section role="dialog" aria-modal="true" aria-label="调拨数量处理" className="max-h-[85vh] w-full max-w-2xl overflow-auto rounded-card bg-white p-5 shadow-xl"><h2 className="text-h2">{processing.action === 'RECEIVE' ? '登记实收' : processing.action === 'RETURN' ? '完好退回' : '损坏处置'} · {processing.row.no}</h2><p className="my-3 text-caption text-gray2">只填写本次实际处理数量；未处理部分继续保留差异。</p><div className="space-y-3">{processing.row.items.map(i=><label key={i.id} className="flex items-center justify-between gap-4"><span>{i.name} · 待处理 {i.pendingQuantity} {i.unit}</span><input type="text" inputMode="decimal" aria-label={`${i.name}处理数量`} value={processing.quantities[i.id]} onChange={e=>setProcessing({...processing,quantities:{...processing.quantities,[i.id]:e.target.value},requestKey:crypto.randomUUID()})} className="w-32 rounded border border-border p-2" /></label>)}</div><label className="mt-4 block">说明<textarea aria-label="处置说明" className="mt-1 w-full rounded border border-border p-2" value={processing.note} onChange={e=>setProcessing({...processing,note:e.target.value,requestKey:crypto.randomUUID()})}/></label>{processingError && <p role="alert" className="my-2 text-red-600">{processingError}</p>}<div className="mt-4 flex justify-end gap-3"><button disabled={Boolean(busy)} onClick={()=>setProcessing(null)} className="rounded border border-border px-4 py-2">取消</button><button disabled={Boolean(busy)} onClick={saveProcessing} className="rounded bg-accent px-4 py-2 text-white">确认</button></div></section></div>}
      <ConfirmSheet {...confirmState} />
    </div>
  )
}

function FilterSelect({ label, value, onChange, children }: { label: string; value: string; onChange: (value: string) => void; children: React.ReactNode }) {
  return <label className="flex min-w-48 flex-col gap-1"><span className="text-micro text-gray3">{label}</span><SearchableSelect searchWhenLong searchLabel={`搜索${label}`} value={value} onChange={event => onChange(event.target.value)} className="h-11 rounded-cta border border-border bg-white px-3 text-body outline-none focus:border-accent">{children}</SearchableSelect></label>
}

function NumberInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label className="flex flex-col gap-1"><span className="text-micro text-gray3">{label}</span><input type="number" min="0" step="0.000001" value={value} onChange={event => onChange(event.target.value)} className="h-11 rounded-cta border border-border bg-white px-3 text-body outline-none focus:border-accent" /></label>
}

function ActionButton({ children, disabled, tone = 'accent', onClick }: { children: React.ReactNode; disabled?: boolean; tone?: 'accent' | 'gray'; onClick: () => void }) {
  const cls = tone === 'gray'
    ? 'border border-border bg-white text-gray2'
    : 'bg-accent text-white'
  return <button type="button" disabled={disabled} onClick={onClick} className={`rounded-cta px-3 py-1.5 text-micro font-semibold disabled:opacity-60 ${cls}`}>{children}</button>
}
