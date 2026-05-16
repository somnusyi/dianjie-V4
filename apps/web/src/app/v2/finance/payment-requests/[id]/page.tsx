/**
 * 财务 · 付款申请详情 + 执行付款
 */
'use client'
import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import dayjs from 'dayjs'
import { Chip } from '@/components/v2'
import { ConfirmSheet, useConfirmSheet } from '@/components/v2/confirm-sheet'
import { ErrorScreen } from '@/components/v2/use-dashboard'
import { apiFetch } from '@/lib/v2-auth'

type Doc = {
  id: string; no: string; title: string; amount: string
  isOverThreshold: boolean; thresholdRule?: string
  payload: any
  status: 'PENDING' | 'APPROVED' | 'AUTO_APPROVED' | 'REJECTED' | 'CANCELED'
  initiator: { id: string; name: string; role: string } | null
  store: { id: string; name: string } | null
  steps: Array<{ id: string; seq: number; approverRole: string; status: string; approver?: any; decidedAt?: string; note?: string }>
  decisions: Array<any>
  createdAt: string
  finalizedAt?: string | null
}

const STATUS_LABEL: Record<string, string> = {
  PENDING: '审批中', APPROVED: '已批准', AUTO_APPROVED: '自动批准',
  REJECTED: '已拒绝', CANCELED: '已撤回',
}
const STATUS_TONE: Record<string, 'amber' | 'green' | 'red' | 'gray'> = {
  PENDING: 'amber', APPROVED: 'green', AUTO_APPROVED: 'green',
  REJECTED: 'red', CANCELED: 'gray',
}

