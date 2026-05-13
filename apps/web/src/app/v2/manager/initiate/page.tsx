/**
 * 店长 · 发起申请 (统一表单页)
 * 路由: /v2/manager/initiate?type=PETTY_CASH | REIMBURSEMENT | PURCHASE_NON_FOOD ...
 *
 * PDF 第 4 条铁律：阈值前置告知 — 表单顶部明确显示"<¥3K 自动批 · ≥¥3K 老板审"
 * PDF 第 9 条铁律：操作按钮上写金额 —"提交·¥1,500"
 */
'use client'
import { useState, useEffect } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { Chip } from '@/components/v2'
import { apiFetch } from '@/lib/v2-auth'

const TYPES: Record<string, {
  label: string
  icon: string
  threshold: { auto: number; rule: string; finalApprover: string }
  amountLabel?: string
  payloadFields: { key: string; label: string; placeholder?: string; type?: 'text' | 'textarea' }[]
}> = {
  PETTY_CASH: {
    label: '备用金申请',
    icon: '⎙',
    threshold: { auto: 3000, rule: '阈值 ¥3,000 内自动通过', finalApprover: '老板' },
    amountLabel: '申请金额',
    payloadFields: [
      { key: 'reason', label: '用途', placeholder: '日常零钱周转 / 应急采购…', type: 'textarea' },
    ],
  },
  REIMBURSEMENT: {
    label: '报销',
    icon: '⊞',
    threshold: { auto: 5000, rule: '阈值 ¥5,000 内财务直接审 · 超阈值老板审', finalApprover: '财务/老板' },
    amountLabel: '报销金额',
    payloadFields: [
      { key: 'category', label: '费用类别', placeholder: '差旅 / 招待 / 办公…' },
      { key: 'description', label: '费用说明', placeholder: '请详述用途, 财务参考', type: 'textarea' },
    ],
  },
  PURCHASE_NON_FOOD: {
    label: '非食材采购',
    icon: '⌧',
    threshold: { auto: 30000, rule: '阈值 ¥30,000 内自动 · 超阈值老板审 · 终审通过自动调招行付款', finalApprover: '老板' },
    amountLabel: '采购总额',
    payloadFields: [
      { key: 'item', label: '采购品类', placeholder: '办公 / 家具 / 设备 / 餐具' },
      { key: 'note', label: '说明', type: 'textarea' },
      { key: 'supplierName', label: '收款方·公司名', placeholder: '××餐饮设备有限公司' },
      { key: 'toName', label: '收款方·开户名', placeholder: '与营业执照一致' },
      { key: 'toAccount', label: '收款方·账号', placeholder: '银行账号 (15-19 位)' },
      { key: 'bankCode', label: '收款行·联行号 (他行必填)', placeholder: '招行可选填' },
      { key: 'bankCity', label: '收款行·开户城市 (他行必填)', placeholder: '北京 / 上海…' },
    ],
  },
}

