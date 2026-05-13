'use client'
import { useEffect, useMemo, useState } from 'react'
import AppLayout from '@/components/AppLayout'
import { Table, Btn, Modal, Field, Input, fmt, fmtDate, useToast } from '@/components/ui'
import api from '@/lib/api'
import dayjs from 'dayjs'

export default function ApprovalPage() {
  const [pending, setPending] = useState<any[]>([])
  const [all, setAll] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [current, setCurrent] = useState<any>(null)
  const [action, setAction] = useState<'approve' | 'reject'>('approve')
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const { show, ToastEl } = useToast()

  const load = async () => {
    setLoading(true)
    try {
      const [p, a] = await Promise.all([
        api.get('/api/schedules/pending-approval'),
        api.get('/api/schedules?status=PENDING_APPROVAL'),
      ])
      setPending(p.data)
      setAll(a.data)
    } catch { show('审批数据读取失败', 'error') }
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  const openApproval = (row: any, act: 'approve' | 'reject') => {
    setCurrent(row); setAction(act); setNote(''); setModalOpen(true)
  }

  const submit = async () => {
    setSubmitting(true)
    try {
      await api.patch(`/api/schedules/${current.id}/approve`, { action, note })
      show(action === 'approve' ? '✅ 已审批通过，到期自动付款' : '已拒绝')
      setModalOpen(false)
      load()
    } catch (e: any) {
      show(e.response?.data?.error || '操作失败', 'error')
    }
    setSubmitting(false)
  }

  const summary = useMemo(() => {
    const totalPendingAmt = pending.reduce((s, r) => s + Math.max(0, Number(r.amount || 0)), 0)
    const urgent = pending.filter(r => dayjs(r.dueAt).diff(dayjs(), 'day') <= 3)
    const overdue = pending.filter(r => dayjs(r.dueAt).diff(dayjs(), 'day') < 0)
    return {
      totalPendingAmt,
      urgentCount: urgent.length,
      overdueCount: overdue.length,
      maxAmount: pending.reduce((m, r) => Math.max(m, Number(r.amount || 0)), 0),
    }
  }, [pending])

  const cols = [
    { key: 'receipt', title: '入库单', render: (_: any, row: any) => (
      <div>
        <div className="dj-table-strong">{row.receipt?.no}</div>
        <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{row.receipt?.store?.name}</div>
      </div>
    )},
    { key: 'supplier', title: '供应商', render: (_: any, row: any) => (
      <div>
        <div style={{ fontWeight: 500 }}>{row.supplier?.name}</div>
        <div style={{ fontSize: 11, color: '#9ca3af' }}>{row.supplier?.bankAccount || '未配置账号'}</div>
      </div>
    )},
    { key: 'amount', title: '付款金额', render: (v: any) => (
      <span style={{ fontSize: 15, fontWeight: 700, color: '#d98a24' }}>{fmt(v)}</span>
    )},
    { key: 'dueAt', title: '到期日', render: (v: string) => {
      const diff = dayjs(v).diff(dayjs(), 'day')
      return (
        <div>
          <div style={{ fontWeight: 600, color: diff <= 3 ? '#dc2626' : '#374151' }}>{fmtDate(v)}</div>
          <div style={{ fontSize: 11, color: diff <= 3 ? '#dc2626' : '#9ca3af' }}>
            {diff < 0 ? `逾期${Math.abs(diff)}天` : diff === 0 ? '今日到期' : `还剩${diff}天`}
          </div>
        </div>
      )
    }},
    { key: 'confirmedAt', title: '确认时间', render: (v: string) => fmtDate(v) },
    { key: 'actions', title: '操作', render: (_: any, row: any) => (
      <div style={{ display: 'flex', gap: 8 }}>
        <Btn variant="primary" size="sm" onClick={() => openApproval(row, 'approve')}>审批通过</Btn>
        <Btn variant="danger" size="sm" onClick={() => openApproval(row, 'reject')}>拒绝</Btn>
      </div>
    )},
  ]

  return (
    <AppLayout>
      {ToastEl}
      <main className="dj-page">
        <div className="dj-topbar">
          <div>
            <span>付款审批 · 老板终审</span>
            <h1>审批决策台</h1>
            <p>超过规则阈值的供应商付款，在这里完成风险判断和终审</p>
          </div>
          <span className={summary.urgentCount ? 'dj-chip dj-chip-orange' : 'dj-chip dj-chip-green'}>
            {summary.urgentCount ? `${summary.urgentCount} 笔临近到期` : '暂无紧急审批'}
          </span>
        </div>

        <section className="dj-hero approval-hero">
          <div className="dj-hero-meta">
            <span>审批队列 <i /> 付款前置决策</span>
            <span>{dayjs().format('HH:mm')}</span>
          </div>
          <div className="dj-hero-main">
            <strong>{pending.length} 笔</strong>
            <em className={summary.overdueCount ? 'is-red' : summary.urgentCount ? 'is-orange' : 'is-green'}>
              {summary.overdueCount ? `${summary.overdueCount} 笔逾期` : summary.urgentCount ? '临近到期' : '队列健康'}
            </em>
          </div>
          <p>待审批金额 {fmt(summary.totalPendingAmt).replace('.00', '')} · 最大单笔 {fmt(summary.maxAmount).replace('.00', '')} · 审批后进入自动付款</p>
          <div className="approval-decision-grid">
            <span>入库单核验</span>
            <span>供应商账户</span>
            <span>付款金额</span>
            <span>到期风险</span>
          </div>
          <div className="dj-hero-stats">
            <div><span>待审批金额</span><strong>{fmt(summary.totalPendingAmt).replace('.00', '')}</strong></div>
            <div><span>3 天内到期</span><strong className={summary.urgentCount ? 'is-orange' : ''}>{summary.urgentCount} 笔</strong></div>
            <div><span>逾期</span><strong className={summary.overdueCount ? 'is-red' : ''}>{summary.overdueCount} 笔</strong></div>
          </div>
        </section>

        <section className="dj-metric-grid">
          <article className={pending.length ? 'tone-orange' : 'tone-green'}>
            <span>待审批笔数</span>
            <strong>{pending.length} 笔</strong>
            <em>等待总部审核</em>
          </article>
          <article>
            <span>待审批金额</span>
            <strong>{fmt(summary.totalPendingAmt).replace('.00', '')}</strong>
            <em>合计付款风险暴露</em>
          </article>
          <article className={summary.urgentCount ? 'tone-red' : 'tone-green'}>
            <span>紧急审批</span>
            <strong>{summary.urgentCount} 笔</strong>
            <em>3 天内到期</em>
          </article>
          <article>
            <span>最大单笔</span>
            <strong>{fmt(summary.maxAmount).replace('.00', '')}</strong>
            <em>重点关注供应商与凭证</em>
          </article>
        </section>

        <section className="dj-dashboard-grid dj-section">
          <div>
            <div className="dj-section-title">
              <h2>待审批列表</h2>
              <span>{loading ? '读取中' : `${pending.length} 条记录`}</span>
            </div>
            <div className="dj-card finance-table-card">
              <Table columns={cols} data={pending} loading={loading} />
            </div>
          </div>

          <aside>
            <div className="dj-section-title">
              <h2>审批判断</h2>
              <span>老板 / 财务</span>
            </div>
            <div className="dj-card receipt-decision-card">
              <article>
                <strong>入库真实</strong>
                <span>确认入库单、门店和供应商信息是否一致。</span>
              </article>
              <article>
                <strong>金额合理</strong>
                <span>查看是否因报损、拒收或临时供应商导致异常。</span>
              </article>
              <article>
                <strong>账户安全</strong>
                <span>确认供应商收款账户已配置且无异常变更。</span>
              </article>
            </div>

            <div className="dj-section-title finance-side-title">
              <h2>审批后链路</h2>
              <span>自动执行</span>
            </div>
            <div className="dj-card order-timeline">
              {['总部审批通过', '等待账期到期', '系统生成付款单', '财务付款执行', '供应商账款结清'].map((text, i) => (
                <article key={text} className={i <= 2 ? 'active' : ''}>
                  <i>{i + 1}</i>
                  <span>{text}</span>
                </article>
              ))}
            </div>
          </aside>
        </section>
      </main>

      {/* 审批弹窗 */}
      <Modal open={modalOpen} title={action === 'approve' ? '确认审批通过' : '确认拒绝付款'} onClose={() => setModalOpen(false)}>
        {current && (
          <>
            <div style={{ background: action === 'approve' ? '#edfaf3' : '#fef2f2', borderRadius: 10, padding: '14px 16px', marginBottom: 16 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 16px', fontSize: 13 }}>
                <div><span style={{ color: '#9ca3af' }}>门店：</span><b>{current.receipt?.store?.name}</b></div>
                <div><span style={{ color: '#9ca3af' }}>供应商：</span><b>{current.supplier?.name}</b></div>
                <div><span style={{ color: '#9ca3af' }}>付款金额：</span>
                  <b style={{ color: '#d97706', fontSize: 16 }}>{fmt(current.amount)}</b>
                </div>
                <div><span style={{ color: '#9ca3af' }}>到期日：</span><b>{fmtDate(current.dueAt)}</b></div>
                <div><span style={{ color: '#9ca3af' }}>收款账号：</span>{current.supplier?.bankAccount || '未配置'}</div>
                <div><span style={{ color: '#9ca3af' }}>入库单：</span>{current.receipt?.no}</div>
              </div>
            </div>

            {action === 'approve' && (
              <div style={{ background: '#eff6ff', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#2563eb', marginBottom: 14 }}>
                审批通过后，系统将在 <b>{fmtDate(current.dueAt)}</b> 自动从门店账户转账 <b>{fmt(current.amount)}</b> 至供应商账户
              </div>
            )}

            <Field label={action === 'approve' ? '审批备注（可选）' : '拒绝原因（建议填写）'}>
              <Input value={note} onChange={setNote} placeholder={action === 'approve' ? '无需备注可留空' : '请说明拒绝原因，将通知门店负责人'} />
            </Field>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20, paddingTop: 16, borderTop: '1px solid #e5e7eb' }}>
              <Btn onClick={() => setModalOpen(false)}>取消</Btn>
              <Btn variant={action === 'approve' ? 'primary' : 'danger'} onClick={submit} disabled={submitting}>
                {submitting ? '处理中...' : action === 'approve' ? '确认审批通过' : '确认拒绝'}
              </Btn>
            </div>
          </>
        )}
      </Modal>
    </AppLayout>
  )
}
