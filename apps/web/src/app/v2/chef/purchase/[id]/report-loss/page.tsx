/**
 * 厨师长 · 验收后「补报短量」(向供应商, 多轮)
 *
 * 2026-06 客户要求: 验收只有一次机会不够, 第一次报损可能遗漏, 需要在验收之后
 * 一直开放报损入口, 可多轮补报来补上遗漏的短量.
 *
 * 与验收页区别:
 *   - 验收页 (receive): PATCH /api/orders/:id/receive, 一次性, 仅 PENDING_CONFIRM
 *   - 本页 (report-loss): POST /api/loss-claims, 可对已验收/已完成的 PO 反复发起,
 *     每轮生成一张新的 LossClaim, 各自走 24h 未响应自动同意 + 扣账期
 *
 * 录入口径: 每项填「本次还短缺多少」, 后端 lossQty = 实发(shippedQty) − receivedQty,
 * 故 receivedQty = shippedQty − 本次短缺.
 */
'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Chip } from '@/components/v2'
import { ConfirmSheet, useConfirmSheet } from '@/components/v2/confirm-sheet'
import { apiFetch } from '@/lib/v2-auth'

export default function ReportLossPage({ params }: { params: { id: string } }) {
  const router = useRouter()
  const [po, setPo] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [shortage, setShortage] = useState<Record<string, number>>({})   // 本次短缺量
  const [description, setDescription] = useState('')
  const [evidence, setEvidence] = useState<string[]>([])
  const [uploading, setUploading] = useState(false)
  const [confirmState, openConfirm] = useConfirmSheet()

  useEffect(() => {
    apiFetch(`/api/orders/${params.id}`).then((d: any) => setPo(d))
      .catch(e => setError(String(e?.message || e)))
  }, [params.id])

  if (error) return <div className="p-6 text-red-fg">{error}</div>
  if (!po) return <div className="p-6 text-gray3 text-caption">加载中…</div>

  const items = po.items || []
  const expected = (it: any) => Number(it.shippedQty ?? it.quantity)
  const lossAmount = items.reduce((s: number, it: any) => {
    const n = Number(shortage[it.productId] || 0)
    return n > 0 ? s + n * Number(it.unitPrice) : s
  }, 0)
  const hasLoss = items.some((it: any) => Number(shortage[it.productId] || 0) > 0)

  async function uploadPhoto(file: File) {
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append('file', file, file.name || 'evidence.jpg')
      const res = await apiFetch<{ url: string }>('/api/upload?category=loss-claims', { method: 'POST', body: fd as any })
      setEvidence(prev => [...prev, res.url])
    } catch (e: any) {
      alert('上传失败: ' + (e?.message || e))
    } finally {
      setUploading(false)
    }
  }

  function submit() {
    if (submitting) return
    if (!hasLoss) return alert('请至少为 1 项填写本次短缺数量')
    openConfirm({
      title: `补报短量 ¥${lossAmount.toFixed(2)}`,
      body: `向 ${po.supplier?.name || '供应商'} 补发起报损索赔，24h 内未响应自动同意。可多轮补报。`,
      confirmLabel: '提交补报',
      tone: 'primary',
      onConfirm: async () => {
        setSubmitting(true)
        try {
          // 仅提交有短缺的项; receivedQty = 实发 − 本次短缺
          const payloadItems = items
            .filter((it: any) => Number(shortage[it.productId] || 0) > 0)
            .map((it: any) => ({
              productId: it.productId,
              receivedQty: Math.max(0, expected(it) - Number(shortage[it.productId] || 0)),
            }))
          await apiFetch('/api/loss-claims', {
            method: 'POST',
            body: JSON.stringify({
              purchaseOrderId: po.id,
              description: description.trim() || `验收后补报短量 (${po.no})`,
              evidenceImages: evidence,
              items: payloadItems,
            }),
          })
          router.push(`/v2/chef/purchase/po-success/${po.id}`)
        } catch (e: any) {
          alert(e.message || '补报失败')
          setSubmitting(false)
          throw e
        }
      },
    })
  }

  return (
    <div className="min-h-screen bg-bg pb-32">
      <header className="px-4 pt-4 pb-2 flex items-center gap-2">
        <button onClick={() => router.back()} className="text-gray2 text-h2">‹</button>
        <h1 className="text-h1">补报短量</h1>
      </header>

      {/* PO 信息 */}
      <div className="mx-4 mt-2 bg-white rounded-card border border-border p-3">
        <div className="flex items-center justify-between">
          <span className="text-h2">{po.supplier?.name}</span>
          <span className="font-num text-h2">¥{Number(po.totalAmount).toLocaleString()}</span>
        </div>
        <p className="text-caption text-gray3 mt-1">{po.no} · {items.length} 项</p>
      </div>

      <div className="mx-4 mt-3 bg-amber/10 border border-amber/40 rounded-card p-3 text-micro text-gray2">
        💡 验收时已报过损也没关系, 这里可继续补报遗漏的短量. 每次补报独立生成报损单, 24h 内供应商未响应自动同意.
      </div>

      {/* 逐条填本次短缺 */}
      <Section title="逐条填写本次短缺数量" right={hasLoss ? `补报 ¥${lossAmount.toFixed(2)}` : '未填'} rightTone={hasLoss ? 'red' : undefined}>
        <ul className="bg-white rounded-card border border-border divide-y divide-border">
          {items.map((it: any) => {
            const exp = expected(it)
            const n = shortage[it.productId] || 0
            const isLoss = n > 0
            return (
              <li key={it.productId} className={`px-3 py-3 ${isLoss ? 'bg-red-bg/30' : ''}`}>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-h2 flex-1 truncate">
                    {it.product?.name || it.productId}
                    {it.product?.spec && <span className="text-micro text-gray3 ml-1 font-normal">· {it.product.spec}</span>}
                  </span>
                  {isLoss && <Chip tone="red">短缺 {n}</Chip>}
                </div>
                <div className="text-micro text-gray3 mb-2 font-num">
                  实发 {exp} {it.product?.unit || ''} × ¥{Number(it.unitPrice).toFixed(2)}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-caption text-gray2">本次短缺</span>
                  <button type="button"
                    onClick={() => setShortage({ ...shortage, [it.productId]: Math.max(0, (shortage[it.productId] || 0) - 1) })}
                    className="w-8 h-8 rounded-md bg-bg flex items-center justify-center text-h2">−</button>
                  <input
                    type="number" min="0" step="0.01" max={exp}
                    value={shortage[it.productId] ?? 0}
                    onChange={(e) => setShortage({ ...shortage, [it.productId]: Math.max(0, Math.min(exp, Number(e.target.value))) })}
                    className="flex-1 text-center font-num text-h2 bg-bg rounded-md py-1"
                  />
                  <button type="button"
                    onClick={() => setShortage({ ...shortage, [it.productId]: Math.min(exp, (shortage[it.productId] || 0) + 1) })}
                    className="w-8 h-8 rounded-md bg-bg flex items-center justify-center text-h2">+</button>
                  <span className="text-micro text-gray3 w-12 text-right">{it.product?.unit || ''}</span>
                </div>
                {isLoss && (
                  <p className="text-micro text-red-fg mt-2">本次损失 ¥{(n * Number(it.unitPrice)).toFixed(2)}</p>
                )}
              </li>
            )
          })}
        </ul>
      </Section>

      {/* 备注 */}
      <Section title="补报说明 (选填)">
        <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)}
          placeholder="例: 入库后清点发现 XX 实际少 2 件 / 隔日发现变质..."
          className="w-full bg-white border border-border rounded-cta p-3 text-body text-ink placeholder:text-gray3 focus:outline-none focus:border-accent" />
      </Section>

      {/* 证据 — 可选 */}
      <Section title="报损证据 (建议)" right={`${evidence.length} 份`}>
        <div className={`rounded-card border p-3 ${evidence.length === 0 ? 'bg-amber/10 border-amber/40' : 'bg-white border-border'}`}>
          <p className={`text-micro mb-2 ${evidence.length === 0 ? 'text-amber-fg' : 'text-gray3'}`}>
            {evidence.length === 0
              ? '💡 建议上传现场照片/短视频, 否则供应商可能拒赔 (非必填)'
              : '已上传 ' + evidence.length + ' 份'}
          </p>
          <div className="flex flex-wrap gap-2">
            {evidence.map((url, i) => {
              const isVideo = /\.(mp4|mov|webm|m4v|3gp|3gpp)(?:\?|$)/i.test(url)
              return (
                <div key={i} className="relative w-20 h-20 rounded border border-border overflow-hidden bg-gray5">
                  {isVideo
                    ? <video src={url} muted playsInline preload="metadata" className="w-full h-full object-cover" />
                    : <img src={url} alt="" className="w-full h-full object-cover" />}
                  {isVideo && <span className="absolute bottom-0 left-0 right-0 bg-ink/60 text-white text-micro text-center py-0.5">▶ 视频</span>}
                  <button onClick={() => setEvidence(evidence.filter((_, j) => j !== i))}
                          className="absolute top-0 right-0 bg-ink/70 text-white w-5 h-5 rounded-bl text-micro flex items-center justify-center">×</button>
                </div>
              )
            })}
            <label className="w-20 h-20 rounded border-2 border-dashed border-border flex flex-col items-center justify-center cursor-pointer hover:bg-bg-warm">
              <input type="file" accept="image/*,video/*" multiple className="hidden"
                     onChange={async e => {
                       const files = Array.from(e.target.files || [])
                       e.target.value = ''
                       for (const f of files) {
                         if (f.type.startsWith('video/') && f.size > 30 * 1024 * 1024) {
                           alert(`视频"${f.name}"超过 30MB, 请压缩后再传`)
                           continue
                         }
                         await uploadPhoto(f)
                       }
                     }} />
              <span className="text-h2 text-gray3">{uploading ? '⏳' : '+'}</span>
              <span className="text-micro text-gray3">{uploading ? '上传中' : '加证据'}</span>
            </label>
          </div>
          <p className="text-micro text-gray3 mt-2">图片 ≤10MB · 视频 ≤30MB · 多选</p>
        </div>
      </Section>

      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-border p-3 flex gap-3">
        <button type="button" onClick={() => router.back()} className="px-4 py-3 bg-white border border-border rounded-cta text-button text-gray2">取消</button>
        <button onClick={submit} disabled={submitting || !hasLoss}
          className="flex-1 py-3 rounded-cta text-button bg-ink text-white disabled:opacity-40">
          {submitting ? '提交中…' : hasLoss ? `提交补报 · ¥${lossAmount.toFixed(2)}` : '请填写短缺数量'}
        </button>
      </div>

      <ConfirmSheet {...confirmState} />
    </div>
  )
}

function Section({ title, right, rightTone, children }: { title: string; right?: string; rightTone?: 'red'; children: React.ReactNode }) {
  return (
    <section className="px-4 mt-5">
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="text-h2">{title}</h2>
        {right && <span className={`text-caption ${rightTone === 'red' ? 'text-red-fg' : 'text-gray3'}`}>{right}</span>}
      </div>
      {children}
    </section>
  )
}
