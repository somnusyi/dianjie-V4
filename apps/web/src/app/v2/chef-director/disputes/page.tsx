/**
 * 总厨 · 报损争议仲裁
 *
 * 流程:
 *   店长发起报损 → 供应商拒绝 (REJECTED) → 总厨在此页仲裁 (RESOLVED, 设最终扣减金额)
 *
 * 接 GET /api/loss-claims?status=REJECTED  + PATCH /api/loss-claims/:id/resolve
 */
'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Chip } from '@/components/v2'
import { apiFetch } from '@/lib/v2-auth'
import dayjs from 'dayjs'

type Claim = {
  id: string; no: string; status: string
  totalLossAmount: string | number
  description?: string | null
  evidenceImages?: string[] | null
  handlerNote?: string | null   // 供应商拒绝理由
  resolvedNote?: string | null
  isManual?: boolean
  reason?: string | null
  createdAt: string
  store?: { name: string } | null
  supplier?: { name: string } | null
  purchaseOrder?: { no: string } | null
  createdBy?: { name: string } | null
  items: { id: string; lossQty: string; unitPrice: string; lossAmount: string
           product?: { name: string; unit: string } }[]
}

export default function DisputesPage() {
  const router = useRouter()
  const [claims, setClaims] = useState<Claim[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [picked, setPicked] = useState<Claim | null>(null)
  const [deduct, setDeduct] = useState('')
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)

  function load() {
    // 拉两批: 1) 供应商拒绝的争议(REJECTED) 2) 店内报损待总厨审(PENDING + isManual)
    Promise.all([
      apiFetch<Claim[]>('/api/loss-claims?status=REJECTED').catch(() => []),
      apiFetch<Claim[]>('/api/loss-claims?status=PENDING').catch(() => []),
    ]).then(([rejected, pending]) => {
      const manualPending = (pending || []).filter(c => c.isManual)
      setClaims([...rejected, ...manualPending])
    }).catch(e => setError(e.message || '加载失败'))
  }
  useEffect(() => { load() }, [])

  function open(c: Claim) {
    setPicked(c)
    setDeduct(String(Number(c.totalLossAmount).toFixed(2)))
    setNote('')
  }
  async function resolve() {
    if (!picked) return
    setSubmitting(true)
    try {
      // 店内报损 (isManual + PENDING) → manual-review
      if (picked.isManual && picked.status === 'PENDING') {
        await apiFetch(`/api/loss-claims/${picked.id}/manual-review`, {
          method: 'PATCH',
          body: JSON.stringify({ action: 'approve', note: note.trim() || undefined }),
        })
      } else {
        // 供应商拒绝的争议 → resolve (要扣减金额)
        const v = Number(deduct)
        if (!Number.isFinite(v) || v < 0) { alert('扣减金额非法'); setSubmitting(false); return }
        if (v > Number(picked.totalLossAmount)) { alert('扣减不能超过报损总额 ¥' + Number(picked.totalLossAmount).toFixed(2)); setSubmitting(false); return }
        await apiFetch(`/api/loss-claims/${picked.id}/resolve`, {
          method: 'PATCH',
          body: JSON.stringify({ finalDeductAmount: v, note: note.trim() || undefined }),
        })
      }
      setPicked(null)
      load()
    } catch (e: any) {
      alert(e.message || '仲裁失败')
    } finally {
      setSubmitting(false)
    }
  }
  async function rejectManual() {
    if (!picked || !picked.isManual) return
    if (!note.trim()) { alert('驳回必须填理由'); return }
    setSubmitting(true)
    try {
      await apiFetch(`/api/loss-claims/${picked.id}/manual-review`, {
        method: 'PATCH', body: JSON.stringify({ action: 'reject', note: note.trim() }),
      })
      setPicked(null); load()
    } catch (e: any) { alert(e.message || '驳回失败') }
    finally { setSubmitting(false) }
  }

  return (
    <div className="min-h-screen bg-bg pb-24">
      <header className="px-4 pt-4 pb-2 flex items-center gap-2">
        <button onClick={() => router.back()} className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center">‹</button>
        <h1 className="text-h1 flex-1">报损争议仲裁</h1>
        {claims && <Chip tone={claims.length > 0 ? 'red' : 'gray'}>{claims.length} 待裁</Chip>}
      </header>

      <p className="px-4 mt-1 text-micro text-gray3">两类待审: ① 供应商拒绝的争议(扣减仲裁) ② 店内报损 ≥¥500(通过/驳回)</p>

      {error && <div className="mx-4 mt-4 bg-red-bg text-red-fg rounded-card p-3 text-caption">{error}</div>}

      {!claims && !error && (
        <div className="mx-4 mt-6 text-center text-gray3">加载中…</div>
      )}
      {claims && claims.length === 0 && (
        <div className="mx-4 mt-12 text-center">
          <div className="text-4xl mb-2">✓</div>
          <p className="text-h2 text-gray2">没有待仲裁争议</p>
          <p className="text-caption text-gray3 mt-1">所有报损都已闭环</p>
        </div>
      )}

      <ul className="mx-4 mt-3 space-y-3">
        {claims?.map(c => (
          <li key={c.id} className="bg-white rounded-card border border-border p-3">
            <div className="flex items-baseline gap-2">
              <span className="font-num text-caption text-gray3">#{c.no}</span>
              {c.isManual ? <Chip tone="blue">店内报损</Chip> : <Chip tone="orange">供应商争议</Chip>}
              <span className="ml-auto text-micro text-gray3">{dayjs(c.createdAt).format('MM/DD HH:mm')}</span>
            </div>
            <div className="mt-2 text-body">
              <span className="font-num text-h2 text-red-fg">¥{Number(c.totalLossAmount).toLocaleString()}</span>
              <span className="text-caption text-gray2 ml-2">
                {c.store?.name}{c.supplier?.name ? ` ↔ ${c.supplier.name}` : ''}
                {c.isManual && c.reason && ` · ${c.reason}`}
              </span>
            </div>
            {c.purchaseOrder?.no && <div className="text-micro text-gray3 mt-1">关联订单: {c.purchaseOrder.no}</div>}
            <div className="mt-2 grid grid-cols-2 gap-2 text-caption">
              <div className="bg-bg rounded-cta p-2">
                <div className="text-micro text-gray3">店长说</div>
                <div className="text-body text-ink mt-0.5 break-words">{c.description || '—'}</div>
              </div>
              <div className="bg-bg rounded-cta p-2">
                <div className="text-micro text-gray3">供应商拒绝理由</div>
                <div className="text-body text-amber-fg mt-0.5 break-words">{c.handlerNote || '(未说明)'}</div>
              </div>
            </div>
            <ul className="mt-2 text-micro text-gray2 space-y-0.5">
              {c.items.slice(0, 3).map(it => (
                <li key={it.id}>· {it.product?.name} 损 <b className="font-num text-red-fg">{it.lossQty}</b> {it.product?.unit} = ¥{Number(it.lossAmount).toFixed(2)}</li>
              ))}
              {c.items.length > 3 && <li className="text-gray3">…还有 {c.items.length - 3} 项</li>}
            </ul>
            {(c.evidenceImages?.length ?? 0) > 0 && (
              <div className="mt-2 flex gap-2 overflow-x-auto">
                {c.evidenceImages!.slice(0, 4).map((u, i) => (
                  <img key={i} src={u} alt="" className="h-20 w-20 object-cover rounded border border-border shrink-0" />
                ))}
                {c.evidenceImages!.length > 4 && <span className="text-micro text-gray3 self-center">+{c.evidenceImages!.length - 4}</span>}
              </div>
            )}
            <button onClick={() => open(c)}
                    className="mt-3 w-full py-2 bg-ink text-white rounded-cta text-button">⚖ 仲裁</button>
          </li>
        ))}
      </ul>

      {/* 仲裁弹层 */}
      {picked && (
        <div className="fixed inset-0 z-50 bg-ink/60 flex items-end justify-center"
             onClick={() => setPicked(null)}>
          <div className="bg-white rounded-t-card w-full max-w-md p-4"
               onClick={e => e.stopPropagation()}
               style={{ paddingBottom: 'calc(16px + env(safe-area-inset-bottom))' }}>
            <div className="w-10 h-1 bg-border rounded-full mx-auto mb-3" />
            <h3 className="text-h2">仲裁 {picked.no}</h3>
            <p className="text-caption text-gray2 mt-1">店长报损 ¥{Number(picked.totalLossAmount).toFixed(2)} · 供应商拒赔</p>

            <div className="mt-3 space-y-2">
              <div className="bg-bg rounded-cta p-2 text-caption">
                <div className="text-micro text-gray3">店长说</div>
                <div className="text-ink mt-0.5">{picked.description || '—'}</div>
              </div>
              <div className="bg-amber/5 rounded-cta p-2 text-caption">
                <div className="text-micro text-gray3">供应商拒绝理由</div>
                <div className="text-amber-fg mt-0.5">{picked.handlerNote || '(未说明)'}</div>
              </div>
            </div>

            {!picked.isManual && (
              <div className="mt-4">
                <label className="text-micro text-gray3 block mb-1">最终扣减金额 ¥</label>
                <input type="number" step="0.01" min="0" max={Number(picked.totalLossAmount)}
                       value={deduct} onChange={e => setDeduct(e.target.value)}
                       className="w-full bg-bg border border-border rounded-cta px-3 py-2 font-num text-h2" />
                <div className="flex gap-2 mt-2">
                  <button onClick={() => setDeduct(String(Number(picked.totalLossAmount).toFixed(2)))}
                          className="flex-1 py-1.5 bg-bg rounded-chip text-caption text-gray2">全赔 ¥{Number(picked.totalLossAmount).toFixed(2)}</button>
                  <button onClick={() => setDeduct(String((Number(picked.totalLossAmount) / 2).toFixed(2)))}
                          className="flex-1 py-1.5 bg-bg rounded-chip text-caption text-gray2">对半 ¥{(Number(picked.totalLossAmount) / 2).toFixed(2)}</button>
                  <button onClick={() => setDeduct('0')}
                          className="flex-1 py-1.5 bg-bg rounded-chip text-caption text-gray2">不赔</button>
                </div>
              </div>
            )}
            <div className="mt-3">
              <label className="text-micro text-gray3 block mb-1">仲裁说明 (可选, 双方都能看到)</label>
              <textarea value={note} onChange={e => setNote(e.target.value)} rows={3} maxLength={200}
                        placeholder="如: 现场照片显示已损 但量未达全部, 半赔合理"
                        className="w-full bg-bg border border-border rounded-cta p-2 text-body" />
            </div>

            {picked.isManual ? (
              // 店内报损 — 通过 / 驳回 (无扣减金额)
              <div className="flex gap-2 mt-4">
                <button onClick={() => setPicked(null)}
                        className="px-3 py-2 border border-border rounded-cta text-button text-gray2">取消</button>
                <button onClick={rejectManual} disabled={submitting}
                        className="flex-1 py-2 bg-white border border-red text-red-fg rounded-cta text-button">驳回</button>
                <button onClick={resolve} disabled={submitting}
                        className="flex-1 py-2 bg-ink text-white rounded-cta text-button disabled:opacity-40">
                  {submitting ? '提交中…' : '通过'}
                </button>
              </div>
            ) : (
              // 供应商争议 — 设最终扣减金额
              <div className="flex gap-2 mt-4">
                <button onClick={() => setPicked(null)}
                        className="px-4 py-2 border border-border rounded-cta text-button text-gray2">取消</button>
                <button onClick={resolve} disabled={submitting}
                        className="flex-1 py-2 bg-ink text-white rounded-cta text-button disabled:opacity-40">
                  {submitting ? '提交中…' : `判定扣 ¥${Number(deduct).toFixed(2)}`}
                </button>
              </div>
            )}
            <p className="text-micro text-gray3 mt-2">{picked.isManual ? '⚠ 通过 = 计入店内损耗 P&L · 驳回 = 不记录, 让店员核对实物' : '⚠ 提交后双方收到通知, 应付款 = 实收金额 - 扣减金额'}</p>
          </div>
        </div>
      )}
    </div>
  )
}
