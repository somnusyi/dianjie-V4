/**
 * 内部账户间转账 BottomSheet
 *
 * 入参:
 *   open       是否显示
 *   from       发起转账的招行账户 (CashAccount, 含 cmbBindAccount)
 *   candidates 收款方候选 (同 tenant 下其他招行实时账户, 不含 from)
 *   onClose    关闭
 *   onSuccess  成功后调用 (父组件 reload 余额 + 流水)
 *
 * 行为:
 *   - 从账户固定 (传 from 是哪个就是哪个)
 *   - 收款下拉只显示同 tenant 其他招行实时账户
 *   - 金额输入 + 备注 + 提交按钮
 *   - 提交调 POST /api/cashbook/internal-transfer
 *   - 成功 alert 银行流水号, 失败 alert 报错码 + 文案
 *   - 警示文案: 真实银行转账, 不可逆
 */
'use client'
import { useState } from 'react'
import { apiFetch } from '@/lib/v2-auth'

export type TransferAccount = {
  id: string
  name: string                // 户名 (用作大标题)
  cmbBindAccount?: string | null
  bankName?: string
}

type Props = {
  open: boolean
  from: TransferAccount | null
  candidates: TransferAccount[]
  onClose: () => void
  onSuccess: () => void
}

export function InternalTransferModal({ open, from, candidates, onClose, onSuccess }: Props) {
  const [toId, setToId]         = useState('')
  const [amount, setAmount]     = useState('')
  const [remark, setRemark]     = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError]       = useState<string | null>(null)

  if (!open || !from) return null

  async function submit() {
    setError(null)
    const to = candidates.find(c => c.id === toId)
    if (!to) { setError('请选择收款账户'); return }
    const amt = Number(amount)
    if (!Number.isFinite(amt) || amt <= 0) { setError('金额必须 > 0'); return }
    if (!confirm(
      `确认从「${from!.name}」转出 ¥${amt.toFixed(2)} 到「${to.name}」?\n\n` +
      `这是真实银行转账, 提交后会立即扣款, 不可撤销。\n` +
      `备注: ${remark.trim() || '(无)'}`
    )) return

    setSubmitting(true)
    try {
      const r = await apiFetch<any>('/api/cashbook/internal-transfer', {
        method: 'POST',
        body: JSON.stringify({
          fromAccountId: from!.id,
          toAccountId:   to.id,
          amount:        amt,
          remark:        remark.trim() || undefined,
        }),
      })
      if (!r.success) {
        setError(`银行返回失败: ${r.resultCode || ''} ${r.resultMsg || ''}`)
        return
      }
      alert(
        `✅ 转账成功\n\n` +
        `银行流水号: ${r.txNo || '-'}\n` +
        `业务参考号: ${r.bizNo}\n` +
        `从 ${r.fromAccount?.name} → ${r.toAccount?.name}\n` +
        `金额: ¥${r.amount}`
      )
      setToId(''); setAmount(''); setRemark(''); setError(null)
      onSuccess()
      onClose()
    } catch (e: any) {
      setError(e?.message || '调用失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-ink/60 flex items-end justify-center"
         onClick={() => !submitting && onClose()}>
      <div className="bg-white rounded-t-card w-full max-w-md p-4"
           onClick={e => e.stopPropagation()}
           style={{ paddingBottom: 'calc(16px + env(safe-area-inset-bottom))' }}>
        <div className="w-10 h-1 bg-border rounded-full mx-auto mb-3" />
        <h3 className="text-h2">内部账户转账</h3>
        <p className="text-caption text-gray3 mt-1">招商银行实时账户之间互转</p>

        <div className="mt-4 space-y-3">
          {/* 付款账户 (固定) */}
          <div className="bg-bg-warm border border-border rounded-card p-3">
            <div className="text-micro text-gray3 mb-1">从</div>
            <div className="text-body">{from.name}</div>
            <div className="text-micro text-gray3 mt-0.5">
              {from.bankName || '招商银行'}
              {from.cmbBindAccount ? ` · 尾号 ${from.cmbBindAccount.slice(-4)}` : ''}
            </div>
          </div>

          {/* 收款账户 (下拉) */}
          <div>
            <label className="text-micro text-gray3 block mb-1">到 *</label>
            <select value={toId} onChange={e => setToId(e.target.value)}
                    className="w-full bg-bg rounded-cta px-3 py-2 text-body outline-none">
              <option value="">— 选择收款账户 —</option>
              {candidates.map(c => (
                <option key={c.id} value={c.id}>
                  {c.name}{c.cmbBindAccount ? ` · 尾号 ${c.cmbBindAccount.slice(-4)}` : ''}
                </option>
              ))}
            </select>
            {candidates.length === 0 && (
              <p className="text-micro text-gray3 mt-1">暂无其他招行实时账户。先在「+ 新建账户」加一个</p>
            )}
          </div>

          {/* 金额 */}
          <div>
            <label className="text-micro text-gray3 block mb-1">金额 (元) *</label>
            <input type="text" inputMode="decimal"
                   value={amount}
                   onChange={e => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
                   placeholder="如 0.01"
                   className="w-full bg-bg rounded-cta px-3 py-2 text-body font-num outline-none" />
          </div>

          {/* 备注 */}
          <div>
            <label className="text-micro text-gray3 block mb-1">备注 (可选)</label>
            <input value={remark}
                   onChange={e => setRemark(e.target.value)}
                   placeholder="如 内部支付测试"
                   className="w-full bg-bg rounded-cta px-3 py-2 text-body outline-none" />
          </div>

          {/* 警告 */}
          <div className="bg-red-bg/30 border border-red/30 rounded-card p-2.5 text-micro text-red-fg">
            ⚠ 这是真实银行转账, 提交后立即扣款, 不可撤销。
          </div>

          {/* 错误 */}
          {error && (
            <div className="bg-red-bg text-red-fg rounded-card p-2.5 text-caption">{error}</div>
          )}
        </div>

        <div className="flex gap-2 mt-5">
          <button onClick={onClose} disabled={submitting}
                  className="px-4 py-2 border border-border rounded-cta text-button text-gray2">取消</button>
          <button onClick={submit} disabled={submitting || !toId || !amount}
                  className="flex-1 py-2 bg-ink text-white rounded-cta text-button disabled:opacity-40">
            {submitting ? '提交中…' : `确认转 ¥${Number(amount) || 0}`}
          </button>
        </div>
      </div>
    </div>
  )
}
