'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { apiFetch, getUser } from '@/lib/v2-auth'
import type { ManagementResult, ManagementRow } from '@/lib/inventory-management'
import { StocktakePrintPreview, type StocktakePrintDocument } from './stocktake-print-preview'

type Mode = 'count' | 'multi-count'
type BatchAction = 'submit' | 'approve' | 'final-review' | 'reverse-approval' | 'delete'
type StocktakeResult = ManagementResult & { columns: Array<{ key: string; label: string }> }
type BatchResult = {
  operationId: string
  status: 'RUNNING' | 'COMPLETED'
  summary: { total: number; succeeded: number; failed: number; skipped: number; pending: number }
  results: Array<{ id: string; no: string; outcome: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'SKIPPED'; code?: string | null; message?: string | null; rowVersion?: number | null }>
}
type PreparedPrint = { id: string; requestKey: string; documents: StocktakePrintDocument[] }
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })
const idOf = (row: ManagementRow) => String(row.detailId || row.id).replace(/^warehouse:/, '')
const selectedRow = (row: ManagementRow) => ({ ...row, id: idOf(row) })

export function StocktakeWorkspace({ mode }: { mode: Mode }) {
  const router = useRouter()
  const role = getUser()?.role || ''
  const canWrite = ['SUPPLY_CHAIN', 'SUPER_ADMIN', 'ADMIN', 'PURCHASER'].includes(role)
  const canAudit = ['SUPPLY_CHAIN', 'SUPER_ADMIN', 'ADMIN'].includes(role)
  const [start, setStart] = useState(today()), [end, setEnd] = useState(today()), [dateField, setDateField] = useState('date')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [page, setPage] = useState(1), [pageSize, setPageSize] = useState(100)
  const [result, setResult] = useState<StocktakeResult | null>(null)
  const [selected, setSelected] = useState<Map<string, ManagementRow>>(new Map())
  const [loading, setLoading] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [refresh, setRefresh] = useState(0)
  const [formalType, setFormalType] = useState<'SELECTED' | 'DAILY' | 'WEEKLY' | 'ALL'>('SELECTED')
  const [batchResult, setBatchResult] = useState<BatchResult | null>(null)
  const [lastBatch, setLastBatch] = useState<{ action: BatchAction; reason?: string } | null>(null)
  const [preparedPrint, setPreparedPrint] = useState<PreparedPrint | null>(null)
  const [printing, setPrinting] = useState(false)
  const requestSequence = useRef(0)
  const batchRequestKeys = useRef(new Map<string, string>())
  const printRequestKeys = useRef(new Map<string, string>())
  const coreFilterKey = useMemo(() => JSON.stringify({ mode, start, end, dateField, filters }), [mode, start, end, dateField, filters])
  const query = useMemo(() => new URLSearchParams({ start, end, dateField, filters: JSON.stringify(filters), page: String(page), pageSize: String(pageSize) }).toString(), [start, end, dateField, filters, page, pageSize])

  useEffect(() => { setPage(1); setSelected(new Map()); setBatchResult(null) }, [coreFilterKey])
  useEffect(() => {
    const sequence = ++requestSequence.current
    setLoading(true)
    apiFetch<StocktakeResult>(`/api/inventory-management/${mode}?${query}`).then(value => {
      if (sequence !== requestSequence.current) return
      setResult(value)
      if (value.page !== page) setPage(value.page)
    }).catch(reason => { if (sequence === requestSequence.current) setError(reason.message || '查询失败') })
      .finally(() => { if (sequence === requestSequence.current) setLoading(false) })
  }, [mode, query, refresh, page])

  const rows = result?.rows || []
  const chosen = [...selected.values()]
  const totalPages = result?.totalPages || Math.max(1, Math.ceil((result?.total || 0) / (result?.pageSize || pageSize)))
  const setFilter = (key: string, value: string) => setFilters(old => ({ ...old, [key]: value }))
  function toggle(row: ManagementRow, checked: boolean) {
    const id = idOf(row)
    setSelected(old => {
      if (checked && !old.has(id) && old.size >= 100) {
        setError('每次批量操作最多选择100张盘点单')
        return old
      }
      const next = new Map(old); if (checked) next.set(id, selectedRow(row)); else next.delete(id); return next
    })
  }

  async function executeBatch(action: BatchAction, targets: ManagementRow[], suppliedReason?: string) {
    if (!targets.length) return setError('请先选择盘点单')
    let reason = suppliedReason?.trim() || ''
    if (['reverse-approval', 'delete'].includes(action) && !reason) reason = window.prompt(action === 'delete'
      ? (targets.length > 1 ? '请输入批量删除原因' : '请输入删除原因')
      : (targets.length > 1 ? '请输入批量反审核原因' : '请输入反审核原因'))?.trim() || ''
    if (['reverse-approval', 'delete'].includes(action) && reason.length < 2) return setError(action === 'delete' ? '删除原因至少2个字' : '反审核原因至少2个字')
    const items = targets.map(row => ({ id: idOf(row), rowVersion: Number(row.rowVersion) }))
    if (items.some(item => !Number.isSafeInteger(item.rowVersion) || item.rowVersion < 0)) return setError('选中单据缺少版本，请刷新列表后重试')
    const identity = JSON.stringify({ action, items: [...items].sort((a, b) => a.id.localeCompare(b.id)), reason })
    const requestKey = batchRequestKeys.current.get(identity) || crypto.randomUUID()
    batchRequestKeys.current.set(identity, requestKey)
    setLoading(true); setError(''); setNotice('')
    try {
      const response = await apiFetch<BatchResult>(`/api/warehouse-stocktakes/batch/${action}`, { method: 'POST', body: JSON.stringify({ requestKey, items, ignoreInvalid: true, ...(reason ? { reason } : {}) }) })
      setBatchResult(response); setLastBatch({ action, ...(reason ? { reason } : {}) })
      setSelected(old => { const next = new Map(old); for (const item of response.results) if (item.outcome === 'SUCCEEDED') next.delete(item.id); return next })
      if (response.status === 'COMPLETED') batchRequestKeys.current.delete(identity)
      setNotice(`批量操作完成：成功 ${response.summary.succeeded}，失败 ${response.summary.failed}，未处理 ${response.summary.skipped + response.summary.pending}`)
      setRefresh(value => value + 1)
    } catch (reason: any) { setError(`${reason.message || '批量操作失败'}；原请求编号已保留，再次点击可安全核对`) }
    finally { setLoading(false) }
  }
  async function retryFailed() {
    if (!batchResult || !lastBatch) return
    const retryIds = new Set(batchResult.results.filter(item => ['FAILED', 'SKIPPED'].includes(item.outcome)).map(item => item.id))
    const targets = chosen.filter(row => retryIds.has(idOf(row)))
    if (!targets.length) return setError('没有可重试的失败项')
    setLoading(true); setError('')
    try {
      // Only explicit retries refresh versions. A first-time batch always
      // submits the rowVersion captured when the user selected each row.
      const refreshedTargets = await Promise.all(targets.map(async row => {
        const id = idOf(row)
        const detail = await apiFetch<{ rowVersion: number }>(`/api/warehouse-stocktakes/${encodeURIComponent(id)}`)
        if (!Number.isSafeInteger(detail.rowVersion) || detail.rowVersion < 0) throw new Error('盘点单版本无效')
        return { ...row, id, detailId: id, rowVersion: detail.rowVersion }
      }))
      setSelected(old => {
        const next = new Map(old)
        for (const row of refreshedTargets) next.set(idOf(row), row)
        return next
      })
      setBatchResult(null)
      await executeBatch(lastBatch.action, refreshedTargets, lastBatch.reason)
    } catch (reason: any) {
      setError(reason.message || '刷新失败项版本失败')
      setLoading(false)
    }
  }
  async function generate() {
    if (!chosen.length) return setError('请选择多人盘点子单')
    if (new Set(chosen.map(row => `${row.date}|${row.warehouse}`)).size !== 1) return setError('只能汇总同一盘点日期、同一仓库的子单')
    try { const response = await apiFetch<{ stocktake: { id: string } }>('/api/warehouse-stocktakes/generate-formal-batch', { method: 'POST', body: JSON.stringify({ sourceIds: chosen.map(idOf), countScope: formalType }) }); router.push(`/v2/supply-chain/stocktake/work?doc=${encodeURIComponent(response.stocktake.id)}&from=count`) }
    catch (reason: any) { setError(reason.message || '生成正式盘点单失败') }
  }
  async function exportList() {
    try { const file = await apiFetch<{ filename: string; fileBase64: string }>(`/api/inventory-management/${mode}?${query}&export=1`); download(file) }
    catch (reason: any) { setError(reason.message || '导出失败') }
  }
  function download(file: { filename: string; fileBase64: string }) {
    const url = URL.createObjectURL(new Blob([Uint8Array.from(atob(file.fileBase64), character => character.charCodeAt(0))], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = file.filename; anchor.click(); setTimeout(() => URL.revokeObjectURL?.(url), 1000)
  }
  async function exportDetail(row: ManagementRow) {
    try { download(await apiFetch<{ filename: string; fileBase64: string }>(`/api/warehouse-stocktakes/${encodeURIComponent(idOf(row))}/export`)) }
    catch (reason: any) { setError(reason.message || '导出盘点明细失败') }
  }
  async function preparePrint(targets: ManagementRow[]) {
    if (!targets.length) return setError('请先选择盘点单')
    if (targets.length > 50) return setError('每次最多打印50张盘点单')
    const ids = targets.map(idOf)
    const identity = ids.join('\n')
    const requestKey = printRequestKeys.current.get(identity) || crypto.randomUUID()
    printRequestKeys.current.set(identity, requestKey)
    setPrinting(true); setError('')
    let preparedJobId = ''
    try {
      const prepared = await apiFetch<{ job: { id: string; requestKey: string } }>('/api/warehouse-stocktakes/print-jobs', { method: 'POST', body: JSON.stringify({ requestKey, ids }) })
      preparedJobId = prepared.job.id
      const job = await apiFetch<{ id: string; requestKey: string; documents: StocktakePrintDocument[] }>(`/api/warehouse-stocktakes/print-jobs/${encodeURIComponent(prepared.job.id)}`)
      setPreparedPrint(job)
    } catch (reason: any) {
      // A deterministic snapshot conflict can never recover, so abandon it and
      // let the next click prepare a fresh job. A network/unknown failure is
      // ambiguous and must retain the key so replay returns the original job.
      const deterministicConflict = reason?.status === 409
      if (preparedJobId && deterministicConflict) {
        try {
          await apiFetch(`/api/warehouse-stocktakes/print-jobs/${encodeURIComponent(preparedJobId)}/abandon`, { method: 'POST', body: JSON.stringify({ requestKey }) })
        } catch { /* keep the original preparation error */ }
      }
      if (deterministicConflict) printRequestKeys.current.delete(identity)
      setError(`${reason.message || '打印准备失败，请重试'}${deterministicConflict ? '；请重新准备打印' : '；原请求编号已保留，可安全重试'}`)
    }
    finally { setPrinting(false) }
  }
  async function completePrint() {
    if (!preparedPrint) return
    setPrinting(true); setError('')
    try {
      await apiFetch(`/api/warehouse-stocktakes/print-jobs/${encodeURIComponent(preparedPrint.id)}/complete`, { method: 'POST', body: JSON.stringify({ requestKey: preparedPrint.requestKey }) })
      printRequestKeys.current.delete(preparedPrint.documents.map(document => document.id).join('\n'))
      setPreparedPrint(null); setNotice('已记录当前版本完成过浏览器打印流程'); setRefresh(value => value + 1)
    } catch (reason: any) { setError(reason.message || '打印结果确认失败，预览已保留') }
    finally { setPrinting(false) }
  }
  async function abandonPrint() {
    if (!preparedPrint) return
    setPrinting(true); setError('')
    try {
      await apiFetch(`/api/warehouse-stocktakes/print-jobs/${encodeURIComponent(preparedPrint.id)}/abandon`, { method: 'POST', body: JSON.stringify({ requestKey: preparedPrint.requestKey }) })
      printRequestKeys.current.delete(preparedPrint.documents.map(document => document.id).join('\n'))
      setPreparedPrint(null); setNotice('已关闭打印预览，未改变打印状态')
    } catch (reason: any) { setError(reason.message || '关闭打印任务失败') }
    finally { setPrinting(false) }
  }

  return <main className="space-y-4 p-5">
    <header><h1 className="text-h1">{mode === 'count' ? '盘点单' : '多人盘点单'}</h1><p className="text-caption text-gray2">{mode === 'multi-count' ? '多人分别建立独立子单，审核后勾选同日同仓子单汇总正式盘点单。' : '审核即调整库存并生成盘盈/盘亏；复审后锁定。'}</p></header>
    {error && <p role="alert" className="bg-red-50 p-3 text-red-700">{error}</p>}{notice && <p role="status" className="bg-green-50 p-3 text-green-700">{notice}</p>}
    <section className="flex flex-wrap items-end gap-2"><label>日期类型<select value={dateField} onChange={event => setDateField(event.target.value)}><option value="date">盘点日期</option><option value="createdAt">创建时间</option></select></label><label>开始<input type="date" value={start} onChange={event => setStart(event.target.value)} /></label><label>结束<input type="date" value={end} onChange={event => setEnd(event.target.value)} /></label><label>单号<input value={filters.no || ''} onChange={event => setFilter('no', event.target.value)} /></label><label>仓库<input value={filters.warehouse || ''} onChange={event => setFilter('warehouse', event.target.value)} /></label><label>状态<select value={filters.status || ''} onChange={event => setFilter('status', event.target.value)}><option value="">全部</option>{(result?.options.status || []).map(value => <option key={value}>{value}</option>)}</select></label><label>打印状态<select value={filters.printed || ''} onChange={event => setFilter('printed', event.target.value)}><option value="">全部</option>{(result?.options.printed || ['未打印', '已打印', '修改后待重打']).map(value => <option key={value}>{value}</option>)}</select></label>{mode === 'count' && <label>复审<select value={filters.review || ''} onChange={event => setFilter('review', event.target.value)}><option value="">全部</option>{(result?.options.review || []).map(value => <option key={value}>{value}</option>)}</select></label>}{mode === 'multi-count' && <label>是否生成<select value={filters.generated || ''} onChange={event => setFilter('generated', event.target.value)}><option value="">全部</option><option>是</option><option>否</option></select></label>}<label>备注<input value={filters.note || ''} onChange={event => setFilter('note', event.target.value)} /></label></section>
    <nav className="flex flex-wrap gap-2"><button disabled={!canWrite} onClick={() => router.push(`/v2/supply-chain/stocktake/work?create=1&from=${mode}`)}>新增</button><button disabled={!chosen.length || !canWrite || loading} onClick={() => void executeBatch('submit', chosen)}>批量提交</button><button disabled={!chosen.length || !canAudit || loading} onClick={() => void executeBatch('approve', chosen)}>批量审核</button>{mode === 'count' && <><button disabled={!chosen.length || !canAudit || loading} onClick={() => void executeBatch('final-review', chosen)}>批量复审</button><button disabled={!chosen.length || !canAudit || loading} onClick={() => void executeBatch('reverse-approval', chosen)}>批量反审核</button></>}{mode === 'multi-count' && <><select aria-label="正式盘点类型" value={formalType} onChange={event => setFormalType(event.target.value as typeof formalType)}><option value="SELECTED">指定物品</option><option value="DAILY">日盘</option><option value="WEEKLY">周盘</option><option value="ALL">全部盘点</option></select><button disabled={!chosen.length || !canAudit} onClick={() => void generate()}>生成盘点单</button></>}<button disabled={!chosen.length || !canWrite || loading} onClick={() => void executeBatch('delete', chosen)}>批量删除</button><button disabled={!chosen.length || chosen.length > 50 || printing} onClick={() => void preparePrint(chosen)}>打印选中单据</button><button disabled={!rows.length} onClick={() => void exportList()}>导出列表</button></nav>
    <div className="flex flex-wrap items-center gap-3 text-caption"><span>已选 {selected.size} 张</span>{selected.size >= 100 && <span role="status" className="text-red-700">已达到每批100张上限</span>}{selected.size > 0 && <button onClick={() => setSelected(new Map())}>清空选择</button>}<label>每页<select value={pageSize} onChange={event => { setPageSize(Number(event.target.value)); setPage(1) }}><option value="20">20</option><option value="50">50</option><option value="100">100</option></select></label></div>
    {batchResult && <aside aria-label="批量操作结果" className="space-y-2 border p-3"><div className="flex items-center justify-between"><strong>批量结果</strong><button onClick={() => setBatchResult(null)}>关闭</button></div><p>成功 {batchResult.summary.succeeded}，失败 {batchResult.summary.failed}，未处理 {batchResult.summary.skipped + batchResult.summary.pending}</p><ul>{batchResult.results.map(item => <li key={item.id}>{item.no}：{item.outcome === 'SUCCEEDED' ? '成功' : item.outcome === 'FAILED' ? '失败' : item.outcome === 'SKIPPED' ? '未处理' : '处理中'}{item.message ? `（${item.message}）` : ''}</li>)}</ul>{batchResult.results.some(item => ['FAILED', 'SKIPPED'].includes(item.outcome)) && <button onClick={() => void retryFailed()}>只重试失败/未处理项</button>}</aside>}
    {loading ? <p>加载中…</p> : <div className="overflow-auto"><table><thead><tr><th>选择</th>{result?.columns.map(column => <th key={column.key}>{column.label}</th>)}<th>操作</th></tr></thead><tbody>{rows.map(row => { const id = idOf(row); const canDelete = canWrite && ['草稿', '盘点中', '已取消'].includes(String(row.status)); return <tr key={id}><td><input aria-label={`选择${row.no}`} type="checkbox" checked={selected.has(id)} disabled={!selected.has(id) && selected.size >= 100} onChange={event => toggle(row, event.target.checked)} /></td>{result?.columns.map(column => <td key={column.key}>{String(row[column.key] ?? '—')}</td>)}<td><button onClick={() => router.push(`/v2/supply-chain/stocktake/work?doc=${encodeURIComponent(id)}&from=${mode}`)}>{['草稿', '盘点中'].includes(String(row.status)) && canWrite ? '编辑' : '查看'}</button>{mode === 'count' && <><button onClick={() => router.push(`/v2/supply-chain/stocktake/count/${encodeURIComponent(id)}?source=warehouse`)}>复盘差异</button>{canAudit && String(row.status) === '已审核' && String(row.review) === '未复审' && <button onClick={() => void executeBatch('reverse-approval', [selectedRow(row)])}>反审核</button>}</>}{mode === 'multi-count' && row.generatedStocktakeId && <button onClick={() => router.push(`/v2/supply-chain/stocktake/work?doc=${encodeURIComponent(String(row.generatedStocktakeId))}&from=count`)}>查看正式单</button>}<button disabled={printing} onClick={() => void preparePrint([selectedRow(row)])}>打印</button><button onClick={() => void exportDetail(row)}>导出明细</button>{canDelete && <button onClick={() => void executeBatch('delete', [selectedRow(row)])}>删除</button>}</td></tr> })}</tbody></table></div>}
    <nav aria-label="分页" className="flex items-center gap-3"><button disabled={page <= 1 || loading} onClick={() => setPage(value => Math.max(1, value - 1))}>上一页</button><span>第 {result?.page || page} / {totalPages} 页，共 {result?.total || 0} 张</span><button disabled={page >= totalPages || loading} onClick={() => setPage(value => Math.min(totalPages, value + 1))}>下一页</button></nav>
    <p className="text-caption text-gray2">打印状态表示当前版本是否完成过浏览器打印流程；浏览器无法证明打印机已实际出纸。</p>
    {preparedPrint && <StocktakePrintPreview documents={preparedPrint.documents} busy={printing} onComplete={completePrint} onAbandon={abandonPrint} />}
  </main>
}
