/**
 * 反馈提交页: 文字 + 图片 + 自动上下文快照 (页面/角色/门店/userAgent/时间)
 * 提交成功 → 跳 /v2/feedback/[id] 对话页 (AI 首轮澄清)
 */
'use client'
import { Suspense, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { apiFetch, getUser } from '@/lib/v2-auth'
import ImageUploader from '@/components/ImageUploader'

function FeedbackNewForm() {
  const searchParams = useSearchParams()
  const [content, setContent] = useState('')
  const [images, setImages] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  async function submit() {
    if (!content.trim()) { setError('请描述你遇到的问题或建议'); return }
    setSubmitting(true)
    setError('')
    try {
      const u = getUser()
      // 自动上下文快照: 无需用户填写
      const context = {
        path: searchParams.get('from') || location.pathname,
        role: u?.role || '',
        storeName: u?.store?.name || '',
        userAgent: navigator.userAgent,
        clientTime: new Date().toLocaleString('zh-CN', { hour12: false }),
      }
      const res = await apiFetch<{ id: string }>('/api/feedback', {
        method: 'POST',
        body: JSON.stringify({
          content: content.trim(),
          context,
          attachments: images.length ? images : undefined,
        }),
      })
      location.href = `/v2/feedback/${res.id}`
    } catch (e: any) {
      setError(e.message || '提交失败，请重试')
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen bg-bg pb-12">
      <header className="px-4 pt-4 pb-2 flex items-center gap-3">
        <button onClick={() => history.back()} className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center">‹</button>
        <div>
          <h1 className="text-h1">提交反馈</h1>
          <p className="text-caption text-gray3 mt-0.5">问题、建议或新需求，AI 助手会帮你整理</p>
        </div>
      </header>

      <div className="px-4 mt-3 space-y-3">
        <div className="bg-white rounded-card border border-border p-3">
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={5}
            maxLength={2000}
            placeholder="描述你遇到的问题或建议，例如：验收照片想放大看细节 / 提交订单按钮点了没反应…"
            className="w-full text-body outline-none resize-none placeholder:text-gray3"
          />
          <div className="text-right text-micro text-gray3 font-num">{content.length}/2000</div>
        </div>

        <div className="bg-white rounded-card border border-border p-3">
          <div className="text-caption text-gray2 mb-2">截图（选填，最多 4 张）</div>
          <ImageUploader images={images} onChange={setImages} maxCount={4} disabled={submitting} />
        </div>

        <p className="text-micro text-gray3 px-1">
          提交时会自动带上当前页面、你的角色和门店信息，方便定位问题，无需手动填写。
        </p>

        {error && <div className="text-caption text-red-fg">{error}</div>}

        <button
          onClick={submit}
          disabled={submitting}
          className="w-full py-3 rounded-cta bg-ink text-white text-button disabled:opacity-50"
        >
          {submitting ? '提交中…' : '提交反馈'}
        </button>
      </div>
    </div>
  )
}

export default function FeedbackNewPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-bg" />}>
      <FeedbackNewForm />
    </Suspense>
  )
}
