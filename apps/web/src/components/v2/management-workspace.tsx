'use client'
import Link from 'next/link'
import {inventoryDocumentHref} from '@/lib/inventory-document-navigation'
import { WarehouseDocumentActions } from './warehouse-document-actions'
import { ProcurementManagementActions } from './procurement-management-actions'
import { ManagementTabs } from './management-tabs'
import { FilterDateRange } from './filter-date-range'
import filters from './scm-filter-bar.module.css'
import { useEffect, useRef, useState } from 'react'
import { apiFetch, getUser } from '@/lib/v2-auth'
import { ConfirmSheet, useConfirmSheet } from './confirm-sheet'
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
const stocktakeDetailKeys=['productCodeSnapshot','productNameSnapshot','productSpecSnapshot','unitSnapshot','bookQuantity','countedQuantity','differenceQuantity','differenceAmount','reasonNote']
const stocktakeDetailLabels=['物品编码','物品名称','规格型号','单位','账面数量','实盘数量','差异数量','差异金额','差异原因']
const selects = new Set(['org', 'warehouse', 'supplier', 'status', 'review', 'printed', 'difference', 'generated', 'reconciliation', 'invoice', 'stockStatus', 'category', 'countType', 'reason', 'supplierAccount'])
const knownOptions: Record<string, string[]> = { printed: ['未打印', '已打印'], generated: ['是', '否'], difference: ['未盘完', '有差异', '无差异'] }
const display = (value: string | number | null | undefined, kind: string) => value == null || value === '' ? '—' : kind === 'number' ? Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 6 }) : value

