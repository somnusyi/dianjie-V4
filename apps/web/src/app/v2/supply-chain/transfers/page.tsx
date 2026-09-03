'use client'

import { useEffect, useMemo, useState } from 'react'
import { Chip } from '@/components/v2'
import { DateRangeCalendar, type DateRangeValue } from '@/components/v2/date-range-calendar'
import { apiFetch } from '@/lib/v2-auth'

type Store = { id: string; no: string; name: string }
type TransferStatus = 'PENDING' | 'SHIPPED' | 'RECEIVED' | 'REVOKED'
type TransferItem = { id: string; name: string; quantity: number; unit: string }
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

type Draft = {
  fromStoreId: string
  toStoreId: string
  transferDate: string
  note: string
  items: Array<{ name: string; quantity: string; unit: string }>
}

const TRANSFER_STORAGE_KEY = 'dianjie-supply-chain-store-transfers-v1'
const FILTER_STORAGE_KEY = 'dianjie-supply-chain-store-transfer-filters-v1'

const STATUS_META: Record<TransferStatus, { label: string; tone: 'orange' | 'blue' | 'green' | 'gray' }> = {
  PENDING: { label: '待发货', tone: 'orange' },
  SHIPPED: { label: '已发货', tone: 'blue' },
  RECEIVED: { label: '已收货', tone: 'green' },
  REVOKED: { label: '已撤回', tone: 'gray' },
}

