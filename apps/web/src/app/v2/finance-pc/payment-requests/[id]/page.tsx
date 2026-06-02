/**
 * 财务 PC Web · 付款申请详情
 *
 * Phase 3 P0
 * 接 /api/payment-requests/:id + /:id/{mark-paid,cancel}
 *
 * 两栏布局:
 *   左 概览 + 收款方 + 会计科目 + 备注
 *   右 审批轨迹 + 操作面板 (mark-paid: 选付款账户 + 流水号 / cancel)
 */
'use client'
import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import dayjs from 'dayjs'
import { Chip } from '@/components/v2'
import { apiFetch } from '@/lib/v2-auth'
import FinanceTopNav from '../../_topnav'

type Doc = {
  id: string; no: string; title: string; amount: string
  isOverThreshold: boolean; thresholdRule?: string
  payload: any
  status: 'PENDING' | 'APPROVED' | 'AUTO_APPROVED' | 'REJECTED' | 'CANCELED'
  initiator: { id: string; name: string; role: string } | null
  store: { id: string; name: string } | null
  steps: Array<{ id: string; seq: number; approverRole: string; status: string; approver?: any; decidedAt?: string; note?: string }>
  decisions: Array<{ id: string; userId: string; decision: string; comment?: string; createdAt: string; user?: { name: string; role: string } }>
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
const ROLE_LABEL: Record<string, string> = {
  ADMIN: '老板', FINANCE: '财务', SUPER_ADMIN: '超级管理员',
  CHEF_DIRECTOR: '总厨', MANAGER: '店长',
}

// 银行账户选项 (跟 mobile 端 voucherForPayment 约定一致)
const BANK_FROM_OPTIONS = [
  { code: '100201', label: '中国银行1674 (100201)' },
  { code: '100202', label: '建设银行3618 (100202)' },
  { code: '1002',   label: '银行存款 (一级 1002 — 招行)' },
  { code: '1001',   label: '库存现金 (1001)' },
]

const fmt2 = (n: number) => `¥${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export default function FinancePCPaymentRequestDetailPage() {
  const router = useRouter()
  const params = useParams() as any
  const id = String(params.id)
  const [d, setD] = useState<Doc | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [bankFrom, setBankFrom] = useState('1002')
  const [bankTxNo, setBankTxNo] = useState('')

  async function reload() {
    try { setD(await apiFetch<Doc>(`/api/payment-requests/${id}`)) }
    catch (e: any) { setError(e.message) }
  }
  useEffect(() => { reload() }, [id])

  useEffect(() => {
    if (d?.payload?.bankFrom) setBankFrom(d.payload.bankFrom)
  }, [d])

  if (error) return (
    <div className="min-h-screen bg-bg">
      <FinanceTopNav />
      <div className="max-w-[1440px] mx-auto px-6 py-6">
        <div className="bg-red-bg text-red-fg rounded-card p-4">{error}</div>
        <a href="/v2/finance-pc/payment-requests" className="inline-block mt-3 px-4 py-2 bg-ink text-white rounded-cta text-button">← 返回列表</a>
      </div>
    </div>
  )

  if (!d) return (
    <div className="min-h-screen bg-bg">
      <FinanceTopNav />
      <div className="max-w-[1440px] mx-auto px-6 py-12 text-center text-caption text-gray3">加载中…</div>
    </div>
  )

  const isPaid = !!d.payload?.paidAt
  const canPay = ['APPROVED', 'AUTO_APPROVED'].includes(d.status) && !isPaid
  const canCancel = d.status === 'PENDING'

  async function markPaid() {
    if (!confirm(`确认已经在网银/招行 App 完成转账 ${fmt2(Number(d!.amount))} 给 ${d!.payload?.payeeName}? 系统会自动建凭证草稿.`)) return
    setBusy(true)
    try {
      const r = await apiFetch<any>(`/api/payment-requests/${id}/mark-paid`, {
        method: 'PATCH',
        body: JSON.stringify({ bankFrom, bankTxNo }),
      })
      if (r?.voucherWarning) alert(`已标记付款,但凭证生成失败: ${r.voucherWarning}\n请财务手工补建`)
      await reload()
    } catch (e: any) { alert(e.message) } finally { setBusy(false) }
  }

  async function cancel() {
    if (!confirm('撤回后无法恢复, 需要重新提交. 确认撤回?')) return
    setBusy(true)
    try {
      await apiFetch(`/api/payment-requests/${id}/cancel`, { method: 'PATCH' })
      await reload()
    } catch (e: any) { alert(e.message) } finally { setBusy(false) }
  }

  return (
    <div className="min-h-screen bg-bg">
      <FinanceTopNav />
      <main className="max-w-[1440px] mx-auto px-6 py-6">
        {/* 面包屑 */}
        <div className="flex items-center gap-2 mb-4">
          <a href="/v2/finance-pc/payment-requests" className="text-gray2 hover:text-ink text-caption">← 付款申请列表</a>
          <span className="text-gray3">/</span>
          <span className="text-caption text-gray2 font-num">{d.no}</span>
        </div>

        <div className="grid grid-cols-[2fr_1fr] gap-4">
          {/* 左侧 概览 + 收款方 + 会计科目 + 备注 */}
          <div className="space-y-4">
            {/* 概览 */}
            <section className="bg-white rounded-card border border-border p-4">
              <div className="flex items-center gap-2 mb-3 flex-wrap">
                <Chip tone={STATUS_TONE[d.status]}>{STATUS_LABEL[d.status]}</Chip>
                {isPaid && <Chip tone="gray">已付</Chip>}
                {d.isOverThreshold && <Chip tone="red">超阈值</Chip>}
                <span className="text-caption text-gray3 ml-auto font-num">{d.no}</span>
              </div>
              <div className="flex items-baseline justify-between mb-2">
                <span className="text-h1 truncate flex-1 mr-2">{d.payload?.payeeName || d.title}</span>
                <span className="font-num text-hero shrink-0">{fmt2(Number(d.amount))}</span>
              </div>
              <p className="text-caption text-gray2">
                {d.payload?.usageLabel}
                {d.thresholdRule && ` · ${d.thresholdRule}`}
              </p>
              <div className="border-t border-border mt-3 pt-3 grid grid-cols-2 gap-2 text-caption">
                <div><span className="text-gray3">发起人</span>: {d.initiator?.name || '—'}</div>
                <div><span className="text-gray3">门店</span>: {d.store?.name || '集团'}</div>
                <div><span className="text-gray3">创建时间</span>: {dayjs(d.createdAt).format('YYYY-MM-DD HH:mm')}</div>
                {d.finalizedAt && (
                  <div><span className="text-gray3">终态时间</span>: {dayjs(d.finalizedAt).format('YYYY-MM-DD HH:mm')}</div>
                )}
              </div>
            </section>

            {/* 收款方 */}
            <section className="bg-white rounded-card border border-border p-4">
              <h2 className="text-h2 mb-2">收款方</h2>
              <div className="space-y-1 text-caption">
                <div><span className="text-gray3 w-20 inline-block">名称</span> <b>{d.payload?.payeeName || '—'}</b></div>
                {d.payload?.payeeBank && <div><span className="text-gray3 w-20 inline-block">开户行</span> {d.payload.payeeBank}</div>}
                {d.payload?.payeeAccount && <div><span className="text-gray3 w-20 inline-block">账号</span> <span className="font-num">{d.payload.payeeAccount}</span></div>}
                {d.payload?.payeeTaxId && <div><span className="text-gray3 w-20 inline-block">税号</span> <span className="font-num">{d.payload.payeeTaxId}</span></div>}
              </div>
            </section>

            {/* 会计科目 */}
            <section className="bg-white rounded-card border border-border p-4">
              <h2 className="text-h2 mb-2">会计处理</h2>
              <div className="text-caption space-y-1">
                <div>
                  <span className="text-gray3 w-12 inline-block">借方</span>
                  <b className="font-num">{d.payload?.accountCode}</b>
                  {' '}{d.payload?.accountName}
                  {' · '}<span className="font-num">{fmt2(Number(d.amount))}</span>
                </div>
                {isPaid && (
                  <div>
                    <span className="text-gray3 w-12 inline-block">贷方</span>
                    <b className="font-num">{d.payload?.bankFrom}</b>
                    {' '}{
                      d.payload?.bankFrom === '100202' ? '建设银行3618'
                      : d.payload?.bankFrom === '1001' ? '库存现金'
                      : d.payload?.bankFrom === '100201' ? '中国银行1674'
                      : '银行存款'
                    }
                    {' · '}<span className="font-num">{fmt2(Number(d.amount))}</span>
                  </div>
                )}
              </div>
            </section>

            {/* 备注 */}
            {d.payload?.note && (
              <section className="bg-amber/10 rounded-card border border-amber/30 p-4">
                <div className="text-caption text-amber-fg mb-1">备注</div>
                <p className="text-body whitespace-pre-wrap">{d.payload.note}</p>
              </section>
            )}

            {/* 已付信息 */}
            {isPaid && (
              <section className="bg-green-bg rounded-card border border-green/30 p-4">
                <div className="text-h2 text-green-fg">✓ 已付款</div>
                <div className="text-caption text-gray2 mt-1 grid grid-cols-2 gap-1">
                  <div><span className="text-gray3">付款时间</span>: {dayjs(d.payload.paidAt).format('YYYY-MM-DD HH:mm')}</div>
                  {d.payload.bankTxNo && <div><span className="text-gray3">银行流水</span>: <span className="font-num">{d.payload.bankTxNo}</span></div>}
                  {d.payload.paidById && <div><span className="text-gray3">执行人 ID</span>: <span className="font-num">{d.payload.paidById}</span></div>}
                </div>
              </section>
            )}
          </div>

          {/* 右侧 审批轨迹 + 操作面板 */}
          <div className="space-y-4">
            {/* 审批轨迹 */}
            {d.steps.length > 0 && (
              <section className="bg-white rounded-card border border-border p-4">
                <h2 className="text-h2 mb-3">审批轨迹</h2>
                <div className="space-y-2">
                  {d.steps.map(s => (
                    <div key={s.id} className="flex items-center gap-3 py-2 border-b border-border last:border-b-0">
                      <span className={`w-7 h-7 rounded-full flex items-center justify-center text-caption font-num ${
                        s.status === 'APPROVED' ? 'bg-green text-white' :
                        s.status === 'REJECTED' ? 'bg-red text-white' :
                        s.status === 'PENDING' ? 'bg-amber/30 text-amber-fg' : 'bg-gray5 text-gray3'
                      }`}>{s.seq}</span>
                      <div className="flex-1 min-w-0">
                        <div className="text-body">{ROLE_LABEL[s.approverRole] || s.approverRole}</div>
                        {s.approver && <div className="text-micro text-gray3">{s.approver.name}</div>}
                        {s.note && <p className="text-micro text-gray3 mt-0.5">{s.note}</p>}
                      </div>
                      <Chip tone={s.status === 'APPROVED' ? 'green' : s.status === 'REJECTED' ? 'red' : s.status === 'PENDING' ? 'amber' : 'gray'}>
                        {s.status === 'APPROVED' ? '✓ 已批' : s.status === 'REJECTED' ? '✗ 驳回' : s.status === 'PENDING' ? '待审' : '-'}
                      </Chip>
                    </div>
                  ))}
                </div>
                {d.status === 'AUTO_APPROVED' && (
                  <p className="text-micro text-gray3 mt-2 bg-bg-warm rounded p-2">阈值内自动批准, 无需人工审</p>
                )}
              </section>
            )}

            {/* 操作面板 */}
            <section className="bg-white rounded-card border border-border p-4 sticky top-4">
              <h2 className="text-h2 mb-3">操作</h2>
              {canPay && (
                <>
                  <label className="block text-caption text-gray3 mb-1">付款账户</label>
                  <select value={bankFrom} onChange={e => setBankFrom(e.target.value)}
                    className="w-full px-3 py-2 rounded-cta border border-border bg-white text-button mb-3">
                    {BANK_FROM_OPTIONS.map(o => (
                      <option key={o.code} value={o.code}>{o.label}</option>
                    ))}
                  </select>
                  <label className="block text-caption text-gray3 mb-1">银行流水号 (选填, 追溯用)</label>
                  <input value={bankTxNo} onChange={e => setBankTxNo(e.target.value)}
                    placeholder="如银行 APP 的交易流水号"
                    className="w-full px-3 py-2 rounded-cta border border-border bg-bg text-button font-num mb-3" />
                  <button onClick={markPaid} disabled={busy}
                    className="w-full py-3 bg-ink text-white rounded-cta text-button disabled:opacity-40 mb-2">
                    {busy ? '处理中…' : '✓ 标记已付款'}
                  </button>
                  <p className="text-micro text-gray3">点击后系统自动建付款凭证草稿 (借: 业务科目 / 贷: 上述银行账户)</p>
                </>
              )}
              {canCancel && (
                <button onClick={cancel} disabled={busy}
                  className="w-full py-2 border border-red text-red-fg rounded-cta text-button disabled:opacity-40 mt-2">
                  撤回申请
                </button>
              )}
              {!canPay && !canCancel && (
                <div className="text-caption text-gray3 text-center py-4">
                  {d.status === 'REJECTED' ? '已驳回, 无可操作'
                  : d.status === 'CANCELED' ? '已撤回, 无可操作'
                  : isPaid ? '已付款完成'
                  : '当前状态无可操作'}
                </div>
              )}
            </section>

            {/* 决策日志 */}
            {d.decisions.length > 0 && (
              <section className="bg-white rounded-card border border-border p-4">
                <h2 className="text-h2 mb-2">决策日志 ({d.decisions.length})</h2>
                <div className="space-y-2">
                  {d.decisions.map(dec => (
                    <div key={dec.id} className="text-caption border-b border-border pb-2 last:border-b-0">
                      <div className="flex items-center justify-between">
                        <span className="font-medium">{dec.user?.name || '—'} <span className="text-micro text-gray3">({ROLE_LABEL[dec.user?.role || ''] || dec.user?.role})</span></span>
                        <Chip tone={dec.decision === 'APPROVE' ? 'green' : 'red'}>
                          {dec.decision === 'APPROVE' ? '通过' : '驳回'}
                        </Chip>
                      </div>
                      {dec.comment && <p className="text-micro text-gray2 mt-1">{dec.comment}</p>}
                      <div className="text-micro text-gray3 mt-1">{dayjs(dec.createdAt).format('YYYY-MM-DD HH:mm')}</div>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        </div>
      </main>
    </div>
  )
}