export default function PaymentRequestDetailPage() {
  const router = useRouter()
  const params = useParams() as any
  const id = String(params.id)
  const [d, setD] = useState<Doc | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirm, openConfirm] = useConfirmSheet()
  const [bankTxNo, setBankTxNo] = useState('')
  const [bankFrom, setBankFrom] = useState<string>('')

  async function reload() {
    try { setD(await apiFetch<Doc>(`/api/payment-requests/${id}`)) }
    catch (e: any) { setError(e.message) }
  }
  useEffect(() => { reload() }, [id])

  useEffect(() => {
    if (d?.payload?.bankFrom) setBankFrom(d.payload.bankFrom)
  }, [d])

  if (error) return <ErrorScreen message={error} />
  if (!d) return <div className="min-h-screen bg-bg flex items-center justify-center text-gray3">加载中…</div>

  const isPaid = !!d.payload?.paidAt
  const canPay = ['APPROVED', 'AUTO_APPROVED'].includes(d.status) && !isPaid
  const canCancel = d.status === 'PENDING'

  async function markPaid() {
    setBusy(true)
    try {
      const r = await apiFetch<any>(`/api/payment-requests/${id}/mark-paid`, {
        method: 'PATCH', body: JSON.stringify({ bankFrom, bankTxNo }),
      })
      if (r?.voucherWarning) alert(`已标记付款,但凭证生成失败: ${r.voucherWarning}\n请财务手工补建`)
      await reload()
    } catch (e: any) { alert(e.message) } finally { setBusy(false) }
  }
  async function cancel() {
    setBusy(true)
    try {
      await apiFetch(`/api/payment-requests/${id}/cancel`, { method: 'PATCH' })
      await reload()
    } catch (e: any) { alert(e.message) } finally { setBusy(false) }
  }

  return (
    <div className="min-h-screen bg-bg pb-32">
      <header className="px-4 pt-4 pb-2 flex items-center gap-2">
        <button onClick={() => router.back()} className="text-gray2 text-h2">‹</button>
        <h1 className="text-h1">付款申请详情</h1>
      </header>

      {/* 概览 */}
      <div className="mx-4 mt-2 bg-white rounded-card border border-border p-3">
        <div className="flex items-center gap-2 mb-2 flex-wrap">
          <Chip tone={STATUS_TONE[d.status]}>{STATUS_LABEL[d.status]}</Chip>
          {isPaid && <Chip tone="gray">已付</Chip>}
          {d.isOverThreshold && <Chip tone="red">超阈</Chip>}
          <span className="text-micro text-gray3 ml-auto">{d.no}</span>
        </div>
        <div className="flex items-baseline justify-between">
          <span className="text-h2 truncate flex-1 min-w-0">{d.payload?.payeeName}</span>
          <span className="font-num text-h1 ml-2 shrink-0">¥{Number(d.amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
        </div>
        <p className="text-caption text-gray2 mt-1">{d.payload?.usageLabel} · {d.thresholdRule}</p>
      </div>

      {/* 收款方 */}
      <div className="mx-4 mt-3 bg-white rounded-card border border-border p-3">
        <div className="text-h2 mb-2">收款方</div>
        <div className="text-caption space-y-1">
          <div><span className="text-gray3">名称:</span> <b>{d.payload?.payeeName}</b></div>
          {d.payload?.payeeBank && <div><span className="text-gray3">开户行:</span> {d.payload.payeeBank}</div>}
          {d.payload?.payeeAccount && <div><span className="text-gray3">账号:</span> <span className="font-num">{d.payload.payeeAccount}</span></div>}
        </div>
      </div>

      {/* 会计科目 */}
      <div className="mx-4 mt-3 bg-white rounded-card border border-border p-3">
        <div className="text-h2 mb-2">会计处理</div>
        <div className="text-caption space-y-1">
          <div><span className="text-gray3">借方:</span> <b className="font-num">{d.payload?.accountCode}</b> {d.payload?.accountName} · <span className="font-num">¥{Number(d.amount).toFixed(2)}</span></div>
          {isPaid && (
            <div><span className="text-gray3">贷方:</span> <b className="font-num">{d.payload?.bankFrom}</b> {d.payload?.bankFrom === '100202' ? '建设银行3618' : d.payload?.bankFrom === '1001' ? '库存现金' : '中国银行1674'} · <span className="font-num">¥{Number(d.amount).toFixed(2)}</span></div>
          )}
        </div>
      </div>

      {/* 审批轨迹 */}
      {d.steps.length > 0 && (
        <div className="mx-4 mt-3 bg-white rounded-card border border-border p-3">
          <div className="text-h2 mb-2">审批轨迹</div>
          {d.steps.map(s => (
            <div key={s.id} className="flex items-center gap-3 py-2 border-b border-border last:border-b-0">
              <span className={`w-7 h-7 rounded-full flex items-center justify-center text-caption font-num ${
                s.status === 'APPROVED' ? 'bg-green text-white' :
                s.status === 'REJECTED' ? 'bg-red text-white' :
                s.status === 'PENDING' ? 'bg-amber/30 text-amber-fg' : 'bg-gray5 text-gray3'
              }`}>{s.seq}</span>
              <div className="flex-1">
                <div className="text-body">{s.approverRole === 'ADMIN' ? '老板' : s.approverRole === 'FINANCE' ? '财务' : s.approverRole}</div>
                {s.note && <p className="text-micro text-gray3 mt-0.5">{s.note}</p>}
              </div>
              <Chip tone={s.status === 'APPROVED' ? 'green' : s.status === 'REJECTED' ? 'red' : s.status === 'PENDING' ? 'amber' : 'gray'}>
                {s.status === 'APPROVED' ? '✓' : s.status === 'REJECTED' ? '✗' : s.status === 'PENDING' ? '...' : '-'}
              </Chip>
            </div>
          ))}
          {d.status === 'AUTO_APPROVED' && (
            <p className="text-micro text-gray3 mt-2">阈值内自动批准, 无需人工审</p>
          )}
        </div>
      )}

      {/* 备注 */}
      {d.payload?.note && (
        <div className="mx-4 mt-3 bg-amber/10 rounded-card border border-amber/30 p-3">
          <div className="text-caption text-amber-fg">备注</div>
          <p className="text-body mt-1 whitespace-pre-wrap">{d.payload.note}</p>
        </div>
      )}

      {/* 已付信息 */}
      {isPaid && (
        <div className="mx-4 mt-3 bg-green-bg rounded-card border border-green/30 p-3">
          <div className="text-caption text-green-fg">✓ 已付</div>
          <p className="text-micro text-gray3 mt-1">{dayjs(d.payload.paidAt).format('YYYY-MM-DD HH:mm')}</p>
          {d.payload.bankTxNo && <p className="text-micro text-gray3">银行流水号: <span className="font-num">{d.payload.bankTxNo}</span></p>}
        </div>
      )}

      {/* 操作 */}
      {(canPay || canCancel) && (
        <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-border p-3 flex gap-2 flex-col">
          {canPay && (
            <>
              <div className="text-micro text-gray3 mb-1">
                银行流水号 (选填,标记追溯用)
              </div>
              <input value={bankTxNo} onChange={e => setBankTxNo(e.target.value)}
                     placeholder="如银行 APP 的交易流水"
                     className="w-full bg-bg rounded-cta px-3 py-2 text-caption font-num mb-1" />
              <button
                onClick={() => openConfirm({
                  title: '确认已付款',
                  body: <span>确认已在网银/招行 App 完成转账 <b>¥{Number(d.amount).toFixed(2)}</b> 给 <b>{d.payload?.payeeName}</b>?<br/>系统会自动建凭证草稿。</span>,
                  confirmLabel: '确认已付', tone: 'primary',
                  onConfirm: markPaid,
                })}
                disabled={busy}
                className="w-full py-3 bg-ink text-white rounded-cta text-button disabled:opacity-40">
                {busy ? '处理中…' : '✓ 标记已付款'}
              </button>
            </>
          )}
          {canCancel && (
            <button onClick={() => openConfirm({
              title: '撤回付款申请', tone: 'danger',
              body: <span>撤回后无法恢复, 需要重新提交</span>,
              confirmLabel: '确认撤回', onConfirm: cancel,
            })} disabled={busy}
                    className="w-full py-2 border border-red text-red rounded-cta text-button disabled:opacity-40">
              撤回申请
            </button>
          )}
        </div>
      )}
      <ConfirmSheet {...confirm} />
    </div>
  )
}