function localDate(value = new Date()) {
  const y = value.getFullYear()
  const m = String(value.getMonth() + 1).padStart(2, '0')
  const d = String(value.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function newDraft(): Draft {
  return {
    fromStoreId: '',
    toStoreId: '',
    transferDate: localDate(),
    note: '',
    items: [{ name: '', quantity: '1', unit: '件' }],
  }
}

function parseStoredTransfers(raw: string | null): Transfer[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function transferNo() {
  const now = new Date()
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
  return `DJDB${stamp}${String(now.getTime()).slice(-5)}`
}

export default function StoreTransfersPage() {
  const [stores, setStores] = useState<Store[]>([])
  const [transfers, setTransfers] = useState<Transfer[]>([])
  const [ready, setReady] = useState(false)
  const [storeError, setStoreError] = useState('')
  const [notice, setNotice] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [draft, setDraft] = useState<Draft>(newDraft)
  const [dateRange, setDateRange] = useState<DateRangeValue>({ from: '', to: '' })
  const [fromStoreId, setFromStoreId] = useState('')
  const [toStoreId, setToStoreId] = useState('')
  const [status, setStatus] = useState<TransferStatus | ''>('')
  const [keyword, setKeyword] = useState('')

  useEffect(() => {
    setTransfers(parseStoredTransfers(sessionStorage.getItem(TRANSFER_STORAGE_KEY)))
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
    setReady(true)

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
    return () => { alive = false }
  }, [])

  useEffect(() => {
    if (!ready) return
    sessionStorage.setItem(TRANSFER_STORAGE_KEY, JSON.stringify(transfers))
  }, [ready, transfers])

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

  function openCreate() {
    setNotice('')
    setDraft(newDraft())
    setModalOpen(true)
  }

  function updateItem(index: number, changes: Partial<Draft['items'][number]>) {
    setDraft(current => ({
      ...current,
      items: current.items.map((item, itemIndex) => itemIndex === index ? { ...item, ...changes } : item),
    }))
  }

  function createTransfer() {
    const fromStore = stores.find(store => store.id === draft.fromStoreId)
    const toStore = stores.find(store => store.id === draft.toStoreId)
    const items = draft.items
      .map((item, index) => ({ id: `${Date.now()}-${index}`, name: item.name.trim(), quantity: Number(item.quantity), unit: item.unit.trim() || '件' }))
      .filter(item => item.name && item.quantity > 0)
    if (!fromStore || !toStore) return setNotice('请选择调出门店和调入门店')
    if (fromStore.id === toStore.id) return setNotice('调出门店和调入门店不能相同')
    if (!draft.transferDate) return setNotice('请选择调拨日期')
    if (!items.length) return setNotice('请至少填写一个商品及有效数量')

    const now = new Date().toISOString()
    const row: Transfer = {
      id: `${Date.now()}`,
      no: transferNo(),
      transferDate: draft.transferDate,
      fromStore,
      toStore,
      status: 'PENDING',
      items,
      note: draft.note.trim(),
      createdAt: now,
    }
    setTransfers(current => [row, ...current])
    setModalOpen(false)
    setNotice(`调拨单 ${row.no} 已新建，当前为待发货`)
  }

  function changeStatus(id: string, nextStatus: TransferStatus) {
    const now = new Date().toISOString()
    const row = transfers.find(item => item.id === id)
    if (!row) return
    setTransfers(current => current.map(item => item.id === id ? {
      ...item,
      status: nextStatus,
      ...(nextStatus === 'SHIPPED' ? { shippedAt: now } : {}),
      ...(nextStatus === 'RECEIVED' ? { receivedAt: now } : {}),
    } : item))
    setNotice(`调拨单 ${row.no} 已${nextStatus === 'SHIPPED' ? '发货' : nextStatus === 'RECEIVED' ? '收货' : '撤回'}`)
  }

  return (
    <div className="min-h-screen bg-bg px-4 py-5 lg:px-8 lg:py-7">
      <header className="mx-auto flex max-w-[1440px] flex-wrap items-end justify-between gap-3 border-b border-border pb-5">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <Chip tone="blue">门店之间</Chip>
            <span className="text-caption text-gray3">调拨演示 · 不变更实际库存</span>
          </div>
          <h1 className="text-h1">门店调拨单</h1>
          <p className="mt-1 text-caption text-gray2">调拨单保存在当前浏览器会话，待正式对接库存后再入账。</p>
        </div>
        <button type="button" onClick={openCreate} disabled={stores.length < 2}
          className="rounded-cta bg-accent px-5 py-2.5 text-button text-white disabled:opacity-40">+新建调拨单</button>
      </header>

      <main className="mx-auto max-w-[1440px]">
        {storeError && <div className="mt-4 rounded-card border border-red-fg/20 bg-red-bg px-4 py-3 text-caption text-red-fg">{storeError}</div>}
        {notice && <div className="mt-4 rounded-card border border-amber/30 bg-amber/10 px-4 py-3 text-caption text-amber-fg">{notice}</div>}

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
            <table className="w-full min-w-[1120px] text-left text-caption">
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
                    {row.status === 'PENDING' && <div className="flex justify-end gap-3"><Action onClick={() => changeStatus(row.id, 'SHIPPED')}>发货</Action><Action muted onClick={() => changeStatus(row.id, 'REVOKED')}>撤回</Action></div>}
                    {row.status === 'SHIPPED' && <Action onClick={() => changeStatus(row.id, 'RECEIVED')}>收货</Action>}
                    {(row.status === 'RECEIVED' || row.status === 'REVOKED') && <span className="text-gray3">—</span>}
                  </td>
                </tr>)}
                {ready && visible.length === 0 && <tr><td colSpan={9} className="px-4 py-16 text-center text-gray3">
                  {transfers.length ? '没有符合筛选条件的调拨单' : '暂无调拨单，点击右上角“新建调拨单”开始'}
                </td></tr>}
              </tbody>
            </table>
          </div>
          <div className="border-t border-border bg-bg px-4 py-3 text-right text-caption text-gray3">共 {visible.length} 条记录</div>
        </div>
      </main>

      {modalOpen && <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/30 p-4" onMouseDown={event => event.currentTarget === event.target && setModalOpen(false)}>
        <div role="dialog" aria-modal="true" aria-label="新建调拨单" className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-card border border-border bg-white shadow-xl">
          <div className="flex items-center justify-between border-b border-border px-5 py-4">
            <div><h2 className="text-h2">新建调拨单</h2><p className="mt-1 text-micro text-gray3">仅保存为交互演示，不扣减门店库存</p></div>
            <button type="button" onClick={() => setModalOpen(false)} aria-label="关闭" className="p-2 text-xl text-gray3">×</button>
          </div>
          <div className="grid gap-4 p-5 sm:grid-cols-2">
            <FilterSelect label="调出门店 *" value={draft.fromStoreId} onChange={value => setDraft(current => ({ ...current, fromStoreId: value }))}>
              <option value="">请选择</option>{stores.map(store => <option key={store.id} value={store.id}>{store.no} · {store.name}</option>)}
            </FilterSelect>
            <FilterSelect label="调入门店 *" value={draft.toStoreId} onChange={value => setDraft(current => ({ ...current, toStoreId: value }))}>
              <option value="">请选择</option>{stores.filter(store => store.id !== draft.fromStoreId).map(store => <option key={store.id} value={store.id}>{store.no} · {store.name}</option>)}
            </FilterSelect>
            <label className="flex flex-col gap-1"><span className="text-micro text-gray3">调拨日期 *</span><input type="date" value={draft.transferDate} onChange={event => setDraft(current => ({ ...current, transferDate: event.target.value }))} className="h-11 rounded-cta border border-border px-3 text-body" /></label>
            <label className="flex flex-col gap-1"><span className="text-micro text-gray3">备注</span><input value={draft.note} onChange={event => setDraft(current => ({ ...current, note: event.target.value }))} placeholder="选填" className="h-11 rounded-cta border border-border px-3 text-body" /></label>
          </div>
          <div className="px-5 pb-5">
            <div className="mb-2 flex items-center justify-between"><h3 className="text-button">调拨商品</h3><button type="button" onClick={() => setDraft(current => ({ ...current, items: [...current.items, { name: '', quantity: '1', unit: '件' }] }))} className="text-button text-amber-fg">+添加一行</button></div>
            <div className="space-y-2">{draft.items.map((item, index) => <div key={index} className="grid grid-cols-[minmax(0,1fr)_100px_90px_36px] gap-2">
              <input aria-label={`第${index + 1}行商品`} value={item.name} onChange={event => updateItem(index, { name: event.target.value })} placeholder="商品名称" className="h-10 rounded-cta border border-border px-3 text-body" />
              <input aria-label={`第${index + 1}行数量`} type="number" min="0.001" step="0.001" value={item.quantity} onChange={event => updateItem(index, { quantity: event.target.value })} className="h-10 rounded-cta border border-border px-3 text-body" />
              <input aria-label={`第${index + 1}行单位`} value={item.unit} onChange={event => updateItem(index, { unit: event.target.value })} placeholder="单位" className="h-10 rounded-cta border border-border px-3 text-body" />
              <button type="button" aria-label={`删除第${index + 1}行`} disabled={draft.items.length === 1} onClick={() => setDraft(current => ({ ...current, items: current.items.filter((_, itemIndex) => itemIndex !== index) }))} className="text-gray3 disabled:opacity-30">×</button>
            </div>)}</div>
          </div>
          <div className="flex items-center justify-between border-t border-border px-5 py-4">
            <span className="text-caption text-red-fg">{notice}</span>
            <div className="flex gap-2"><button type="button" onClick={() => setModalOpen(false)} className="rounded-cta border border-border px-4 py-2 text-button text-gray2">取消</button><button type="button" onClick={createTransfer} className="rounded-cta bg-accent px-5 py-2 text-button text-white">保存调拨单</button></div>
          </div>
        </div>
      </div>}
    </div>
  )
}

function FilterSelect({ label, value, onChange, children }: { label: string; value: string; onChange: (value: string) => void; children: React.ReactNode }) {
  return <label className="flex min-w-48 flex-col gap-1"><span className="text-micro text-gray3">{label}</span><select value={value} onChange={event => onChange(event.target.value)} className="h-11 rounded-cta border border-border bg-white px-3 text-body outline-none focus:border-accent">{children}</select></label>
}

function Action({ children, onClick, muted = false }: { children: React.ReactNode; onClick: () => void; muted?: boolean }) {
  return <button type="button" onClick={onClick} className={`text-button ${muted ? 'text-gray2' : 'text-amber-fg'}`}>{children}</button>
}
