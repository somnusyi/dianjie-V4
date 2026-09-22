'use client'
import Link from 'next/link'
import { Suspense, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import styles from '../reports/reports.module.css'
import local from './preview.module.css'
import { financeReports, defaultFinanceFilters, selectPreviewRows, previewDetails, type FinanceColumn, type FinanceFilters } from './preview-data'

const href = (id: string) => `/v2/supply-chain/finance-reports?report=${id}`
function FinancePreview() {
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
  const [compact, setCompact] = useState(false); const [focused, setFocused] = useState(false)
  const [notice, setNotice] = useState(''); const [exporting, setExporting] = useState(false)
  useEffect(() => {
    if (financeReports.some(r => r.id === id)) setOpened(old => old.includes(id) ? old : [...old, id])
    setFilters(defaultFinanceFilters()); setApplied(defaultFinanceFilters()); setRanges({}); setAppliedRanges({}); setPage(1); setSort(''); setHidden([]); setAdvanced(false); setNotice(''); setColumnDialog(false)
  }, [id])
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setFocused(false); setColumnDialog(false) } }
    document.addEventListener('keydown', escape); return () => document.removeEventListener('keydown', escape)
  }, [])
  const rows = useMemo(() => selectPreviewRows(id, applied).filter(row => Object.entries(appliedRanges).every(([key, range]) => row[key] != null && (range.min == null || Number(row[key]) >= range.min) && (range.max == null || Number(row[key]) <= range.max))).sort((a, b) => {
    const av = a[sort], bv = b[sort]
    if (!sort) return 0
    if (av == null) return bv == null ? 0 : 1
    if (bv == null) return -1
    return (typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv), 'zh-CN', { numeric: true })) * (descending ? -1 : 1)
  }), [id, applied, appliedRanges, sort, descending])
  const columns: FinanceColumn[] = (report?.columns || []).filter(c => !hidden.includes(c.key))
  const numericColumns = (report?.columns || []).filter(c => 'kind' in c) as FinanceColumn[]
  const totalPages = Math.max(1, Math.ceil(rows.length / size)); const currentPage = Math.min(page, totalPages)
  const view = rows.slice((currentPage - 1) * size, currentPage * size)
  function closeTab(key: string) {
    const index = opened.indexOf(key); const rest = opened.filter(r => r !== key); setOpened(rest)
    if (key === id) router.push(href(rest[index] || rest[index - 1] || 'none'))
  }
  function apply() {
    if (filters.start && filters.end && filters.start > filters.end) return setNotice('开始日期不能晚于结束日期')
    if (Object.values(ranges).some(r => r.min != null && r.max != null && r.min > r.max)) return setNotice('最小值不能大于最大值')
    setApplied({ ...filters }); setAppliedRanges({ ...ranges }); setPage(1); setNotice('')
  }
  function reset() { setFilters(defaultFinanceFilters()); setApplied(defaultFinanceFilters()); setRanges({}); setAppliedRanges({}); setPage(1); setNotice('') }
  const input = (key: keyof FinanceFilters, label: string, type = 'text') => <label key={key}>{label}<input type={type} value={filters[key]} onChange={e => setFilters(f => ({ ...f, [key]: e.target.value }))} placeholder={type === 'text' ? '输入查询' : undefined} /></label>
  const select = (key: keyof FinanceFilters, label: string) => <label key={key}>{label}<select value={filters[key]} onChange={e => setFilters(f => ({ ...f, [key]: e.target.value }))}><option value="">全部</option>{[...new Set(previewDetails.map(r => String(r[key])))].map(v => <option key={v}>{v}</option>)}</select></label>
  const format = (value: string | number | null, column: FinanceColumn) => value == null ? '—' : column.kind === 'percent' ? `${(Number(value) * 100).toFixed(2)}%` : column.kind ? Number(value).toLocaleString('zh-CN', { minimumFractionDigits: column.kind === 'money' ? 2 : 0, maximumFractionDigits: column.kind === 'money' ? 2 : 3 }) : value
  async function download() {
    if (!report) return
    setExporting(true)
    try {
      const XLSX = await import('xlsx')
      const worksheet = XLSX.utils.aoa_to_sheet([report.columns.map(c => c.label), ...rows.map(row => report.columns.map(c => row[c.key] ?? null))])
      worksheet['!cols'] = report.columns.map(c => ({ wch: c.key === 'document' ? 26 : 20 }))
      report.columns.forEach((c, col) => { if (!('kind' in c)) return; rows.forEach((_, row) => { const cell = worksheet[XLSX.utils.encode_cell({ r: row + 1, c: col })]; if (cell) cell.z = c.kind === 'percent' ? '0.00%' : c.kind === 'money' ? '#,##0.00' : '#,##0.###' }) })
      const workbook = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(workbook, worksheet, report.title)
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['UI 预览：所有记录均为人工构造示例，未连接财务接口或数据库。'], [report.note], ['筛选条件', JSON.stringify(applied)]]), '示例说明')
      XLSX.writeFile(workbook, `${report.title}-UI示例.xlsx`)
      setNotice('已导出当前查询的全部示例记录，非真实财务数据。')
    } catch { setNotice('示例导出失败，请重试') } finally { setExporting(false) }
  }
  return <div className={`${styles.reports} ${local.preview} ${compact ? styles.compact : ''} ${focused ? styles.focused : ''}`}>
    <header className={styles.top}><span>核算与分析 / <strong>财务报表</strong></span><span className={local.badge}>UI 预览 · 示例数据 · 未连接后端</span></header>
    <nav className={styles.tabs} aria-label="已打开财务报表">{opened.map(key => <div key={key} className={key === id ? styles.active : ''}><Link href={href(key)}>{financeReports.find(r => r.id === key)?.title}</Link><button aria-label={`关闭${financeReports.find(r => r.id === key)?.title}`} onClick={() => closeTab(key)}>×</button></div>)}</nav>
    <section className={styles.content}>
      <div className={styles.heading}><h1>{report?.title || '暂无打开的财务报表'}</h1><div className={styles.actions}><select aria-label="切换财务报表" value={report ? id : ''} onChange={e => router.push(href(e.target.value))}><option value="" disabled>选择报表</option>{financeReports.map(r => <option key={r.id} value={r.id}>{r.title}</option>)}</select><button onClick={() => setFocused(v => !v)}>{focused ? '退出专注' : '专注表格'}</button><button disabled={!report || exporting} className={styles.primary} onClick={download}>{exporting ? '正在导出…' : '导出示例 Excel'}</button></div></div>
      {!report ? <p>从“财务报表”菜单选择一张表，继续预览。</p> : <>
        <form className={styles.card} onSubmit={e => { e.preventDefault(); apply() }}>
          <div className={styles.filters}>
            {id === 'group-profit' ? <>{select('customer', '客户名称')}{select('center', '配送中心')}</> : <>{input('keyword', id === 'profit-detail' ? '名称 / 编码' : '物品 / 编码')}{id === 'profit-detail' ? input('document', '单据号') : select('customer', '客户名称')}</>}
            {input('start', '开始日期', 'date')}{input('end', '结束日期', 'date')}
          </div>
          {advanced && <div className={`${styles.filters} ${styles.advancedFilters}`}>
            {id === 'item-profit' && <>{select('warehouse', '仓库')}{select('category', '类别名称')}{select('unit', '单位')}</>}
            {id === 'profit-detail' && select('source', '出入库相关项')}
            {numericColumns.map(c => <label key={c.key}>{c.label}{c.kind === 'percent' ? '（%）' : ''}<span className={styles.range}>{(['min', 'max'] as const).map(side => <input key={side} aria-label={`${c.label}${side === 'min' ? '最小值' : '最大值'}`} type="number" step="any" placeholder={side === 'min' ? '最小值' : '最大值'} value={ranges[c.key]?.[side] == null ? '' : Number(ranges[c.key]?.[side]) * (c.kind === 'percent' ? 100 : 1)} onChange={e => setRanges(r => ({ ...r, [c.key]: { ...r[c.key], [side]: e.target.value === '' ? undefined : Number(e.target.value) / (c.kind === 'percent' ? 100 : 1) } }))} />)}</span></label>)}
          </div>}
          <div className={styles.filterFoot}><button type="button" onClick={() => setAdvanced(v => !v)} aria-expanded={advanced}>{advanced ? '收起筛选' : '更多筛选'}</button><div><button type="button" onClick={reset}>重置</button><button className={styles.primary}>查询</button></div></div>
        </form>
        {notice && <p role="status" className={local.notice}>{notice}</p>}
        <p className={styles.note} title={report.note}>示例数据 · {report.note}</p>
        <div className={styles.results}><strong>报表明细 <small>共 {rows.length} 条</small></strong><div><button onClick={() => setCompact(v => !v)}>{compact ? '标准行高' : '紧凑行高'}</button><button onClick={() => setColumnDialog(true)}>列设置</button></div></div>
        <div className={styles.tableCard}><div className={styles.scroll}><table><thead><tr>{columns.map(c => <th key={c.key}><button onClick={() => { setSort(c.key); setDescending(sort === c.key ? !descending : false); setPage(1) }}>{c.label}{sort === c.key ? descending ? ' ↓' : ' ↑' : ''}</button></th>)}</tr></thead><tbody>{view.length ? view.map(row => <tr key={String(row.id)}>{columns.map(c => <td key={c.key} className={`${c.kind ? styles.numeric : ''} ${typeof row[c.key] === 'number' && Number(row[c.key]) < 0 ? local.negative : ''}`}>{format(row[c.key], c)}</td>)}</tr>) : <tr><td colSpan={columns.length} className={local.empty}>没有符合条件的示例记录</td></tr>}</tbody></table></div>
          <div className={styles.pagination}><span>共 {rows.length} 条 · 示例数据</span><div><select aria-label="每页条数" value={size} onChange={e => { setSize(Number(e.target.value)); setPage(1) }}>{[10, 20, 50].map(n => <option key={n} value={n}>{n} 条 / 页</option>)}</select><button disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>上一页</button><span>{currentPage} / {totalPages}</span><button disabled={currentPage >= totalPages} onClick={() => setPage(currentPage + 1)}>下一页</button></div></div>
        </div>
      </>}
    </section>
    {columnDialog && <div className={styles.overlay} onClick={() => setColumnDialog(false)}><section className={styles.dialog} role="dialog" aria-modal="true" aria-label="财务报表显示列" onClick={e => e.stopPropagation()}><h2>显示列</h2><div>{report?.columns.map((c, i) => <label key={c.key}><input type="checkbox" checked={!hidden.includes(c.key)} disabled={i === 0} onChange={e => setHidden(old => e.target.checked ? old.filter(k => k !== c.key) : [...old, c.key])} />{c.label}</label>)}</div><button onClick={() => setHidden([])}>恢复全部列</button><button className={styles.primary} onClick={() => setColumnDialog(false)}>完成</button></section></div>}
  </div>
}
export default function FinanceReportsPreviewPage() { return <Suspense fallback={<p>正在加载财务报表预览…</p>}><FinancePreview /></Suspense> }
