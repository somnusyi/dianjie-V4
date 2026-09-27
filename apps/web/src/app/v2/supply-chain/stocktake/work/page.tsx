'use client'
import { useEffect, useState } from 'react'
import { apiFetch, getUser } from '@/lib/v2-auth'
import { ConfirmSheet, useConfirmSheet } from '@/components/v2/confirm-sheet'
type Option = { id: string; name: string }
type Product = Option & { code: string; inventoryUnit: string | null; unit: string }
type Line = { id: string; productName: string; productCode: string; inventoryUnit: string; bookQuantity: string; unitCost: string; countedQuantity: string | null; differenceQuantity: string | null; differenceAmount: string | null; reason: string | null }
type Partition = { id: string; name: string; assignedToId: string; savedAt: string | null; version: number; lines: Line[] }
type Count = { id: string; no: string; status: string; warehouse: Option; partitions: Partition[]; adjustments: Array<{ id: string; no: string; kind: string; amount: string }>; countedCount: number; itemCount: number; totalDifferenceValue: string }
type DraftPartition = { name: string; assignedToId: string; productIds: string[] }
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
  const [partitions, setPartitions] = useState<DraftPartition[]>([])
  const [entries, setEntries] = useState<Record<string, { quantity: string; unitCost: string; reason: string }>>({})
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirm, openConfirm] = useConfirmSheet()
  const [query, setQuery] = useState('')
  async function load(id?: string, savedPartitionId?: string) {
    const list = await apiFetch<typeof rows>('/api/warehouse-stocktakes')
    setRows(list)
    if (id) {
      const detail = await apiFetch<Count>(`/api/warehouse-stocktakes/${id}`)
      setCount(detail)
      setEntries(previous => Object.fromEntries(detail.partitions.flatMap(partition => partition.lines.map(line => [line.id, savedPartitionId && partition.id !== savedPartitionId && previous[line.id] ? previous[line.id] : { quantity: line.countedQuantity ?? '', unitCost: line.unitCost, reason: line.reason || '' }]))))
    }
  }
  useEffect(() => {
    apiFetch<typeof options>('/api/warehouse-stocktakes/options').then(result => { setOptions(result); setWarehouseId(result.warehouses[0]?.id || ''); setPartitions([{ name: '分区 1', assignedToId: user?.id || result.users[0]?.id || '', productIds: [] }]) }).catch(reason => setError(reason.message))
    void load(new URLSearchParams(window.location.search).get('doc') || undefined).catch(reason => setError(reason.message))
  }, [])
  async function run(task: () => Promise<any>, message: string, savedPartitionId?: string) {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try { const result = await task(); await load(result.id || count?.id, savedPartitionId); setNotice(message); return true }
    catch (reason: any) { setError(reason.message); return false }
    finally { setBusy(false) }
  }
  function transition(action: 'submit' | 'approve' | 'reject' | 'cancel') {
    const title = { submit: '汇总提交审核', approve: '审核并生成盘盈盘亏', reject: '退回继续录入', cancel: '取消盘点单' }[action]
    openConfirm({ title, body: action === 'approve' ? '将根据汇总实盘自动调整总仓库存，并生成盘盈/盘亏单。本轮不支持反审核。' : '请确认已核对单据与各分区保存进度。', tone: action === 'cancel' ? 'danger' : 'primary', onConfirm: async () => { if (!await run(() => apiFetch(`/api/warehouse-stocktakes/${count!.id}/${action}`, { method: 'POST' }), `${title}成功`)) throw new Error('操作未完成') } })
  }
  return <main className="mx-auto max-w-6xl p-4 space-y-4">
    <header><a href="/v2/supply-chain/stocktake/count" className="underline text-caption">返回盘点查询</a><h1 className="text-h1 mt-3">总仓盘点作业</h1><p className="text-caption text-gray2">分配商品与负责人 → 每人保存实盘 → 汇总提交 → 审核自动生成盘盈盘亏。盘点期间请暂停相关商品出入库；账面变动会阻止审核。</p></header>
    {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-red-700">{error}</p>}{notice && <p role="status" className="rounded-xl bg-green-50 p-3">{notice}</p>}
    {canWrite && <button className="rounded-lg bg-ink text-white px-4 py-2" onClick={() => setCreating(!creating)}>新建总仓盘点</button>}
    {creating && <section className="rounded-xl border p-4 space-y-3"><h2 className="text-h2">创建盘点与分区</h2><div className="grid gap-3 sm:grid-cols-2"><label>仓库<select className={field} value={warehouseId} onChange={event => setWarehouseId(event.target.value)}>{options.warehouses.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}</select></label><label>盘点日期<input className={field} type="date" value={date} onChange={event => setDate(event.target.value)} /></label></div>
      <label className="block">筛选商品<input className={field} value={query} onChange={event => setQuery(event.target.value)} placeholder="商品名称 / 编码" /></label>
      {partitions.map((partition, index) => <div key={index} className="rounded-lg border p-3"><div className="grid gap-2 sm:grid-cols-2"><label>分区名<input className={field} value={partition.name} onChange={event => setPartitions(rows => rows.map((row, i) => i === index ? { ...row, name: event.target.value } : row))} /></label><label>负责人<select className={field} value={partition.assignedToId} onChange={event => setPartitions(rows => rows.map((row, i) => i === index ? { ...row, assignedToId: event.target.value } : row))}>{options.users.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}</select></label></div><p className="mt-2 text-caption">已分配 {partition.productIds.length} 项 · 同一商品仅能分配一个分区</p><div className="max-h-52 overflow-auto grid sm:grid-cols-2 gap-2 mt-2">{options.products.filter(product => `${product.code} ${product.name}`.includes(query)).map(product => <label key={product.id} className="text-caption"><input type="checkbox" checked={partition.productIds.includes(product.id)} disabled={partitions.some((row, i) => i !== index && row.productIds.includes(product.id))} onChange={event => setPartitions(rows => rows.map((row, i) => i === index ? { ...row, productIds: event.target.checked ? [...row.productIds, product.id] : row.productIds.filter(id => id !== product.id) } : row))} /> {product.code} {product.name}</label>)}</div>{partitions.length > 1 && <button className="mt-2 underline" onClick={() => setPartitions(rows => rows.filter((_, i) => i !== index))}>移除此分区</button>}</div>)}
      <div className="flex flex-wrap gap-3"><button className="underline" onClick={() => setPartitions(rows => [...rows, { name: `分区 ${rows.length + 1}`, assignedToId: user?.id || options.users[0]?.id || '', productIds: [] }])}>添加分区 / 负责人</button><button disabled={busy} className="rounded-lg bg-ink text-white px-4 py-2" onClick={async () => { if (await run(() => apiFetch('/api/warehouse-stocktakes', { method: 'POST', body: JSON.stringify({ warehouseId, countDate: date, partitions }) }), '盘点已创建，请各负责人录入')) setCreating(false) }}>保存盘点草稿</button></div>
    </section>}
    <label className="block">选择盘点单<select className={field} value={count?.id || ''} onChange={event => { if (event.target.value) void load(event.target.value).catch(reason => setError(reason.message)) }}><option value="">请选择</option>{rows.map(row => <option key={row.id} value={row.id}>{row.no} · {row.warehouse.name} · {labels[row.status]}</option>)}</select></label>
    {count && <section className="space-y-4"><div className="rounded-xl border p-4"><h2 className="text-h2">{count.no} · {labels[count.status]}</h2><p>{count.warehouse.name} · 已盘 {count.countedCount}/{count.itemCount} 项 · 汇总差异金额 ¥{Number(count.totalDifferenceValue).toFixed(2)}</p><a className="underline text-caption" href={`/v2/supply-chain/stocktake/count/${count.id}?source=warehouse`}>查看差异 / 打印 / 保存 PDF</a><div className="flex flex-wrap gap-3 mt-3">{canWrite && ['DRAFT', 'COUNTING'].includes(count.status) && <button disabled={busy} onClick={() => transition('submit')}>汇总提交审核</button>}{canAudit && count.status === 'REVIEWING' && <><button disabled={busy} onClick={() => transition('approve')}>审核并生成盘盈盘亏</button><button disabled={busy} onClick={() => transition('reject')}>退回录入</button></>}{canWrite && ['DRAFT', 'COUNTING', 'REVIEWING'].includes(count.status) && <button disabled={busy} onClick={() => transition('cancel')}>取消盘点</button>}</div></div>
      {count.partitions.map(partition => { const editable = canWrite && partition.assignedToId === user?.id && ['DRAFT', 'COUNTING'].includes(count.status); return <section key={partition.id} className="rounded-xl border p-4"><h3 className="text-h3">{partition.name} · {options.users.find(user => user.id === partition.assignedToId)?.name || '负责人'}</h3><p className="text-caption">{partition.savedAt ? `已保存 ${new Date(partition.savedAt).toLocaleString('zh-CN')}` : '尚未保存'}</p><div className="grid gap-3 mt-3 md:grid-cols-2">{partition.lines.map(line => <article key={line.id} className="rounded-lg bg-bg p-3 space-y-2"><b>{line.productCode} {line.productName}</b><p className="text-caption">账面 {line.bookQuantity} {line.inventoryUnit} · 差异 {line.differenceQuantity ?? '未盘'} · ¥{line.differenceAmount ?? '—'}</p><label className="block">实盘数量（{line.inventoryUnit}）<input aria-label={`${line.productName}实盘数量`} className={field} type="number" min="0" step="0.000001" disabled={!editable || busy} value={entries[line.id]?.quantity ?? ''} onChange={event => setEntries(rows => ({ ...rows, [line.id]: { ...rows[line.id], quantity: event.target.value } }))} /></label><label className="block">成本单价<input className={field} type="number" min="0" step="0.000001" disabled={!editable || busy || Number(line.unitCost) > 0} value={entries[line.id]?.unitCost ?? ''} onChange={event => setEntries(rows => ({ ...rows, [line.id]: { ...rows[line.id], unitCost: event.target.value } }))} /></label><label className="block">差异说明<input className={field} disabled={!editable || busy} value={entries[line.id]?.reason ?? ''} onChange={event => setEntries(rows => ({ ...rows, [line.id]: { ...rows[line.id], reason: event.target.value } }))} /></label></article>)}</div>{editable && <button disabled={busy} className="mt-3 rounded-lg bg-ink text-white px-4 py-2" onClick={() => void run(() => apiFetch(`/api/warehouse-stocktakes/${count.id}/partitions/${partition.id}`, { method: 'PUT', body: JSON.stringify({ version: partition.version, lines: partition.lines.filter(line => entries[line.id]?.quantity !== '').map(line => ({ id: line.id, ...entries[line.id] })) }) }), `${partition.name}已保存`, partition.id)}>保存我的分区</button>}</section> })}
      {count.adjustments.length > 0 && <div className="rounded-xl bg-green-50 p-4"><h3>已生成并过账</h3>{count.adjustments.map(row => <p key={row.id}><a className="underline" href={`/v2/supply-chain/stocktake/${row.kind === 'PROFIT' ? 'profit' : 'loss'}`}>{row.no} · {row.kind === 'PROFIT' ? '盘盈' : '盘亏'} ¥{Number(row.amount).toFixed(2)}</a></p>)}</div>}
    </section>}
    <ConfirmSheet {...confirm} />
  </main>
}
