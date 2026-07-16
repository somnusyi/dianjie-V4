/**
 * 厨师长 · 新增店内报损（盘点路径）
 *
 * 与"供应商责任报损"不同：这里录的是临期/客退/破损等店内自有损耗，
 * 不扣供应商账期，直接计入 P&L 损耗成本。
 *
 * POST /api/loss-claims/manual { items, reason, description }
 */
'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Chip } from '@/components/v2'
import { ConfirmSheet, useConfirmSheet } from '@/components/v2/confirm-sheet'
import { apiFetch } from '@/lib/v2-auth'

type Product = {
  id: string; code: string; name: string; unit: string; price: number | string; avgUnitCost?: number | string; stock?: number | string
}
type Reason = '临期' | '变质' | '客退' | '掉落' | '破损' | '其他'
const REASONS: { key: Reason; tone: 'orange' | 'red' | 'blue' | 'gray' }[] = [
  { key: '临期', tone: 'orange' },
  { key: '变质', tone: 'red' },
  { key: '客退', tone: 'blue' },
  { key: '掉落', tone: 'gray' },
  { key: '破损', tone: 'gray' },
  { key: '其他', tone: 'gray' },
]

type Item = { productId: string; quantity: number; unitPrice: number }

export default function ChefLossNewPage() {
  const router = useRouter()
  const [products, setProducts] = useState<Product[] | null>(null)
  const [reason, setReason] = useState<Reason>('临期')
  const [customReason, setCustomReason] = useState('')   // 选"其他"时自填原因
  const [description, setDescription] = useState('')

  // 实际提交的原因: 选"其他"且填了自定义文本时用自定义, 否则用标签
  const effectiveReason = reason === '其他' && customReason.trim() ? customReason.trim() : reason
  const [items, setItems] = useState<Item[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [evidence, setEvidence] = useState<string[]>([])
  const [confirmState, openConfirm] = useConfirmSheet()

  // 上传单张图片到 OSS, 复用 receive 页同款 endpoint
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

  useEffect(() => {
    apiFetch<Product[]>('/api/inventory')
      .then(setProducts)
      .catch(() => apiFetch<Product[]>('/api/products').then(setProducts).catch(() => setProducts([])))
  }, [])

  function addItem(p: Product) {
    if (items.some(i => i.productId === p.id)) return
    setItems([...items, { productId: p.id, quantity: 1, unitPrice: Number(p.avgUnitCost ?? p.price) }])
  }
  function updateQty(idx: number, q: number) {
    setItems(items.map((it, i) => i === idx ? { ...it, quantity: q } : it))
  }
  function removeItem(idx: number) {
    setItems(items.filter((_, i) => i !== idx))
  }

  const total = items.reduce((s, it) => s + it.quantity * it.unitPrice, 0)

  function submit() {
    if (submitting) return
    if (items.length === 0) return alert('请选择至少 1 项商品')
    if (reason === '其他' && !customReason.trim()) return alert('选「其他」时请填写自定义原因')
    openConfirm({
      title: `${effectiveReason} · ¥${total.toFixed(2)}`,
      body: `登记 ${items.length} 项店内报损 · 直接计入 P&L 损耗成本，不影响供应商账期`,
      confirmLabel: '提交',
      tone: 'primary',
      onConfirm: async () => {
        setSubmitting(true)
        try {
          await apiFetch('/api/loss-claims/manual', {
            method: 'POST',
            body: JSON.stringify({ items, reason: effectiveReason, description, evidenceImages: evidence }),
          })
          router.push('/v2/chef/check')
        } catch (e: any) {
          alert(e.message || '提交失败')
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
        <h1 className="text-h1">新增报损</h1>
      </header>

      {/* 原因选择 */}
      <div className="mx-4 mt-2 bg-bg-card rounded-card border border-border p-3">
        <p className="text-micro text-gray3 mb-2">报损原因</p>
        <div className="flex gap-2 flex-wrap">
          {REASONS.map(r => (
            <button
              key={r.key}
              onClick={() => setReason(r.key)}
              className={`px-3 py-1.5 rounded-chip text-button transition ${
                reason === r.key
                  ? 'bg-ink text-white'
                  : 'bg-white border border-border text-gray2'
              }`}
            >{r.key}</button>
          ))}
        </div>
        {/* 选「其他」时自填原因 (2026-06 客户要求: 店内盘损支持自定义) */}
        {reason === '其他' && (
          <input
            type="text"
            value={customReason}
            onChange={(e) => setCustomReason(e.target.value)}
            maxLength={20}
            placeholder="自定义原因 (如: 设备故障损坏 / 试菜消耗)"
            className="mt-2 w-full bg-white border border-border rounded-cta px-3 py-2 text-body text-ink placeholder:text-gray3 focus:outline-none focus:border-accent"
          />
        )}
      </div>

      {/* 商品列表 */}
      <div className="mx-4 mt-3 bg-bg-card rounded-card border border-border p-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-micro text-gray3">报损商品 ({items.length})</span>
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            disabled={!products}
            className="text-button text-accent disabled:opacity-50"
          >+ 添加商品</button>
        </div>
        {items.length === 0 && (
          <p className="text-micro text-gray3 py-3 text-center">点击右上角「+ 添加商品」</p>
        )}
        <ul className="space-y-2">
          {items.map((it, i) => {
            const p = products?.find(pr => pr.id === it.productId)
            return (
              <li key={it.productId} className="flex items-center gap-2 py-1.5 border-b border-border last:border-b-0">
                <div className="flex-1 min-w-0">
                  <div className="text-body truncate">{p?.name || it.productId}</div>
                  <div className="text-micro text-gray3">移动均价 ¥{it.unitPrice.toFixed(2)} / {p?.unit || '件'}</div>
                </div>
                <input
                  type="number"
                  min="0.01" step="0.01"
                  value={it.quantity}
                  onChange={(e) => updateQty(i, Number(e.target.value))}
                  className="w-16 text-right font-num bg-bg rounded-chip px-2 py-1"
                />
                <span className="font-num text-body w-20 text-right">¥{(it.quantity * it.unitPrice).toFixed(2)}</span>
                <button onClick={() => removeItem(i)} className="text-gray3 px-1">×</button>
              </li>
            )
          })}
        </ul>
      </div>

      {/* 备注 */}
      <div className="mx-4 mt-3">
        <label className="text-micro text-gray3 block mb-1">备注（可选）</label>
        <textarea
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="例: 鸭血保质期 04/30 · 已优先用 / 客退原因..."
          className="w-full bg-bg-card border border-border rounded-cta p-2 text-body text-ink placeholder:text-gray3 focus:outline-none focus:border-accent"
        />
      </div>

      {/* 证据 — 图片 + 短视频 (≤50MB), 多选 */}
      <div className="mx-4 mt-3">
        <label className="text-micro text-gray3 block mb-1">证据（可选, 图片+短视频, 多选）</label>
        <div className="flex items-center gap-2 flex-wrap">
          {evidence.map((url, i) => {
            const isVideo = /\.(mp4|mov|webm|m4v|3gp|3gpp)(?:\?|$)/i.test(url)
            return (
              <div key={i} className="relative w-20 h-20 rounded border border-border overflow-hidden bg-gray5">
                {isVideo ? (
                  <video src={url} muted playsInline preload="metadata" className="w-full h-full object-cover" />
                ) : (
                  <img src={url} alt="" className="w-full h-full object-cover" />
                )}
                {isVideo && (
                  <span className="absolute bottom-0 left-0 right-0 bg-ink/60 text-white text-micro text-center py-0.5">▶ 视频</span>
                )}
                <button type="button" onClick={() => setEvidence(evidence.filter((_, j) => j !== i))}
                        className="absolute top-0 right-0 bg-ink/70 text-white w-5 h-5 rounded-bl text-micro flex items-center justify-center">×</button>
              </div>
            )
          })}
          <label className="w-20 h-20 rounded border-2 border-dashed border-border flex flex-col items-center justify-center cursor-pointer hover:bg-bg-warm">
            <input type="file" accept="image/*,video/*" multiple
                   className="hidden"
                   onChange={async e => {
                     const files = Array.from(e.target.files || [])
                     e.target.value = ''
                     for (const f of files) {
                       if (f.type.startsWith('video/') && f.size > 50 * 1024 * 1024) {
                         alert(`视频"${f.name}"超过 50MB, 请压缩后再传`)
                         continue
                       }
                       await uploadPhoto(f)
                     }
                   }} />
            <span className="text-h2 text-gray3">{uploading ? '⏳' : '+'}</span>
            <span className="text-micro text-gray3">{uploading ? '上传中' : '加证据'}</span>
          </label>
        </div>
        <p className="text-micro text-gray3 mt-1">图片 ≤10MB · 视频 ≤50MB · 点 + 可从相册 / 现场拍/录, 多选</p>
      </div>

      {/* 底部固定 */}
      <div className="fixed bottom-0 left-0 right-0 bg-bg-card border-t border-border p-4 flex gap-2 items-center" style={{ paddingBottom: 'calc(16px + env(safe-area-inset-bottom))' }}>
        <div className="flex-1">
          <div className="text-micro text-gray3">合计</div>
          <div className="font-num text-h2 text-red-fg">¥{total.toFixed(2)}</div>
        </div>
        <button
          onClick={() => router.back()}
          className="px-4 py-3 bg-white border border-border rounded-cta text-button text-gray2"
        >取消</button>
        <button
          onClick={submit}
          disabled={submitting || items.length === 0}
          className="flex-1 py-3 bg-ink text-white rounded-cta text-button disabled:opacity-40"
        >{submitting ? '提交中…' : `提交报损 · ¥${total.toFixed(2)}`}</button>
      </div>

      {/* Picker drawer */}
      {pickerOpen && (
        <div className="fixed inset-0 z-50 bg-ink/40 flex items-end" onClick={() => setPickerOpen(false)}>
          <div className="bg-bg-card w-full max-h-[70vh] rounded-t-card flex flex-col" onClick={e => e.stopPropagation()}>
            <header className="px-4 py-3 border-b border-border flex items-center justify-between">
              <h2 className="text-h2">选择商品</h2>
              <button onClick={() => setPickerOpen(false)} className="text-gray3">完成</button>
            </header>
            <ul className="overflow-y-auto flex-1">
              {(products || []).map(p => {
                const added = items.some(i => i.productId === p.id)
                return (
                  <li key={p.id} className="px-4 py-2.5 flex items-center justify-between border-b border-border">
                    <div className="flex-1 min-w-0">
                      <div className="text-body truncate">{p.name}</div>
                      <div className="text-micro text-gray3">¥{Number(p.price).toFixed(2)} / {p.unit}</div>
                    </div>
                    {added ? (
                      <Chip tone="green">已选</Chip>
                    ) : (
                      <button
                        onClick={() => addItem(p)}
                        className="px-3 py-1.5 bg-ink text-white rounded-cta text-button"
                      >+ 加入</button>
                    )}
                  </li>
                )
              })}
              {products && products.length === 0 && (
                <li className="text-caption text-gray3 text-center py-8">还没有商品 · 先到商品管理录入</li>
              )}
            </ul>
          </div>
        </div>
      )}

      <ConfirmSheet {...confirmState} />
    </div>
  )
}
