'use client'

import { useEffect, useMemo, useState } from 'react'
import AppLayout from '@/components/AppLayout'
import { Btn, Field, Input, Modal, Pagination, Select, Table, fmt, fmtDate, useToast } from '@/components/ui'
import api from '@/lib/api'
import dayjs from 'dayjs'

type Tab = 'schedules' | 'payments' | 'rules'

const PAGE_SIZE = 20

const SCHEDULE_STATUS: Record<string, { label: string; tone: string; color: string; bg: string }> = {
  PENDING: { label: '待付款', tone: 'orange', color: '#854f0b', bg: '#faeeda' },
  PENDING_APPROVAL: { label: '待审批', tone: 'blue', color: '#185fa5', bg: '#e7eef6' },
  APPROVED: { label: '已审批', tone: 'green', color: '#1d9e75', bg: '#eaf3de' },
  NOTIFIED: { label: '已提醒', tone: 'orange', color: '#854f0b', bg: '#faeeda' },
  PROCESSING: { label: '付款中', tone: 'blue', color: '#185fa5', bg: '#e7eef6' },
  PAID: { label: '已付款', tone: 'gray', color: '#888780', bg: '#f2f1eb' },
  OVERDUE: { label: '已逾期', tone: 'red', color: '#a32d2d', bg: '#fcebeb' },
  CANCELLED: { label: '已取消', tone: 'gray', color: '#888780', bg: '#f2f1eb' },
  REJECTED: { label: '审批拒绝', tone: 'red', color: '#a32d2d', bg: '#fcebeb' },
}

const CONDITION_OPTIONS = [
  { value: 'AMOUNT_OVER', label: '单笔金额超过阈值' },
  { value: 'MONTHLY_OVER', label: '同供应商月累计超过' },
  { value: 'NEW_SUPPLIER', label: '新供应商首次付款' },
  { value: 'ALWAYS_AUTO', label: '始终自动付款' },
]

const ACTION_OPTIONS = [
  { value: 'auto_pay', label: '自动付款' },
  { value: 'require_approval', label: '需要审批' },
]

const CONDITION_LABEL: Record<string, string> = {
  AMOUNT_OVER: '单笔超过',
  MONTHLY_OVER: '月累计超过',
  NEW_SUPPLIER: '新供应商',
  ALWAYS_AUTO: '始终',
}

