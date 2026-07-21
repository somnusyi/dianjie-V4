'use client'

import { useEffect, useMemo, useState } from 'react'
import { apiFetch } from '@/lib/v2-auth'
import { formatQuantity } from '@/lib/format'

type CountItem = {
  id: string; productNameSnapshot: string; productCodeSnapshot: string; productSpecSnapshot?: string | null
  categorySnapshot?: string | null; unitSnapshot: string
  bookQuantity: number; countedQuantity: number | null; averageUnitCost: number
  differenceQuantity: number | null; differenceAmount: number | null
  reasonCode?: string | null; reasonNote?: string | null; evidenceKeys: string[]; evidenceUrls: string[]
}
type Count = {
  id: string; no: string; countDate: string; revision: number; status: string; rowVersion: number
  itemCount: number; countedCount: number; differenceCount: number
  totalBookValue: number; totalCountedValue: number; totalDifferenceValue: number
  store: { name: string; no: string }; items: CountItem[]
  reversalReason?: string | null
}
type Draft = { quantity: string; reasonCode: string; reasonNote: string; evidenceKeys: string[]; evidenceUrls: string[] }

const REASONS = [
  ['WEIGHING', '称重/计量差异'], ['SPOILAGE', '变质损耗'], ['WASTE', '加工损耗'],
  ['UNRECORDED', '漏记领用/入库'], ['BREAKAGE', '破损/撒漏'], ['OTHER', '其他'],
]

