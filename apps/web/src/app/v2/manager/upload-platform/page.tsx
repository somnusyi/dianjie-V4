/** 店长每日两表上传：综合营业统计 + 菜品销售明细。 */
'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ConfirmSheet, useConfirmSheet } from '@/components/v2/confirm-sheet'
import { apiFetch, getUser } from '@/lib/v2-auth'
import { canConfirmDailyImport, formatUploadFileSize, IMPORT_STATUS, splitDailyImportIssues, type DailyImportStatus } from './upload-state'

type Issue = { code: string; message: string; detail?: string }
type ImportRecord = {
  id: string
  businessDate: string
  revision: number
  status: DailyImportStatus
  businessFileName: string
  salesFileName: string
  grossAmount: number
  discountAmount: number
  netRevenue: number
  orderCount: number
  dishRowCount: number
  blockingIssues: Issue[]
  warningIssues: Issue[]
  previewData: {
    totals: { quantity: number; grossAmount: number; discountAmount: number; netIncome: number }
    dishSales: Array<unknown>
    consumptions: Array<{ productName: string; unit: string; quantity: number }>
    excludedDishes: Array<unknown>
    existingConfirmedRevision: number | null
  }
  createdAt: string
  confirmedAt?: string | null
}
type DailyStatus = {
  store: { id: string; name: string; no: string }
  requestedDate: string
  expectedBusinessDate: string
  dueAt: string
  state: 'PENDING' | 'OVERDUE' | 'CONFIRMED'
  latest: ImportRecord | null
  history: ImportRecord[]
}