export default function InitiatePage() {
  const params = useSearchParams()
  const router = useRouter()
  const typeKey = (params?.get('type') || 'PETTY_CASH').toUpperCase()
  const cfg = TYPES[typeKey]

  const [amount, setAmount] = useState<string>('')
  const [payload, setPayload] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!cfg) {
    return (
      <div className="min-h-screen bg-bg p-6">
        <div className="bg-red-bg text-red-fg rounded-card p-4 text-caption">未知申请类型: {typeKey}</div>
      </div>
    )
  }

  const amountN = Number(amount) || 0
  const isOver = amountN >= cfg.threshold.auto
  const willAutoApprove = !isOver && amountN > 0

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (amountN <= 0) { setError('请输入正确金额'); return }
    setError(null); setSubmitting(true)
    try {
      const title = (() => {
        if (typeKey === 'PETTY_CASH') return `备用金申请 · ¥${amountN.toLocaleString()}`
        if (typeKey === 'REIMBURSEMENT') return `${payload.category || '报销'} · ¥${amountN.toLocaleString()}`
        if (typeKey === 'PURCHASE_NON_FOOD') return `${payload.item || '非食材采购'} · ¥${amountN.toLocaleString()}`
        return cfg.label
      })()
      const result = await apiFetch<{ id: string; number: string; status: string }>('/api/documents', {
        method: 'POST',
        body: JSON.stringify({
          type: typeKey,
          title,
          amount: amountN,
          payload,
        }),
      })
      router.push(`/v2/manager/document-success/${result.id}`)
    } catch (e: any) {
      setError(e.message || '提交失败')
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen bg-bg pb-32">
      <header className="px-4 pt-4 pb-2 flex items-center gap-2">
        <button onClick={() => router.back()} className="text-gray2 text-h2">‹</button>
        <h1 className="text-h1">{cfg.label}</h1>
      </header>

      {/* PDF 第 4 条铁律：阈值前置告知（暖白卡 + 琥珀金图标） */}
      <div className="mx-4 mt-2 bg-bg-warm rounded-card border border-border p-4">
        <div className="flex items-center gap-3">
          <span className="w-10 h-10 rounded-md bg-amber-bg text-amber-fg flex items-center justify-center text-h2">{cfg.icon}</span>
          <div className="flex-1">
            <div className="text-h2">{cfg.label}</div>
            <p className="text-caption text-gray2 mt-0.5">{cfg.threshold.rule}</p>
          </div>
        </div>
      </div>

      <form onSubmit={submit} className="space-y-3 mt-4 px-4">
        {/* 金额（带实时阈值反馈） */}
        <div className="bg-white rounded-card border border-border p-3">
          <label className="text-micro text-gray3 block mb-1">{cfg.amountLabel}</label>
          <div className="flex items-baseline gap-1">
            <span className="text-h2">¥</span>
            <input
              type="number"
              min="1"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              required
              className="flex-1 text-hero font-num bg-transparent outline-none"
              placeholder="0"
              autoFocus
            />
          </div>
          {amountN > 0 && (
            <div className="mt-2 flex items-center gap-2">
              {willAutoApprove ? (
                <Chip tone="green">阈值内 · 自动通过</Chip>
              ) : (
                <Chip tone="orange">超阈值 · 需 {cfg.threshold.finalApprover} 审批</Chip>
              )}
              <span className="text-micro text-gray3">
                {willAutoApprove
                  ? `< ¥${cfg.threshold.auto.toLocaleString()} 阈值`
                  : `≥ ¥${cfg.threshold.auto.toLocaleString()} 阈值`}
              </span>
            </div>
          )}
        </div>

        {/* 业务字段 */}
        {cfg.payloadFields.map((f) => (
          <div key={f.key} className="bg-white rounded-card border border-border p-3">
            <label className="text-micro text-gray3 block mb-1">{f.label}</label>
            {f.type === 'textarea' ? (
              <textarea
                value={payload[f.key] || ''}
                onChange={(e) => setPayload({ ...payload, [f.key]: e.target.value })}
                rows={3}
                placeholder={f.placeholder}
                className="w-full text-body bg-transparent outline-none resize-none"
              />
            ) : (
              <input
                type="text"
                value={payload[f.key] || ''}
                onChange={(e) => setPayload({ ...payload, [f.key]: e.target.value })}
                placeholder={f.placeholder}
                className="w-full text-body bg-transparent outline-none"
              />
            )}
          </div>
        ))}

        {error && (
          <div className="bg-red-bg text-red-fg rounded-card p-3 text-caption">{error}</div>
        )}
      </form>

      {/* 底部固定提交按钮（金额前置防误操作 - PDF 第 9 条铁律） */}
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-border p-3 flex gap-3">
        <button
          type="button"
          onClick={() => router.back()}
          className="px-4 py-3 bg-white border border-border rounded-cta text-button text-gray2"
        >
          取消
        </button>
        <button
          type="submit"
          form=""
          onClick={submit}
          disabled={submitting || amountN <= 0}
          className="flex-1 py-3 bg-ink text-white rounded-cta text-button transition disabled:opacity-40"
        >
          {submitting ? '提交中…' : `提交${amountN > 0 ? ` · ¥${amountN.toLocaleString()}` : ''}`}
        </button>
      </div>
    </div>
  )
}
