'use client'
import Link from 'next/link'
import { ManagementTabs } from './management-tabs'
import { FilterDateRange } from './filter-date-range'
import filters from './scm-filter-bar.module.css'
import { useEffect, useRef, useState } from 'react'
import { apiFetch } from '@/lib/v2-auth'
import { managementPages, managementHref, managementGroupLabel, type ManagementGroup, type ManagementPage, type ManagementResult, type ManagementRow } from '@/lib/inventory-management'
import styles from './management-workspace.module.css'

const shanghaiDay = (value: Date) => new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(value)
const initial = (withDate: boolean) => {
  if (!withDate) return { start: '', end: '', dateField: 'date', filters: {} as Record<string, string> }
  const end = shanghaiDay(new Date())
  const startDate = new Date(`${end}T00:00:00+08:00`)
  startDate.setUTCDate(startDate.getUTCDate() - 59)
  return { start: shanghaiDay(startDate), end, dateField: 'date', filters: {} as Record<string, string> }
}
const selects = new Set(['org', 'warehouse', 'supplier', 'status', 'review', 'printed', 'difference', 'generated', 'reconciliation', 'invoice', 'stockStatus', 'category', 'countType', 'reason', 'supplierAccount'])
const knownOptions: Record<string, string[]> = { printed: ['未打印', '已打印'], generated: ['是', '否'], difference: ['未盘完', '有差异', '无差异'] }
const display = (value: string | number | null | undefined, kind: string) => value == null || value === '' ? '—' : kind === 'number' ? Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 6 }) : value

