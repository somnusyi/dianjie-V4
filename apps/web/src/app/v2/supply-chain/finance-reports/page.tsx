'use client'
import Link from 'next/link'
import { FilterDateRange } from '@/components/v2/filter-date-range'
import filterStyles from '@/components/v2/scm-filter-bar.module.css'
import { Suspense, useEffect, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import styles from '../reports/reports.module.css'
import local from './preview.module.css'
import { apiFetch } from '@/lib/v2-auth'
import { financeReports, defaultFinanceFilters, type FinanceRow, type FinanceColumn, type FinanceFilters } from './report-definitions'
type Result = { id: string; columns: FinanceColumn[]; rows: FinanceRow[]; total: number; page: number; note: string; warnings: string[]; options: Record<string, string[]> }

const href = (id: string) => `/v2/supply-chain/finance-reports?report=${id}`
function FinanceReports() {
  const router = useRouter(); const search = useSearchParams()
  const id = search.get('report') || 'group-profit'
  const report = financeReports.find(r => r.id === id)
  const [opened, setOpened] = useState<string[]>([])
  const [filters, setFilters] = useState(defaultFinanceFilters)
  const [applied, setApplied] = useState(defaultFinanceFilters)
  const [advanced, setAdvanced] = useState(false)
  const [ranges, setRanges] = useState<Record<string, { min?: number; max?: number }>>({})
  const [appliedRanges, setAppliedRanges] = useState<typeof ranges>({})
  const [page, setPage] = useState(1); const [size, setSize] = useState(20)
  const [sort, setSort] = useState(''); const [descending, setDescending] = useState(false)
  const [hidden, setHidden] = useState<string[]>([]); const [columnDialog, setColumnDialog] = useState(false)
  const [focused, setFocused] = useState(false)
  const [notice, setNotice] = useState(''); const [exporting, setExporting] = useState(false)
  useEffect(() => {
    if (financeReports.some(r => r.id === id)) setOpened(old => old.includes(id) ? old : [...old, id])
    setFilters(defaultFinanceFilters()); setApplied(defaultFinanceFilters()); setRanges({}); setAppliedRanges({}); setPage(1); setSort(''); setHidden([]); setAdvanced(false); setNotice(''); setColumnDialog(false)
  }, [id])
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setFocused(false); setColumnDialog(false) } }
    document.addEventListener('keydown', escape); return () => document.removeEventListener('keydown', escape)
  }, [])
  const [result, setResult] = useState<Result | null>(null)
  const [loading, setLoading] = useState(false); const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0); const serial = useRef(0)
  const query = new URLSearchParams({ ...applied, ranges: JSON.stringify(appliedRanges), page: String(page), pageSize: String(size), sort, direction: descending ? 'desc' : 'asc' }).toString()
  useEffect(() => {
    const request = ++serial.current
    setResult(null); setError('')
    if (!report) { setLoading(false); return }
    setLoading(true)
    apiFetch<Result>(`/api/supply-chain/finance-reports/${id}?${query}`)
      .then(data => { if (serial.current === request) setResult(data) })
      .catch(e => { if (serial.current === request) setError(e.message || '查询失败') })
      .finally(() => { if (serial.current === request) setLoading(false) })
    return () => { serial.current++ }
  }, [id, query, refresh, report])
  const rows = result?.id === id ? result.rows : []
  const total = result?.id === id ? result.total : 0
  const columns: FinanceColumn[] = (result?.columns || []).filter(c => !hidden.includes(c.key))
  const numericColumns = (result?.columns || []).filter(c => c.kind && c.key !== 'seq') as FinanceColumn[]
  const totalPages = Math.max(1, Math.ceil(total / size)); const currentPage = result?.page || 1
  const view = rows
  function closeTab(key: string) {
    const index = opened.indexOf(key); const rest = opened.filter(r => r !== key); setOpened(rest)
    if (key === id) router.push(href(rest[index] || rest[index - 1] || 'none'))
  }
  function apply() {
    if (filters.start && filters.end && filters.start > filters.end) return setNotice('开始日期不能晚于结束日期')
    if (Object.values(ranges).some(r => r.min != null && r.max != null && r.min > r.max)) return setNotice('最小值不能大于最大值')
    setApplied({ ...filters }); setAppliedRanges({ ...ranges }); setPage(1); setNotice(''); setRefresh(n => n + 1)
  }
  function reset() { setFilters(defaultFinanceFilters()); setApplied(defaultFinanceFilters()); setRanges({}); setAppliedRanges({}); setPage(1); setNotice(''); setRefresh(n => n + 1) }
  const input = (key: keyof FinanceFilters, label: string, type = 'text') => <label key={key}><span>{label}：</span><input type={type} value={filters[key]} onChange={e => setFilters(f => ({ ...f, [key]: e.target.value }))} placeholder={type === 'text' ? '输入查询' : undefined} /></label>
  const select = (key: keyof FinanceFilters, label: string) => <label key={key}><span>{label}：</span><select value={filters[key]} onChange={e => setFilters(f => ({ ...f, [key]: e.target.value }))}><option value="">全部</option>{(result?.options[key] || (filters[key] ? [filters[key]] : [])).map(v => <option key={v}>{v}</option>)}</select></label>
  const format = (value: string | number | null, column: FinanceColumn) => value == null ? '—' : column.kind === 'percent' ? `${(Number(value) * 100).toFixed(2)}%` : column.kind ? Number(value).toLocaleString('zh-CN', { minimumFractionDigits: column.kind === 'money' ? 2 : 0, maximumFractionDigits: column.kind === 'money' ? 2 : 3 }) : value
  async function download() {
    if (!report) return
    setExporting(true)
    try {
      const file = await apiFetch<{ filename: string; fileBase64: string }>(`/api/supply-chain/finance-reports/${id}?${query}&export=1`)
      const bytes = Uint8Array.from(atob(file.fileBase64), c => c.charCodeAt(0))
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
      const a = document.createElement('a'); a.href = url; a.download = file.filename; a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      setNotice('已导出当前查询的全部记录。')
    } catch (e: any) { setNotice(e.message || '导出失败，请重试') } finally { setExporting(false) }
  }
  return <div className={`${styles.reports} ${local.preview} ${focused ? styles.focused : ''}`}>
    <header className={styles.top}><span>核算与分析 / <strong>财务报表</strong></span><span className={local.badge}>业务数据 · 总部配送毛利</span></header>
    <div className={filterStyles.mobileMenu}><details><summary>财务报表菜单</summary><nav aria-label="财务报表功能菜单">{financeReports.map(r => <Link key={r.id} href={`/v2/supply-chain/finance-reports?report=${r.id}`}>{r.title}</Link>)}</nav></details></div>
    <nav className={styles.tabs} aria-label="已打开财务报表">{opened.map(key => <div key={key} className={key === id ? styles.active : ''}><Link href={href(key)}>{financeReports.find(r => r.id === key)?.title}</Link><button aria-label={`关闭${financeReports.find(r => r.id === key)?.title}`} onClick={() => closeTab(key)}>×</button></div>)}</nav>
    <section className={styles.content}>
      <div className={styles.heading}><h1>{report?.title || '暂无打开的财务报表'}</h1><div className={styles.actions}><button onClick={() => setFocused(v => !v)}>{focused ? '退出专注' : '专注表格'}</button><button disabled={!report || loading || !result} onClick={() => setColumnDialog(true)}>表格设置</button></div></div>
      {!report ? <p>从“财务报表”菜单选择一张表，继续查看。</p> : <>
        <form className={filterStyles.bar} onSubmit={e => { e.preventDefault(); apply() }}>
          <div className={filterStyles.fields}>
            <div className={filterStyles.date}><span className={filterStyles.dateLabel}>日期范围：</span><FilterDateRange value={{ start: filters.start, end: filters.end }} onChange={range => setFilters(f => ({ ...f, ...range }))} /></div>
            {id === 'group-profit' ? <>{select('customer', '客户名称')}{select('center', '配送中心名称')}</> : <>{input('keyword', id === 'profit-detail' ? '客户 / 物品 / 编码' : '物品 / 编码')}{id === 'profit-detail' ? input('document', '单据号') : select('customer', '客户名称')}</>}

          </div>
          {advanced && <div className={`${filterStyles.fields} ${filterStyles.advanced}`}>
            {id === 'item-profit' && <>{select('warehouse', '仓库')}{select('category', '类别名称')}{select('unit', '单位')}</>}
            {id === 'profit-detail' && select('source', '单据类型')}
            {numericColumns.map(c => <label key={c.key}>{c.label}{c.kind === 'percent' ? '（%）' : ''}<span className={filterStyles.range}>{(['min', 'max'] as const).map(side => <input key={side} aria-label={`${c.label}${side === 'min' ? '最小值' : '最大值'}`} type="number" step="any" placeholder={side === 'min' ? '最小值' : '最大值'} value={ranges[c.key]?.[side] == null ? '' : Number(ranges[c.key]?.[side]) * (c.kind === 'percent' ? 100 : 1)} onChange={e => setRanges(r => ({ ...r, [c.key]: { ...r[c.key], [side]: e.target.value === '' ? undefined : Number(e.target.value) / (c.kind === 'percent' ? 100 : 1) } }))} />)}</span></label>)}
          </div>}
          <div className={filterStyles.buttons}><button type="button" className={filterStyles.expand} onClick={() => setAdvanced(v => !v)} aria-expanded={advanced}>{advanced ? '收起筛选 ∧' : '展开筛选 ∨'}</button><button className={filterStyles.primary}>查询</button><button type="button" onClick={reset}>重置</button></div>
        </form>
        {notice && <p role="status" className={local.notice}>{notice}</p>}
        {error && <p role="alert" className={styles.error}>{error}<button onClick={() => setRefresh(n => n + 1)}>重试</button></p>}
        {result?.warnings.map(w => <p role="status" className={local.notice} key={w}>{w}</p>)}
        <p className={styles.note} title={result?.note || report.note}>{result?.note || report.note}</p>
        <div className={styles.results}><div><button disabled={!report || exporting || loading || !result} onClick={download}>{exporting ? '正在导出…' : '导出列表'}</button></div><span className={styles.resultCount}>共 {total} 条</span></div>
        <div className={styles.tableCard} aria-busy={loading}><div className={styles.scroll}><table><thead><tr>{columns.map(c => <th key={c.key}><button disabled={c.key === 'seq'} onClick={() => { setSort(c.key); setDescending(sort === c.key ? !descending : false); setPage(1) }}>{c.label}{sort === c.key ? descending ? ' ↓' : ' ↑' : ''}</button></th>)}</tr></thead><tbody>{loading ? <tr><td colSpan={columns.length}>正在查询…</td></tr> : view.length ? view.map(row => <tr key={String(row.id)}>{columns.map(c => <td key={c.key} className={`${c.kind ? styles.numeric : ''} ${typeof row[c.key] === 'number' && Number(row[c.key]) < 0 ? local.negative : ''}`}>{format(row[c.key], c)}</td>)}</tr>) : <tr><td colSpan={columns.length} className={local.empty}>{error ? '查询失败，请重试' : '没有符合条件的记录'}</td></tr>}</tbody></table></div>
          <div className={styles.pagination}><span>共 {total} 条</span><div><select aria-label="每页条数" value={size} onChange={e => { setSize(Number(e.target.value)); setPage(1) }}>{[10, 20, 50].map(n => <option key={n} value={n}>{n} 条 / 页</option>)}</select><button disabled={loading || currentPage <= 1} onClick={() => setPage(currentPage - 1)}>上一页</button><span>{currentPage} / {totalPages}</span><button disabled={loading || currentPage >= totalPages} onClick={() => setPage(currentPage + 1)}>下一页</button></div></div>
        </div>
      </>}
    </section>
    {columnDialog && <div className={styles.overlay} onClick={() => setColumnDialog(false)}><section className={styles.dialog} role="dialog" aria-modal="true" aria-label="财务报表表格设置" onClick={e => e.stopPropagation()}><h2>表格设置</h2><div>{result?.columns.map((c, i) => <label key={c.key}><input type="checkbox" checked={!hidden.includes(c.key)} disabled={i === 0} onChange={e => setHidden(old => e.target.checked ? old.filter(k => k !== c.key) : [...old, c.key])} />{c.label}</label>)}</div><button onClick={() => setHidden([])}>恢复全部列</button><button className={styles.primary} onClick={() => setColumnDialog(false)}>完成</button></section></div>}
  </div>
}
export default function FinanceReportsPage() { return <Suspense fallback={<p>正在加载财务报表…</p>}><FinanceReports /></Suspense> }
