'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Chip } from '@/components/v2'
import { ConfirmSheet, useConfirmSheet } from '@/components/v2/confirm-sheet'
import { apiFetch } from '@/lib/v2-auth'

type ClaimKind = 'ARRIVAL_DAMAGE' | 'ARRIVAL_SHORTAGE'

export default function PostReceiptLossPage({ params }: { params: { id: string } }) {
  const router = useRouter()
  const [po, setPo] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)
  const [receiptId, setReceiptId] = useState('')
  const [kind, setKind] = useState<ClaimKind>('ARRIVAL_DAMAGE')
  const [quantity, setQuantity] = useState<Record<string, number>>({})
  const [reason, setReason] = useState('')
  const [description, setDescription] = useState('')
  const [evidence, setEvidence] = useState<string[]>([])
  const [uploading, setUploading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [confirmState, openConfirm] = useConfirmSheet()

  useEffect(() => {
    apiFetch(`/api/orders/${params.id}`)
      .then((data: any) => {
        setPo(data)
        const eligible = eligibleReceipts(data)
        setReceiptId(eligible[eligible.length - 1]?.id || '')
      })
      .catch((e: any) => setError(e?.message || '加载失败'))
  }, [params.id])

  const receipts = useMemo(() => eligibleReceipts(po), [po])
  const receipt = receipts.find((item: any) => item.id === receiptId)
  const productRows = useMemo(() => aggregateReceiptItems(receipt?.items || []), [receipt])
  const claimedByProduct = useMemo(() => {
    const result: Record<string, number> = {}
    for (const claim of po?.lossClaims || []) {
      if (claim.receiptId !== receiptId || claim.payableBasis !== 'GROSS_PENDING_CLAIM') continue
      for (const item of claim.items || []) result[item.productId] = (result[item.productId] || 0) + Number(item.lossQty || 0)
    }
    return result
  }, [po, receiptId])
  const selected = productRows.filter(row => Number(quantity[row.productId] || 0) > 0)
  const total = selected.reduce((sum, row) => sum + Number(quantity[row.productId]) * row.unitPrice, 0)

  async function upload(file: File) {
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append('file', file, file.name || 'evidence.jpg')
      const result = await apiFetch<{ url: string }>('/api/upload?category=loss-claims', { method: 'POST', body: fd as any })
      setEvidence(current => [...current, result.url].slice(0, 9))
    } catch (e: any) {
      alert(e?.message || '证据上传失败')
    } finally {
      setUploading(false)
    }
  }

  function submit() {
    if (!receipt) return alert('没有处于 48 小时补报期内的收货单')
    if (!selected.length) return alert('请至少填写 1 项异常数量')
    if (!reason.trim() || !description.trim()) return alert('请填写异常原因和具体说明')
    if (!evidence.length) return alert('请至少上传 1 份现场照片或视频')
    openConfirm({
      title: `提交到货异常 ¥${total.toFixed(2)}`,
      body: '提交后异常数量立即移出可用库存，供应商需在 24 小时内处理。',
      confirmLabel: '确认提交',
      tone: 'primary',
      onConfirm: async () => {
        setSubmitting(true)
        try {
          await apiFetch('/api/loss-claims', {
            method: 'POST',
            body: JSON.stringify({
              purchaseOrderId: po.id,
              receiptId: receipt.id,
              kind,
              reason: reason.trim(),
              description: description.trim(),
              evidenceImages: evidence,
              items: selected.map(row => ({ productId: row.productId, lossQty: Number(quantity[row.productId]) })),
            }),
          })
          router.push(`/v2/chef/purchase/po-success/${po.id}`)
        } catch (e: any) {
          alert(e?.message || '补报失败')
          setSubmitting(false)
          throw e
        }
      },
    })
  }

  if (error) return <div className="p-6 text-red-fg">{error}</div>
  if (!po) return <div className="p-6 text-caption text-gray3">加载中…</div>

  return (
    <div className="min-h-screen bg-bg pb-32">
      <header className="px-4 pt-4 pb-2 flex items-center gap-2">
        <button onClick={() => router.back()} className="text-gray2 text-h2">‹</button>
        <h1 className="text-h1">收货后补报异常</h1>
      </header>

      <div className="mx-4 mt-3 bg-amber/10 border border-amber/40 rounded-card p-3">
        <div className="flex items-center gap-2"><Chip tone="orange">48 小时内</Chip><b className="text-body">拆包后发现异常可补报</b></div>
        <p className="text-micro text-gray2 mt-2">异常实物提交后立即从可用库存中隔离；供应商同意后扣减应付，拒绝则转总厨仲裁。</p>
      </div>

      {!receipts.length ? (
        <div className="mx-4 mt-4 bg-white border border-border rounded-card p-5 text-center">
          <p className="text-h2">当前没有可补报的收货单</p>
          <p className="text-caption text-gray3 mt-2">仅支持收货确认后 48 小时内补报；超时请走门店内部报损。</p>
          <button onClick={() => router.push('/v2/chef/check/new')} className="mt-4 px-5 py-3 bg-ink text-white rounded-cta text-button">登记店内报损</button>
        </div>
      ) : (
        <>
          <Section title="1. 选择收货单">
            <select value={receiptId} onChange={e => { setReceiptId(e.target.value); setQuantity({}) }} className="w-full bg-white border border-border rounded-cta p-3 text-body">
              {receipts.map((item: any) => <option key={item.id} value={item.id}>{item.no} · {new Date(item.confirmedAt).toLocaleString('zh-CN')} · 截止 {deadlineText(item)}</option>)}
            </select>
          </Section>

          <Section title="2. 异常类型">
            <div className="grid grid-cols-2 gap-2">
              <button onClick={() => setKind('ARRIVAL_DAMAGE')} className={`py-3 rounded-cta border text-button ${kind === 'ARRIVAL_DAMAGE' ? 'bg-ink text-white border-ink' : 'bg-white border-border'}`}>破损 / 品质异常</button>
              <button onClick={() => setKind('ARRIVAL_SHORTAGE')} className={`py-3 rounded-cta border text-button ${kind === 'ARRIVAL_SHORTAGE' ? 'bg-ink text-white border-ink' : 'bg-white border-border'}`}>拆包后发现短量</button>
            </div>
          </Section>

          <Section title="3. 填写异常数量" right={selected.length ? `${selected.length} 项 · ¥${total.toFixed(2)}` : '未填写'}>
            <ul className="bg-white rounded-card border border-border divide-y divide-border">
              {productRows.map(row => {
                const max = Math.max(0, row.receivedQty - (claimedByProduct[row.productId] || 0))
                const value = Number(quantity[row.productId] || 0)
                return (
                  <li key={row.productId} className={`p-3 ${value > 0 ? 'bg-red-bg/30' : ''}`}>
                    <div className="flex justify-between gap-2">
                      <div className="min-w-0"><b className="text-body">{row.name}</b><p className="text-micro text-gray3">实收 {row.receivedQty} {row.unit} · 已补报 {claimedByProduct[row.productId] || 0} · 可补报 {max}</p></div>
                      <span className="font-num text-caption">¥{row.unitPrice.toFixed(2)}/{row.unit}</span>
                    </div>
                    <div className="flex items-center gap-2 mt-2">
                      <button onClick={() => setQuantity({ ...quantity, [row.productId]: Math.max(0, value - 1) })} className="w-10 h-10 bg-bg rounded-md text-h2">−</button>
                      <input type="number" min="0" max={max} step="0.01" value={quantity[row.productId] ?? 0}
                        onChange={e => setQuantity({ ...quantity, [row.productId]: Math.max(0, Math.min(max, Number(e.target.value) || 0)) })}
                        className="flex-1 min-w-0 text-center font-num text-h2 bg-bg rounded-md py-2" />
                      <button onClick={() => setQuantity({ ...quantity, [row.productId]: Math.min(max, value + 1) })} className="w-10 h-10 bg-bg rounded-md text-h2">+</button>
                      <span className="text-caption text-gray3 w-10">{row.unit}</span>
                    </div>
                  </li>
                )
              })}
            </ul>
          </Section>

          <Section title="4. 原因与说明">
            <input value={reason} onChange={e => setReason(e.target.value)} placeholder="异常原因，如：开箱发现腐坏" className="w-full bg-white border border-border rounded-cta p-3 text-body" />
            <textarea value={description} onChange={e => setDescription(e.target.value)} rows={3} placeholder="说明发现时间、包装状态、具体异常情况" className="w-full mt-2 bg-white border border-border rounded-cta p-3 text-body" />
          </Section>

          <Section title="5. 现场证据（必填）" right={`${evidence.length}/9`}>
            <div className="bg-white border border-border rounded-card p-3">
              <div className="flex gap-2 flex-wrap">
                {evidence.map((url, index) => (
                  <div key={url} className="relative w-20 h-20">
                    {isVideoEvidence(url)
                      ? <video src={url} muted playsInline preload="metadata" className="w-full h-full object-cover rounded border border-border" />
                      : <img src={url} alt="异常证据" className="w-full h-full object-cover rounded border border-border" />}
                    <button onClick={() => setEvidence(evidence.filter((_, i) => i !== index))} className="absolute top-0 right-0 w-6 h-6 bg-ink/70 text-white rounded-bl">×</button>
                  </div>
                ))}
                <label className="w-20 h-20 border-2 border-dashed border-border rounded flex flex-col items-center justify-center cursor-pointer text-gray3">
                  <input type="file" accept="image/*,video/*" multiple className="hidden" onChange={async e => { const files = Array.from(e.target.files || []); e.target.value = ''; for (const file of files) await upload(file) }} />
                  <span className="text-h2">{uploading ? '…' : '+'}</span><span className="text-micro">照片/视频</span>
                </label>
              </div>
            </div>
          </Section>

          <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-border p-3 flex gap-2">
            <button onClick={() => router.back()} className="px-4 py-3 bg-white border border-border rounded-cta text-button">取消</button>
            <button disabled={submitting || uploading || !selected.length} onClick={submit} className="flex-1 py-3 bg-ink text-white rounded-cta text-button disabled:opacity-40">{submitting ? '提交中…' : `提交异常 · ¥${total.toFixed(2)}`}</button>
          </div>
        </>
      )}
      <ConfirmSheet {...confirmState} />
    </div>
  )
}