const money = (value: number) => `¥${Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const shortDate = (value: string) => String(value || '').slice(0, 10)
export default function DailyBusinessUploadPage() {
  const [status, setStatus] = useState<DailyStatus | null>(null)
  const [businessFile, setBusinessFile] = useState<File | null>(null)
  const [salesFile, setSalesFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<ImportRecord | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmSheet, openConfirmSheet] = useConfirmSheet()
  const user = useMemo(() => getUser(), [])

  const loadStatus = useCallback(async (quiet = false, selectLatest = false) => {
    try {
      const data = await apiFetch<DailyStatus>('/api/daily-business-imports/status')
      setStatus(data)
      setPreview(current => {
        if (data.latest?.status === 'PREVIEWED' && (current?.id === data.latest.id || (selectLatest && !current))) return data.latest
        if (current) return data.history.find(row => row.id === current.id) || current
        return null
      })
      if (!quiet) setError(null)
    } catch (reason: any) {
      if (!quiet) setError(reason.message || '状态加载失败')
    }
  }, [])

  useEffect(() => {
    loadStatus(false, true)
    const timer = window.setInterval(() => loadStatus(true), 60_000)
    return () => window.clearInterval(timer)
  }, [loadStatus])

  function selectFile(kind: 'business' | 'sales') {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    input.onchange = () => {
      const file = input.files?.[0]
      if (!file) return
      if (file.size > 5 * 1024 * 1024) { setError('单个文件不能超过 5MB'); return }
      if (kind === 'business') setBusinessFile(file)
      else setSalesFile(file)
      setPreview(null)
      setError(null)
    }
    input.click()
  }

  async function createPreview() {
    if (!businessFile || !salesFile) { setError('请先选择两份文件'); return }
    setBusy(true); setError(null)
    try {
      const form = new FormData()
      form.append('businessFile', businessFile)
      form.append('salesFile', salesFile)
      if (user?.storeId) form.append('storeId', user.storeId)
      const result = await apiFetch<ImportRecord>('/api/daily-business-imports/preview', { method: 'POST', body: form })
      setPreview(result)
      await loadStatus(true)
    } catch (reason: any) {
      setError(reason.message || '预览失败')
    } finally { setBusy(false) }
  }

  async function performConfirmImport(target: ImportRecord, deferredCount: number) {
    setBusy(true); setError(null)
    try {
      const result = await apiFetch<ImportRecord>(`/api/daily-business-imports/${target.id}/confirm`, {
        method: 'POST', body: JSON.stringify({ deferBomIssues: deferredCount > 0 }),
      })
      setPreview(result)
      setBusinessFile(null); setSalesFile(null)
      await loadStatus(true)
    } catch (reason: any) {
      if (reason?.data?.code === 'PREVIEW_REFRESHED' && reason.data.import) {
        setPreview(reason.data.import)
        setError('扣减结果已自动刷新，本次尚未写入数据。请重新核对后，再点击下方按钮完成确认。')
        return
      }
      setError(reason.message || '确认失败')
    } finally { setBusy(false) }
  }

  function requestConfirmImport() {
    if (!preview || !canConfirmDailyImport(preview.status, preview.blockingIssues)) return
    const target = preview
    const { deferred } = splitDailyImportIssues(target.blockingIssues)
    const hasDeferred = deferred.length > 0
    openConfirmSheet({
      title: hasDeferred ? `暂缓 ${deferred.length} 项并确认导入？` : '确认导入？',
      body: hasDeferred
        ? `营业日：${shortDate(target.businessDate)}\n已能计算的 ${target.previewData?.consumptions?.length || 0} 个食材 SKU 将立即扣减。\n${deferred.length} 项将转交总厨，补齐 BOM 后自动回补本日消耗。`
        : `确认导入 ${shortDate(target.businessDate)} 的营业与销量数据，并按 BOM 扣减库存？`,
      confirmLabel: hasDeferred ? '暂缓并确认' : '确认导入',
      tone: 'primary',
      onConfirm: () => performConfirmImport(target, deferred.length),
    })
  }

  const expected = status?.expectedBusinessDate || '前一日'
  const issueGroups = splitDailyImportIssues(preview?.blockingIssues || [])
  return (
    <div className="min-h-screen bg-bg pb-16">
      <header className="px-4 pt-4 pb-2 flex items-center gap-3">
        <button onClick={() => history.back()} className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center">‹</button>
        <div className="flex-1">
          <h1 className="text-h1">每日营业数据</h1>
          <p className="text-caption text-gray3">{status?.store.name || user?.store?.name || '本店'} · 每日上午 11:00 前</p>
        </div>
      </header>

      <div className={`mx-4 mt-3 rounded-card border p-3 ${
        status?.state === 'CONFIRMED' ? 'bg-green-bg border-green-fg/20' :
          status?.state === 'OVERDUE' ? 'bg-red-bg border-red-fg/20' : 'bg-amber/10 border-amber/30'
      }`}>
        <div className="flex items-center gap-3">
          <span className="text-h2">{status?.state === 'CONFIRMED' ? '✓' : status?.state === 'OVERDUE' ? '!' : '◷'}</span>
          <div className="flex-1">
            <div className="text-button">
              {status?.state === 'CONFIRMED' ? `${expected} 已确认` : status?.state === 'OVERDUE' ? `${expected} 日报已逾期` : `请上传 ${expected} 日报`}
            </div>
            <div className="text-micro text-gray2 mt-0.5">
              {status?.state === 'CONFIRMED' ? '营业、销量和库存消耗已同步' : '两份表必须为同一营业日，预览无误后再确认'}
            </div>
          </div>
          {status?.latest && <span className="text-micro text-gray3">第 {status.latest.revision} 版</span>}
        </div>
      </div>

      <section className="px-4 mt-5">
        <div className="flex items-baseline justify-between mb-2">
          <h2 className="text-h2">1. 选择两份文件</h2>
          <span className="text-micro text-gray3">仅 XLSX · 单份 ≤ 5MB</span>
        </div>
        <div className="space-y-2">
          <FileCard
            title="综合营业统计"
            hint="包含营业额、营业收入、优惠金额、订单量"
            file={businessFile}
            onPick={() => selectFile('business')}
          />
          <FileCard
            title="菜品销售明细"
            hint="选择“单品+套餐明细”，用于销量与 BOM 扣减"
            file={salesFile}
            onPick={() => selectFile('sales')}
          />
        </div>
        <button
          onClick={createPreview}
          disabled={busy || !businessFile || !salesFile}
          className="w-full mt-3 py-3 rounded-cta bg-ink text-white text-button disabled:opacity-35"
        >{busy ? '解析中…' : '生成预览'}</button>
      </section>

      {error && <div className="mx-4 mt-3 bg-red-bg text-red-fg rounded-card p-3 text-caption">{error}</div>}

      {preview && (
        <section className="px-4 mt-5">
          <div className="flex items-baseline justify-between mb-2">
            <h2 className="text-h2">2. 核对并确认</h2>
            <span className="text-caption text-gray3">{shortDate(preview.businessDate)} · 第 {preview.revision} 版</span>
          </div>
          <div className="bg-white rounded-card border border-border overflow-hidden">
            <div className="grid grid-cols-2 divide-x divide-y divide-border">
              <Metric label="营业额" value={money(preview.grossAmount)} />
              <Metric label="营业收入" value={money(preview.netRevenue)} />
              <Metric label="订单量" value={`${preview.orderCount} 笔`} />
              <Metric label="优惠金额" value={money(preview.discountAmount)} />
            </div>
            <div className="px-3 py-3 border-t border-border text-caption text-gray2 flex justify-between">
              <span>销售 {preview.previewData?.dishSales?.length || preview.dishRowCount} 个菜品</span>
              <span>扣减 {preview.previewData?.consumptions?.length || 0} 个食材 SKU</span>
            </div>
            <div className="px-3 py-2 border-t border-border text-micro text-gray3 space-y-1">
              <div className="truncate">营业表：{preview.businessFileName}</div>
              <div className="truncate">销售表：{preview.salesFileName}</div>
            </div>
          </div>

          {preview.previewData?.consumptions?.length > 0 && (
            <details className="mt-3 bg-white rounded-card border border-border">
              <summary className="px-3 py-3 text-caption cursor-pointer">查看预计食材扣减明细（{preview.previewData.consumptions.length} 项）</summary>
              <div className="border-t border-border divide-y divide-border max-h-72 overflow-auto">
                {preview.previewData.consumptions.map((row, index) => (
                  <div key={`${row.productName}-${index}`} className="px-3 py-2 flex justify-between gap-3 text-caption">
                    <span className="min-w-0 truncate">{row.productName}</span>
                    <span className="font-num whitespace-nowrap">{Number(row.quantity).toLocaleString('zh-CN', { maximumFractionDigits: 6 })} {row.unit}</span>
                  </div>
                ))}
              </div>
            </details>
          )}

          {issueGroups.hard.length > 0 && (
            <IssueBox tone="red" title={`${issueGroups.hard.length} 项问题阻止确认`} issues={issueGroups.hard as Issue[]} />
          )}
          {issueGroups.deferred.length > 0 && (
            <IssueBox
              tone="amber"
              title={preview.status === 'CONFIRMED'
                ? `${issueGroups.deferred.length} 项已转交总厨处理`
                : `${issueGroups.deferred.length} 项可暂缓，确认后转交总厨`}
              issues={issueGroups.deferred as Issue[]}
            />
          )}
          {preview.warningIssues.length > 0 && (
            <IssueBox tone="amber" title="请留意" issues={preview.warningIssues} />
          )}

          {preview.status === 'CONFIRMED' ? (
            <div className="mt-3 py-3 rounded-cta bg-green-bg text-green-fg text-button text-center">✓ 已确认并更新数据</div>
          ) : preview.status === 'SUPERSEDED' ? (
            <div className="mt-3 py-3 rounded-cta bg-bg text-gray3 text-button text-center">此版本已被新版替代，仅供审计查看</div>
          ) : preview.status === 'CONFIRMING' ? (
            <div className="mt-3 py-3 rounded-cta bg-blue/10 text-blue-fg text-button text-center">正在确认，请稍后刷新状态</div>
          ) : (
            <button
              data-testid="confirm-daily-import"
              onClick={requestConfirmImport}
              disabled={busy || !canConfirmDailyImport(preview.status, preview.blockingIssues)}
              className="w-full mt-3 py-3 rounded-cta bg-amber text-white text-button disabled:opacity-35"
            >{busy ? '确认中…' : issueGroups.deferred.length > 0
                ? `暂缓 ${issueGroups.deferred.length} 项并确认导入`
                : preview.previewData?.existingConfirmedRevision ? '确认更正并替换旧版' : '确认导入并扣减库存'}</button>
          )}
          <p className="text-micro text-gray3 mt-2 text-center">确认采用原子事务：任一步失败，营业、销量与库存均不会部分写入</p>
        </section>
      )}

      <section className="px-4 mt-6">
        <div className="flex items-baseline justify-between mb-2">
          <h2 className="text-h2">导入历史</h2>
          <button onClick={() => loadStatus()} disabled={busy} className="text-caption text-amber-fg disabled:opacity-35">
            刷新 · {status?.history.length || 0} 条
          </button>
        </div>
        <div className="bg-white rounded-card border border-border divide-y divide-border">
          {!status && <div className="p-4 text-caption text-gray3 text-center">加载中…</div>}
          {status?.history.length === 0 && <div className="p-5 text-caption text-gray3 text-center">暂无导入记录</div>}
          {status?.history.map(row => (
            <button key={row.id} onClick={() => setPreview(row)} className="w-full px-3 py-3 text-left flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="text-body">{shortDate(row.businessDate)} · {money(row.netRevenue)}</div>
                <div className="text-micro text-gray3 mt-0.5 truncate">第 {row.revision} 版 · {row.orderCount} 笔 · {row.businessFileName}</div>
              </div>
              <span className={`text-micro px-2 py-1 rounded-chip ${IMPORT_STATUS[row.status].badge}`}>
                {IMPORT_STATUS[row.status].label}
              </span>
            </button>
          ))}
        </div>
      </section>
      <ConfirmSheet {...confirmSheet} />
    </div>
  )
}

function FileCard({ title, hint, file, onPick }: { title: string; hint: string; file: File | null; onPick: () => void }) {
  return (
    <button onClick={onPick} className="w-full bg-white rounded-card border border-border p-3 text-left flex items-center gap-3">
      <span className={`w-10 h-10 rounded-md flex items-center justify-center ${file ? 'bg-green-bg text-green-fg' : 'bg-bg text-gray3'}`}>{file ? '✓' : '⇪'}</span>
      <div className="flex-1 min-w-0">
        <div className="text-button">{title}</div>
        <div className={`text-micro mt-0.5 truncate ${file ? 'text-green-fg' : 'text-gray3'}`}>
          {file ? `${file.name} · ${formatUploadFileSize(file.size)}` : hint}
        </div>
      </div>
      <span className="text-caption text-gray3">{file ? '更换' : '选择'}</span>
    </button>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="p-3"><div className="text-micro text-gray3">{label}</div><div className="text-h2 font-num mt-1">{value}</div></div>
}

function IssueBox({ tone, title, issues }: { tone: 'red' | 'amber'; title: string; issues: Issue[] }) {
  const colors = tone === 'red' ? 'bg-red-bg text-red-fg' : 'bg-orange-bg text-orange-fg'
  return (
    <div className={`mt-3 rounded-card p-3 ${colors}`}>
      <div className="text-button">{title}</div>
      <ul className="mt-2 space-y-2">
        {issues.map((issue, index) => <li key={`${issue.code}-${index}`} className="text-caption"><div>• {issue.message}</div>{issue.detail && <div className="text-micro opacity-75 ml-3 mt-0.5">{issue.detail}</div>}</li>)}
      </ul>
    </div>
  )
}