function safeUser() {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem('dj_user')
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export default function FinancePage() {
  const [tab, setTab] = useState<Tab>('schedules')
  const [schedules, setSchedules] = useState<any[]>([])
  const [payments, setPayments] = useState<any[]>([])
  const [rules, setRules] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [user, setUser] = useState<any>(null)
  const [filterStatus, setFilterStatus] = useState('')
  const [payPage, setPayPage] = useState(1)
  const [payTotal, setPayTotal] = useState(0)
  const { show, ToastEl } = useToast()

  const [approvalOpen, setApprovalOpen] = useState(false)
  const [approvalItem, setApprovalItem] = useState<any>(null)
  const [approvalNote, setApprovalNote] = useState('')
  const [approvalAction, setApprovalAction] = useState<'approve' | 'reject'>('approve')

  const [ruleOpen, setRuleOpen] = useState(false)
  const [editingRule, setEditingRule] = useState<any>(null)
  const [ruleForm, setRuleForm] = useState({
    name: '',
    description: '',
    condition: 'AMOUNT_OVER',
    threshold: '',
    action: 'require_approval',
    priority: '0',
  })

  useEffect(() => {
    setUser(safeUser())
  }, [])

  useEffect(() => {
    load(1)
  }, [tab, filterStatus])

  const load = async (p = payPage) => {
    setLoading(true)
    try {
      if (tab === 'schedules') {
        const qs = filterStatus ? `?status=${filterStatus}` : ''
        const r = await api.get(`/api/schedules${qs}`)
        setSchedules(Array.isArray(r.data) ? r.data : [])
      } else if (tab === 'payments') {
        const r = await api.get(`/api/payments?page=${p}&pageSize=${PAGE_SIZE}`)
        setPayments(r.data.items || [])
        setPayTotal(r.data.total || 0)
        setPayPage(p)
      } else {
        const r = await api.get('/api/payment-rules')
        setRules(Array.isArray(r.data) ? r.data : [])
      }
    } catch {
      show('财务数据读取失败', 'error')
    }
    setLoading(false)
  }

  const summary = useMemo(() => {
    const active = schedules.filter(s => !['PAID', 'CANCELLED', 'REJECTED'].includes(s.status))
    const overdue = schedules.filter(s => s.status === 'OVERDUE' || dayjs().isAfter(dayjs(s.dueAt), 'day'))
    const pendingApproval = schedules.filter(s => s.status === 'PENDING_APPROVAL')
    const dueIn7 = active.filter(s => {
      const days = dayjs(s.dueAt).diff(dayjs(), 'day')
      return days >= 0 && days <= 7
    })

    return {
      activeTotal: active.reduce((sum, s) => sum + Number(s.amount || 0), 0),
      overdueTotal: overdue.reduce((sum, s) => sum + Number(s.amount || 0), 0),
      pendingApprovalTotal: pendingApproval.reduce((sum, s) => sum + Number(s.amount || 0), 0),
      dueIn7Count: dueIn7.length,
      pendingApprovalCount: pendingApproval.length,
      overdueCount: overdue.length,
    }
  }, [schedules])

  const priorityList = useMemo(() => {
    return [...schedules]
      .filter(s => !['PAID', 'CANCELLED'].includes(s.status))
      .sort((a, b) => dayjs(a.dueAt).valueOf() - dayjs(b.dueAt).valueOf())
      .slice(0, 5)
  }, [schedules])

  const doApproval = async () => {
    try {
      await api.patch(`/api/schedules/${approvalItem.id}/${approvalAction}`, { note: approvalNote })
      show(approvalAction === 'approve' ? '已审批通过，到期将自动付款' : '已拒绝')
      setApprovalOpen(false)
      load(payPage)
    } catch (e: any) {
      show(e.response?.data?.error || '操作失败', 'error')
    }
  }

  const openRuleEdit = (rule?: any) => {
    if (rule) {
      setEditingRule(rule)
      setRuleForm({
        name: rule.name,
        description: rule.description || '',
        condition: rule.condition,
        threshold: rule.threshold || '',
        action: rule.action,
        priority: String(rule.priority),
      })
    } else {
      setEditingRule(null)
      setRuleForm({ name: '', description: '', condition: 'AMOUNT_OVER', threshold: '', action: 'require_approval', priority: '0' })
    }
    setRuleOpen(true)
  }

  const saveRule = async () => {
    if (!ruleForm.name || !ruleForm.condition || !ruleForm.action) return show('请填写完整信息', 'error')
    try {
      const data = {
        ...ruleForm,
        threshold: ruleForm.threshold ? Number(ruleForm.threshold) : null,
        priority: Number(ruleForm.priority),
      }
      if (editingRule) {
        await api.patch(`/api/payment-rules/${editingRule.id}`, data)
        show('规则已更新')
      } else {
        await api.post('/api/payment-rules', data)
        show('规则已创建')
      }
      setRuleOpen(false)
      load(payPage)
    } catch (e: any) {
      show(e.response?.data?.error || '保存失败', 'error')
    }
  }

  const toggleRule = async (rule: any) => {
    try {
      await api.patch(`/api/payment-rules/${rule.id}`, { enabled: !rule.enabled })
      load(payPage)
    } catch {
      show('规则状态更新失败', 'error')
    }
  }

  const deleteRule = async (rule: any) => {
    if (!window.confirm(`确认删除规则「${rule.name}」？`)) return
    try {
      await api.delete(`/api/payment-rules/${rule.id}`)
      load(payPage)
    } catch {
      show('规则删除失败', 'error')
    }
  }

  const tabs = [
    { key: 'schedules' as Tab, label: '账期总览', desc: '应付、逾期、审批' },
    { key: 'payments' as Tab, label: '付款历史', desc: '流水、凭证、状态' },
    { key: 'rules' as Tab, label: '付款规则', desc: '阈值与自动化', roles: ['ADMIN', 'SUPER_ADMIN'] },
  ]

  const scheduleCols = [
    { key: 'receipt', title: '入库单', render: (_: any, r: any) => <span className="dj-table-strong">{r.receipt?.no || '-'}</span> },
    { key: 'store', title: '门店', render: (_: any, r: any) => r.receipt?.store?.name?.replace('滇界·', '') || '-' },
    { key: 'supplier', title: '供应商', render: (_: any, r: any) => r.supplier?.name || '-' },
    { key: 'amount', title: '金额', render: (v: any) => <b>{fmt(v)}</b> },
    {
      key: 'dueAt',
      title: '到期日',
      render: (v: string, r: any) => {
        const days = dayjs(v).diff(dayjs(), 'day')
        const isOver = r.status === 'OVERDUE' || days < 0
        return (
          <div>
            <div>{fmtDate(v)}</div>
            <small className={isOver ? 'is-red' : days <= 3 ? 'is-orange' : ''}>
              {isOver ? `逾期${Math.abs(days)}天` : days === 0 ? '今天到期' : `${days}天后`}
            </small>
          </div>
        )
      },
    },
    {
      key: 'status',
      title: '状态',
      render: (v: string) => {
        const s = SCHEDULE_STATUS[v] || { label: v, color: '#888780', bg: '#f2f1eb' }
        return <span className="dj-chip" style={{ color: s.color, background: s.bg }}>{s.label}</span>
      },
    },
    {
      key: 'actions',
      title: '操作',
      render: (_: any, row: any) => {
        if (!['ADMIN', 'FINANCE', 'SUPER_ADMIN'].includes(user?.role)) return null
        if (row.status !== 'PENDING_APPROVAL') return null
        return (
          <Btn size="sm" variant="primary" onClick={() => {
            setApprovalItem(row)
            setApprovalAction('approve')
            setApprovalNote('')
            setApprovalOpen(true)
          }}>
            审批
          </Btn>
        )
      },
    },
  ]

  const paymentCols = [
    { key: 'no', title: '付款单号', render: (v: string) => <span className="dj-table-strong">{v}</span> },
    { key: 'supplier', title: '供应商', render: (_: any, r: any) => r.supplier?.name || '-' },
    { key: 'amount', title: '金额', render: (v: any) => <b>{fmt(v)}</b> },
    { key: 'method', title: '方式', render: (v: string) => ({ BANK_TRANSFER: '银行转账', ALIPAY: '支付宝', CASH: '现金' }[v] || v) },
    {
      key: 'status',
      title: '状态',
      render: (v: string) => {
        const m: any = { UNPAID: ['未付', 'dj-chip-orange'], PAYING: ['付款中', 'dj-chip-blue'], PAID: ['已付', 'dj-chip-green'], FAILED: ['失败', 'dj-chip-red'] }
        const [label, klass] = m[v] || [v, '']
        return <span className={`dj-chip ${klass}`}>{label}</span>
      },
    },
    { key: 'bankTxNo', title: '银行流水', render: (v: string) => <span className="dj-muted">{v || '-'}</span> },
    { key: 'paidAt', title: '付款时间', render: (v: string) => v ? fmtDate(v) : '-' },
  ]

  return (
    <AppLayout>
      {ToastEl}
      <main className="dj-page">
        <div className="dj-topbar">
          <div>
            <span>财务中心 · 账期与付款决策</span>
            <h1>财务工作台</h1>
            <p>把入库、账期、审批、付款规则放在同一个经营闭环里</p>
          </div>
          <span className={summary.overdueCount ? 'dj-chip dj-chip-red' : 'dj-chip dj-chip-green'}>
            {summary.overdueCount ? `${summary.overdueCount} 笔逾期需处理` : '账期健康'}
          </span>
        </div>

        <section className="dj-hero finance-hero">
          <div className="dj-hero-meta">
            <span>本期应付 <i /> 实时账期</span>
            <span>{dayjs().format('HH:mm')}</span>
          </div>
          <div className="dj-hero-main">
            <strong>{fmt(summary.activeTotal).replace('.00', '')}</strong>
            <em className={summary.overdueTotal > 0 ? 'is-red' : 'is-green'}>
              {summary.overdueTotal > 0 ? `逾期 ${fmt(summary.overdueTotal).replace('.00', '')}` : '无逾期'}
            </em>
          </div>
          <p>当前待审批 {summary.pendingApprovalCount} 笔 · 7 天内到期 {summary.dueIn7Count} 笔 · 付款规则 {rules.length || '-'} 条</p>
          <div className="finance-rail">
            <span style={{ width: '38%' }} />
            <span style={{ width: '22%' }} />
            <span style={{ width: '16%' }} />
          </div>
          <div className="dj-hero-stats">
            <div><span>待审批金额</span><strong>{fmt(summary.pendingApprovalTotal).replace('.00', '')}</strong></div>
            <div><span>逾期笔数</span><strong className={summary.overdueCount ? 'is-red' : ''}>{summary.overdueCount} 笔</strong></div>
            <div><span>7 天内到期</span><strong>{summary.dueIn7Count} 笔</strong></div>
          </div>
        </section>

        <section className="dj-metric-grid">
          <article>
            <span>待付款总额</span>
            <strong>{fmt(summary.activeTotal).replace('.00', '')}</strong>
            <em>含已审批与待处理账期</em>
          </article>
          <article className={summary.dueIn7Count > 0 ? 'tone-orange' : 'tone-green'}>
            <span>7 天内到期</span>
            <strong>{summary.dueIn7Count} 笔</strong>
            <em>需要提前安排资金</em>
          </article>
          <article className={summary.pendingApprovalCount > 0 ? 'tone-blue' : 'tone-green'}>
            <span>待审批</span>
            <strong>{summary.pendingApprovalCount} 笔</strong>
            <em>超过规则阈值进入人工决策</em>
          </article>
          <article className={summary.overdueTotal > 0 ? 'tone-red' : 'tone-green'}>
            <span>逾期金额</span>
            <strong>{summary.overdueTotal > 0 ? fmt(summary.overdueTotal).replace('.00', '') : '无'}</strong>
            <em>供应商履约信用相关</em>
          </article>
        </section>

        <section className="dj-dashboard-grid dj-section">
          <div>
            <div className="dj-section-title">
              <h2>财务处理台</h2>
              <span>{loading ? '读取中' : `${tab === 'payments' ? payTotal : schedules.length} 条记录`}</span>
            </div>

            <div className="finance-tabs">
              {tabs.filter(t => !t.roles || t.roles.includes(user?.role)).map(t => (
                <button key={t.key} className={tab === t.key ? 'active' : ''} onClick={() => { setTab(t.key); setFilterStatus('') }}>
                  <strong>{t.label}</strong>
                  <span>{t.desc}</span>
                </button>
              ))}
            </div>

            {tab === 'schedules' && (
              <div className="finance-filter">
                {[
                  { v: '', l: '全部' },
                  { v: 'PENDING', l: '待付款' },
                  { v: 'PENDING_APPROVAL', l: '待审批' },
                  { v: 'OVERDUE', l: '逾期' },
                  { v: 'PAID', l: '已付款' },
                ].map(f => (
                  <button key={f.v} className={filterStatus === f.v ? 'active' : ''} onClick={() => setFilterStatus(f.v)}>{f.l}</button>
                ))}
              </div>
            )}

            {tab === 'rules' ? (
              <div className="finance-rule-panel">
                <div className="finance-rule-head">
                  <div>
                    <strong>付款规则</strong>
                    <span>规则按优先级匹配，命中后决定自动付款或人工审批。</span>
                  </div>
                  <Btn variant="primary" onClick={() => openRuleEdit()}>新建规则</Btn>
                </div>
                {rules.length === 0 && !loading ? (
                  <div className="dj-empty-row">暂无规则，先建立大额付款、月累计付款等审批边界。</div>
                ) : (
                  rules.map((rule, i) => (
                    <article key={rule.id} className={rule.enabled ? '' : 'disabled'}>
                      <i>{i + 1}</i>
                      <div>
                        <strong>{rule.name}</strong>
                        <span>{rule.description || '未填写说明'}</span>
                      </div>
                      <em>
                        {CONDITION_LABEL[rule.condition] || rule.condition}
                        {rule.threshold ? ` ¥${Number(rule.threshold).toLocaleString()}` : ''}
                      </em>
                      <b>{rule.action === 'auto_pay' ? '自动付款' : '人工审批'}</b>
                      <div>
                        <Btn size="sm" onClick={() => toggleRule(rule)}>{rule.enabled ? '停用' : '启用'}</Btn>
                        <Btn size="sm" onClick={() => openRuleEdit(rule)}>编辑</Btn>
                        <Btn size="sm" variant="danger" onClick={() => deleteRule(rule)}>删除</Btn>
                      </div>
                    </article>
                  ))
                )}
              </div>
            ) : (
              <div className="dj-card finance-table-card">
                {tab === 'schedules' && <Table columns={scheduleCols} data={schedules} loading={loading} />}
                {tab === 'payments' && (
                  <>
                    <Table columns={paymentCols} data={payments} loading={loading} />
                    <div className="finance-pagination">
                      <Pagination page={payPage} pageSize={PAGE_SIZE} total={payTotal} onChange={p => load(p)} />
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          <aside>
            <div className="dj-section-title">
              <h2>近期资金动作</h2>
              <span>按到期日排序</span>
            </div>
            <div className="dj-card finance-action-list">
              {priorityList.length === 0 ? (
                <div className="dj-empty-row">暂无需要处理的账期。</div>
              ) : priorityList.map(item => {
                const days = dayjs(item.dueAt).diff(dayjs(), 'day')
                const status = SCHEDULE_STATUS[item.status] || SCHEDULE_STATUS.PENDING
                return (
                  <article key={item.id}>
                    <div>
                      <span className="dj-chip" style={{ color: status.color, background: status.bg }}>{status.label}</span>
                      <strong>{item.supplier?.name || '未知供应商'}</strong>
                      <p>{item.receipt?.store?.name?.replace('滇界·', '') || '-'} · {fmtDate(item.dueAt)}</p>
                    </div>
                    <div>
                      <b>{fmt(item.amount).replace('.00', '')}</b>
                      <em className={days < 0 ? 'is-red' : days <= 3 ? 'is-orange' : ''}>
                        {days < 0 ? `逾期${Math.abs(days)}天` : days === 0 ? '今天' : `${days}天后`}
                      </em>
                    </div>
                  </article>
                )
              })}
            </div>

            <div className="dj-section-title finance-side-title">
              <h2>经营建议</h2>
              <span>AI 规则草案</span>
            </div>
            <div className="dj-card finance-ai-card">
              <strong>把付款审批拆成三档</strong>
              <p>建议保留 5000 元以下自动付款、5000-20000 元财务复核、20000 元以上老板终审。这样能减少小额账期堆积，同时把大额风险留给人工判断。</p>
              <div>
                <span>效率</span>
                <b style={{ width: '72%' }} />
              </div>
              <div>
                <span>风险</span>
                <b style={{ width: '38%', background: 'var(--dj-red)' }} />
              </div>
            </div>
          </aside>
        </section>
      </main>

      <Modal open={approvalOpen} title="付款审批" onClose={() => setApprovalOpen(false)}>
        {approvalItem && (
          <>
            <div className="finance-approval-card">
              <span>供应商</span>
              <strong>{approvalItem.supplier?.name}</strong>
              <span>付款金额</span>
              <b>{fmt(approvalItem.amount)}</b>
              <span>到期日</span>
              <em>{fmtDate(approvalItem.dueAt)}</em>
            </div>
            <div className="finance-decision">
              {(['approve', 'reject'] as const).map(a => (
                <button key={a} className={approvalAction === a ? 'active' : ''} onClick={() => setApprovalAction(a)}>
                  {a === 'approve' ? '审批通过' : '拒绝付款'}
                </button>
              ))}
            </div>
            <Field label={approvalAction === 'approve' ? '备注（可选）' : '拒绝原因'}>
              <Input value={approvalNote} onChange={setApprovalNote} placeholder={approvalAction === 'reject' ? '请填写拒绝原因' : '可选'} />
            </Field>
            <div className="finance-modal-actions">
              <Btn onClick={() => setApprovalOpen(false)}>取消</Btn>
              <Btn variant={approvalAction === 'approve' ? 'primary' : 'danger'} onClick={doApproval}>确认</Btn>
            </div>
          </>
        )}
      </Modal>

      <Modal open={ruleOpen} title={editingRule ? '编辑付款规则' : '新建付款规则'} onClose={() => setRuleOpen(false)}>
        <Field label="规则名称" required>
          <Input value={ruleForm.name} onChange={v => setRuleForm({ ...ruleForm, name: v })} placeholder="如：大额人工确认" />
        </Field>
        <Field label="说明">
          <Input value={ruleForm.description} onChange={v => setRuleForm({ ...ruleForm, description: v })} placeholder="简单描述这条规则的作用" />
        </Field>
        <div className="finance-form-grid">
          <Field label="触发条件" required>
            <Select value={ruleForm.condition} onChange={v => setRuleForm({ ...ruleForm, condition: v })} options={CONDITION_OPTIONS} />
          </Field>
          <Field label="金额阈值">
            <Input
              value={ruleForm.threshold}
              onChange={v => setRuleForm({ ...ruleForm, threshold: v })}
              placeholder="填金额（元）"
              type="number"
              disabled={['NEW_SUPPLIER', 'ALWAYS_AUTO'].includes(ruleForm.condition)}
            />
          </Field>
        </div>
        <div className="finance-form-grid">
          <Field label="执行动作" required>
            <Select value={ruleForm.action} onChange={v => setRuleForm({ ...ruleForm, action: v })} options={ACTION_OPTIONS} />
          </Field>
          <Field label="优先级">
            <Input value={ruleForm.priority} onChange={v => setRuleForm({ ...ruleForm, priority: v })} placeholder="数字越大越先匹配" type="number" />
          </Field>
        </div>
        <div className="finance-rule-preview">
          {ruleForm.condition === 'AMOUNT_OVER' && `当单笔付款金额超过 ¥${ruleForm.threshold || '?'} 时，${ruleForm.action === 'auto_pay' ? '自动付款' : '需要人工审批'}`}
          {ruleForm.condition === 'MONTHLY_OVER' && `当同一供应商本月累计付款超过 ¥${ruleForm.threshold || '?'} 时，${ruleForm.action === 'auto_pay' ? '自动付款' : '需要人工审批'}`}
          {ruleForm.condition === 'NEW_SUPPLIER' && `新供应商首次付款时，${ruleForm.action === 'auto_pay' ? '自动付款' : '需要人工审批'}`}
          {ruleForm.condition === 'ALWAYS_AUTO' && '所有付款始终自动执行，不需要审批'}
        </div>
        <div className="finance-modal-actions">
          <Btn onClick={() => setRuleOpen(false)}>取消</Btn>
          <Btn variant="primary" onClick={saveRule}>保存规则</Btn>
        </div>
      </Modal>
    </AppLayout>
  )
}
