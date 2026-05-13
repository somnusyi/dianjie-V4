'use client'
import { useEffect, useState } from 'react'
import AppLayout from '@/components/AppLayout'
import { PageHeader, Card, Table, Badge, Btn, Modal, Field, Input, Select, fmt, fmtDate, useToast, TableSkeleton, Pagination } from '@/components/ui'
import api from '@/lib/api'

const PAGE_SIZE = 20

export default function PaymentsPage() {
  const [payments, setPayments] = useState<any[]>([])
  const [recons, setRecons] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [createOpen, setCreateOpen] = useState(false)
  const [paidOpen, setPaidOpen] = useState(false)
  const [current, setCurrent] = useState<any>(null)
  const [form, setForm] = useState({ reconciliationId: '', amount: '', method: 'BANK_TRANSFER', note: '' })
  const [bankTxNo, setBankTxNo] = useState('')
  const { show, ToastEl } = useToast()

  const load = async (p = page) => {
    setLoading(true)
    try {
      const [pm, r] = await Promise.all([
        api.get(`/api/payments?page=${p}&pageSize=${PAGE_SIZE}`),
        api.get('/api/reconciliations'),
      ])
      const data = pm.data
      setPayments(Array.isArray(data) ? data : data.items || [])
      setTotal(data.total || 0)
      setPage(p)
      setRecons(r.data.filter((r: any) => r.status === 'APPROVED'))
    } catch {}
    setLoading(false)
  }
  useEffect(() => { load(1) }, [])

  const openPaid = (row: any) => { setCurrent(row); setBankTxNo(''); setPaidOpen(true) }

  const submitCreate = async () => {
    if (!form.reconciliationId || !form.amount) return show('请填写完整信息', 'error')
    try {
      await api.post('/api/payments', { ...form, amount: Number(form.amount) })
      show('付款单已创建'); setCreateOpen(false); load(1)
    } catch (e: any) { show(e.response?.data?.error || '创建失败', 'error') }
  }

  const submitPaid = async () => {
    try {
      await api.patch(`/api/payments/${current.id}/paid`, { bankTxNo })
      show('已标记付款完成'); setPaidOpen(false); load(page)
    } catch (e: any) { show(e.response?.data?.error || '操作失败', 'error') }
  }

  const cols = [
    { key: 'no', title: '付款单号', render: (v: string) => <span style={{ color: '#156b43', fontWeight: 600 }}>{v}</span> },
    { key: 'supplier', title: '供应商', render: (_: any, row: any) => row.supplier?.name },
    { key: 'reconciliation', title: '关联对账单', render: (_: any, row: any) => row.reconciliation?.no || '-' },
    { key: 'amount', title: '付款金额', render: (v: any) => <b style={{ color: '#d97706' }}>{fmt(v)}</b> },
    { key: 'method', title: '付款方式', render: (v: string) => ({ BANK_TRANSFER: '网银转账', ALIPAY: '支付宝', WECHAT: '微信', CASH: '现金' }[v] || v) },
    { key: 'bankTxNo', title: '银行流水号', render: (v: string) => v || '-' },
    { key: 'status', title: '状态', render: (v: string) => <Badge status={v} /> },
    { key: 'paidAt', title: '付款时间', render: (v: string) => v ? fmtDate(v) : '-' },
    { key: 'actions', title: '操作', render: (_: any, row: any) => (
      row.status === 'UNPAID'
        ? <Btn size="sm" variant="primary" onClick={() => openPaid(row)}>标记已支付</Btn>
        : null
    )},
  ]

  return (
    <AppLayout>
      {ToastEl}
      <div style={{ padding: 28 }}>
        <PageHeader title="付款管理" sub="创建付款单，录入银行流水，完成供应商货款支付"
          action={<Btn variant="primary" onClick={() => setCreateOpen(true)}>＋ 创建付款单</Btn>} />
        <Card style={{ padding: loading ? 16 : 0 }}>
          {loading ? <TableSkeleton rows={8} /> : <Table columns={cols} data={payments} />}
          <div style={{ padding: '0 12px' }}>
            <Pagination page={page} pageSize={PAGE_SIZE} total={total} onChange={p => load(p)} />
          </div>
        </Card>
      </div>

      <Modal open={createOpen} title="创建付款单" onClose={() => setCreateOpen(false)}>
        <Field label="关联对账单" required>
          <Select value={form.reconciliationId} onChange={v => {
            const r = recons.find(r => r.id === v)
            setForm({ ...form, reconciliationId: v, amount: r ? String(r.totalAmount) : '' })
          }} options={recons.map(r => ({ value: r.id, label: `${r.no} · ${r.supplier?.name} · ${fmt(r.totalAmount)}` }))} placeholder="选择已审核的对账单" />
        </Field>
        <Field label="付款金额" required><Input value={form.amount} onChange={v => setForm({ ...form, amount: v })} type="number" /></Field>
        <Field label="付款方式">
          <Select value={form.method} onChange={v => setForm({ ...form, method: v })}
            options={[{ value: 'BANK_TRANSFER', label: '网银转账' }, { value: 'ALIPAY', label: '支付宝' }, { value: 'CASH', label: '现金' }]} />
        </Field>
        <Field label="备注"><Input value={form.note} onChange={v => setForm({ ...form, note: v })} placeholder="可选" /></Field>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20, paddingTop: 16, borderTop: '1px solid #e5e7eb' }}>
          <Btn onClick={() => setCreateOpen(false)}>取消</Btn>
          <Btn variant="primary" onClick={submitCreate}>创建</Btn>
        </div>
      </Modal>

      <Modal open={paidOpen} title="标记付款完成" onClose={() => setPaidOpen(false)}>
        {current && (
          <>
            <div style={{ background: '#f9fafb', borderRadius: 8, padding: '12px 14px', marginBottom: 16, fontSize: 13 }}>
              <div>供应商：<b>{current.supplier?.name}</b></div>
              <div style={{ marginTop: 4 }}>付款金额：<b style={{ color: '#d97706', fontSize: 15 }}>{fmt(current.amount)}</b></div>
              <div style={{ marginTop: 4 }}>收款账号：<span style={{ color: '#6b7280' }}>{current.supplier?.bankAccount || '未填写'}</span></div>
            </div>
            <Field label="银行流水号">
              <Input value={bankTxNo} onChange={setBankTxNo} placeholder="请填写银行转账流水号" />
            </Field>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20, paddingTop: 16, borderTop: '1px solid #e5e7eb' }}>
              <Btn onClick={() => setPaidOpen(false)}>取消</Btn>
              <Btn variant="primary" onClick={submitPaid}>确认已付款</Btn>
            </div>
          </>
        )}
      </Modal>
    </AppLayout>
  )
}