export function ManagementWorkspace({ config }: { config: ManagementPage }) {
  const defaults = () => initial(Boolean(config.dateLabel))
  const [draft, setDraft] = useState(defaults); const [applied, setApplied] = useState(defaults)
  const [result, setResult] = useState<ManagementResult | null>(null); const [error, setError] = useState('')
  const [loading, setLoading] = useState(true); const [exporting, setExporting] = useState(false)
  const [page, setPage] = useState(1); const [pageSize, setPageSize] = useState(20); const [refresh, setRefresh] = useState(0)
  const [advanced, setAdvanced] = useState(false); const [selected, setSelected] = useState<string[]>([])
  const [hidden, setHidden] = useState<string[]>([]); const [focused, setFocused] = useState(false)
  const [dialog, setDialog] = useState<'columns' | ManagementRow | null>(null)
  const dialogRef = useRef<HTMLDialogElement>(null); const firstDialogButton = useRef<HTMLButtonElement>(null)
  const query = new URLSearchParams({ start: applied.start, end: applied.end, dateField: applied.dateField, filters: JSON.stringify(applied.filters), page: String(page), pageSize: String(pageSize) }).toString()
  useEffect(() => {
    let current = true
    setLoading(true); setError(''); setSelected([]); setResult(null)
    apiFetch<ManagementResult>(`/api/inventory-management/${config.id}?${query}`)
      .then(data => { if (current) setResult(data) })
      .catch(e => { if (current) setError(e.message || '查询失败') })
      .finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [config.id, query, refresh])
  useEffect(() => {
    if (dialog) { dialogRef.current?.showModal(); firstDialogButton.current?.focus() }
    else dialogRef.current?.close()
  }, [dialog])
  useEffect(() => {
    if (!focused) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && !dialog && !document.querySelector('[role="dialog"][aria-label="日期范围选择器"]')) setFocused(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [focused, dialog])
  const change = (key: string, value: string) => setDraft(d => ({ ...d, filters: { ...d.filters, [key]: value } }))
  function filter(field: { key: string; label: string }) {
    const disabled = !!result && !result.supportedFilters.includes(field.key)
    const options = result?.options[field.key]?.length ? result.options[field.key] : knownOptions[field.key] || []
    return <label className={styles.filter} key={field.key} title={disabled ? '当前业务尚未记录此字段' : undefined}>
      <span>{field.label}：</span>
      {field.key === 'priceAdjusted' ? <input type="checkbox" disabled={disabled} checked={draft.filters[field.key] === '是'} onChange={e => change(field.key, e.target.checked ? '是' : '')} /> : selects.has(field.key) ?
        <select disabled={disabled} value={draft.filters[field.key] || ''} onChange={e => change(field.key, e.target.value)}><option value="">{disabled ? '未记录' : '全部'}</option>{options.map(v => <option key={v}>{v}</option>)}</select> :
        <input disabled={disabled} value={draft.filters[field.key] || ''} onChange={e => change(field.key, e.target.value)} placeholder={disabled ? '未记录' : '请输入'} />}
    </label>
  }
  async function exportList() {
    setExporting(true); setError('')
    try {
      const file = await apiFetch<{ filename: string; fileBase64: string }>(`/api/inventory-management/${config.id}?${query}&export=1`)
      const url = URL.createObjectURL(new Blob([Uint8Array.from(atob(file.fileBase64), c => c.charCodeAt(0))], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
      const a = document.createElement('a'); a.href = url; a.download = file.filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (e: any) { setError(e.message || '导出失败') } finally { setExporting(false) }
  }
  async function exportSelected() {
    setExporting(true); setError('')
    try {
      const XLSX = await import('xlsx')
      const rows = result?.rows.filter(r => selected.includes(String(r.id))) || []
      const sheet = XLSX.utils.aoa_to_sheet([config.columns.map(c => c.label), ...rows.map(r => config.columns.map(c => r[c.key] ?? null))])
      const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, sheet, config.title); XLSX.writeFile(book, `${config.title}-所选记录.xlsx`)
    } catch { setError('导出所选记录失败，请重试') } finally { setExporting(false) }
  }
  const columns = config.columns.filter(c => !hidden.includes(c.key))
  const rows = result?.rows || []
  const group = config.group as ManagementGroup
  return <div className={`${styles.workspace} ${focused ? styles.focused : ''}`}>
    <header className={styles.breadcrumb}><span>货品与仓库 <span>/</span> <strong>{managementGroupLabel(group)}</strong></span><span>单据与库存</span></header>
    <div className={filters.mobileMenu}><details><summary>库存与盘点菜单</summary><nav aria-label="库存与盘点功能菜单">{managementPages.map(p => <Link key={p.id} href={managementHref(p)} aria-current={p.id === config.id ? 'page' : undefined}>{p.title}</Link>)}</nav></details></div>
    <ManagementTabs activeId={config.id} />
    <section className={styles.content}>
      <div className={styles.heading}><div><p>{managementGroupLabel(group)}</p><h1>{config.title}{['purchase-in', 'purchase-return', 'other-in', 'other-out'].includes(config.id) ? '单' : ''}</h1></div><div className={styles.actions}><button aria-pressed={focused} onClick={() => setFocused(v => !v)}>{focused ? '退出专注' : '专注表格'}</button><button onClick={() => setDialog('columns')}>表格设置</button></div></div>
      <form className={filters.bar} onSubmit={e => { e.preventDefault(); setApplied({ ...draft, filters: { ...draft.filters } }); setPage(1); setRefresh(n => n + 1) }}>
        <div className={filters.fields}>
          {config.dateLabel && <div className={filters.date}><div className={filters.segments} role="group" aria-label="日期类型">{[['date', config.dateLabel], ['createdAt', '创建时间']].map(([value, label]) => <label key={value}><input type="radio" name="dateField" value={value} checked={draft.dateField === value} onChange={() => setDraft(d => ({ ...d, dateField: value }))} /><span>{label}</span></label>)}</div><FilterDateRange value={{ start: draft.start, end: draft.end }} onChange={range => setDraft(d => ({ ...d, ...range }))} /></div>}
          {config.filters.map(filter)}
          {advanced && config.advanced.map(filter)}
        </div>
        <div className={filters.buttons}>{config.advanced.length > 0 && <button type="button" className={filters.expand} onClick={() => setAdvanced(v => !v)} aria-expanded={advanced}>{advanced ? '收起筛选 ∧' : '展开筛选 ∨'}</button>}<button className={filters.primary}>查询</button><button type="button" onClick={() => { const next = defaults(); setDraft(next); setApplied({ ...next, filters: {} }); setPage(1); setRefresh(n => n + 1) }}>重置</button></div>
      </form>
      {error && <div role="alert" className={styles.error}>{error}<button onClick={() => setRefresh(n => n + 1)}>重新查询</button></div>}
      {result?.note && <p className={styles.note} title={result.note}>{result.note}</p>}
      <div className={styles.toolbar}><div className={styles.actions}>
        {config.id === 'purchase-in' && <Link href="/v2/supply-chain/procurement" className={styles.primary}>采购作业 ↗</Link>}
        {['other-in', 'other-out', 'limits'].includes(config.id) && <Link href="/v2/supply-chain/inventory" className={styles.primary}>库存作业 ↗</Link>}
        {['other-in', 'other-out'].includes(config.id) && <Link href="/v2/supply-chain/docs">单据审核 ↗</Link>}
        <button disabled={loading || exporting || !result?.sourceAvailable} onClick={exportList}>{exporting ? '正在导出…' : '导出列表'}</button>
        {selected.length > 0 && <button disabled={exporting || loading} onClick={exportSelected}>导出所选（{selected.length}）</button>}
      </div>{config.id === 'limits' ? <label className={styles.unit}>计量单位类型 <select aria-label="计量单位类型" value="inventory" onChange={() => {}}><option value="inventory">库存单位</option></select></label> : <span className={styles.total}>共 {result?.total ?? '—'} 条</span>}</div>
      <div className={styles.tableCard} aria-busy={loading}>
        <div className={styles.scroll} tabIndex={0} role="region" aria-label={`${config.title}表格，可横向滚动`}><table>
          <thead><tr><th className={styles.check}><input type="checkbox" aria-label="选择本页全部记录" disabled={!rows.length || loading} checked={!!rows.length && selected.length === rows.length} ref={el => { if (el) el.indeterminate = selected.length > 0 && selected.length < rows.length }} onChange={e => setSelected(e.target.checked ? rows.map(r => String(r.id)) : [])} /></th>{columns.map(c => <th key={c.key} className={c.kind === 'number' ? styles.numeric : ''}>{c.label}</th>)}<th className={styles.operation}>操作</th></tr></thead>
          <tbody>{loading || !rows.length ? <tr><td colSpan={columns.length + 2}><div className={styles.empty}><span aria-hidden="true">▤</span><strong>{loading ? '正在查询…' : error ? '查询未完成' : result?.sourceAvailable === false ? '暂无可用单据来源' : '暂无符合条件的记录'}</strong><p>{!loading && (error ? '请重试后查看记录。' : result?.sourceAvailable === false ? result.note : '可以调整筛选条件后重新查询。')}</p></div></td></tr> : rows.map(row => <tr key={row.id} data-selected={selected.includes(String(row.id))}>
            <td className={styles.check}><input type="checkbox" aria-label={`选择${row.no || row.name}`} checked={selected.includes(String(row.id))} onChange={e => setSelected(old => e.target.checked ? [...old, String(row.id)] : old.filter(v => v !== String(row.id)))} /></td>
            {columns.map(c => <td key={c.key} className={c.kind === 'number' ? styles.numeric : ''} title={row[c.key] == null ? '尚未记录' : String(row[c.key])}>{c.key === 'no' ? <button className={styles.textButton} onClick={() => setDialog(row)}>{row[c.key]}</button> : ['status', 'review'].includes(c.key) && row[c.key] ? <span className={styles.badge}>{row[c.key]}</span> : display(row[c.key], c.kind)}</td>)}
            <td className={styles.operation}><button className={styles.textButton} onClick={() => setDialog(row)}>查看</button></td>
          </tr>)}</tbody>
          {!!result?.total && !!Object.keys(result.totals || {}).length && <tfoot><tr title="全部筛选结果合计"><td /><td>合计</td>{columns.slice(1).map(c => <td key={c.key} className={styles.numeric}>{result.totals?.[c.key] == null ? '' : display(result.totals[c.key], 'number')}</td>)}<td className={styles.operation} /></tr></tfoot>}
        </table></div>
        <footer className={styles.pagination}><span>已选 <strong>{selected.length}</strong> 条 <span className={styles.divider}>|</span> 共 {result?.total ?? '—'} 条</span><div className={styles.actions}><select aria-label="每页条数" value={pageSize} onChange={e => { setPageSize(Number(e.target.value)); setPage(1) }}>{[20, 50, 100].map(n => <option key={n} value={n}>{n} 条 / 页</option>)}</select><button aria-label="上一页" disabled={loading || !result || result.page <= 1} onClick={() => setPage((result?.page || 1) - 1)}>‹</button><span>{result?.page || 1} / {Math.max(1, Math.ceil((result?.total || 0) / pageSize))}</span><button aria-label="下一页" disabled={loading || !result || result.page * pageSize >= result.total} onClick={() => setPage((result?.page || 1) + 1)}>›</button></div></footer>
      </div>
    </section>
    <dialog ref={dialogRef} className={styles.dialog} onClose={() => setDialog(null)} aria-label={dialog === 'columns' ? '表格设置' : '记录信息'}>
      <header><h2>{dialog === 'columns' ? '表格设置' : '记录信息'}</h2><button ref={firstDialogButton} onClick={() => setDialog(null)} aria-label="关闭">×</button></header>
      {dialog === 'columns' ? <><p>默认字段及顺序与审核要求一致。隐藏字段只影响当前页面显示。</p><div className={styles.columnList}>{config.columns.map(c => <label key={c.key}><input type="checkbox" disabled={c.key === 'seq'} checked={!hidden.includes(c.key)} onChange={e => setHidden(old => e.target.checked ? old.filter(k => k !== c.key) : [...old, c.key])} />{c.label}</label>)}</div><footer><button onClick={() => setHidden([])}>恢复全部字段</button><button className={styles.primary} onClick={() => setDialog(null)}>完成</button></footer></> : dialog && <dl className={styles.detail}>{config.columns.filter(c => c.key !== 'seq').map(c => <div key={c.key}><dt>{c.label}</dt><dd>{display(dialog[c.key], c.kind)}</dd></div>)}</dl>}
    </dialog>
  </div>
}
