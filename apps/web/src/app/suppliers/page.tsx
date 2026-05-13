'use client'
import { useEffect, useState } from 'react'
import AppLayout from '@/components/AppLayout'
import { PageHeader, Card, Table, Badge, Btn, Modal, Field, Input, Select, fmt, useToast, Pagination } from '@/components/ui'
import api from '@/lib/api'

const CREDIT_TYPES = [
  { value: 'FIXED_DAYS', label: '固定账期' },
  { value: 'MONTHLY', label: '月结' },
  { value: 'WEEKLY', label: '周结' },
  { value: 'ON_DELIVERY', label: '到货即付' },
]

const PAGE_SIZE = 20

export default function SuppliersPage() {
  const [suppliers, setSuppliers] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<any>(null)
  const { show, ToastEl } = useToast()

  const emptyForm = { no: '', name: '', contactName: '', contactPhone: '', category: '',
    creditType: 'FIXED_DAYS', creditDays: '30', autoPay: false,
    bankName: '', bankAccount: '', bankAccountName: '', bankCode: '' }
  const [form, setForm] = useState<any>(emptyForm)
  const [submitting, setSubmitting] = useState(false)

  const load = async (p = page) => {
    setLoading(true)
    try {
      const r = await api.get(`/api/suppliers?page=${p}&pageSize=${PAGE_SIZE}`)
      const data = r.data
      setSuppliers(data.items || [])
      setTotal(data.total || 0)
      setPage(p)
    } catch {}
    setLoading(false)
  }
  useEffect(() => { load(1) }, [])

  const openEdit = (row: any) => {
    setEditing(row)
    setForm({ ...row, creditDays: String(row.creditDays) })
    setModalOpen(true)
  }
  const openCreate = () => { setEditing(null); setForm(emptyForm); setModalOpen(true) }

  const toggle = async (row: any) => {
    try {
      await api.patch(`/api/suppliers/${row.id}/toggle`)
      show(`已${row.status === 'ENABLED' ? '停用' : '启用'}`)
      load(page)
    } catch { show('操作失败', 'error') }
  }

  const submit = async () => {
    if (!form.no || !form.name) return show('请填写供应商编号和名称', 'error')
    setSubmitting(true)
    try {
      const payload = { ...form, creditDays: Number(form.creditDays) }
      if (editing) await api.patch(`/api/suppliers/${editing.id}`, payload)
      else await api.post('/api/suppliers', payload)
      show(editing ? '已更新' : '供应商已创建')
      setModalOpen(false)
      load(editing ? page : 1)
    } catch (e: any) { show(e.response?.data?.error || '操作失败', 'error') }
    setSubmitting(false)
  }

  const cols = [
    { key: 'no', title: '编号', render: (v: string) => <span style={{ color: '#156b43', fontWeight: 600 }}>{v}</span> },
    { key: 'name', title: '供应商名称', render: (v: string) => <b>{v}</b> },
    { key: 'category', title: '品类' },
    { key: 'contactName', title: '联系人', render: (v: string, row: any) => `${v || '-'} ${row.contactPhone || ''}` },
    { key: 'creditType', title: '账期', render: (v: string, row: any) => {
      const t = CREDIT_TYPES.find(c => c.value === v)
      return <span style={{ fontSize: 11 }}>{t?.label}{v === 'FIXED_DAYS' ? ` (${row.creditDays}天)` : ''}</span>
    }},
    { key: 'autoPay', title: '自动打款', render: (v: boolean) => (
      <span style={{ color: v ? '#156b43' : '#9ca3af', fontSize: 11, fontWeight: 600 }}>{v ? '✓ 开启' : '手动'}</span>
    )},
    { key: 'scoreTotal', title: '评分', render: (v: number) => (
      <span style={{ color: v >= 90 ? '#156b43' : v >= 75 ? '#d97706' : '#dc2626', fontWeight: 700 }}>{v}</span>
    )},
    { key: 'status', title: '状态', render: (v: string) => <Badge status={v} /> },
    { key: 'actions', title: '操作', render: (_: any, row: any) => (
      <div style={{ display: 'flex', gap: 6 }}>
        <Btn size="sm" onClick={() => openEdit(row)}>编辑</Btn>
        <Btn size="sm" variant={row.status === 'ENABLED' ? 'danger' : 'primary'} onClick={() => toggle(row)}>
          {row.status === 'ENABLED' ? '停用' : '启用'}
        </Btn>
      </div>
    )},
  ]

  const f = (k: string) => ({ value: form[k] ?? '', onChange: (v: string) => setForm({ ...form, [k]: v }) })

  return (
    <AppLayout>
      {ToastEl}
      <div style={{ padding: 28 }}>
        <PageHeader title="供应商管理" sub="管理食材供应商信息及账期配置"
          action={<Btn variant="primary" onClick={openCreate}>＋ 新增供应商</Btn>} />
        <Card style={{ padding: loading ? 16 : 0 }}>
          <Table columns={cols} data={suppliers} loading={loading} />
          <div style={{ padding: '0 12px' }}>
            <Pagination page={page} pageSize={PAGE_SIZE} total={total} onChange={p => load(p)} />
          </div>
        </Card>
      </div>

      <Modal open={modalOpen} title={editing ? '编辑供应商' : '新增供应商'} onClose={() => setModalOpen(false)} width={580}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="编号" required><Input {...f('no')} placeholder="SUP006" disabled={!!editing} /></Field>
          <Field label="供应商名称" required><Input {...f('name')} placeholder="供应商全称" /></Field>
          <Field label="品类"><Input {...f('category')} placeholder="菌类/蔬菜/水产..." /></Field>
          <Field label="联系人"><Input {...f('contactName')} placeholder="联系人姓名" /></Field>
          <Field label="联系电话"><Input {...f('contactPhone')} placeholder="手机号" /></Field>
          <Field label="账期类型">
            <Select value={form.creditType} onChange={v => setForm({ ...form, creditType: v })} options={CREDIT_TYPES} />
          </Field>
          {form.creditType === 'FIXED_DAYS' && (
            <Field label="账期天数"><Input {...f('creditDays')} type="number" placeholder="30" /></Field>
          )}
        </div>

        <div style={{ margin: '14px 0 10px', fontSize: 12, fontWeight: 600, color: '#374151', borderTop: '1px solid #f3f4f6', paddingTop: 14 }}>
          收款银行信息
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="开户银行"><Input {...f('bankName')} placeholder="如：中国银行昆明分行" /></Field>
          <Field label="银行账号"><Input {...f('bankAccount')} placeholder="收款账号" /></Field>
          <Field label="账户名称"><Input {...f('bankAccountName')} placeholder="开户名" /></Field>
          <Field label="联行号"><Input {...f('bankCode')} placeholder="跨行付款必填，如：308584000013" /></Field>
          <Field label="自动打款">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
              <input type="checkbox" checked={form.autoPay} onChange={e => setForm({ ...form, autoPay: e.target.checked })} />
              <span style={{ fontSize: 12, color: '#6b7280' }}>到期自动发起网银转账</span>
            </div>
          </Field>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20, paddingTop: 16, borderTop: '1px solid #e5e7eb' }}>
          <Btn onClick={() => setModalOpen(false)}>取消</Btn>
          <Btn variant="primary" onClick={submit} disabled={submitting}>{submitting ? '保存中...' : '保存'}</Btn>
        </div>
      </Modal>
    </AppLayout>
  )
}
