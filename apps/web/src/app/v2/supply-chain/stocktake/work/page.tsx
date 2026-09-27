'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { apiFetch, getUser } from '@/lib/v2-auth'
import { ConfirmSheet, useConfirmSheet } from '@/components/v2/confirm-sheet'

type Option = { id: string; name: string; code?: string }
type Product = Option & { code: string; spec?: string | null; category?: string | null; inventoryUnit: string | null; unit: string }
type Item = {
  id: string; productNameSnapshot: string; productCodeSnapshot: string; productSpecSnapshot: string | null
  inventoryUnit: string; bookQuantity: string; averageUnitCost: string; countedQuantity: string | null
  countedUnitCost: string | null; differenceQuantity: string | null; differenceValue: string | null; reason: string | null
}
type Section = { id: string; name: string; assignedToId: string; status: 'OPEN' | 'SUBMITTED'; rowVersion: number; submittedAt: string | null; items: Item[] }
type Count = {
  id: string; no: string; status: string; rowVersion: number; warehouse: Option; sections: Section[]
  adjustments: Array<{ id: string; no: string; type: 'PROFIT' | 'LOSS'; totalAmount: string }>
  countedCount: number; itemCount: number; totalDifferenceValue: string
}
type DraftSection = { name: string; assignedToId: string; productIds: string[] }

const labels: Record<string, string> = { DRAFT: '草稿', COUNTING: '盘点中', REVIEWING: '待审核', CONFIRMED: '已审核', CANCELLED: '已取消' }
const field = 'w-full rounded-lg border border-border bg-white p-2'

