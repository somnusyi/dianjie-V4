'use client'
import { useEffect, useState } from 'react'
import AppLayout from '@/components/AppLayout'
import { PageHeader, Card, Table, Badge, Btn, Modal, Field, Input, Select, fmt, fmtDate, useToast, TableSkeleton } from '@/components/ui'
import api from '@/lib/api'

export default function ReconciliationsPage() {
  const [recons, setRecons] = useState<any[]>([])
  const [suppliers, setSuppliers] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [form, setForm] = useState({ supplierId: '', periodStart: '', periodEnd: '' })
  const { show, ToastEl } = useToast()

  const load = async () => {
    setLoading(true)
    try {
      const [r, s] = await Promise.all([api.get('/api/reconciliations'), api.get('/api/suppliers?status=ENABLED')])
      setRecons(r.data); setSuppliers(s.data)
    } catch {}
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  const review = async (id: string, action: 'approve' | 'reject') => {
    if (!window.confirm(action === 'approve' ? '确认审核通过？' : '确认驳回？')) return
    try {
      await api.patch(`/api/reconciliations/${id}/review`, { action })
      show(action === 'approve' ? '已审核通过' : '已驳回'); load()
    } catch (e: any) { show(e.response?.data?.error || '操作失败', 'error') }
  }

  const submit = async () => {
    if (!form.supplierId || !form.periodStart || !form.periodEnd) return show('请填写完整信息', 'error')
    try {
      await api.post('/api/reconciliations', form)
      show('对账单已生成'); setModalOpen(false); load()
    } catch (e: any) { show(e.response?.data?.error || '生成失败', 'error') }
  }

  const cols = [
    { key: 'no', title: '对账单号', render: (v: string) => <span style={{ color: '#156b43', fontWeight: 600 }}>{v}</span> },
    { key: 'supplier', title: '供应商', render: (_: any, row: any) => row.supplier?.name },
    { key: 'periodStart', title: '账期', render: (v: string, row: any) => `${fmtDate(v)} ~ ${fmtDate(row.periodEnd)}` },
    { key: 'totalAmount', title: '对账金额', render: (v: any) => <b style={{ color: '#d97706' }}>{fmt(v)}</b> },
    { key: 'status', title: '状态', render: (v: string) => <Badge status={v} /> },
    { key: 'createdAt', title: '生成时间', render: (v: string) => fmtDate(v) },
    { key: 'actions', title: '操作', render: (_: any, row: any) => (
      <div style={{ display: 'flex', gap: 6 }}>
        {row.status === 'DRAFT' && <>
          <Btn size="sm" variant="primary" onClick={() => review(row.id, 'approve')}>审核通过</Btn>
          <Btn size="sm" variant="danger" onClick={() => review(row.id, 'reject')}>驳回</Btn>
        </>}
      </div>
    )},
  ]

  return (
    <AppLayout>
      {ToastEl}
      <div style={{ padding: 28 }}>
        <PageHeader title="对账管理" sub="汇总已确认入库单，生成供应商对账单"
          action={<Btn variant="primary" onClick={() => setModalOpen(true)}>＋ 生成对账单</Btn>} />
        <Card style={{ padding: loading ? 16 : 0 }}>
          {loading ? <TableSkeleton rows={8} /> : <Table columns={cols} data={recons} />}
        </Card>
      </div>
      <Modal open={modalOpen} title="生成对账单" onClose={() => setModalOpen(false)}>
        <Field label="供应商" required>
          <Select value={form.supplierId} onChange={v => setForm({ ...form, supplierId: v })}
            options={suppliers.map(s => ({ value: s.id, label: s.name }))} placeholder="选择供应商" />
        </Field>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="账期开始" required><Input type="date" value={form.periodStart} onChange={v => setForm({ ...form, periodStart: v })} /></Field>
          <Field label="账期结束" required><Input type="date" value={form.periodEnd} onChange={v => setForm({ ...form, periodEnd: v })} /></Field>
        </div>
        <div style={{ background: '#f9fafb', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#6b7280', marginTop: 8 }}>
          将汇总该供应商在所选时间段内所有【已确认】入库单，生成对账单
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20, paddingTop: 16, borderTop: '1px solid #e5e7eb' }}>
          <Btn onClick={() => setModalOpen(false)}>取消</Btn>
          <Btn variant="primary" onClick={submit}>生成对账单</Btn>
        </div>
      </Modal>
    </AppLayout>
  )
}