export default function InventoryCountDetailPage({ params }: { params: { id: string } }) {
  const [count, setCount] = useState<Count | null>(null)
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [filter, setFilter] = useState<'all' | 'uncounted' | 'difference'>('all')
  const [keyword, setKeyword] = useState('')
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState('')
  const [error, setError] = useState('')
  const [issues, setIssues] = useState<string[]>([])
  const [reverseReason, setReverseReason] = useState('')
  const [cancelReason, setCancelReason] = useState('')

  const applyCount = (next: Count) => {
    setCount(next)
    setDrafts(Object.fromEntries(next.items.map(item => [item.id, {
      quantity: item.countedQuantity == null ? '' : String(item.countedQuantity),
      reasonCode: item.reasonCode || '', reasonNote: item.reasonNote || '',
      evidenceKeys: item.evidenceKeys || [], evidenceUrls: item.evidenceUrls || [],
    }])))
  }
  const load = () => apiFetch<Count>(`/api/inventory-counts/${params.id}`).then(applyCount).catch(error => setError(error.message))
  useEffect(() => { load() }, [params.id])

  const visible = useMemo(() => (count?.items || []).filter(item => {
    const draft = drafts[item.id]
    const quantity = draft?.quantity === '' ? null : Number(draft?.quantity)
    const difference = quantity == null ? null : quantity - item.bookQuantity
    if (keyword && !`${item.productNameSnapshot}${item.productCodeSnapshot}${item.categorySnapshot || ''}`.toLowerCase().includes(keyword.toLowerCase())) return false
    if (filter === 'uncounted' && quantity != null) return false
    if (filter === 'difference' && (difference == null || Math.abs(difference) < 0.000001)) return false
    return true
  }), [count, drafts, filter, keyword])

  const save = async () => {
    if (!count) return
    const items = count.items.filter(item => drafts[item.id]?.quantity !== '').map(item => ({
      id: item.id, countedQuantity: Number(drafts[item.id].quantity),
      reasonCode: drafts[item.id].reasonCode || null, reasonNote: drafts[item.id].reasonNote || null,
      evidenceKeys: drafts[item.id].evidenceKeys,
    }))
    if (items.length === 0) return setError('请至少填写一个实盘数量；零库存请填 0')
    setBusy(true); setError(''); setIssues([])
    try {
      applyCount(await apiFetch<Count>(`/api/inventory-counts/${count.id}/items`, {
        method: 'PUT', body: JSON.stringify({ rowVersion: count.rowVersion, items }),
      }))
    } catch (error: any) { setError(error.message || '保存失败') } finally { setBusy(false) }
  }

  const transition = async (action: 'start' | 'submit' | 'confirm') => {
    if (!count) return
    setBusy(true); setError(''); setIssues([])
    try {
      applyCount(await apiFetch<Count>(`/api/inventory-counts/${count.id}/${action}`, {
        method: 'POST', body: JSON.stringify({ rowVersion: count.rowVersion }),
      }))
    } catch (error: any) {
      setError(error.message || '操作失败'); setIssues(error.data?.issues || [])
    } finally { setBusy(false) }
  }

  const reverse = async () => {
    if (!count || reverseReason.trim().length < 4) return setError('请填写至少 4 个字的冲销原因')
    setBusy(true); setError('')
    try {
      applyCount(await apiFetch<Count>(`/api/inventory-counts/${count.id}/reverse`, {
        method: 'POST', body: JSON.stringify({ rowVersion: count.rowVersion, reason: reverseReason }),
      }))
      setReverseReason('')
    } catch (error: any) { setError(error.message || '冲销失败') } finally { setBusy(false) }
  }

  const cancel = async () => {
    if (!count || cancelReason.trim().length < 2) return setError('请填写至少 2 个字的取消原因')
    setBusy(true); setError('')
    try {
      applyCount(await apiFetch<Count>(`/api/inventory-counts/${count.id}/cancel`, {
        method: 'POST', body: JSON.stringify({ rowVersion: count.rowVersion, reason: cancelReason }),
      }))
      setCancelReason('')
    } catch (error: any) { setError(error.message || '取消失败') } finally { setBusy(false) }
  }

  const upload = async (itemId: string, file: File | null) => {
    if (!file) return
    setUploading(itemId); setError('')
    try {
      const form = new FormData(); form.append('file', file)
      const result = await apiFetch<{ key: string; url: string }>('/api/upload?category=inventory-counts', { method: 'POST', body: form })
      setDrafts(current => ({ ...current, [itemId]: {
        ...current[itemId], evidenceKeys: [...current[itemId].evidenceKeys, result.key], evidenceUrls: [...current[itemId].evidenceUrls, result.url],
      } }))
    } catch (error: any) { setError(error.message || '图片上传失败') } finally { setUploading('') }
  }

  if (!count) return <div className="min-h-screen bg-bg p-6 text-center text-caption text-gray3">{error || '加载盘点单…'}</div>
  const editable = count.status === 'COUNTING'

  return (
    <div className="min-h-screen bg-bg pb-28">
      <header className="sticky top-0 z-20 bg-bg/95 backdrop-blur border-b border-border px-4 py-3">
        <div className="flex items-center gap-3"><a href="/v2/inventory-counts" className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center">‹</a><div className="flex-1"><h1 className="text-h2">{count.store.name} · {count.countDate}</h1><p className="text-micro text-gray3">{count.no} · {statusText(count.status)}</p></div><span className="text-caption text-gray2">{count.countedCount}/{count.itemCount}</span></div>
      </header>
      <main className="px-4">
        <section className="mt-4 grid grid-cols-3 rounded-card bg-white border border-border divide-x divide-border text-center">
          <Metric label="账面金额" value={count.totalBookValue} />
          <Metric label="实盘金额" value={count.totalCountedValue} />
          <Metric label="差异金额" value={count.totalDifferenceValue} warn={Math.abs(count.totalDifferenceValue) > 0.001} />
        </section>
        <div className="mt-3 rounded-card bg-amber/10 border border-amber/30 p-3 text-caption text-gray2">盘点差异只校准门店库存，不改变供应商库存、供应商应付或已确认入库单。</div>
        {error && <div className="mt-3 rounded-card bg-red-bg text-red-fg p-3 text-caption">{error}</div>}
        {issues.length > 0 && <ul className="mt-2 rounded-card bg-red-bg text-red-fg p-3 text-caption space-y-1">{issues.map(issue => <li key={issue}>• {issue}</li>)}</ul>}

        {editable && <div className="mt-4"><input value={keyword} onChange={event => setKeyword(event.target.value)} placeholder="搜索食材 / 编码 / 分类" className="w-full rounded-cta bg-white border border-border px-3 py-3 text-body" /><div className="flex gap-2 mt-2">{(['all','uncounted','difference'] as const).map(value => <button key={value} onClick={() => setFilter(value)} className={`px-3 py-2 rounded-chip text-caption ${filter === value ? 'bg-ink text-white' : 'bg-white border border-border text-gray2'}`}>{value === 'all' ? '全部' : value === 'uncounted' ? '未盘' : '有差异'}</button>)}</div></div>}

        <section className="mt-4 space-y-2">
          {visible.map(item => {
            const draft = drafts[item.id]
            const counted = draft?.quantity === '' ? null : Number(draft?.quantity)
            const difference = counted == null ? null : counted - item.bookQuantity
            const amount = difference == null ? null : difference * item.averageUnitCost
            const needsReason = difference != null && Math.abs(difference) > 0.000001
            const needsEvidence = needsReason && ((Math.abs(item.bookQuantity) > 0 ? Math.abs(difference! / item.bookQuantity) > 0.05 : true) || Math.abs(amount || 0) > 200)
            return <div key={item.id} className="rounded-card bg-white border border-border p-3">
              <div className="flex items-start gap-3"><div className="flex-1 min-w-0"><div className="text-button truncate">{item.productNameSnapshot}</div><div className="text-micro text-gray3 mt-0.5">{item.productCodeSnapshot} · {item.productSpecSnapshot || item.categorySnapshot || '食材'} · 账面 {formatQuantity(item.bookQuantity, item.unitSnapshot)}</div></div>{difference != null && <span className={`text-caption font-num ${Math.abs(difference) < 0.000001 ? 'text-green-fg' : difference < 0 ? 'text-red-fg' : 'text-amber-fg'}`}>{difference > 0 ? '+' : ''}{difference.toFixed(3)}</span>}</div>
              {editable ? <><div className="flex items-center gap-2 mt-3"><span className="text-caption text-gray2">实盘</span><input type="number" min="0" step="any" inputMode="decimal" value={draft?.quantity || ''} onChange={event => setDrafts(current => ({ ...current, [item.id]: { ...current[item.id], quantity: event.target.value } }))} className="flex-1 rounded-cta border border-border bg-bg px-3 py-2.5 text-right font-num" /><span className="text-caption text-gray2">{item.unitSnapshot}</span></div>{needsReason && <div className="mt-2 space-y-2"><select value={draft.reasonCode} onChange={event => setDrafts(current => ({ ...current, [item.id]: { ...current[item.id], reasonCode: event.target.value } }))} className="w-full rounded-cta border border-border bg-bg px-3 py-2.5 text-caption"><option value="">选择差异原因（必填）</option>{REASONS.map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select><input value={draft.reasonNote} onChange={event => setDrafts(current => ({ ...current, [item.id]: { ...current[item.id], reasonNote: event.target.value } }))} placeholder="补充说明（选填）" className="w-full rounded-cta border border-border bg-bg px-3 py-2.5 text-caption" />{needsEvidence && <label className="block rounded-cta border border-dashed border-amber px-3 py-2.5 text-center text-caption text-amber-fg">{uploading === item.id ? '图片上传中…' : draft.evidenceKeys.length > 0 ? `已上传 ${draft.evidenceKeys.length} 张，可继续添加` : '差异超过阈值，上传图片证据'}<input type="file" accept="image/*" capture="environment" className="hidden" disabled={uploading === item.id || draft.evidenceKeys.length >= 6} onChange={event => upload(item.id, event.target.files?.[0] || null)} /></label>}</div>}</> : <div className="mt-2 text-caption text-gray2">实盘 {formatQuantity(Number(item.countedQuantity ?? 0), item.unitSnapshot)}{item.reasonCode ? ` · ${REASONS.find(r => r[0] === item.reasonCode)?.[1] || item.reasonCode}` : ''}</div>}
            </div>
          })}
        </section>

        {count.status === 'CONFIRMED' && <section className="mt-5 rounded-card bg-white border border-border p-3"><div className="text-button">发现整单录错？</div><p className="text-micro text-gray3 mt-1">只能冲销当前最新盘点基准，然后重新建立盘点单；不能直接修改已确认数据。</p><textarea value={reverseReason} onChange={event => setReverseReason(event.target.value)} placeholder="填写冲销原因（至少 4 个字）" className="w-full mt-2 rounded-cta bg-bg border border-border p-3 text-caption" /><button onClick={reverse} disabled={busy || reverseReason.trim().length < 4} className="w-full mt-2 rounded-cta bg-red-bg text-red-fg py-3 text-button disabled:opacity-35">冲销并等待重新盘点</button></section>}
        {(count.status === 'DRAFT' || count.status === 'COUNTING') && <section className="mt-5 rounded-card bg-white border border-border p-3"><div className="text-button">取消本次盘点</div><p className="text-micro text-gray3 mt-1">取消后不会改变库存，也不会保留为可信盘点基准。</p><div className="flex gap-2 mt-2"><input value={cancelReason} onChange={event => setCancelReason(event.target.value)} placeholder="取消原因" className="flex-1 rounded-cta bg-bg border border-border px-3 py-2.5 text-caption" /><button onClick={cancel} disabled={busy || cancelReason.trim().length < 2} className="rounded-cta bg-red-bg text-red-fg px-4 text-button disabled:opacity-35">取消</button></div></section>}
        {count.status === 'REVERSED' && <div className="mt-4 rounded-card bg-red-bg text-red-fg p-3 text-caption">该盘点已冲销：{count.reversalReason}</div>}
      </main>

      {(count.status === 'DRAFT' || editable || count.status === 'REVIEWING') && <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-border p-3 flex gap-2 z-20">{count.status === 'DRAFT' ? <button onClick={() => transition('start')} disabled={busy} className="w-full rounded-cta bg-ink text-white py-3 text-button disabled:opacity-35">开始录入盘点</button> : editable ? <><button onClick={save} disabled={busy} className="flex-1 rounded-cta border border-border py-3 text-button disabled:opacity-35">{busy ? '保存中…' : '保存进度'}</button><button onClick={() => transition('submit')} disabled={busy || count.countedCount !== count.itemCount} className="flex-[1.4] rounded-cta bg-amber text-white py-3 text-button disabled:opacity-35">提交核对</button></> : <button onClick={() => transition('confirm')} disabled={busy} className="w-full rounded-cta bg-ink text-white py-3 text-button disabled:opacity-35">{busy ? '确认中…' : '确认盘点并建立新库存基准'}</button>}</div>}
    </div>
  )
}

function Metric({ label, value, warn }: { label: string; value: number; warn?: boolean }) { return <div className="p-3"><div className="text-micro text-gray3">{label}</div><div className={`text-h2 font-num mt-1 ${warn ? value < 0 ? 'text-red-fg' : 'text-amber-fg' : ''}`}>¥{Number(value || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}</div></div> }
function statusText(status: string) { return ({ DRAFT:'待开始', COUNTING:'盘点中', REVIEWING:'待确认', CONFIRMED:'已确认', CANCELLED:'已取消', REVERSED:'已冲销' } as Record<string,string>)[status] || status }
