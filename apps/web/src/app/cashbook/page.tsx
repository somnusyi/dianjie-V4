'use client'
import { useEffect, useState } from 'react'
import AppLayout from '@/components/AppLayout'
import { PageHeader, Card, Table, Btn, Modal, Field, Input, Select, fmt, fmtDate, useToast, Pagination } from '@/components/ui'
import api from '@/lib/api'
import dayjs from 'dayjs'

type Tab = 'transactions' | 'summary'

const ACCOUNT_TYPE_ICON: Record<string, string> = {
  BANK: '🏦', ALIPAY: '💙', WECHAT: '💚', CASH: '💵',
}
const ACCOUNT_TYPE_LABEL: Record<string, string> = {
  BANK: '银行账户', ALIPAY: '支付宝', WECHAT: '微信支付', CASH: '现金/备用金',
}
const ACCOUNT_TYPES = [
  { value: 'BANK', label: '🏦 银行账户' },
  { value: 'ALIPAY', label: '💙 支付宝' },
  { value: 'WECHAT', label: '💚 微信支付' },
  { value: 'CASH', label: '💵 现金/备用金' },
]
const CATEGORIES = [
  { value: '供应商付款', label: '供应商付款' },
  { value: '营业收入',   label: '营业收入' },
  { value: '人工费用',   label: '人工费用' },
  { value: '运营支出',   label: '运营支出' },
  { value: '房租',       label: '房租' },
  { value: '税费',       label: '税费' },
  { value: '转账',       label: '转账' },
  { value: '其他',       label: '其他' },
]

const PAGE_SIZE = 20

