/**
 * 厨师长 · 收货页 (PDF: chef_purchasing_tab "去验收")
 *
 * 接 PATCH /api/orders/:id/receive {items: [{productId, receivedQty}]}
 * - 默认显示下单数量, 用户改实收
 * - 实收 < 下单 → 自动产生 LossClaim (后端处理)
 * - 收货后跳 po-success 页, 看到 ProgressDots 推进 + 报损
 */
'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Chip } from '@/components/v2'
import { ConfirmSheet, useConfirmSheet } from '@/components/v2/confirm-sheet'
import { apiFetch } from '@/lib/v2-auth'

export default function ReceivePage({ params }: { params: { id: string } }) {
  const router = useRouter()
  const [po, setPo] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [received, setReceived] = useState<Record<string, number>>({})
  const [evidence, setEvidence] = useState<string[]>([])     // OSS URL 数组
  const [uploading, setUploading] = useState(false)
  const [confirmState, openConfirm] = useConfirmSheet()

  useEffect(() => {
    apiFetch(`/api/orders/${params.id}`).then((d: any) => {
      setPo(d)
      // 默认 实收 = 供应商实际发货量 (shippedQty), 没有就回退下单 quantity
      const init: Record<string, number> = {}
      ;(d.items || []).forEach((it: any) => {
        init[it.productId] = Number(it.shippedQty ?? it.quantity)
      })
      setReceived(init)
    }).catch(e => setError(String(e?.message || e)))
  }, [params.id])

  if (error) return <div className="p-6 text-red-fg">{error}</div>
  if (!po) return <div className="p-6 text-gray3 text-caption">加载中…</div>

  const items = po.items || []
  // 应到量 = shippedQty (供应商发货时议定的量) ?? quantity (没改过). 实收 < 应到 才算报损
  const expected = (it: any) => Number(it.shippedQty ?? it.quantity)
  const hasLoss = items.some((it: any) => Number(received[it.productId] ?? 0) < expected(it))
  const lossAmount = items.reduce((s: number, it: any) => {
    const diff = expected(it) - Number(received[it.productId] ?? 0)
    return diff > 0 ? s + diff * Number(it.unitPrice) : s
  }, 0)
  const total = items.reduce((s: number, it: any) =>
    s + Number(received[it.productId] ?? 0) * Number(it.unitPrice), 0)

  async function uploadPhoto(file: File) {
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append('file', file, file.name || 'evidence.jpg')
      const res = await apiFetch<{ url: string }>('/api/upload?category=loss-claims', { method: 'POST', body: fd as any })
      setEvidence(prev => [...prev, res.url])
    } catch (e: any) {
      alert('上传失败: ' + (e.message || e))
    } finally {
      setUploading(false)
    }
  }
  function submit() {
    if (submitting) return
    const doSubmit = async () => {
      setSubmitting(true)
      try {
        await apiFetch(`/api/orders/${params.id}/receive`, {
          method: 'PATCH',
          body: JSON.stringify({
            items: items.map((it: any) => ({
              productId: it.productId,
              receivedQty: Number(received[it.productId] ?? 0),
            })),
            evidenceImages: hasLoss ? evidence : undefined,
          }),
        })
        router.push(`/v2/chef/purchase/po-success/${params.id}`)
      } catch (e: any) {
        alert(e.message || '收货失败')
        setSubmitting(false)
        throw e
      }
    }
    if (hasLoss) {
      openConfirm({
        title: `本单存在报损 ¥${lossAmount.toFixed(2)}`,
        body: '确认收货后将自动向供应商发起报损索赔，24h 内未响应自动同意。',
        confirmLabel: '确认收货',
        tone: 'primary',
        onConfirm: doSubmit,
      })
    } else {
      doSubmit()
    }
  }

  return (
    <div className="min-h-screen bg-bg pb-32">
      <header className="px-4 pt-4 pb-2 flex items-center gap-2">
        <button onClick={() => router.back()} className="text-gray2 text-h2">‹</button>
        <h1 className="text-h1">验收</h1>
      </header>

      {/* PO 信息 */}
      <div className="mx-4 mt-2 bg-white rounded-card border border-border p-3">
        <div className="flex items-center justify-between">
          <span className="text-h2">{po.supplier?.name}</span>
          <span className="font-num text-h2">¥{Number(po.totalAmount).toLocaleString()}</span>
        </div>
        <p className="text-caption text-gray3 mt-1">{po.no} · {items.length} 项</p>
      </div>

      {/* 商品逐条核对 */}
      <Section title="逐条核对实收数量" right={hasLoss ? `报损 ¥${lossAmount.toFixed(2)}` : '一致'} rightTone={hasLoss ? 'red' : 'green'}>
        <ul className="bg-white rounded-card border border-border divide-y divide-border">
          {items.map((it: any) => {
            const rq = received[it.productId] ?? 0
            const ordered = Number(it.quantity)
            const shipped = it.shippedQty != null ? Number(it.shippedQty) : null
            const exp = shipped != null ? shipped : ordered
            const isLoss = rq < exp
            const supplierShortShipped = shipped != null && shipped < ordered
            // 「按下单索赔」: 把实收设回 0 (或减到供应商少发的量), 让差额计入报损
            // 等同于"我不接受供应商擅自调减, 要求按 5 件赔"
            function claimByOrdered() {
              setReceived({ ...received, [it.productId]: rq })  // 实收不变, 但把比较基准换成 ordered (UI 提示)
            }
            // 一键 = 强制让 expected 用 ordered. 我们用前端临时标记: 把实收设为 max(rq, shipped) 但通过 0.001 偏移触发报损显示
            // 简单做法: 给行加一个 state, 用户主动选"按下单量验收"
            return (
              <li key={it.productId} className={`px-3 py-3 ${isLoss ? 'bg-red-bg/30' : ''}`}>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-h2 flex-1">{it.product?.name || it.productId}</span>
                  {isLoss && <Chip tone="red">报损 {(exp - rq).toFixed(2)}</Chip>}
                </div>
                <div className="text-micro text-gray3 mb-2 font-num">
                  下单 {ordered} {it.product?.unit || ''}
                  {supplierShortShipped && <span className="text-amber-fg ml-1">→ 实发 {shipped}</span>}
                  {' '}× ¥{Number(it.unitPrice).toFixed(2)}
                </div>
                {/* 供应商少发 — 仅信息提示, 因金额已按实发算清, 不存在报损需求 */}
                {supplierShortShipped && (
                  <div className="mb-2 text-micro text-gray3 bg-bg rounded-cta p-2">
                    ⓘ 供应商发货时已调减 {(ordered - (shipped ?? 0)).toFixed(2)} {it.product?.unit || ''} (金额已按实发 ¥{((shipped ?? 0) * Number(it.unitPrice)).toFixed(2)} 算清)
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <span className="text-caption text-gray2">实收</span>
                  <button
                    type="button"
                    onClick={() => setReceived({ ...received, [it.productId]: Math.max(0, (received[it.productId] || 0) - 1) })}
                    className="w-8 h-8 rounded-md bg-bg flex items-center justify-center text-h2"
                  >−</button>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={received[it.productId] ?? 0}
                    onChange={(e) => setReceived({ ...received, [it.productId]: Number(e.target.value) })}
                    className="flex-1 text-center font-num text-h2 bg-bg rounded-md py-1"
                  />
                  <button
                    type="button"
                    onClick={() => setReceived({ ...received, [it.productId]: (received[it.productId] || 0) + 1 })}
                    className="w-8 h-8 rounded-md bg-bg flex items-center justify-center text-h2"
                  >+</button>
                  <span className="text-micro text-gray3 w-12 text-right">{it.product?.unit || ''}</span>
                </div>
                {isLoss && (
                  <p className="text-micro text-red-fg mt-2">短缺 {(exp - rq).toFixed(2)} {it.product?.unit || ''} · 损失 ¥{((exp - rq) * Number(it.unitPrice)).toFixed(2)}</p>
                )}
              </li>
            )
          })}
        </ul>
      </Section>

      <Section title="收货说明">
        <div className="bg-white rounded-card border border-border p-3">
          <p className="text-caption text-gray2">
            实收金额：<span className="font-num text-h2 text-ink">¥{total.toFixed(2)}</span>
          </p>
          {hasLoss && (
            <p className="text-caption text-red-fg mt-1">
              本单存在报损 ¥{lossAmount.toFixed(2)}，提交后自动向 {po.supplier?.name} 发起索赔。
              对方 24h 未响应将自动同意扣减账期。
            </p>
          )}
        </div>
      </Section>

      {/* 报损证据照片 — 有报损时强制必传 */}
      {hasLoss && (
        <Section id="evidence-section" title="报损证据 *" right={`${evidence.length} 张${evidence.length === 0 ? ' · 至少 1 张' : ''}`} rightTone={evidence.length === 0 ? 'red' : undefined}>
          <div className={`rounded-card border p-3 ${evidence.length === 0 ? 'bg-red-bg/30 border-red/40' : 'bg-white border-border'}`}>
            <p className={`text-micro mb-2 ${evidence.length === 0 ? 'text-red-fg' : 'text-gray3'}`}>
              {evidence.length === 0
                ? '⚠ 报损必须上传至少 1 张现场照片, 否则供应商可拒赔'
                : '拍照证据 — 短量 / 破损 / 变质 现场图, 已上传 ' + evidence.length + ' 张'}
            </p>
            <div className="flex flex-wrap gap-2">
              {evidence.map((url, i) => (
                <div key={i} className="relative w-20 h-20 rounded border border-border overflow-hidden">
                  <img src={url} alt="" className="w-full h-full object-cover" />
                  <button onClick={() => setEvidence(evidence.filter((_, j) => j !== i))}
                          className="absolute top-0 right-0 bg-ink/70 text-white w-5 h-5 rounded-bl text-micro flex items-center justify-center">×</button>
                </div>
              ))}
              <label className="w-20 h-20 rounded border-2 border-dashed border-border flex flex-col items-center justify-center cursor-pointer hover:bg-bg-warm">
                <input type="file" accept="image/*" capture="environment"
                       className="hidden"
                       onChange={e => {
                         const f = e.target.files?.[0]
                         if (f) uploadPhoto(f)
                         e.target.value = ''
                       }} />
                <span className="text-h2 text-gray3">{uploading ? '⏳' : '+'}</span>
                <span className="text-micro text-gray3">{uploading ? '上传中' : '加图'}</span>
              </label>
            </div>
          </div>
        </Section>
      )}

      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-border p-3 flex gap-3">
        <button type="button" onClick={() => router.back()} className="px-4 py-3 bg-white border border-border rounded-cta text-button text-gray2">取消</button>
        <button
          onClick={() => {
            // 没传证据时点按钮 → 自动滚到上传区, 不直接 disabled (用户摸不着头脑)
            if (hasLoss && evidence.length === 0) {
              const el = document.getElementById('evidence-section')
              if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
              return
            }
            submit()
          }}
          disabled={submitting}
          className={`flex-1 py-3 rounded-cta text-button transition ${
            (hasLoss && evidence.length === 0)
              ? 'bg-amber text-white animate-pulse'
              : 'bg-ink text-white disabled:opacity-40'
          }`}
        >
          {submitting ? '提交中…' :
            (hasLoss && evidence.length === 0)
              ? '⚠ 点这里去上传报损证据 ↓'
              : `确认收货 · ¥${total.toFixed(2)}`}
        </button>
      </div>

      <ConfirmSheet {...confirmState} />
    </div>
  )
}

function Section({ id, title, right, rightTone, children }: { id?: string; title: string; right?: string; rightTone?: 'red' | 'green'; children: React.ReactNode }) {
  return (
    <section id={id} className="px-4 mt-5 scroll-mt-4">
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="text-h2">{title}</h2>
        {right && <span className={`text-caption ${rightTone === 'red' ? 'text-red-fg' : rightTone === 'green' ? 'text-green-fg' : 'text-gray3'}`}>{right}</span>}
      </div>
      {children}
    </section>
  )
}
