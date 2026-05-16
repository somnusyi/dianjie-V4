/**
 * 总厨 · 新建菜品
 */
'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { apiFetch } from '@/lib/v2-auth'

export default function DishNewPage() {
  const router = useRouter()
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [category, setCategory] = useState('汤锅')
  const [salePrice, setSalePrice] = useState('')
  const [description, setDescription] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) { setErr('请填菜品名'); return }
    const p = Number(salePrice)
    if (!p || p <= 0) { setErr('售价无效'); return }
    setErr(null); setSubmitting(true)
    try {
      const r = await apiFetch<{ id: string }>('/api/dishes', {
        method: 'POST',
        body: JSON.stringify({
          name, code: code || undefined, category, salePrice: p,
          description: description || undefined,
        }),
      })
      router.push(`/v2/chef-director/dishes/${r.id}`)
    } catch (e: any) {
      setErr(e.message)
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen bg-bg pb-32">
      <header className="px-4 pt-4 pb-2 flex items-center gap-2">
        <button onClick={() => router.back()} className="text-gray2 text-h2">‹</button>
        <h1 className="text-h1">新建菜品</h1>
      </header>

      <form onSubmit={submit} className="space-y-3 mt-2 px-4">
        <div className="bg-white rounded-card border border-border p-3">
          <label className="text-micro text-gray3 block mb-1">菜品名 *</label>
          <input value={name} onChange={e => setName(e.target.value)} required
                 placeholder="如: 云南山珍菌汤锅"
                 className="w-full bg-bg rounded-cta px-3 py-2 text-body" />
        </div>
        <div className="bg-white rounded-card border border-border p-3 grid grid-cols-2 gap-3">
          <div>
            <label className="text-micro text-gray3 block mb-1">分类</label>
            <input value={category} onChange={e => setCategory(e.target.value)}
                   placeholder="汤锅 / 凉菜 / ..."
                   className="w-full bg-bg rounded-cta px-3 py-2 text-body" />
          </div>
          <div>
            <label className="text-micro text-gray3 block mb-1">内部编码</label>
            <input value={code} onChange={e => setCode(e.target.value)}
                   placeholder="可选, 美团对接用"
                   className="w-full bg-bg rounded-cta px-3 py-2 text-body font-num" />
          </div>
        </div>
        <div className="bg-white rounded-card border border-border p-3">
          <label className="text-micro text-gray3 block mb-1">售价 (元) *</label>
          <input type="number" min="0.01" step="0.01" required
                 value={salePrice} onChange={e => setSalePrice(e.target.value)}
                 className="w-full bg-bg rounded-cta px-3 py-2 text-h2 font-num" />
        </div>
        <div className="bg-white rounded-card border border-border p-3">
          <label className="text-micro text-gray3 block mb-1">描述</label>
          <textarea value={description} onChange={e => setDescription(e.target.value)} rows={2}
                    placeholder="特色 / 制作说明 ..."
                    className="w-full bg-bg rounded-cta px-3 py-2 text-body resize-none" />
        </div>

        {err && <div className="bg-red-bg text-red-fg rounded-card p-3 text-caption">{err}</div>}
      </form>

      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-border p-3 flex gap-2">
        <button type="button" onClick={() => router.back()}
                className="px-4 py-3 bg-white border border-border rounded-cta text-button text-gray2">取消</button>
        <button onClick={submit} disabled={submitting || !name || !salePrice}
                className="flex-1 py-3 bg-ink text-white rounded-cta text-button disabled:opacity-40">
          {submitting ? '保存中…' : '保存 (下一步加配方)'}
        </button>
      </div>
    </div>
  )
}
