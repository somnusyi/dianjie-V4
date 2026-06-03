/**
 * 财务 PC · 新建付款申请
 * 复刻同事手机端 /v2/finance/payment-requests/new, 给 PC 端用
 */
'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Chip } from '@/components/v2'
import { apiFetch } from '@/lib/v2-auth'
import FinanceTopNav from '../../_topnav'

type UsageOpt = { key: string; label: string; accountCode: string; accountName: string }

export default function PaymentRequestNewPCPage() {
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
    apiFetch<UsageOpt[]>('/api/payment-requests/usage-options').then(setUsages).catch(() => {})
  }, [])

  const selectedUsage = usages.find(u => u.key === usage)
  const amountNum = Number(amount) || 0
  const overThreshold = amountNum > 1000

  async function submit() {
    if (!payeeName.trim()) { setError('请填收款方'); return }
    if (amountNum <= 0) { setError('金额必须 > 0'); return }
    setError(null); setSubmitting(true)
    try {
      const r = await apiFetch<{ id: string }>('/api/payment-requests', {
        method: 'POST',
        body: JSON.stringify({ payeeName, payeeBank, payeeAccount, amount: amountNum, usage, bankFrom, note }),
      })
      router.replace(`/v2/finance-pc/payment-requests/${r.id}`)
    } catch (e: any) {
      setError(e.message || '提交失败')
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen bg-bg">
      <FinanceTopNav />
      <main className="max-w-[900px] mx-auto px-6 py-6">
        <div className="flex items-center gap-2 mb-4">
          <a href="/v2/finance-pc/payment-requests" className="text-gray2 hover:text-ink text-caption">← 付款申请列表</a>
          <span className="text-gray3">/</span>
          <span className="text-caption text-gray2">新建</span>
        </div>

        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-h1">新建付款申请</h1>
            <p className="text-caption text-gray3">≤ ¥1000 财务自审 · &gt; ¥1000 需老板批</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => router.back()}
                    className="px-4 py-2 bg-white border border-border rounded-cta text-button text-gray2">取消</button>
            <button onClick={submit} disabled={submitting || !payeeName || amountNum <= 0}
                    className="px-5 py-2 bg-ink text-white rounded-cta text-button disabled:opacity-40">
              {submitting ? '提交中…' : `提交申请${amountNum > 0 ? ` · ¥${amountNum.toFixed(2)}` : ''}`}
            </button>
          </div>
        </div>

        {error && <div className="bg-red-bg text-red-fg rounded-card p-3 text-caption mb-4">{error}</div>}

        <div className="space-y-4">
          {/* 用途 */}
          <section className="bg-white rounded-card border border-border p-4">
            <label className="text-h2 block mb-3">① 用途</label>
            <div className="grid grid-cols-5 gap-2">
              {usages.map(u => (
                <button key={u.key} type="button" onClick={() => setUsage(u.key)}
                        className={`px-3 py-2 rounded-cta text-button transition ${
                          usage === u.key ? 'bg-ink text-white' : 'bg-bg text-gray2 border border-border hover:border-ink'
                        }`}>
                  {u.label}
                </button>
              ))}
            </div>
            {selectedUsage && (
              <p className="text-caption text-gray3 mt-3">
                将记账到 <b className="font-num">{selectedUsage.accountCode}</b> {selectedUsage.accountName}
              </p>
            )}
          </section>

          {/* 收款方 */}
          <section className="bg-white rounded-card border border-border p-4">
            <label className="text-h2 block mb-3">② 收款方</label>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <label className="text-micro text-gray3 block mb-1">收款方名称 *</label>
                <input value={payeeName} onChange={e => setPayeeName(e.target.value)}
                       placeholder="如 国家税务总局南京市税务局"
                       className="w-full px-3 py-2 rounded-cta border border-border bg-white text-button" />
              </div>
              <div>
                <label className="text-micro text-gray3 block mb-1">开户行 (选填)</label>
                <input value={payeeBank} onChange={e => setPayeeBank(e.target.value)}
                       placeholder="如 中国工商银行南京分行"
                       className="w-full px-3 py-2 rounded-cta border border-border bg-white text-button" />
              </div>
              <div>
                <label className="text-micro text-gray3 block mb-1">银行账号 (选填)</label>
                <input value={payeeAccount} onChange={e => setPayeeAccount(e.target.value)}
                       placeholder="如 6228 4800 1234 5678 9"
                       className="w-full px-3 py-2 rounded-cta border border-border bg-white text-button font-num" />
              </div>
            </div>
          </section>

          {/* 金额 + 付款账户 */}
          <section className="bg-white rounded-card border border-border p-4">
            <label className="text-h2 block mb-3">③ 金额 + 付款账户</label>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-micro text-gray3 block mb-1">金额 (元) *</label>
                <input type="number" min="0.01" step="0.01" value={amount}
                       onChange={e => setAmount(e.target.value)}
                       className="w-full px-3 py-2 rounded-cta border border-border bg-white text-h1 font-num text-right" />
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
              <div>
                <label className="text-micro text-gray3 block mb-1">从哪个账户付</label>
                <select value={bankFrom} onChange={e => setBankFrom(e.target.value)}
                        className="w-full px-3 py-2 rounded-cta border border-border bg-white text-button">
                  <option value="100201">中国银行 1674 (100201)</option>
                  <option value="100202">建设银行 3618 (100202)</option>
                  <option value="1001">库存现金 (1001)</option>
                </select>
              </div>
            </div>
          </section>

          {/* 备注 */}
          <section className="bg-white rounded-card border border-border p-4">
            <label className="text-h2 block mb-3">④ 备注 (可选)</label>
            <textarea value={note} onChange={e => setNote(e.target.value)} rows={3}
                      placeholder="付款周期 / 合同期 / 凭证编号..."
                      className="w-full px-3 py-2 rounded-cta border border-border bg-white text-button resize-none" />
          </section>
        </div>
      </main>
    </div>
  )
}
