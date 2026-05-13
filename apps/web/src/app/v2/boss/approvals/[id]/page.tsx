/**
 * 老板 App · 审批详情  PDF: boss_approval_detail
 * Hero 单笔金额 + 4 信任徽章 · 审批链 · 预算上下文 · 历史对比 · 凭证 · 双按钮带金额
 */
'use client'
import { useEffect, useState } from 'react'
import { ApprovalRouting, ActionButtonPair, Chip, ProgressDots } from '@/components/v2'
import { ConfirmSheet, useConfirmSheet } from '@/components/v2/confirm-sheet'

type Doc = {
  id: string
  number: string
  type: string
  title: string
  amount: string | null
  status: string
  isOverThreshold: boolean
  thresholdRule: string | null
  payload: any
  store?: { name: string } | null
  initiator?: { name: string; role: string } | null
  steps: { id: string; seq: number; approverRole: string; status: string; decision: string | null; approver?: { name: string; role: string } | null; decidedAt: string | null }[]
  attachments: { id: string; filename: string; sizeBytes: number; url: string }[]
}

const HISTORY = [
  { quarter: 'Q1 (1-3 月)', amount: 12500, count: 1 },
  { quarter: 'Q2 (4-6 月)', amount: 0,     count: 0, current: true },
  { quarter: 'Q3 (7-9 月)', amount: 8300,  count: 2 },
  { quarter: '过去 12 月平均', amount: 6950, count: '/ 季', highlight: true },
]
const BUDGET = { used: 18000, total: 30000 }
const TYPE_LABEL: Record<string, string> = {
  PETTY_CASH: '备用金',
  REIMBURSEMENT: '报销',
  PURCHASE_FOOD_REGULAR: '食材采购·常规',
  PURCHASE_FOOD_OVER: '食材采购·超阈值',
  PURCHASE_NON_FOOD: '非食材采购',
  CONTRACT: '合同',
  PRICE_ADJUSTMENT: '调价',
  NEW_SUPPLIER: '新供应商',
  NEW_DISH: '新菜品',
  STORE_TRANSFER: '调拨',
  MARKETING_BUDGET: '营销预算',
  PERSONNEL_PAY: '调薪',
}