export default function WarehouseStocktakeWorkPage() {
  const user = getUser()
  const canWrite = ['SUPPLY_CHAIN', 'SUPER_ADMIN', 'ADMIN', 'PURCHASER'].includes(user?.role || '')
  const canAudit = ['SUPPLY_CHAIN', 'SUPER_ADMIN', 'ADMIN', 'FINANCE'].includes(user?.role || '')
  const [options, setOptions] = useState<{ warehouses: Option[]; users: Option[]; products: Product[] }>({ warehouses: [], users: [], products: [] })
  const [rows, setRows] = useState<Array<{ id: string; no: string; status: string; warehouse: Option }>>([])
  const [count, setCount] = useState<Count | null>(null)
  const [creating, setCreating] = useState(false)
  const [warehouseId, setWarehouseId] = useState('')
  const [date, setDate] = useState(new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }))
  const [sections, setSections] = useState<DraftSection[]>([])
  const [entries, setEntries] = useState<Record<string, { countedQuantity: string; countedUnitCost: string; reason: string }>>({})
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirm, openConfirm] = useConfirmSheet()

  async function load(id?: string) {
    const list = await apiFetch<{ rows: typeof rows }>('/api/warehouse-stocktakes?page=1&pageSize=200')
    setRows(list.rows)
    if (!id) return
    const detail = await apiFetch<Count>(`/api/warehouse-stocktakes/${id}`)
    setCount(detail)
    setEntries(Object.fromEntries(detail.sections.flatMap(section => section.items.map(item => [item.id, {
      countedQuantity: item.countedQuantity ?? '',
      countedUnitCost: item.countedUnitCost ?? item.averageUnitCost,
      reason: item.reason || '',
    }]))))
  }

  useEffect(() => {
    apiFetch<typeof options>('/api/warehouse-stocktakes/options').then(result => {
      setOptions(result)
      setWarehouseId(result.warehouses[0]?.id || '')
      setSections([{ name: '分区 1', assignedToId: user?.id || result.users[0]?.id || '', productIds: [] }])
    }).catch(reason => setError(reason.message))
    void load(new URLSearchParams(window.location.search).get('doc') || undefined).catch(reason => setError(reason.message))
  }, [])

  async function run(task: () => Promise<unknown>, message: string, id = count?.id) {
    if (busy) return false
    setBusy(true); setError(''); setNotice('')
    try { await task(); await load(id); setNotice(message); return true }
    catch (reason: any) { setError(reason.message || '操作失败'); return false }
    finally { setBusy(false) }
  }

  async function createDraft() {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await apiFetch<{ stocktake: Count }>('/api/warehouse-stocktakes', {
        method: 'POST',
        body: JSON.stringify({ requestKey: crypto.randomUUID(), warehouseId, countDate: date, sections }),
      })
      setCreating(false)
      await load(result.stocktake.id)
      setNotice('盘点已创建，请各负责人录入')
    } catch (reason: any) {
      setError(reason.message || '创建盘点失败')
    } finally {
      setBusy(false)
    }
  }

  function confirmTransition(action: 'submit' | 'approve' | 'reject' | 'cancel') {
    if (!count) return
    const title = { submit: '汇总提交审核', approve: '审核并生成盘盈盘亏', reject: '退回继续录入', cancel: '取消盘点单' }[action]
    openConfirm({
      title,
      body: action === 'approve' ? '将按差额调整总仓库存并生成盘盈/盘亏单。已审核不支持反审核。' : '请确认已核对单据和各分区进度。',
      tone: action === 'cancel' ? 'danger' : 'primary',
      withInput: ['reject', 'cancel'].includes(action),
      inputRequired: ['reject', 'cancel'].includes(action),
      inputPlaceholder: action === 'reject' ? '请填写退回原因' : action === 'cancel' ? '请填写取消原因' : undefined,
      onConfirm: async inputReason => {
        const reason = inputReason?.trim() || ''
        if (['reject', 'cancel'].includes(action) && (!reason || reason.length < 2)) throw new Error('请填写至少2个字的原因')
        const body = action === 'submit' ? { rowVersion: count.rowVersion } : action === 'cancel' ? { reason, rowVersion: count.rowVersion } : action === 'reject' ? { reason } : undefined
        if (!await run(() => apiFetch(`/api/warehouse-stocktakes/${count.id}/${action}`, { method: 'POST', ...(body ? { body: JSON.stringify(body) } : {}) }), `${title}成功`)) throw new Error('操作未完成')
      },
    })
  }

  return <main className="mx-auto max-w-6xl space-y-4 p-4">
    <header><Link href="/v2/supply-chain/stocktake/count" className="text-caption underline">返回盘点查询</Link><h1 className="mt-3 text-h1">总仓盘点作业</h1><p className="text-caption text-gray2">分配商品与负责人 → 分区逐人录入/提交 → 汇总提交 → 审核生成盘盈盘亏。盘点期间有新出入库时，审核会整单拒绝。</p></header>
    {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-red-700">{error}</p>}{notice && <p role="status" className="rounded-xl bg-green-50 p-3">{notice}</p>}
    {canWrite && <button className="rounded-lg bg-ink px-4 py-2 text-white" onClick={() => setCreating(value => !value)}>新建总仓盘点</button>}
    {creating && <section className="space-y-3 rounded-xl border p-4"><h2 className="text-h2">创建盘点与分区</h2><div className="grid gap-3 sm:grid-cols-2"><label>仓库<select className={field} value={warehouseId} onChange={event => setWarehouseId(event.target.value)}>{options.warehouses.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}</select></label><label>盘点日期<input className={field} type="date" value={date} onChange={event => setDate(event.target.value)} /></label></div>
      <label className="block">筛选商品<input className={field} value={query} onChange={event => setQuery(event.target.value)} placeholder="商品名称 / 编码" /></label>
      {sections.map((section, index) => <div key={index} className="rounded-lg border p-3"><div className="grid gap-2 sm:grid-cols-2"><label>分区名<input className={field} value={section.name} onChange={event => setSections(rows => rows.map((row, i) => i === index ? { ...row, name: event.target.value } : row))} /></label><label>负责人<select className={field} value={section.assignedToId} onChange={event => setSections(rows => rows.map((row, i) => i === index ? { ...row, assignedToId: event.target.value } : row))}>{options.users.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}</select></label></div><p className="mt-2 text-caption">已分配 {section.productIds.length} 项；同一商品只能进入一个分区。</p><div className="mt-2 grid max-h-56 gap-2 overflow-auto sm:grid-cols-2">{options.products.filter(product => `${product.code} ${product.name}`.toLowerCase().includes(query.toLowerCase())).map(product => <label key={product.id} className="text-caption"><input type="checkbox" checked={section.productIds.includes(product.id)} disabled={sections.some((row, i) => i !== index && row.productIds.includes(product.id))} onChange={event => setSections(rows => rows.map((row, i) => i === index ? { ...row, productIds: event.target.checked ? [...row.productIds, product.id] : row.productIds.filter(id => id !== product.id) } : row))} /> {product.code} {product.name}</label>)}</div>{sections.length > 1 && <button className="mt-2 underline" onClick={() => setSections(rows => rows.filter((_, i) => i !== index))}>移除此分区</button>}</div>)}
      <div className="flex flex-wrap gap-3"><button className="underline" onClick={() => setSections(rows => [...rows, { name: `分区 ${rows.length + 1}`, assignedToId: user?.id || options.users[0]?.id || '', productIds: [] }])}>添加分区 / 负责人</button><button disabled={busy} className="rounded-lg bg-ink px-4 py-2 text-white" onClick={() => void createDraft()}>保存盘点草稿</button></div>
    </section>}
    <label className="block">选择盘点单<select className={field} value={count?.id || ''} onChange={event => { if (event.target.value) void load(event.target.value).catch(reason => setError(reason.message)) }}><option value="">请选择</option>{rows.map(row => <option key={row.id} value={row.id}>{row.no} · {row.warehouse.name} · {labels[row.status]}</option>)}</select></label>
    {count && <section className="space-y-4"><div className="rounded-xl border p-4"><h2 className="text-h2">{count.no} · {labels[count.status]}</h2><p>{count.warehouse.name} · 已盘 {count.countedCount}/{count.itemCount} 项 · 汇总差异金额 ¥{Number(count.totalDifferenceValue).toFixed(2)}</p><Link className="text-caption underline" href={`/v2/supply-chain/stocktake/count/${count.id}?source=warehouse`}>查看差异 / 打印 / 保存 PDF</Link><div className="mt-3 flex flex-wrap gap-3">{canWrite && ['DRAFT', 'COUNTING'].includes(count.status) && <button disabled={busy} onClick={() => confirmTransition('submit')}>汇总提交审核</button>}{canAudit && count.status === 'REVIEWING' && <><button disabled={busy} onClick={() => confirmTransition('approve')}>审核并生成盘盈盘亏</button><button disabled={busy} onClick={() => confirmTransition('reject')}>退回录入</button></>}{canWrite && ['DRAFT', 'COUNTING'].includes(count.status) && <button disabled={busy} onClick={() => confirmTransition('cancel')}>取消盘点</button>}</div></div>
      {count.sections.map(section => { const editable = canWrite && section.assignedToId === user?.id && ['DRAFT', 'COUNTING'].includes(count.status) && section.status === 'OPEN'; return <section key={section.id} className="rounded-xl border p-4"><h3 className="text-h3">{section.name} · {options.users.find(option => option.id === section.assignedToId)?.name || '负责人'} · {section.status === 'SUBMITTED' ? '已提交' : '录入中'}</h3><div className="mt-3 grid gap-3 md:grid-cols-2">{section.items.map(item => <article key={item.id} className="space-y-2 rounded-lg bg-bg p-3"><b>{item.productCodeSnapshot} {item.productNameSnapshot}</b><p className="text-caption">账面 {item.bookQuantity} {item.inventoryUnit} · 差异 {item.differenceQuantity ?? '未盘'} · ¥{item.differenceValue ?? '—'}</p><label className="block">实盘数量（{item.inventoryUnit}）<input aria-label={`${item.productNameSnapshot}实盘数量`} className={field} type="number" min="0" step="0.000001" disabled={!editable || busy} value={entries[item.id]?.countedQuantity ?? ''} onChange={event => setEntries(rows => ({ ...rows, [item.id]: { ...rows[item.id], countedQuantity: event.target.value } }))} /></label><label className="block">成本单价<input className={field} type="number" min="0" step="0.000001" disabled={!editable || busy || Number(item.averageUnitCost) > 0} value={entries[item.id]?.countedUnitCost ?? ''} onChange={event => setEntries(rows => ({ ...rows, [item.id]: { ...rows[item.id], countedUnitCost: event.target.value } }))} /></label><label className="block">差异说明<input className={field} disabled={!editable || busy} value={entries[item.id]?.reason ?? ''} onChange={event => setEntries(rows => ({ ...rows, [item.id]: { ...rows[item.id], reason: event.target.value } }))} /></label></article>)}</div>{editable && <div className="mt-3 flex gap-3"><button disabled={busy} className="rounded-lg border px-4 py-2" onClick={() => void run(() => apiFetch(`/api/warehouse-stocktakes/${count.id}/sections/${section.id}`, { method: 'PUT', body: JSON.stringify({ rowVersion: section.rowVersion, submit: false, items: section.items.filter(item => entries[item.id]?.countedQuantity !== '').map(item => ({ itemId: item.id, ...entries[item.id] })) }) }), `${section.name}已保存`)}>保存我的分区</button><button disabled={busy} className="rounded-lg bg-ink px-4 py-2 text-white" onClick={() => void run(() => apiFetch(`/api/warehouse-stocktakes/${count.id}/sections/${section.id}`, { method: 'PUT', body: JSON.stringify({ rowVersion: section.rowVersion, submit: true, items: section.items.filter(item => entries[item.id]?.countedQuantity !== '').map(item => ({ itemId: item.id, ...entries[item.id] })) }) }), `${section.name}已提交`)}>提交我的分区</button></div>}</section> })}
      {count.adjustments.length > 0 && <div className="rounded-xl bg-green-50 p-4"><h3>已生成并过账</h3>{count.adjustments.map(row => <p key={row.id}><Link className="underline" href={`/v2/supply-chain/stocktake/${row.type === 'PROFIT' ? 'profit' : 'loss'}`}>{row.no} · {row.type === 'PROFIT' ? '盘盈' : '盘亏'} ¥{Number(row.totalAmount).toFixed(2)}</Link></p>)}</div>}
    </section>}
    <ConfirmSheet {...confirm} />
  </main>
}
