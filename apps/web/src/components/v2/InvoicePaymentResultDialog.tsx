'use client'

import { useEffect, useMemo, useState } from 'react'
import { apiFetch } from '@/lib/v2-auth'

export const invoicePaymentMethods = [
  { value: 'manual', label: '银行转账', accountType: 'BANK' },
  { value: 'cmb', label: '招行转账', accountType: 'BANK' },
  { value: 'wechat', label: '微信支付', accountType: 'WECHAT' },
  { value: 'alipay', label: '支付宝', accountType: 'ALIPAY' },
  { value: 'cash', label: '现金', accountType: 'CASH' },
] as const

type CashAccount = {
  id: string
  name: string
  type: 'BANK' | 'WECHAT' | 'ALIPAY' | 'CASH'
  balance: string | number
  status: string
  accountNo?: string | null
}

type Payment = {
  id: string
  amount: string | number
  paymentMethod: string
}

function localToday() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

export default function InvoicePaymentResultDialog({
  payment,
  invoiceLabel,
  supplierName,
  mode = 'mobile',
  onClose,
  onDone,
}: {
  payment: Payment
  invoiceLabel: string
  supplierName: string
  mode?: 'mobile' | 'pc'
  onClose: () => void
  onDone: () => void
}) {
  const [accounts, setAccounts] = useState<CashAccount[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [accountId, setAccountId] = useState('')
  const [paidAt, setPaidAt] = useState(localToday())
  const [bankTxNo, setBankTxNo] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const method = invoicePaymentMethods.find(item => item.value === payment.paymentMethod)
    || invoicePaymentMethods[0]

  useEffect(() => {
    apiFetch<CashAccount[]>('/api/cashbook/accounts')
      .then(setAccounts)
      .catch(e => setError(e?.message || '资金账户加载失败'))
  }, [])

  const availableAccounts = useMemo(() => (accounts || []).filter(account =>
    account.status === 'ACTIVE' && account.type === method.accountType,
  ), [accounts, method.accountType])

  useEffect(() => {
    if (availableAccounts.length === 1) setAccountId(availableAccounts[0].id)
    else if (!availableAccounts.some(account => account.id === accountId)) setAccountId('')
  }, [availableAccounts, accountId])

  async function confirmSuccess() {
    if (!accountId) { setError(`请选择${method.label}对应的实际出款账户`); return }
    if (method.accountType !== 'CASH' && !bankTxNo.trim()) {
      setError('非现金付款必须填写实际支付流水号')
      return
    }
    setBusy(true); setError(null)
    try {
      const result = await apiFetch<any>(`/api/invoice-payments/${payment.id}/confirm`, {
        method: 'PATCH',
        body: JSON.stringify({
          status: 'SUCCESS', accountId, paidAt,
          bankTxNo: bankTxNo.trim() || undefined,
          note: note.trim() || undefined,
        }),
      })
      if (result?.voucherWarning) alert(result.voucherWarning)
      onDone()
    } catch (e: any) {
      setError(e?.message || '付款确认失败')
    } finally { setBusy(false) }
  }

  async function markFailed() {
    const reason = window.prompt('请输入付款失败原因')?.trim()
    if (!reason) return
    setBusy(true); setError(null)
    try {
      await apiFetch(`/api/invoice-payments/${payment.id}/confirm`, {
        method: 'PATCH', body: JSON.stringify({ status: 'FAILED', failReason: reason }),
      })
      onDone()
    } catch (e: any) { setError(e?.message || '标记失败未完成') }
    finally { setBusy(false) }
  }

  async function cancelPayment() {
    const reason = window.prompt('取消原因（可不填）')?.trim()
    if (reason === undefined) return
    setBusy(true); setError(null)
    try {
      await apiFetch(`/api/invoice-payments/${payment.id}/cancel`, {
        method: 'PATCH', body: JSON.stringify({ reason: reason || undefined }),
      })
      onDone()
    } catch (e: any) { setError(e?.message || '取消付款未完成') }
    finally { setBusy(false) }
  }

  const panelClass = mode === 'pc'
    ? 'absolute right-0 top-0 bottom-0 w-[480px] bg-white shadow-xl overflow-auto'
    : 'absolute bottom-0 left-0 right-0 bg-white rounded-t-card max-h-[88vh] overflow-auto'
  return (
    <div className="fixed inset-0 z-[60]" onClick={() => !busy && onClose()}>
      <div className="absolute inset-0 bg-ink/55" />
      <div className={panelClass} onClick={event => event.stopPropagation()}>
        <div className="px-5 py-4 border-b border-border flex items-start justify-between">
          <div>
            <h3 className="text-h2">确认付款结果</h3>
            <p className="text-caption text-gray3">{supplierName} · #{invoiceLabel}</p>
          </div>
          <button onClick={onClose} disabled={busy} className="text-h2 text-gray3">×</button>
        </div>
        <div className="px-5 py-4 space-y-3">
          <div className="bg-bg-warm border border-border rounded-card p-3 flex justify-between">
            <span className="text-caption text-gray2">{method.label} · 待确认</span>
            <span className="font-num text-h2">¥{Number(payment.amount).toLocaleString()}</span>
          </div>
          {error && <div className="bg-red-bg text-red-fg rounded-card p-3 text-caption">{error}</div>}
          <div>
            <label className="text-micro text-gray3 block mb-1">实际出款账户 *</label>
            <select value={accountId} onChange={e => setAccountId(e.target.value)}
                    className="w-full bg-bg rounded-chip px-3 py-2 text-body">
              <option value="">{accounts === null ? '加载账户中…' : `请选择 ${method.label} 账户`}</option>
              {availableAccounts.map(account => (
                <option key={account.id} value={account.id}>
                  {account.name} · 余额 ¥{Number(account.balance).toFixed(2)}
                </option>
              ))}
            </select>
            {accounts && availableAccounts.length === 0 && (
              <p className="text-micro text-red-fg mt-1">未配置可用的 {method.accountType} 资金账户，不能确认付款。</p>
            )}
          </div>
          <div>
            <label className="text-micro text-gray3 block mb-1">实际付款日期 *</label>
            <input type="date" value={paidAt} max={localToday()} onChange={e => setPaidAt(e.target.value)}
                   className="w-full bg-bg rounded-chip px-3 py-2 font-num" />
          </div>
          {method.accountType !== 'CASH' && (
            <div>
              <label className="text-micro text-gray3 block mb-1">实际支付流水号 *</label>
              <input value={bankTxNo} onChange={e => setBankTxNo(e.target.value)} maxLength={100}
                     placeholder="银行/微信/支付宝交易流水"
                     className="w-full bg-bg rounded-chip px-3 py-2 font-num" />
            </div>
          )}
          <div>
            <label className="text-micro text-gray3 block mb-1">确认备注（可选）</label>
            <textarea value={note} onChange={e => setNote(e.target.value)} rows={2} maxLength={500}
                      className="w-full bg-bg rounded-chip px-3 py-2 resize-none" />
          </div>
          <p className="text-micro text-gray2 bg-orange-bg/30 rounded-card p-2">
            确认成功后将同时扣减所选账户、写入资金流水并累计发票已付；请先核对真实银行结果。
          </p>
        </div>
        <div className="border-t border-border px-5 py-3 sticky bottom-0 bg-white space-y-2">
          <button onClick={confirmSuccess} disabled={busy || !accountId || availableAccounts.length === 0}
                  className="w-full py-3 bg-ink text-white rounded-cta text-button disabled:opacity-40">
            {busy ? '处理中…' : '确认已实际付款'}
          </button>
          <div className="grid grid-cols-2 gap-2">
            <button onClick={markFailed} disabled={busy}
                    className="py-2.5 border border-red-fg text-red-fg rounded-cta text-button">标记失败</button>
            <button onClick={cancelPayment} disabled={busy}
                    className="py-2.5 border border-border text-gray2 rounded-cta text-button">取消付款单</button>
          </div>
        </div>
      </div>
    </div>
  )
}