export default function BossApprovalDetailPage({ params }: { params: { id: string } }) {
  const [doc, setDoc] = useState<Doc | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [cmbLogs, setCmbLogs] = useState<any[]>([])
  const [confirmState, openConfirm] = useConfirmSheet()

  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null
    if (!token) { setError('未登录'); return }
    fetch(`/api/documents/${params.id}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then((d) => {
        setDoc(d)
        // 单据若已批准，附带查招行触发日志
        if (d?.status === 'APPROVED' || d?.status === 'AUTO_APPROVED') {
          fetch(`/api/documents/${params.id}/cmb-logs`, { headers: { Authorization: `Bearer ${token}` } })
            .then(r => r.json()).then(setCmbLogs).catch(() => {})
        }
      })
      .catch(e => setError(String(e)))
  }, [params.id])

  function decide(decision: 'APPROVE' | 'REJECT') {
    if (!doc || submitting) return
    const doDecision = async () => {
      setSubmitting(true)
      const token = localStorage.getItem('token')
      const res = await fetch(`/api/documents/${doc.id}/decisions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ decision }),
      })
      const data = await res.json()
      if (res.ok) location.href = '/v2/boss/approvals'
      else { alert(data.error || '操作失败'); setSubmitting(false); throw new Error(data.error) }
    }
    if (decision === 'APPROVE') {
      openConfirm({
        title: `批准 ¥${Number(doc.amount).toLocaleString()}?`,
        body: doc.title,
        confirmLabel: '批准',
        tone: 'primary',
        onConfirm: doDecision,
      })
    } else {
      doDecision()
    }
  }

  if (error) return <div className="p-6 text-red-fg">{error}</div>
  if (!doc)  return <div className="p-6 text-gray3">加载中…</div>

  const amount = Number(doc.amount || 0)
  const currentStep = doc.steps.find(s => s.status === 'PENDING')
  const stepIdx = currentStep ? currentStep.seq - 1 : doc.steps.length

  return (
    <div className="min-h-screen bg-bg pb-24">
      <header className="px-4 pt-4 pb-2 flex items-center gap-2">
        <a href="/v2/boss/approvals" className="text-gray2">‹</a>
        <div className="flex-1">
          <p className="text-caption text-gray3">{TYPE_LABEL[doc.type] || doc.type}</p>
          <h1 className="text-h1">{doc.store?.name ?? '集团'} · {doc.title}</h1>
        </div>
        <button className="text-gray3">⋮</button>
      </header>

      {/* Hero 单笔金额 + 4 信任徽章 */}
      <div className="mx-4 mt-2 bg-ink text-white rounded-card p-5">
        <p className="text-micro text-gray4">本单金额</p>
        <div className="font-num text-hero mt-1">¥{amount.toLocaleString()}</div>
        <p className="text-caption text-gray4 mt-1">超阈值 {doc.thresholdRule || '—'}</p>
        <p className="text-caption text-gray4 mt-1">{doc.number} · {doc.initiator?.name ?? '—'} 发起</p>
        <div className="flex gap-1 mt-3 flex-wrap">
          <Chip tone="green">凭证齐</Chip>
          <Chip tone="green">财务初审 ✓</Chip>
          <Chip tone="green">阈值合规</Chip>
          <Chip tone="green">历史正常</Chip>
        </div>
      </div>

      {/* 审批链 */}
      <Section title={`审批链 · ${doc.steps.length} 步`}>
        <div className="bg-white rounded-card border border-border p-4">
          <ApprovalRouting
            steps={doc.steps.map(s => ({
              name: s.approver?.name ?? roleLabel(s.approverRole),
              role: roleLabel(s.approverRole),
              status: s.status === 'DECIDED' ? 'done' : s.status === 'PENDING' ? 'current' : s.status === 'SKIPPED' ? 'skipped' : 'waiting',
              meta: s.decidedAt ? new Date(s.decidedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : (s.status === 'PENDING' ? '待我审' : ''),
            }))}
          />
        </div>
      </Section>

      {/* 预算上下文 */}
      <Section title="预算上下文" right="本季度">
        <div className="bg-white rounded-card border border-border p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-h2">{doc.store?.name ?? '集团'} {doc.payload?.budget_label ?? 'Q2 设备预算'}</span>
            <span className="font-num text-caption">¥{BUDGET.used / 1000}K / ¥{BUDGET.total / 1000}K</span>
          </div>
          <div className="h-2 bg-bg rounded-full overflow-hidden">
            <div className="h-full bg-gray2" style={{ width: `${(BUDGET.used / BUDGET.total) * 100}%` }} />
          </div>
          <p className="text-micro text-gray3 mt-2">
            批后占比 {Math.round(((BUDGET.used + amount) / BUDGET.total) * 100)}% · 剩余 ¥{(BUDGET.total - BUDGET.used - amount) / 1000}K
          </p>
        </div>
      </Section>

      {/* 历史对比 */}
      <Section title="历史对比" right={`该店${TYPE_LABEL[doc.type] || ''}`}>
        <div className="bg-white rounded-card border border-border divide-y divide-border">
          {HISTORY.map((h) => (
            <div key={h.quarter} className={`px-3 py-2.5 flex items-center justify-between ${h.highlight ? 'bg-bg' : ''} ${h.current ? 'border-l-2 border-l-orange' : ''}`}>
              <span className="text-body">{h.quarter}</span>
              <div className="text-right">
                <span className="font-num text-body">¥{(h.amount / 1).toLocaleString()}</span>
                <span className="text-micro text-gray3 ml-2">{h.count} 笔</span>
                {h.current && <span className="ml-2 text-caption text-orange-fg">本笔 ↑158%</span>}
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* 凭证附件 */}
      <Section title="凭证附件" right={`${doc.attachments?.length ?? 0} 份`}>
        <ul className="bg-white rounded-card border border-border divide-y divide-border">
          {(doc.attachments || []).map((a) => (
            <li key={a.id} className="px-3 py-3 flex items-center gap-3">
              <span className="text-h2">📎</span>
              <div className="flex-1 min-w-0">
                <div className="text-body truncate">{a.filename}</div>
                <div className="text-micro text-gray3">{(a.sizeBytes / 1024 / 1024).toFixed(1)} MB</div>
              </div>
              <span className="text-gray3">›</span>
            </li>
          ))}
          {(doc.attachments || []).length === 0 && (
            <li className="px-3 py-4 text-center text-caption text-gray3">无附件</li>
          )}
        </ul>
      </Section>

      {/* 招行付款触发日志（仅 APPROVED 后展示） */}
      {cmbLogs.length > 0 && (
        <Section title="招行付款" right={cmbLogs[0].action === 'CMB_TRANSFER_OK' ? '✓ 已成功' : '触发日志'}>
          <ul className="space-y-2">
            {cmbLogs.map((log) => {
              const ok = log.action === 'CMB_TRANSFER_OK'
              const skipped = log.action === 'CMB_TRANSFER_SKIPPED'
              return (
                <li key={log.id} className={`bg-white rounded-card border border-border p-3 ${ok ? 'border-green/30 bg-green-bg/40' : skipped ? 'bg-bg' : 'border-red/30 bg-red-bg/40'}`}>
                  <div className="flex items-center gap-2 mb-1">
                    <Chip tone={ok ? 'green' : skipped ? 'gray' : 'red'}>
                      {ok ? '已转账' : skipped ? '已跳过' : '失败'}
                    </Chip>
                    <span className="text-micro text-gray3 ml-auto">{new Date(log.createdAt).toLocaleString('zh-CN')}</span>
                  </div>
                  {log.metadata?.toName && (
                    <div className="text-body">收款方: {log.metadata.toName} <span className="text-micro text-gray3 font-num">{log.metadata.toAccount}</span></div>
                  )}
                  {log.metadata?.amount && (
                    <div className="text-caption text-gray2 mt-0.5">金额: <span className="font-num">¥{Number(log.metadata.amount).toLocaleString()}</span></div>
                  )}
                  {log.metadata?.txNo && (
                    <div className="text-caption text-gray2 mt-0.5">银行流水号: <span className="font-num">{log.metadata.txNo}</span></div>
                  )}
                  {log.metadata?.resultMsg && !ok && (
                    <div className="text-micro text-red-fg mt-1">{log.metadata.resultMsg}</div>
                  )}
                </li>
              )
            })}
          </ul>
        </Section>
      )}

      {/* 底部双按钮 */}
      {currentStep && (
        <ActionButtonPair
          sticky
          secondary={{ label: '驳回', onClick: () => decide('REJECT'), danger: true }}
          primary={{ label: '批准', onClick: () => decide('APPROVE'), amount: `¥${amount.toLocaleString()}`, disabled: submitting }}
        />
      )}

      <ConfirmSheet {...confirmState} />
    </div>
  )
}

function Section({ title, right, children }: { title: string; right?: string; children: React.ReactNode }) {
  return (
    <section className="px-4 mt-5">
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="text-h2">{title}</h2>
        {right && <span className="text-caption text-gray3">{right}</span>}
      </div>
      {children}
    </section>
  )
}

function roleLabel(r: string) {
  return ({ BOSS: '老板·我', CHEF_DIRECTOR: '总厨', FINANCE: '财务', MANAGER: '店长', KITCHEN_LEAD: '厨师长', SUPPLIER_OWNER: '供应商', ADMIN: '老板·我', CHEF: '总厨', SUPPLIER_STAFF: '供应商', PURCHASER: '店长', SUPER_ADMIN: '老板·我' } as Record<string, string>)[r] ?? r
}