export default function CashbookPage() {
  const [tab, setTab] = useState<Tab>('transactions')
  const [accounts, setAccounts] = useState<any[]>([])
  const [transactions, setTransactions] = useState<any[]>([])
  const [summary, setSummary] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)

  // 过滤条件
  const [filterAccount, setFilterAccount] = useState('')
  const [filterMonth, setFilterMonth] = useState(dayjs().format('YYYY-MM'))

  // 新增账户弹窗
  const [accountOpen, setAccountOpen] = useState(false)
  const [accountForm, setAccountForm] = useState({ name: '', type: 'BANK', bankName: '', accountNo: '', note: '' })

  // 录入流水弹窗
  const [txOpen, setTxOpen] = useState(false)
  const [txForm, setTxForm] = useState({
    accountId: '', direction: '1', category: '供应商付款',
    amount: '', txDate: dayjs().format('YYYY-MM-DD'), note: '',
  })

  const { show, ToastEl } = useToast()

  useEffect(() => { loadAll(1) }, [tab, filterAccount, filterMonth])

  const loadAll = async (p = page) => {
    setLoading(true)
    try {
      const [acctRes, summaryRes] = await Promise.all([
        api.get('/api/cashbook/accounts'),
        api.get('/api/cashbook/summary'),
      ])
      setAccounts(acctRes.data || [])
      setSummary(summaryRes.data)

      if (tab === 'transactions') {
        const params = new URLSearchParams({ page: String(p), pageSize: String(PAGE_SIZE) })
        if (filterAccount) params.set('accountId', filterAccount)
        if (filterMonth) params.set('month', filterMonth + '-01')
        const txRes = await api.get(`/api/cashbook/transactions?${params}`)
        setTransactions(txRes.data.items || [])
        setTotal(txRes.data.total || 0)
        setPage(p)
      }
    } catch {}
    setLoading(false)
  }

  const submitAccount = async () => {
    if (!accountForm.name) return show('账户名称不能为空', 'error')
    try {
      await api.post('/api/cashbook/accounts', accountForm)
      show('账户已创建')
      setAccountOpen(false)
      setAccountForm({ name: '', type: 'BANK', bankName: '', accountNo: '', note: '' })
      loadAll(1)
    } catch (e: any) { show(e.response?.data?.error || '创建失败', 'error') }
  }

  const submitTx = async () => {
    if (!txForm.accountId || !txForm.amount || !txForm.txDate)
      return show('请填写完整信息', 'error')
    if (Number(txForm.amount) <= 0) return show('金额必须大于 0', 'error')
    try {
      await api.post('/api/cashbook/transactions', {
        ...txForm,
        direction: Number(txForm.direction),
        amount: Number(txForm.amount),
      })
      show(`${txForm.direction === '1' ? '收入' : '支出'}已录入`)
      setTxOpen(false)
      setTxForm({ accountId: '', direction: '1', category: '供应商付款', amount: '', txDate: dayjs().format('YYYY-MM-DD'), note: '' })
      loadAll(1)
    } catch (e: any) { show(e.response?.data?.error || '录入失败', 'error') }
  }

  const txCols = [
    { key: 'txDate', title: '日期', render: (v: string) => fmtDate(v) },
    { key: 'account', title: '账户', render: (_: any, r: any) => (
      <span style={{ fontSize: 12 }}>{ACCOUNT_TYPE_ICON[r.account?.type]} {r.account?.name}</span>
    )},
    { key: 'direction', title: '收/支', render: (v: number) => (
      <span style={{ fontWeight: 700, color: v === 1 ? '#156b43' : '#dc2626', fontSize: 12 }}>
        {v === 1 ? '↑ 收入' : '↓ 支出'}
      </span>
    )},
    { key: 'category', title: '分类', render: (v: string) => <span style={{ fontSize: 12 }}>{v}</span> },
    { key: 'amount', title: '金额', render: (v: any, r: any) => (
      <b style={{ color: r.direction === 1 ? '#156b43' : '#dc2626' }}>
        {r.direction === 1 ? '+' : '-'}{fmt(v)}
      </b>
    )},
    { key: 'balanceAfter', title: '余额快照', render: (v: any) => (
      <span style={{ fontSize: 12, color: '#6b7280' }}>{fmt(v)}</span>
    )},
    { key: 'note', title: '备注', render: (v: string) => <span style={{ fontSize: 11, color: '#9ca3af' }}>{v || '-'}</span> },
  ]

  const months = Array.from({ length: 6 }, (_, i) => {
    const m = dayjs().subtract(i, 'month').format('YYYY-MM')
    return { value: m, label: m }
  })

  return (
    <AppLayout>
      {ToastEl}
      <div style={{ padding: 28 }}>
        <PageHeader title="资金台账" sub="管理多账户余额 · 记录资金收支流水"
          action={
            <div style={{ display: 'flex', gap: 8 }}>
              <Btn onClick={() => setAccountOpen(true)}>＋ 新增账户</Btn>
              <Btn variant="primary" onClick={() => setTxOpen(true)}>＋ 录入流水</Btn>
            </div>
          }
        />

        {/* 账户卡片区 */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12, marginBottom: 20 }}>
          {accounts.map(acct => (
            <div key={acct.id} style={{
              background: '#fff', borderRadius: 12, padding: '16px 18px',
              border: `1px solid ${Number(acct.balance) < 0 ? '#fca5a5' : '#e5e7eb'}`,
              boxShadow: '0 1px 4px rgba(0,0,0,.05)',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontSize: 18 }}>{ACCOUNT_TYPE_ICON[acct.type]}</span>
                <span style={{ fontSize: 10, color: '#9ca3af', background: '#f3f4f6', borderRadius: 4, padding: '2px 6px' }}>
                  {ACCOUNT_TYPE_LABEL[acct.type]}
                </span>
              </div>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: '#374151', marginBottom: 6 }}>{acct.name}</div>
              {acct.accountNo && (
                <div style={{ fontSize: 10, color: '#9ca3af', marginBottom: 6 }}>
                  尾号 {acct.accountNo.slice(-4)}
                </div>
              )}
              <div style={{
                fontSize: 20, fontWeight: 800,
                color: Number(acct.balance) < 0 ? '#dc2626' : '#111827',
              }}>
                {fmt(acct.balance)}
              </div>
              {Number(acct.balance) < 0 && (
                <div style={{ fontSize: 10, color: '#dc2626', marginTop: 4 }}>⚠️ 余额为负，请及时处理</div>
              )}
            </div>
          ))}
          {accounts.length === 0 && !loading && (
            <div style={{
              background: '#f9fafb', borderRadius: 12, padding: '20px',
              border: '2px dashed #e5e7eb', color: '#9ca3af', fontSize: 13, textAlign: 'center',
            }}>
              暂无账户，点击「新增账户」开始
            </div>
          )}
        </div>

        {/* Tab 切换 */}
        <div style={{ display: 'flex', gap: 4, marginBottom: 16, background: '#f3f4f6', borderRadius: 10, padding: 4, width: 'fit-content' }}>
          {[{ key: 'transactions' as Tab, label: '💳 流水明细' }, { key: 'summary' as Tab, label: '📊 本月汇总' }].map(t => (
            <div key={t.key} onClick={() => setTab(t.key)} style={{
              padding: '8px 20px', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 500,
              background: tab === t.key ? '#fff' : 'transparent',
              color: tab === t.key ? '#111827' : '#6b7280',
              boxShadow: tab === t.key ? '0 1px 4px rgba(0,0,0,.1)' : 'none',
              transition: 'all .15s',
            }}>{t.label}</div>
          ))}
        </div>

        {/* 流水明细 Tab */}
        {tab === 'transactions' && (
          <>
            <div style={{ display: 'flex', gap: 10, marginBottom: 14, alignItems: 'center' }}>
              <Select
                value={filterAccount}
                onChange={v => { setFilterAccount(v); loadAll(1) }}
                options={[{ value: '', label: '全部账户' }, ...accounts.map(a => ({ value: a.id, label: `${ACCOUNT_TYPE_ICON[a.type]} ${a.name}` }))]}
              />
              <Select
                value={filterMonth}
                onChange={v => { setFilterMonth(v); loadAll(1) }}
                options={months}
              />
            </div>
            <Card style={{ padding: 0 }}>
              <Table columns={txCols} data={transactions} loading={loading} />
              <div style={{ padding: '0 12px' }}>
                <Pagination page={page} pageSize={PAGE_SIZE} total={total} onChange={p => loadAll(p)} />
              </div>
            </Card>
          </>
        )}

        {/* 本月汇总 Tab */}
        {tab === 'summary' && summary && (
          <div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
              {[
                { label: '账户总余额', value: fmt(summary.totalBalance), color: Number(summary.totalBalance) >= 0 ? '#111827' : '#dc2626', icon: '💰' },
                { label: '本月总收入', value: fmt(summary.monthIncome),  color: '#156b43', icon: '↑' },
                { label: '本月总支出', value: fmt(summary.monthExpense), color: '#dc2626', icon: '↓' },
                { label: '本月净额',   value: fmt(summary.monthNet),     color: Number(summary.monthNet) >= 0 ? '#156b43' : '#dc2626', icon: '≈' },
              ].map(c => (
                <div key={c.label} style={{ background: '#fff', borderRadius: 12, padding: '16px 18px', border: '1px solid #e5e7eb' }}>
                  <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 6, display: 'flex', justifyContent: 'space-between' }}>
                    {c.label} <span style={{ fontWeight: 700 }}>{c.icon}</span>
                  </div>
                  <div style={{ fontSize: 20, fontWeight: 800, color: c.color }}>{c.value}</div>
                </div>
              ))}
            </div>

            <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 12 }}>各账户余额明细</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {summary.accounts.map((acct: any) => (
                <div key={acct.id} style={{
                  background: '#fff', borderRadius: 10, padding: '12px 16px',
                  border: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', gap: 12,
                }}>
                  <span style={{ fontSize: 20 }}>{ACCOUNT_TYPE_ICON[acct.type]}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>{acct.name}</div>
                    <div style={{ fontSize: 11, color: '#9ca3af' }}>{ACCOUNT_TYPE_LABEL[acct.type]}</div>
                  </div>
                  <div style={{ fontSize: 18, fontWeight: 800, color: Number(acct.balance) < 0 ? '#dc2626' : '#111827' }}>
                    {fmt(acct.balance)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 新增账户弹窗 */}
      <Modal open={accountOpen} title="新增账户" onClose={() => setAccountOpen(false)}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="账户名称" required>
            <Input value={accountForm.name} onChange={v => setAccountForm({ ...accountForm, name: v })} placeholder="如：工商银行对公账户" />
          </Field>
          <Field label="账户类型" required>
            <Select value={accountForm.type} onChange={v => setAccountForm({ ...accountForm, type: v })} options={ACCOUNT_TYPES} />
          </Field>
          <Field label="开户行">
            <Input value={accountForm.bankName} onChange={v => setAccountForm({ ...accountForm, bankName: v })} placeholder="如：工商银行昆明分行" />
          </Field>
          <Field label="账号">
            <Input value={accountForm.accountNo} onChange={v => setAccountForm({ ...accountForm, accountNo: v })} placeholder="收款账号" />
          </Field>
        </div>
        <Field label="备注">
          <Input value={accountForm.note} onChange={v => setAccountForm({ ...accountForm, note: v })} placeholder="可选" />
        </Field>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20, paddingTop: 16, borderTop: '1px solid #e5e7eb' }}>
          <Btn onClick={() => setAccountOpen(false)}>取消</Btn>
          <Btn variant="primary" onClick={submitAccount}>创建账户</Btn>
        </div>
      </Modal>

      {/* 录入流水弹窗 */}
      <Modal open={txOpen} title="录入资金流水" onClose={() => setTxOpen(false)}>
        {/* 收入/支出切换 */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          {[{ v: '1', label: '↑ 收入', ok: '#156b43', bg: '#edfaf3' }, { v: '-1', label: '↓ 支出', ok: '#dc2626', bg: '#fef2f2' }].map(d => (
            <div key={d.v} onClick={() => setTxForm({ ...txForm, direction: d.v })} style={{
              flex: 1, padding: '10px', borderRadius: 8, textAlign: 'center', cursor: 'pointer',
              fontWeight: 700, fontSize: 14,
              background: txForm.direction === d.v ? d.bg : '#f9fafb',
              color: txForm.direction === d.v ? d.ok : '#9ca3af',
              border: `2px solid ${txForm.direction === d.v ? d.ok : '#e5e7eb'}`,
              transition: 'all .15s',
            }}>{d.label}</div>
          ))}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="账户" required>
            <Select value={txForm.accountId} onChange={v => setTxForm({ ...txForm, accountId: v })}
              options={accounts.map(a => ({ value: a.id, label: `${ACCOUNT_TYPE_ICON[a.type]} ${a.name}` }))}
              placeholder="选择账户" />
          </Field>
          <Field label="分类" required>
            <Select value={txForm.category} onChange={v => setTxForm({ ...txForm, category: v })} options={CATEGORIES} />
          </Field>
          <Field label="金额" required>
            <Input value={txForm.amount} onChange={v => setTxForm({ ...txForm, amount: v })} type="number" placeholder="0.00" />
          </Field>
          <Field label="交易日期" required>
            <Input value={txForm.txDate} onChange={v => setTxForm({ ...txForm, txDate: v })} type="date" />
          </Field>
        </div>
        <Field label="备注">
          <Input value={txForm.note} onChange={v => setTxForm({ ...txForm, note: v })} placeholder="可选" />
        </Field>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20, paddingTop: 16, borderTop: '1px solid #e5e7eb' }}>
          <Btn onClick={() => setTxOpen(false)}>取消</Btn>
          <Btn variant={txForm.direction === '1' ? 'primary' : 'danger'} onClick={submitTx}>
            确认录入{txForm.direction === '1' ? '收入' : '支出'}
          </Btn>
        </div>
      </Modal>
    </AppLayout>
  )
}