function eligibleReceipts(po: any) {
  const now = Date.now()
  return (po?.receipts || []).filter((receipt: any) => receipt.confirmedAt && ['CONFIRMED', 'ACCOUNTED'].includes(receipt.status) && new Date(receipt.confirmedAt).getTime() + 48 * 60 * 60 * 1000 >= now)
}

function deadlineText(receipt: any) {
  return new Date(new Date(receipt.confirmedAt).getTime() + 48 * 60 * 60 * 1000).toLocaleString('zh-CN')
}

function isVideoEvidence(url: string) {
  return /\.(mp4|mov|m4v|webm)(?:\?|#|$)/i.test(url)
}

function aggregateReceiptItems(items: any[]) {
  const rows = new Map<string, { productId: string; name: string; unit: string; receivedQty: number; amount: number; unitPrice: number }>()
  for (const item of items) {
    const current = rows.get(item.productId) || { productId: item.productId, name: item.product?.name || item.productNameSnapshot || '商品', unit: item.productUnitSnapshot || item.product?.unit || '', receivedQty: 0, amount: 0, unitPrice: 0 }
    current.receivedQty += Number(item.quantity || 0)
    current.amount += Number(item.amount || 0)
    current.unitPrice = current.receivedQty > 0 ? current.amount / current.receivedQty : 0
    rows.set(item.productId, current)
  }
  return [...rows.values()]
}

function Section({ title, right, children }: { title: string; right?: string; children: React.ReactNode }) {
  return <section className="px-4 mt-5"><div className="flex justify-between items-baseline mb-2"><h2 className="text-h2">{title}</h2>{right && <span className="text-caption text-gray3">{right}</span>}</div>{children}</section>
}
