/**
 * 财务 · 新建付款申请
 */
'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Chip } from '@/components/v2'
import { apiFetch } from '@/lib/v2-auth'

type UsageOpt = { key: string; label: string; accountCode: string; accountName: string }

export default function PaymentRequestNewPage() {
  const router = useRouter()
  const [usages, setUsages] = useState<UsageOpt[]>([])
  const [usage, setUsage] = useState<string>('rent')
  const [payeeName, setPayeeName] = useState('')
  const [payeeBank, setPayeeBank] = useState('')
  const [payeeAccount, setPayeeAccount] = useState('')
  const [amount, setAmount] = useState<string>('')
  const [note, setNote] = useState('')
  const [bankFrom, setBankFrom] = useState('100201')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    apiFetch<UsageOpt[]>('/api/payment-requests/usage-options')
      .then(setUsages).catch(() => {})
  }, [])

  const selectedUsage = usages.find(u => u.key === usage)
  const amountNum = Number(amount) || 0
  const overThreshold = amountNum > 1000

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!payeeName.trim()) { setError('请填收款方'); return }
    if (amountNum <= 0) { setError('金额必须 > 0'); return }
    setError(null); setSubmitting(true)
    try {
      const r = await apiFetch<{ id: string }>('/api/payment-requests', {
        method: 'POST',
        body: JSON.stringify({
          payeeName, payeeBank, payeeAccount,
          amount: amountNum,
          usage, bankFrom,
          note,
        }),
      })
      router.push(`/v2/finance/payment-requests/${r.id}`)
    } catch (e: any) {
      setError(e.message || '提交失败')
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen bg-bg pb-32">
      <header className="px-4 pt-4 pb-2 flex items-center gap-2">
        <button onClick={() => router.back()} className="text-gray2 text-h2">‹</button>
        <h1 className="text-h1">新建付款申请</h1>
      </header>

      <div className="mx-4 mt-2 bg-bg-warm rounded-card border border-border p-3">
        <p className="text-caption text-gray2">
          ≤ ¥1000 财务自审 · &gt; ¥1000 需老板批
        </p>
      </div>

      <form onSubmit={submit} className="space-y-3 mt-4 px-4">
        {/* 用途 */}
        <div className="bg-white rounded-card border border-border p-3">
          <label className="text-micro text-gray3 block mb-2">用途</label>
          <div className="grid grid-cols-3 gap-1.5">
            {usages.map(u => (
              <button key={u.key} type="button" onClick={() => setUsage(u.key)}
                      className={`px-2 py-1.5 rounded-cta text-caption ${usage === u.key ? 'bg-ink text-white' : 'bg-bg text-gray2 border border-border'}`}>
                {u.label}
              </button>
            ))}
          </div>
          {selectedUsage && (
            <p className="text-micro text-gray3 mt-2">
              将记账到 <b className="font-num">{selectedUsage.accountCode}</b> {selectedUsage.accountName}
            </p>
          )}
        </div>

        {/* 收款方 */}
        <div className="bg-white rounded-card border border-border p-3 space-y-2">
          <div>
            <label className="text-micro text-gray3 block mb-1">收款方名称 *</label>
            <input value={payeeName} onChange={e => setPayeeName(e.target.value)} required
                   placeholder="如: 国家税务总局南京市税务局"
                   className="w-full bg-bg rounded-cta px-3 py-2 text-body" />
          </div>
          <div>
            <label className="text-micro text-gray3 block mb-1">开户行 (选填)</label>
            <input value={payeeBank} onChange={e => setPayeeBank(e.target.value)}
                   placeholder="如: 中国工商银行南京分行"
                   className="w-full bg-bg rounded-cta px-3 py-2 text-body" />
          </div>
          <div>
            <label className="text-micro text-gray3 block mb-1">银行账号 (选填)</label>
            <input value={payeeAccount} onChange={e => setPayeeAccount(e.target.value)}
                   placeholder="如: 6228 4800 1234 5678 9"
                   className="w-full bg-bg rounded-cta px-3 py-2 text-body font-num" />
          </div>
        </div>

        {/* 金额 */}
        <div className="bg-white rounded-card border border-border p-3">
          <label className="text-micro text-gray3 block mb-1">金额 (元) *</label>
          <input type="number" min="0.01" step="0.01" required
                 value={amount} onChange={e => setAmount(e.target.value)}
                 className="w-full bg-bg rounded-cta px-3 py-2 text-h2 font-num" />
          {amountNum > 0 && (
            <div className="mt-2">
              {overThreshold ? (
                <Chip tone="red">&gt; ¥1000 · 需老板审批</Chip>
              ) : (
                <Chip tone="green">≤ ¥1000 · 财务自审</Chip>
              )}
            </div>
          )}
        </div>

        {/* 付款账户 */}
        <div className="bg-white rounded-card border border-border p-3">
          <label className="text-micro text-gray3 block mb-1">从哪个账户付</label>
          <select value={bankFrom} onChange={e => setBankFrom(e.target.value)}
                  className="w-full bg-transparent text-body py-1 outline-none">
            <option value="100201">中国银行 1674</option>
            <option value="100202">建设银行 3618</option>
            <option value="1001">库存现金</option>
          </select>
        </div>

        {/* 备注 */}
        <div className="bg-white rounded-card border border-border p-3">
          <label className="text-micro text-gray3 block mb-1">备注 (可选)</label>
          <textarea value={note} onChange={e => setNote(e.target.value)} rows={2}
                    placeholder="付款周期/合同期/凭证编号..."
                    className="w-full bg-bg rounded-cta px-3 py-2 text-body resize-none" />
        </div>

        {error && <div className="bg-red-bg text-red-fg rounded-card p-3 text-caption">{error}</div>}
      </form>

      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-border p-3 flex gap-3">
        <button type="button" onClick={() => router.back()}
                className="px-4 py-3 bg-white border border-border rounded-cta text-button text-gray2">取消</button>
        <button onClick={submit} disabled={submitting || !payeeName || amountNum <= 0}
                className="flex-1 py-3 bg-ink text-white rounded-cta text-button disabled:opacity-40">
          {submitting ? '提交中…' : `提交申请${amountNum > 0 ? ` · ¥${amountNum.toFixed(2)}` : ''}`}
        </button>
      </div>
    </div>
  )
}
