/**
 * 厨师长 · 发验收单页 (2026-05-29 客户反馈)
 *
 * 流程: PO 在 DELIVERING 状态时, 厨师收到货物 → 进这个页面 → 上传 1-5 张照片 + 选填备注
 *      → 提交后供应商在 supplier/orders/[id] 页看到照片, 确认无误才点"送达"
 *
 * 接 PATCH /api/orders/:id/chef-ack { images: string[], note?: string }
 * 限制: 1-5 张图; 备注选填, 提供则上限 500 字
 */
'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { apiFetch } from '@/lib/v2-auth'

export default function ChefAckPage({ params }: { params: { id: string } }) {
  const router = useRouter()
  const [po, setPo] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)
  const [images, setImages] = useState<string[]>([])      // OSS URL 数组, 上限 3
  const [note, setNote] = useState('')
  const [uploading, setUploading] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    apiFetch(`/api/orders/${params.id}`)
      .then((d: any) => setPo(d))
      .catch(e => setError(String(e?.message || e)))
  }, [params.id])

  if (error) {
    return (
      <div className="min-h-screen bg-bg p-6">
        <div className="bg-red-bg text-red-fg rounded-card p-4">{error}</div>
        <button onClick={() => router.back()} className="mt-4 px-4 py-2 bg-ink text-white rounded-cta">返回</button>
      </div>
    )
  }
  if (!po) return <div className="p-6 text-gray3 text-caption">加载中…</div>

  // 状态守卫: 仅 DELIVERING 可发验收单
  if (po.status !== 'DELIVERING') {
    const STATUS_LABEL: Record<string, string> = {
      DRAFT: '草稿', SUBMITTED: '待接单', CONFIRMED: '已接单',
      PENDING_CONFIRM: '已送达待签收', RECEIVED: '已验收',
      COMPLETED: '已完成', CANCELLED: '已取消',
    }
    return (
      <div className="min-h-screen bg-bg pb-10">
        <header className="px-4 pt-4 pb-2 flex items-center gap-2">
          <button onClick={() => router.back()} className="text-gray2 text-h2">‹</button>
          <h1 className="text-h1">发验收单</h1>
        </header>
        <div className="mx-4 mt-4 bg-amber/10 border border-amber/40 rounded-card p-4">
          <div className="text-h2 text-amber-fg mb-2">⚠ 此单不在配送中</div>
          <div className="text-caption text-gray2 space-y-1">
            <p>订单: <b>{po.no}</b></p>
            <p>当前状态: <b>{STATUS_LABEL[po.status] || po.status}</b></p>
            <p className="text-gray3 pt-2">
              验收单只在"在途/配送中"阶段可以发, 现在已经过了这个阶段。
            </p>
          </div>
        </div>
        <div className="mx-4 mt-3">
          <button onClick={() => router.push('/v2/chef/purchase')}
                  className="w-full py-3 bg-ink text-white rounded-cta text-button">
            返回采购列表
          </button>
        </div>
      </div>
    )
  }

  // 已发过验收单: 显示当前状态 + 允许重发覆盖
  const alreadySent = po.chefAckAt != null

  async function uploadPhoto(file: File) {
    if (images.length >= 5) {
      alert('最多 5 张照片')
      return
    }
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append('file', file, file.name || 'ack.jpg')
      const res = await apiFetch<{ url: string }>('/api/upload?category=chef-ack', { method: 'POST', body: fd as any })
      setImages(prev => [...prev, res.url])
    } catch (e: any) {
      alert('上传失败: ' + (e?.message || e))
    } finally {
      setUploading(false)
    }
  }

  function removeImage(idx: number) {
    setImages(prev => prev.filter((_, i) => i !== idx))
  }

  async function submit() {
    if (submitting) return
    if (images.length === 0) { alert('请至少上传 1 张验收照片'); return }
    if (images.length > 5)   { alert('最多 5 张'); return }
    setSubmitting(true)
    try {
      await apiFetch(`/api/orders/${params.id}/chef-ack`, {
        method: 'PATCH',
        body: JSON.stringify({ images, note: note.trim() || undefined }),
      })
      alert('验收单已发送给供应商')
      router.push('/v2/chef/purchase')
    } catch (e: any) {
      alert('发送失败: ' + (e?.message || e))
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen bg-bg pb-32">
      <header className="px-4 pt-4 pb-2 flex items-center gap-2">
        <button onClick={() => router.back()} className="text-gray2 text-h2">‹</button>
        <h1 className="text-h1">发验收单</h1>
      </header>

      {/* 订单上下文 */}
      <div className="mx-4 mt-2 bg-white rounded-card border border-border p-3">
        <div className="text-h2 mb-1">{po.supplier?.name || '供应商'} <span className="text-micro text-gray3 font-num ml-1">#{po.no}</span></div>
        <div className="text-caption text-gray3">
          {po.items?.length ?? 0} 项 · 总额 ¥{Number(po.totalAmount).toLocaleString()}
          {po.shippedAt && ` · 发货 ${new Date(po.shippedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`}
        </div>
      </div>

      {alreadySent && (
        <div className="mx-4 mt-3 bg-amber/10 border border-amber/40 rounded-card p-3">
          <div className="text-caption text-amber-fg">
            ⓘ 之前已发过验收单 ({new Date(po.chefAckAt).toLocaleString('zh-CN')}, {po.chefAckImages?.length || 0} 张)
            <br />
            供应商可能还在看, 重新发会覆盖上一份。
          </div>
        </div>
      )}

      {/* 照片上传 */}
      <section className="mx-4 mt-4">
        <h2 className="text-h2 mb-2">验收照片 <span className="text-caption text-gray3">{images.length}/5</span></h2>
        <div className="grid grid-cols-3 gap-2">
          {images.map((url, i) => (
            <div key={i} className="relative aspect-square bg-bg rounded-card overflow-hidden border border-border">
              <img src={url} alt="" className="w-full h-full object-cover" />
              <button
                type="button"
                onClick={() => removeImage(i)}
                className="absolute top-1 right-1 w-6 h-6 rounded-full bg-ink/70 text-white text-micro flex items-center justify-center"
                aria-label="移除"
              >×</button>
            </div>
          ))}
          {images.length < 5 && (
            <label className="aspect-square bg-white border border-dashed border-border rounded-card flex flex-col items-center justify-center text-gray3 text-micro cursor-pointer hover:bg-bg-warm">
              {uploading ? (
                <>上传中…</>
              ) : (
                <>
                  <span className="text-h1">+</span>
                  <span>拍照 / 相册</span>
                </>
              )}
              <input
                type="file"
                accept="image/*"
                className="hidden"
                disabled={uploading}
                onChange={e => {
                  const f = e.target.files?.[0]
                  if (f) uploadPhoto(f)
                  e.target.value = ''  // 允许重选同一文件
                }}
              />
            </label>
          )}
        </div>
        <p className="text-micro text-gray3 mt-2">
          建议拍: 货物整体 / 重点商品近照 / 数量证明。最多 5 张, 至少 1 张。
        </p>
      </section>

      {/* 备注 */}
      <section className="mx-4 mt-5">
        <h2 className="text-h2 mb-2">备注 <span className="text-gray3 text-caption">(选填)</span></h2>
        <textarea
          value={note}
          onChange={e => setNote(e.target.value)}
          placeholder="如: 货已收到, 数量对齐, 有 1 箱包装破损但商品完好。(选填)"
          maxLength={500}
          rows={4}
          className="w-full bg-white border border-border rounded-card p-3 text-body outline-none focus:border-ink"
        />
        <div className="text-micro text-gray3 text-right mt-1">{note.length}/500</div>
      </section>

      {/* 提交栏 */}
      <div className="fixed bottom-0 inset-x-0 bg-white border-t border-border p-3 flex gap-2 z-10">
        <button
          type="button"
          onClick={() => router.back()}
          className="px-4 py-3 bg-white border border-border rounded-cta text-button">
          取消
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={submitting || uploading || images.length === 0}
          className="flex-1 py-3 bg-ink text-white rounded-cta text-button disabled:bg-gray3 disabled:cursor-not-allowed">
          {submitting ? '发送中…' : '发给供应商'}
        </button>
      </div>
    </div>
  )
}
