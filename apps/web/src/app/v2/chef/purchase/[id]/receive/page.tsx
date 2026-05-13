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
  const [confirmState, openConfirm] = useConfirmSheet()

  useEffect(() => {
    apiFetch(`/api/orders/${params.id}`).then((d: any) => {
      setPo(d)
      // 默认 实收 = 下单
      const init: Record<string, number> = {}
      ;(d.items || []).forEach((it: any) => { init[it.productId] = Number(it.quantity) })
      setReceived(init)
    }).catch(e => setError(String(e?.message || e)))
  }, [params.id])

  if (error) return <div className="p-6 text-red-fg">{error}</div>
  if (!po) return <div className="p-6 text-gray3 text-caption">加载中…</div>

  const items = po.items || []
  const hasLoss = items.some((it: any) => Number(received[it.productId] ?? 0) < Number(it.quantity))
  const lossAmount = items.reduce((s: number, it: any) => {
    const diff = Number(it.quantity) - Number(received[it.productId] ?? 0)
    return diff > 0 ? s + diff * Number(it.unitPrice) : s
  }, 0)
  const total = items.reduce((s: number, it: any) =>
    s + Number(received[it.productId] ?? 0) * Number(it.unitPrice), 0)

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
            const isLoss = rq < ordered
            return (
              <li key={it.productId} className={`px-3 py-3 ${isLoss ? 'bg-red-bg/30' : ''}`}>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-h2 flex-1">{it.product?.name || it.productId}</span>
                  {isLoss && <Chip tone="red">报损 {(ordered - rq).toFixed(2)}</Chip>}
                </div>
                <div className="text-micro text-gray3 mb-2 font-num">
                  下单 {ordered} {it.product?.unit || ''} × ¥{Number(it.unitPrice).toFixed(2)}
                </div>
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
                  <p className="text-micro text-red-fg mt-2">短缺 {(ordered - rq).toFixed(2)} {it.product?.unit || ''} · 损失 ¥{((ordered - rq) * Number(it.unitPrice)).toFixed(2)}</p>
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

      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-border p-3 flex gap-3">
        <button type="button" onClick={() => router.back()} className="px-4 py-3 bg-white border border-border rounded-cta text-button text-gray2">取消</button>
        <button
          onClick={submit}
          disabled={submitting}
          className="flex-1 py-3 bg-ink text-white rounded-cta text-button disabled:opacity-40"
        >
          {submitting ? '提交中…' : `确认收货 · ¥${total.toFixed(2)}`}
        </button>
      </div>

      <ConfirmSheet {...confirmState} />
    </div>
  )
}

function Section({ title, right, rightTone, children }: { title: string; right?: string; rightTone?: 'red' | 'green'; children: React.ReactNode }) {
  return (
    <section className="px-4 mt-5">
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="text-h2">{title}</h2>
        {right && <span className={`text-caption ${rightTone === 'red' ? 'text-red-fg' : rightTone === 'green' ? 'text-green-fg' : 'text-gray3'}`}>{right}</span>}
      </div>
      {children}
    </section>
  )
}
