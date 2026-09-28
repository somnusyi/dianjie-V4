'use client'
import { ResponsiveDataTable } from '@/components/v2/responsive-data-table'
import { ConfirmSheet, useConfirmSheet } from '@/components/v2/confirm-sheet'

import { useEffect, useMemo, useState } from 'react'
import { Chip } from '@/components/v2'
import { DateRangeCalendar, type DateRangeValue } from '@/components/v2/date-range-calendar'
import { apiFetch } from '@/lib/v2-auth'

type Store = { id: string; no: string; name: string }
type Product = { id: string; code: string; name: string; inventoryUnit?: string | null }
type TransferStatus = 'PENDING' | 'SHIPPED' | 'RECEIVED' | 'REVOKED'
type TransferItem = { id: string; name: string; quantity: number; unit: string; cost: number; settlement: number }
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
  RECEIVED: { label: '已收货', tone: 'green' },
  REVOKED: { label: '已撤回', tone: 'gray' },
}

export default function StoreTransfersPage() {
  const [confirmState, openConfirm] = useConfirmSheet()
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
  const [form, setForm] = useState({ transferDate: new Date().toISOString().slice(0, 10), fromStoreId: '', toStoreId: '', productId: '', quantity: '1', cost: '0', settlement: '0', note: '' })

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
          <p className="mt-1 text-caption text-gray2">调拨单保存到后台；已发货和已收货单据进入库存报表。本登记不改写门店盘点库存。</p>
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
            <FilterSelect label="调出门店" value={form.fromStoreId} onChange={value => setForm({ ...form, fromStoreId: value })}>
              <option value="">请选择</option>
              {stores.map(store => <option key={store.id} value={store.id}>{store.no} · {store.name}</option>)}
            </FilterSelect>
            <FilterSelect label="调入门店" value={form.toStoreId} onChange={value => setForm({ ...form, toStoreId: value })}>
              <option value="">请选择</option>
              {stores.map(store => <option key={store.id} value={store.id}>{store.no} · {store.name}</option>)}
            </FilterSelect>
            <FilterSelect label="调拨商品" value={form.productId} onChange={value => setForm({ ...form, productId: value })}>
              <option value="">请选择</option>
              {products.map(product => <option key={product.id} value={product.id}>{product.code} · {product.name}{product.inventoryUnit ? ` / ${product.inventoryUnit}` : ''}</option>)}
            </FilterSelect>
            <NumberInput label="数量" value={form.quantity} onChange={value => setForm({ ...form, quantity: value })} />
            <NumberInput label="调出成本价" value={form.cost} onChange={value => setForm({ ...form, cost: value })} />
            <NumberInput label="调入结算价" value={form.settlement} onChange={value => setForm({ ...form, settlement: value })} />
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
                  <td className="min-w-64 px-4 py-4 text-gray2">{row.items.map(item => `${item.name} ${item.quantity}${item.unit}`).join('、')}</td>
                  <td className="whitespace-nowrap px-4 py-4"><Chip tone={STATUS_META[row.status]?.tone || 'gray'}>{STATUS_META[row.status]?.label || row.status}</Chip></td>
                  <td className="whitespace-nowrap px-4 py-4 font-num text-gray2">{new Date(row.createdAt).toLocaleString('zh-CN', { hour12: false })}</td>
                  <td className="whitespace-nowrap px-4 py-4 text-right">
                    {row.status === 'PENDING' && <div className="flex justify-end gap-2">
                      <ActionButton disabled={busy === `${row.id}:SHIPPED`} onClick={() => requestStatusChange(row, 'SHIPPED')}>审核发货</ActionButton>
                      <ActionButton disabled={busy === `${row.id}:REVOKED`} tone="gray" onClick={() => requestStatusChange(row, 'REVOKED')}>撤回</ActionButton>
                    </div>}
                    {row.status === 'SHIPPED' && <ActionButton disabled={busy === `${row.id}:RECEIVED`} onClick={() => requestStatusChange(row, 'RECEIVED')}>确认收货</ActionButton>}
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
      <ConfirmSheet {...confirmState} />
    </div>
  )
}

function FilterSelect({ label, value, onChange, children }: { label: string; value: string; onChange: (value: string) => void; children: React.ReactNode }) {
  return <label className="flex min-w-48 flex-col gap-1"><span className="text-micro text-gray3">{label}</span><select value={value} onChange={event => onChange(event.target.value)} className="h-11 rounded-cta border border-border bg-white px-3 text-body outline-none focus:border-accent">{children}</select></label>
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