export function ManagementWorkspace({ config }: { config: ManagementPage }) {
  const defaults = () => initial(Boolean(config.dateLabel))
  const [draft, setDraft] = useState(defaults); const [applied, setApplied] = useState(defaults)
  const [result, setResult] = useState<ManagementResult | null>(null); const [error, setError] = useState('')
  const [loading, setLoading] = useState(true); const [exporting, setExporting] = useState(false)
  const [printing, setPrinting] = useState(false); const [printResult, setPrintResult] = useState<ManagementResult | null>(null)
  const [page, setPage] = useState(1); const [pageSize, setPageSize] = useState(20); const [refresh, setRefresh] = useState(0)
  const [advanced, setAdvanced] = useState(false); const [selected, setSelected] = useState<string[]>([])
  const [hidden, setHidden] = useState<string[]>([]); const [focused, setFocused] = useState(false)
  const [dialog, setDialog] = useState<'columns' | 'org' | 'logs' | 'help' | ManagementRow | null>(null)
  const [orgQuery, setOrgQuery] = useState('')
  const [logs, setLogs] = useState<Array<{ id: string; no: string | null; action: string; actor: string; createdAt: string }>>([])
  const [logsLoading, setLogsLoading] = useState(false)
  const [logsError, setLogsError] = useState('')
  const [confirmation, openConfirmation] = useConfirmSheet()
  const [batchBusy, setBatchBusy] = useState(false)
  const approvalContextLocked = confirmation.open || batchBusy
  const [batchMessage, setBatchMessage] = useState('')
  const [failedStocktakeHref,setFailedStocktakeHref]=useState('')
  const [printDocuments, setPrintDocuments] = useState<Array<{ no: string; countDate: string; items: Array<Record<string, string | number | null>> }> | null>(null)
  const printPreviewRef = useRef<HTMLElement>(null)
  const clearPrintPreview = () => { setPrintDocuments(null); setPrintResult(null); setPrinting(false) }
  useEffect(() => {
    const afterPrint = () => { setPrintDocuments(null); setPrintResult(null); setPrinting(false) }
    window.addEventListener('afterprint', afterPrint)
    return () => window.removeEventListener('afterprint', afterPrint)
  }, [])
  useEffect(() => {
    if (!printDocuments && !printResult) return
    const previousFocus = document.activeElement as HTMLElement | null
    printPreviewRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setPrintDocuments(null); setPrintResult(null); setPrinting(false) }
      if (event.key !== 'Tab') return
      const buttons = Array.from(printPreviewRef.current?.querySelectorAll<HTMLButtonElement>('button') || [])
      const first = buttons[0], last = buttons[buttons.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', keydown)
    return () => { document.removeEventListener('keydown', keydown); if (previousFocus?.isConnected) previousFocus.focus() }
  }, [printDocuments, printResult])
  const isStocktake = ['count', 'multi-count'].includes(config.id)
  const canBatchWrite = ['SUPPLY_CHAIN', 'SUPER_ADMIN', 'ADMIN'].includes(getUser()?.role || '')
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
  const change = (key: string, value: string) => setDraft(d => ({ ...d, filters: { ...d.filters, ...(config.id === 'count' && key === 'org' ? { warehouse: '' } : {}), [key]: value } }))
  async function openLogs() {
    setDialog('logs'); setLogsLoading(true); setLogsError(''); setLogs([])
    try { const response = await apiFetch<{ items: typeof logs }>('/api/warehouse-stocktakes/logs'); setLogs(response.items) } catch (error: any) { setLogsError(error.message || '操作日志读取失败') } finally { setLogsLoading(false) }
  }
  function filter(field: { key: string; label: string }) {
    const waitingForOrg = config.id === 'count' && field.key === 'warehouse' && !draft.filters.org
    const disabled = waitingForOrg || (!!result && !result.supportedFilters.includes(field.key))
    const options = config.id === 'count' && field.key === 'warehouse' && draft.filters.org && result?.warehousesByOrg ? result.warehousesByOrg[draft.filters.org] || [] : result?.options[field.key]?.length ? result.options[field.key] : knownOptions[field.key] || []
    const choices=field.key==='warehouse'&&draft.filters.org&&result?.warehouseChoicesByOrg?result.warehouseChoicesByOrg[draft.filters.org]:result?.choiceOptions?.[field.key]
    return <label className={`${styles.filter} ${config.id === 'count' && ['warehouse', 'difference'].includes(field.key) ? styles.wideFilter : ''}`} key={field.key} title={waitingForOrg ? '请先选择机构，再选择所属仓库' : disabled ? '当前业务尚未记录此字段' : undefined}>
      <span>{field.label}：</span>
      {field.key === 'priceAdjusted' ? <input type="checkbox" disabled={disabled} checked={draft.filters[field.key] === '是'} onChange={e => change(field.key, e.target.checked ? '是' : '')} /> : selects.has(field.key) ?
        <select disabled={disabled} value={draft.filters[field.key] || ''} onChange={e => change(field.key, e.target.value)}><option value="">{waitingForOrg ? '请先选择机构' : disabled ? '未记录' : field.key === 'org' && config.id === 'count' ? '请选择' : '全部'}</option>{choices?choices.map(choice=><option key={choice.value} value={choice.value}>{choice.label}</option>):options.map(v => <option key={v}>{v}</option>)}</select> :
        <input disabled={disabled} value={draft.filters[field.key] || ''} onChange={e => change(field.key, e.target.value)} placeholder={disabled ? '未记录' : '请输入'} />}
      {config.id === 'count' && field.key === 'org' && <button type="button" disabled={disabled} onClick={() => { setOrgQuery(''); setDialog('org') }}>高级</button>}
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
  const selectedRows = () => (result?.rows || []).filter(row => selected.includes(String(row.id)))
  const stocktakeId = (row: ManagementRow) => String(row.detailId || row.id).replace(/^warehouse:/, '')
  async function selectedDocuments(targets = selectedRows()) {
    return Promise.all(targets.map(row => apiFetch<{ no: string; countDate: string; items: Array<Record<string, string | number | null>> }>(
      row.recordType === 'WAREHOUSE_STOCKTAKE'
        ? `/api/warehouse-stocktakes/${encodeURIComponent(stocktakeId(row))}/review`
        : `/api/inventory-counts/${encodeURIComponent(String(row.id))}`,
    ))).then(docs=>docs.map(doc=>({...doc,countDate:doc.countDate.slice(0,10)})))
  }
  async function exportDocuments(targets = selectedRows()) {
    setExporting(true); setError('')
    try {
      const docs = await selectedDocuments(targets)
      const XLSX = await import('xlsx')
      const keys = stocktakeDetailKeys
      const data = [['单据编号', '盘点日期', ...stocktakeDetailLabels],
        ...docs.flatMap(doc => doc.items.map(item => [doc.no, doc.countDate, ...keys.map(key => item[key] ?? null)]))]
      const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(data), '盘点明细')
      XLSX.writeFile(book, `${config.title}-所选单据明细.xlsx`)
    } catch (e: any) { setError(e.message || '单据导出失败，未生成部分文件') } finally { setExporting(false) }
  }
  async function printSelectedDocuments(targets = selectedRows()) {
    setPrinting(true); setError('')
    try {
      const docs = await selectedDocuments(targets)
      setPrintDocuments(docs)
      setPrinting(false)
    } catch (e: any) { setError(e.message || '打印准备失败'); setPrinting(false) }
  }
  function batchTransition(action: 'submit' | 'approve', targets = selectedRows(), single = false) {
    const label = action === 'submit' ? '提交' : '审核'
    openConfirmation({ title: `${single ? '盘点单' : '批量'}${label}`, body: `将${label}所选的${targets.length}张总仓盘点单。${action === 'approve' ? '审核成功会调整库存数量和金额。' : '各分区必须已完成并提交。'}每张单据独立处理，失败会列出单号并停止后续处理。`, confirmLabel: `确认${label}`, layerClassName: 'z-[100]', onConfirm: async () => {
      setBatchBusy(true); setBatchMessage(''); setFailedStocktakeHref(''); setError('')
      let completed = 0
      try {
        for (const row of targets) {
          const id = stocktakeId(row)
          try {
            const current = await apiFetch<{ rowVersion: number; status: string }>(`/api/warehouse-stocktakes/${encodeURIComponent(id)}`)
            if (action === 'submit' && !['DRAFT', 'COUNTING'].includes(current.status)) throw new Error('当前状态不能提交，请刷新核对')
            if (action === 'approve' && current.status !== 'REVIEWING') throw new Error('只有待审核单据可以审核')
            await apiFetch(`/api/warehouse-stocktakes/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: JSON.stringify(action === 'submit' ? { rowVersion: current.rowVersion } : {}) })
            completed++
          } catch (e: any) {
            setFailedStocktakeHref(`/v2/supply-chain/stocktake/work?doc=${encodeURIComponent(id)}&from=${config.id==='multi-count'?'multi-count':'count'}`)
            setBatchMessage(`${row.no}：${e.message || '操作结果未确认'}。已成功${completed}张；本张结果请刷新核对，后续${targets.length - completed - 1}张未执行。`)
            break
          }
        }
        if (completed === targets.length) setBatchMessage(`批量${label}：已成功${completed} / ${targets.length}张。`)
      } finally { setBatchBusy(false); setRefresh(n => n + 1) }
    } })
  }
  async function printCurrentResults() {
    if (loading || printing || !result?.sourceAvailable) return
    setPrinting(true); setError('')
    try {
      const full = await apiFetch<ManagementResult>(`/api/inventory-management/${config.id}?${query}&print=1`)
      setPrintResult(full)
      setPrinting(false)
    } catch (e: any) {
      setError(e.message || '打印准备失败')
      setPrinting(false)
    }
  }
  function detailHref(row: ManagementRow) {
    if (row.recordType === 'WAREHOUSE_DOC') return inventoryDocumentHref(`/v2/supply-chain/docs/${encodeURIComponent(String(row.detailId))}/edit`,config.id)
    if (row.recordType === 'UPSTREAM_RECEIPT') return inventoryDocumentHref(`/v2/supply-chain/procurement/receipts/${encodeURIComponent(String(row.detailId))}/edit`,config.id)
    if (row.recordType === 'UPSTREAM_RETURN') return inventoryDocumentHref(`/v2/supply-chain/procurement/returns/${encodeURIComponent(String(row.detailId))}/edit`,config.id)
    if (row.recordType === 'WAREHOUSE_STOCKTAKE') return `/v2/supply-chain/stocktake/work?doc=${encodeURIComponent(String(row.detailId))}&from=${config.id}`
    if (config.id === 'purchase-return') return `/v2/supply-chain/procurement?return=${encodeURIComponent(String(row.id))}`
    if (config.id === 'count' && row.recordType !== 'IMPORTED_BASELINE') return String(row.id).startsWith('warehouse:')
      ? `/v2/supply-chain/stocktake/count/${String(row.id).slice(10)}?source=warehouse`
      : `/v2/supply-chain/stocktake/count/${row.id}`
    return null
  }
  const dialogTitle = dialog === 'columns' ? '表格设置' : dialog === 'org' ? '选择机构' : dialog === 'logs' ? '操作日志' : dialog === 'help' ? '常见问题' : '记录信息'
  const columns = config.columns.filter(c => !hidden.includes(c.key))
  const rows = result?.rows || []
  const showOperation = ['count','multi-count','purchase-in','purchase-return','other-in','other-out'].includes(config.id)
  const fixedColumn = (key: string) => config.id !== 'count' ? '' : key === 'seq' ? styles.fixedSequence : key === 'no' ? styles.fixedDocument : ''
  const checkClass = `${styles.check} ${config.id === 'count' ? styles.fixedCheck : ''}`
  const group = config.group as ManagementGroup
  const batchDisabled = loading || batchBusy || exporting || printing || !result?.sourceAvailable || !selected.length
  const onlyWarehouse = selectedRows().every(row => row.recordType === 'WAREHOUSE_STOCKTAKE')
  return <div className={`${styles.workspace} ${focused ? styles.focused : ''}`}>
    <header className={styles.breadcrumb}><span>货品与仓库 <span>/</span> <strong>{managementGroupLabel(group)}</strong></span><span>单据与库存</span></header>
    <div className={filters.mobileMenu}><details><summary>库存与盘点菜单</summary><nav aria-label="库存与盘点功能菜单">{managementPages.map(p => <Link key={p.id} href={managementHref(p)} aria-current={p.id === config.id ? 'page' : undefined}>{p.title}</Link>)}</nav></details></div>
    <ManagementTabs activeId={config.id} />
    <section className={styles.content}>
      <div className={styles.heading}><div><p>{managementGroupLabel(group)}</p><h1>{config.title}{['purchase-in', 'purchase-return', 'other-in', 'other-out'].includes(config.id) ? '单' : ''}</h1></div><div className={styles.actions}>{config.id === 'count' && <button onClick={() => void openLogs()}>操作日志</button>}<button aria-pressed={focused} onClick={() => setFocused(v => !v)}>{focused ? '退出专注' : '专注表格'}</button><button onClick={() => setDialog('columns')}>表格设置</button>{config.id === 'count' && <button onClick={() => setDialog('help')}>常见问题</button>}</div></div>
      <form className={`${filters.bar} ${config.id === 'count' ? styles.stocktakeFilters : ''}`} onSubmit={e => { e.preventDefault(); if (approvalContextLocked) return; setApplied({ ...draft, filters: { ...draft.filters } }); setPage(1); setRefresh(n => n + 1) }}>
        <div className={`${filters.fields} ${config.id === 'count' ? styles.stocktakeFields : ''}`}>
          {config.dateLabel && <div className={`${filters.date} ${config.id === 'count' ? styles.stocktakeDate : ''}`}><div className={filters.segments} role="group" aria-label="日期类型">{[['date', config.dateLabel], ['createdAt', '创建时间']].map(([value, label]) => <label key={value}><input type="radio" name="dateField" value={value} checked={draft.dateField === value} onChange={() => setDraft(d => ({ ...d, dateField: value }))} /><span>{label}</span></label>)}</div><FilterDateRange value={{ start: draft.start, end: draft.end }} onChange={range => setDraft(d => ({ ...d, ...range }))} /></div>}
          {config.filters.map(filter)}
          {advanced && config.advanced.map(filter)}
        </div>
        <div className={`${filters.buttons} ${config.id === 'count' ? styles.countButtons : ''}`}>{config.advanced.length > 0 && <button type="button" className={filters.expand} onClick={() => setAdvanced(v => !v)} aria-expanded={advanced}>{advanced ? '收起筛选 ∧' : '展开筛选 ∨'}</button>}<button disabled={approvalContextLocked} className={filters.primary}>查询</button><button type="button" disabled={approvalContextLocked} onClick={() => { if (approvalContextLocked) return; const next = defaults(); setDraft(next); setApplied({ ...next, filters: {} }); setPage(1); setRefresh(n => n + 1) }}>重置</button></div>
      </form>
      {error && <div role="alert" className={styles.error}>{error}<button disabled={approvalContextLocked} onClick={() => { if (!approvalContextLocked) setRefresh(n => n + 1) }}>重新查询</button></div>}
      {result?.note && <p className={styles.note} title={result.note}>{result.note}</p>}
      {batchMessage && <div role="status"><p>{batchMessage}</p>{failedStocktakeHref&&<Link className="underline" href={failedStocktakeHref}>查看并处理未完成的盘点单</Link>}{batchMessage.includes('库存已变动')&&<p>原库存快照已过期；需退回、取消旧单，再新建同仓盘点。只退回重填不能恢复审核。</p>}</div>}
      <div className={styles.toolbar}><div className={styles.actions}>
        {isStocktake ? <>
          <Link href={`/v2/supply-chain/stocktake/work?create=1&from=${config.id}${result?.warehouseOptions?.find(warehouse=>`warehouse:${warehouse.id}`===draft.filters.warehouse)?`&warehouseId=${encodeURIComponent(result.warehouseOptions.find(warehouse=>`warehouse:${warehouse.id}`===draft.filters.warehouse)!.id)}`:''}`} className={styles.primary}>＋ 批次盘点</Link>
          <button disabled={batchDisabled} onClick={() => void printSelectedDocuments()}>批量打印</button>
          <button disabled={batchDisabled || !canBatchWrite || !onlyWarehouse || selectedRows().some(row => !['草稿', '盘点中'].includes(String(row.status)))} title={!onlyWarehouse ? '门店来源单据请在原页面处理' : undefined} onClick={() => batchTransition('submit')}>批量提交</button>
          <button disabled={batchDisabled || !canBatchWrite || !onlyWarehouse || selectedRows().some(row => row.status !== '待审核')} onClick={() => batchTransition('approve')}>批量审核</button>
          <span title="本轮不实施盘点反审核"><button disabled>批量反审核</button></span>
          <button disabled={batchDisabled} onClick={() => void exportDocuments()}>批量导出</button>
          <button disabled={batchDisabled} onClick={exportSelected}>批量导出单据列表</button>
        </> : <>
        {config.id === 'purchase-in' && <Link href="/v2/supply-chain/procurement" className={styles.primary}>采购作业 ↗</Link>}
        {['other-in', 'other-out', 'limits'].includes(config.id) && <Link href="/v2/supply-chain/inventory" className={styles.primary}>库存作业 ↗</Link>}
        {['other-in','other-out'].includes(config.id) && canBatchWrite && <Link href={inventoryDocumentHref(config.id==='other-out'?'/v2/supply-chain/docs/new-outbound':'/v2/supply-chain/docs/new',config.id)} className={styles.primary}>{config.id==='other-out'?'新增出库单':'新增入库单'}</Link>}
        {['other-in', 'other-out'].includes(config.id) && <Link href="/v2/supply-chain/docs">单据审核 ↗</Link>}
        <button disabled={loading || exporting || !result?.sourceAvailable} onClick={exportList}>{exporting ? '正在导出…' : '导出列表'}</button>
        {selected.length > 0 && <button disabled={exporting || loading} onClick={exportSelected}>导出所选（{selected.length}）</button>}
        <button disabled={loading || printing || !result?.sourceAvailable} onClick={printCurrentResults}>{printing ? '正在准备打印…' : '打印当前筛选结果'}</button>
        </>}
      </div>{config.id === 'limits' ? <label className={styles.unit}>计量单位类型 <select aria-label="计量单位类型" value="inventory" onChange={() => {}}><option value="inventory">库存单位</option></select></label> : <span className={styles.total}>共 {result?.total ?? '—'} 条</span>}</div>
      <div className={styles.tableCard} aria-busy={loading}>
        <div className={styles.scroll} tabIndex={0} role="region" aria-label={`${config.title}表格，可横向滚动`}><table>
          <thead><tr><th className={checkClass}><input type="checkbox" aria-label="选择本页全部记录" disabled={!rows.length || loading} checked={!!rows.length && selected.length === rows.length} ref={el => { if (el) el.indeterminate = selected.length > 0 && selected.length < rows.length }} onChange={e => setSelected(e.target.checked ? rows.map(r => String(r.id)) : [])} /></th>{columns.map(c => <th key={c.key} className={`${c.kind === 'number' ? styles.numeric : ''} ${fixedColumn(c.key)}`}>{c.label}</th>)}{showOperation && <th className={styles.operation}>操作</th>}</tr></thead>
          <tbody>{loading || !rows.length ? <tr><td colSpan={columns.length + (showOperation ? 2 : 1)}><div className={styles.empty}><span aria-hidden="true">▤</span><strong>{loading ? '正在查询…' : error ? '查询未完成' : result?.sourceAvailable === false ? '暂无可用单据来源' : '暂无符合条件的记录'}</strong><p>{!loading && (error ? '请重试后查看记录。' : result?.sourceAvailable === false ? result.note : '可以调整筛选条件后重新查询。')}</p></div></td></tr> : rows.map(row => <tr key={row.id} data-selected={selected.includes(String(row.id))}>
            <td className={checkClass}><input type="checkbox" aria-label={`选择${row.no || row.name}`} checked={selected.includes(String(row.id))} onChange={e => setSelected(old => e.target.checked ? [...old, String(row.id)] : old.filter(v => v !== String(row.id)))} /></td>
            {columns.map(c => <td key={c.key} className={`${c.kind === 'number' ? styles.numeric : ''} ${fixedColumn(c.key)}`} title={row[c.key] == null ? '尚未记录' : String(row[c.key])}>{c.key === 'no' ? <>{detailHref(row) ? <Link className={styles.textButton} href={detailHref(row)!}>{display(row[c.key], c.kind)}</Link> : <span>{display(row[c.key], c.kind)}</span>}{row.source && <span className={`${styles.badge} ml-2`}>{row.source}</span>}</> : config.id === 'count' && c.key === 'difference' && Number(row.differenceCount) > 0 ? <span className={styles.differenceCount}>{row.differenceCount}项差异</span> : ['status', 'review'].includes(c.key) && row[c.key] ? <span className={styles.badge}>{row[c.key]}</span> : display(row[c.key], c.kind)}</td>)}
            {showOperation && <td className={styles.operation}>{config.id === 'multi-count' ? <div className={styles.rowActions}>
              {row.recordType === 'WAREHOUSE_STOCKTAKE' && canBatchWrite && ['草稿','盘点中','待提交'].includes(String(row.status)) && <button className={styles.textButton} disabled={loading || printing || exporting || batchBusy} onClick={()=>batchTransition('submit',[row],true)}>提交</button>}
              {row.recordType === 'WAREHOUSE_STOCKTAKE' && canBatchWrite && ['草稿','盘点中','待提交','待审核'].includes(String(row.status)) && <button className={styles.textButton} disabled={String(row.status)!=='待审核' || loading || printing || exporting || batchBusy} title={String(row.status)!=='待审核'?'先提交，进入待审核后才可审核':undefined} onClick={()=>batchTransition('approve',[row],true)}>审核</button>}
              <button className={styles.textButton} disabled={loading || printing || exporting || batchBusy} onClick={()=>void printSelectedDocuments([row])}>打印</button>
              <button className={styles.textButton} disabled={loading || printing || exporting || batchBusy} onClick={()=>void exportDocuments([row])}>导出</button>
            </div> : row.recordType === 'WAREHOUSE_DOC' ? <WarehouseDocumentActions row={row} from={config.id} /> : ['UPSTREAM_RECEIPT','UPSTREAM_RETURN'].includes(String(row.recordType)) ? <ProcurementManagementActions row={row} from={config.id} /> : config.id !== 'count' ? (detailHref(row) ? <Link className={styles.textButton} href={detailHref(row)!}>查看</Link> : '—') : row.recordType !== 'IMPORTED_BASELINE' ? <div className={styles.rowActions}>
              {row.recordType === 'WAREHOUSE_STOCKTAKE' && canBatchWrite && ['草稿','盘点中','待提交'].includes(String(row.status)) && <><button className={styles.textButton} disabled={loading || printing || exporting || batchBusy} onClick={() => batchTransition('submit', [row], true)}>提交</button><span aria-hidden="true">｜</span></>}
              {row.recordType === 'WAREHOUSE_STOCKTAKE' && canBatchWrite && ['草稿','盘点中','待提交','待审核'].includes(String(row.status)) && <><button className={styles.textButton} disabled={String(row.status) !== '待审核' || loading || printing || exporting || batchBusy} title={String(row.status) !== '待审核' ? '先提交，进入待审核后才可审核' : undefined} onClick={() => batchTransition('approve', [row], true)}>审核</button><span aria-hidden="true">｜</span></>}
              <Link className={styles.textButton} href={String(row.id).startsWith('warehouse:') ? `/v2/supply-chain/stocktake/count/${String(row.id).slice(10)}?source=warehouse` : `/v2/supply-chain/stocktake/count/${row.id}`}>复盘差异</Link>
              <span aria-hidden="true">｜</span><span title="本轮不实施盘点反审核"><button className={styles.textButton} disabled>反审核</button></span>
              <span aria-hidden="true">｜</span><button className={styles.textButton} disabled={loading || printing || exporting || batchBusy} onClick={() => void printSelectedDocuments([row])}>打印</button>
              <span aria-hidden="true">｜</span><button className={styles.textButton} disabled={loading || printing || exporting || batchBusy} onClick={() => void exportDocuments([row])}>导出</button>
            </div> : '—'}</td>}

          </tr>)}</tbody>
          {!!result?.total && !!Object.keys(result.totals || {}).length && <tfoot><tr title="全部筛选结果合计"><td /><td>合计</td>{columns.slice(1).map(c => <td key={c.key} className={styles.numeric}>{result.totals?.[c.key] == null ? '' : display(result.totals[c.key], 'number')}</td>)}{showOperation && <td className={styles.operation} />}</tr></tfoot>}
        </table></div>
        <footer className={styles.pagination}><span>已选 <strong>{selected.length}</strong> 条 <span className={styles.divider}>|</span> 共 {result?.total ?? '—'} 条</span><div className={styles.actions}><select aria-label="每页条数" disabled={approvalContextLocked} value={pageSize} onChange={e => { if (approvalContextLocked) return; setPageSize(Number(e.target.value)); setPage(1) }}>{[20, 50, 100].map(n => <option key={n} value={n}>{n} 条 / 页</option>)}</select><button aria-label="上一页" disabled={approvalContextLocked || loading || !result || result.page <= 1} onClick={() => { if (!approvalContextLocked) setPage((result?.page || 1) - 1) }}>‹</button><span>{result?.page || 1} / {Math.max(1, Math.ceil((result?.total || 0) / pageSize))}</span><button aria-label="下一页" disabled={approvalContextLocked || loading || !result || result.page * pageSize >= result.total} onClick={() => { if (!approvalContextLocked) setPage((result?.page || 1) + 1) }}>›</button></div></footer>
      </div>
    </section>
    <ConfirmSheet {...confirmation} />
    {printDocuments && <section ref={printPreviewRef} className={`${styles.printOnly} ${styles.printPreview}`} role="dialog" aria-modal="true" aria-label="所选盘点单打印明细"><header className={styles.printPreviewControls}><strong>{config.title}打印预览</strong><span>若打印窗口没有弹出，可查看内容后再次打印或关闭。</span><button onClick={() => window.print()}>打印 / 保存 PDF</button><button onClick={clearPrintPreview}>关闭打印预览</button></header>{printDocuments.map(doc => <article key={doc.no} style={{ breakAfter: 'page' }}><h1>{config.title} {doc.no}</h1><p>盘点日期 {doc.countDate}</p><table><thead><tr>{stocktakeDetailLabels.map(label => <th key={label}>{label}</th>)}</tr></thead><tbody>{doc.items.map((item, index) => <tr key={String(item.id || index)}>{stocktakeDetailKeys.map(key => <td key={key}>{display(item[key], 'text')}</td>)}</tr>)}</tbody></table></article>)}</section>}
    {printResult && <section ref={printPreviewRef} className={`${styles.printOnly} ${styles.printPreview}`} role="dialog" aria-modal="true" aria-label={`${config.title}当前筛选打印结果`}>
      <header className={styles.printPreviewControls}><strong>单据列表打印预览</strong><span>若打印窗口没有弹出，可查看内容后再次打印或关闭。</span><button onClick={() => window.print()}>打印 / 保存 PDF</button><button onClick={clearPrintPreview}>关闭打印预览</button></header>
      <h1>{config.title}</h1>
      <p>共 {printResult.total} 条 · 生成时间 {printResult.generatedAt || '—'}</p>
      <table><thead><tr>{config.columns.map(column => <th key={column.key}>{column.label}</th>)}</tr></thead><tbody>{printResult.rows.map(row => <tr key={row.id}>{config.columns.map(column => <td key={column.key}>{display(row[column.key], column.kind)}</td>)}</tr>)}</tbody></table>
    </section>}
    <dialog ref={dialogRef} className={styles.dialog} onClose={() => setDialog(null)} aria-label={dialogTitle}>
      <header><h2>{dialogTitle}</h2><button ref={firstDialogButton} onClick={() => setDialog(null)} aria-label="关闭">×</button></header>
      {dialog === 'columns' ? <><p>默认字段及顺序与审核要求一致。隐藏字段只影响当前页面显示。</p><div className={styles.columnList}>{config.columns.map(c => <label key={c.key}><input type="checkbox" disabled={c.key === 'seq'} checked={!hidden.includes(c.key)} onChange={e => setHidden(old => e.target.checked ? old.filter(k => k !== c.key) : [...old, c.key])} />{c.label}</label>)}</div><footer><button onClick={() => setHidden([])}>恢复全部字段</button><button className={styles.primary} onClick={() => setDialog(null)}>完成</button></footer></> : dialog === 'org' ? <><input aria-label="搜索机构" value={orgQuery} onChange={event => setOrgQuery(event.target.value)} placeholder="输入机构名称" /><div className={styles.columnList}>{(result?.choiceOptions?.org || (result?.options.org || []).map(name=>({value:name,label:name}))).filter(choice => choice.label.includes(orgQuery.trim())).map(choice => <button key={choice.value} onClick={() => { change('org', choice.value); setDialog(null) }}>{choice.label}</button>)}</div><footer><button onClick={() => { change('org', ''); setDialog(null) }}>全部机构</button></footer></> : dialog === 'logs' ? <>{logsLoading ? <p>正在读取最近100条操作日志…</p> : logsError ? <p role="alert">{logsError}</p> : <><p>最近100条总仓盘点操作；只读查看。</p>{logs.length ? logs.map(log => <p key={log.id}>{new Date(log.createdAt).toLocaleString('zh-CN')} · {log.no || '—'} · {log.action} · {log.actor}</p>) : <p>暂无操作日志</p>}</>}</> : dialog === 'help' ? <p>按盘点日期或创建时间查询，选择机构后选择仓库。勾选单据可批量打印或导出；逐行打印、导出只处理当前单据。差异项数来自盘点记录，未记录的打印状态显示为“—”。</p> : dialog && <dl className={styles.detail}>{config.columns.filter(c => c.key !== 'seq').map(c => <div key={c.key}><dt>{c.label}</dt><dd>{display(dialog[c.key], c.kind)}</dd></div>)}</dl>}
    </dialog>
  </div>
}
