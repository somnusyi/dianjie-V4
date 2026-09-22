'use client'
import { Suspense, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { apiFetch } from '@/lib/v2-auth'
import { inventoryReports } from '@/components/v2/inventory-report-menu'
import styles from './reports.module.css'

type Column = { key: string; label: string; kind: 'text' | 'number'; group?: string }
type Result = { id: string; title: string; note: string; columns: Column[]; rows: Record<string, string | number | null>[]; total: number; page: number; pageSize: number; warehouses: { id: string; name: string; isDefault: boolean }[] }
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date())
const initialFilters = () => ({ start: `${today().slice(0, 7)}-01`, end: today(), keyword: '', warehouseId: '', category: '', unit: '', org: '', type: '', doc: '', upstream: '', upstreamType: '', reason: '', adjustment: '', counterparty: '', target: '', conversion: '', stagnantDays: '30' })
type Filters = ReturnType<typeof initialFilters>
function Reports() {
  const router = useRouter(); const params = useSearchParams(); const requested = params.get('report') || 'realtime'
  const id = inventoryReports.some(r => r.id === requested) ? requested : ''
  const [opened, setOpened] = useState<string[]>([])
  const [filters, setFilters] = useState(initialFilters); const [applied, setApplied] = useState(initialFilters)
  const [ranges, setRanges] = useState<Record<string, { min?: number; max?: number }>>({}); const [appliedRanges, setAppliedRanges] = useState<typeof ranges>({})
  const [result, setResult] = useState<Result | null>(null); const [error, setError] = useState(''); const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1); const [pageSize, setPageSize] = useState(20); const [sort, setSort] = useState(''); const [direction, setDirection] = useState('asc'); const [refresh, setRefresh] = useState(0)
  const [advanced, setAdvanced] = useState(false); const [columnDialog, setColumnDialog] = useState(false); const [hidden, setHidden] = useState<string[]>([])
  const [compact, setCompact] = useState(false); const [focused, setFocused] = useState(false); const [exporting, setExporting] = useState(false)
  const requestSerial = useRef(0)
  useEffect(() => {
    if (id) setOpened(old => old.includes(id) ? old : [...old, id])
    setFilters(initialFilters()); setApplied(initialFilters()); setRanges({}); setAppliedRanges({}); setPage(1); setSort(''); setHidden([]); setResult(null)
  }, [id])
  const query = new URLSearchParams({ ...applied, ranges: JSON.stringify(appliedRanges), page: String(page), pageSize: String(pageSize), sort, direction }).toString()
  useEffect(() => {
    const serial = ++requestSerial.current
    if (!id) { setResult(null); setLoading(false); return }
    setLoading(true); setError('')
    apiFetch<Result>(`/api/inventory-reports/${id}?${query}`).then(data => { if (requestSerial.current === serial) setResult(data) }).catch(e => { if (requestSerial.current === serial) { setError(e.message); setResult(null) } }).finally(() => { if (requestSerial.current === serial) setLoading(false) })
    return () => { requestSerial.current++ }
  }, [id, query, refresh])
  useEffect(() => { const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') { setFocused(false); setColumnDialog(false) } }; document.addEventListener('keydown', escape); return () => document.removeEventListener('keydown', escape) }, [])
  function closeTab(closed: string) { const index = opened.indexOf(closed); const rest = opened.filter(r => r !== closed); setOpened(rest); if (closed === id) router.push(`/v2/supply-chain/reports?report=${rest[index] || rest[index - 1] || 'none'}`) }
  function apply() { setApplied({ ...filters }); setAppliedRanges({ ...ranges }); setPage(1); setRefresh(n => n + 1) }
  async function download() {
    setExporting(true); setError('')
    try { const file = await apiFetch<{ filename: string; fileBase64: string }>(`/api/inventory-reports/${id}?${query}&export=1`); const bytes = Uint8Array.from(atob(file.fileBase64), c => c.charCodeAt(0)); const url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })); const a = document.createElement('a'); a.href = url; a.download = file.filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000) } catch (e: any) { setError(e.message) } finally { setExporting(false) }
  }
  const input = (key: keyof Filters, label: string, type = 'text') => <label key={key}>{label}<input type={type} value={filters[key]} onChange={e => setFilters(f => ({ ...f, [key]: e.target.value }))} placeholder={type === 'text' ? '全部 / 输入查询' : undefined} /></label>
  const columns = result?.columns.filter(c => !hidden.includes(c.key)) || []
  const groups: { name: string; span: number }[] = []
  columns.forEach(c => { const name = c.group || ''; const last = groups[groups.length - 1]; if (last?.name === name) last.span++; else groups.push({ name, span: 1 }) })
  const transfer = id.startsWith('transfer')
  const currentStock = ['realtime', 'stagnant', 'alerts'].includes(id)
  return <div className={`${styles.reports} ${compact ? styles.compact : ''} ${focused ? styles.focused : ''}`}>
    <header className={styles.top}><span>货品与仓库 / <strong>库存报表</strong></span><span>业务数据</span></header>
    <nav className={styles.tabs} aria-label="已打开报表">{opened.map(key => <div key={key} className={key === id ? styles.active : ''}><Link href={`/v2/supply-chain/reports?report=${key}`}>{inventoryReports.find(r => r.id === key)?.title}</Link><button aria-label={`关闭${inventoryReports.find(r => r.id === key)?.title}`} onClick={() => closeTab(key)}>×</button></div>)}</nav>
    <section className={styles.content}>
      <div className={styles.heading}><div><small>库存报表</small><h1>{inventoryReports.find(r => r.id === id)?.title || '暂无打开的报表'}</h1></div><div className={styles.actions}><select aria-label="切换报表" value={id} onChange={e => router.push(`/v2/supply-chain/reports?report=${e.target.value}`)}><option value="" disabled>选择报表</option>{inventoryReports.map(r => <option key={r.id} value={r.id}>{r.title}</option>)}</select><button onClick={() => setFocused(v => !v)}>{focused ? '退出专注' : '专注表格'}</button><button className={styles.primary} disabled={!id || loading || exporting || !result} onClick={download}>{exporting ? '正在导出…' : '导出 Excel'}</button></div></div>
      {!id ? <p>从“库存报表”菜单选择一张报表，继续查看。</p> : <>
        <form className={styles.card} onSubmit={e => { e.preventDefault(); apply() }}>
          <div className={styles.filters}>
            {transfer ? <>{input('org', '调出门店')}{input('target', '调入门店')}</> : <><label>仓库<select value={filters.warehouseId} onChange={e => setFilters(f => ({ ...f, warehouseId: e.target.value }))}><option value="">全部仓库</option>{result?.warehouses.map(w => <option key={w.id} value={w.id}>{w.name}{w.isDefault ? '（默认）' : ''}</option>)}</select></label></>}
            {input('keyword', '物品名称 / 编码')}{currentStock && input('category', '物品类别')}{id === 'stagnant' && input('stagnantDays', '呆滞天数阈值', 'number')}
            {!currentStock && <>{input('start', transfer ? '调拨开始日期' : '开始日期', 'date')}{input('end', '结束日期', 'date')}</>}

          </div>
          {advanced && <div className={`${styles.filters} ${styles.advancedFilters}`}>{!transfer && <label>机构名称<input value="总部" readOnly /></label>}{!currentStock && input('category', '物品类别')}            {['movements', 'summary', 'other-summary'].includes(id) && <label>出入库类型<select value={filters.type} onChange={e => setFilters(f => ({ ...f, type: e.target.value }))}>{['', '期初建账', '手工入库', '采购入库', '出库', '库存调整', '报损', '冲销'].map(v => <option key={v} value={v}>{v || '全部'}</option>)}</select></label>}
            {['movements', 'transfer-detail'].includes(id) && input('doc', '单据号')}{input('unit', '单位')}{id === 'realtime' && input('conversion', '与基准单位的换算率')}{id === 'other-summary' && input('reason', '原因类型')}{id === 'movements' && <>{input('upstream', '上游单据号')}{input('upstreamType', '上游单据类型')}{input('reason', '原因类型')}{input('counterparty', '对方机构')}<label>调整单标识<select value={filters.adjustment} onChange={e => setFilters(f => ({ ...f, adjustment: e.target.value }))}><option value="">全部</option><option>是</option><option>否</option></select></label></>}{result?.columns.filter(c => c.kind === 'number' && c.key !== 'seq').map(c => <label key={c.key}>{c.group} {c.label}<span className={styles.range}><input aria-label={`${c.group || ''}${c.label}最小值`} type="number" step="any" placeholder="最小值" value={ranges[c.key]?.min ?? ''} onChange={e => setRanges(r => ({ ...r, [c.key]: { ...r[c.key], min: e.target.value === '' ? undefined : Number(e.target.value) } }))} /><input aria-label={`${c.group || ''}${c.label}最大值`} type="number" step="any" placeholder="最大值" value={ranges[c.key]?.max ?? ''} onChange={e => setRanges(r => ({ ...r, [c.key]: { ...r[c.key], max: e.target.value === '' ? undefined : Number(e.target.value) } }))} /></span></label>)}</div>}
          <div className={styles.filterFoot}><button type="button" onClick={() => setAdvanced(v => !v)}>{advanced ? '收起筛选' : '更多筛选'}</button><div><button type="button" onClick={() => { setFilters(initialFilters()); setApplied(initialFilters()); setRanges({}); setAppliedRanges({}); setPage(1); setRefresh(n => n + 1) }}>重置</button><button className={styles.primary}>查询</button></div></div>
        </form>
        {error && <div role="alert" className={styles.error}>{error}<button onClick={() => setRefresh(n => n + 1)}>重试</button></div>}
        <p className={styles.note} title={result?.note}>{result?.note}</p>
        <div className={styles.results}><strong>报表明细 <small>共 {result?.total ?? 0} 条</small></strong><div><button onClick={() => setCompact(v => !v)}>{compact ? '标准行高' : '紧凑行高'}</button><button onClick={() => setColumnDialog(true)}>列设置</button></div></div>
        <div className={styles.tableCard} aria-busy={loading}><div className={styles.scroll}><table><thead>{groups.some(g => g.name) && <tr>{groups.map((g, i) => <th key={i} colSpan={g.span}>{g.name}</th>)}</tr>}<tr>{columns.map(c => <th key={c.key}><button disabled={c.key === 'seq'} onClick={() => { setSort(c.key); setDirection(sort === c.key && direction === 'asc' ? 'desc' : 'asc'); setPage(1) }}>{c.label} {sort === c.key ? direction === 'asc' ? '↑' : '↓' : ''}</button></th>)}</tr></thead><tbody>{loading ? <tr><td colSpan={columns.length || 1}>正在查询…</td></tr> : result?.rows.length ? result.rows.map((r, i) => <tr key={i}>{columns.map(c => <td key={c.key} className={c.kind === 'number' ? styles.numeric : ''}>{r[c.key] == null ? '—' : c.kind === 'number' ? Number(r[c.key]).toLocaleString('zh-CN', { maximumFractionDigits: 6 }) : r[c.key]}</td>)}</tr>) : <tr><td colSpan={columns.length || 1}>{error ? '查询失败，请重试' : '没有符合条件的记录'}</td></tr>}</tbody></table></div>
          <div className={styles.pagination}><span>共 {result?.total ?? 0} 条</span><div><select aria-label="每页条数" value={pageSize} onChange={e => { setPageSize(Number(e.target.value)); setPage(1) }}>{[10, 20, 50, 100].map(n => <option key={n} value={n}>{n} 条 / 页</option>)}</select><button disabled={loading || (result?.page || 1) <= 1} onClick={() => setPage((result?.page || 1) - 1)}>上一页</button><span>{result?.page || 1} / {Math.max(1, Math.ceil((result?.total || 0) / pageSize))}</span><button disabled={loading || (result?.page || 1) * pageSize >= (result?.total || 0)} onClick={() => setPage((result?.page || 1) + 1)}>下一页</button></div></div>
        </div>
      </>}
    </section>
    {columnDialog && <div className={styles.overlay} onClick={() => setColumnDialog(false)}><section role="dialog" aria-modal="true" aria-label="显示列" className={styles.dialog} onClick={e => e.stopPropagation()}><h2>显示列</h2><div>{result?.columns.map(c => <label key={c.key}><input type="checkbox" checked={!hidden.includes(c.key)} disabled={['seq', 'name', 'code'].includes(c.key)} onChange={e => setHidden(old => e.target.checked ? old.filter(k => k !== c.key) : [...old, c.key])} />{c.group} {c.label}</label>)}</div><button onClick={() => setHidden([])}>恢复全部列</button><button className={styles.primary} onClick={() => setColumnDialog(false)}>完成</button></section></div>}
  </div>
}
export default function InventoryReportsPage() { return <Suspense fallback={<p>正在加载报表…</p>}><Reports /></Suspense> }
