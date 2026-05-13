'use client'
import { useEffect, useState } from 'react'
import AppLayout from '@/components/AppLayout'
import { PageHeader, Card, Table, Badge, Btn, KpiCard, Empty, fmt, fmtDate, useToast, TableSkeleton } from '@/components/ui'
import api from '@/lib/api'
import dayjs from 'dayjs'

function CountdownBadge({ dueAt, status }: { dueAt: string; status: string }) {
  const now = dayjs()
  const due = dayjs(dueAt)
  const diff = due.diff(now, 'day')
  if (status === 'PAID') return <span style={{ color: '#156b43', fontSize: 11, fontWeight: 600 }}>已付款</span>
  if (status === 'OVERDUE') return <span style={{ color: '#dc2626', fontSize: 11, fontWeight: 700 }}>已逾期 {Math.abs(diff)}天</span>
  if (diff <= 0) return <span style={{ color: '#dc2626', fontSize: 11, fontWeight: 700 }}>今日到期</span>
  if (diff <= 3) return <span style={{ color: '#d97706', fontSize: 11, fontWeight: 700 }}>还剩 {diff} 天</span>
  return <span style={{ color: '#6b7280', fontSize: 11 }}>还剩 {diff} 天</span>
}

export default function SchedulesPage() {
  const [schedules, setSchedules] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [filterStatus, setFilterStatus] = useState('')
  const { show, ToastEl } = useToast()

  const load = async () => {
    setLoading(true)
    try {
      const params = filterStatus ? `?status=${filterStatus}` : ''
      const r = await api.get(`/api/schedules${params}`)
      setSchedules(r.data)
    } catch {}
    setLoading(false)
  }

  useEffect(() => { load() }, [filterStatus])

  // 统计
  const total = schedules.length
  const overdue = schedules.filter(s => s.status === 'OVERDUE').length
  const dueSoon = schedules.filter(s => {
    const diff = dayjs(s.dueAt).diff(dayjs(), 'day')
    return diff >= 0 && diff <= 7 && s.status !== 'PAID'
  }).length
  const totalAmt = schedules.filter(s => !['PAID', 'CANCELLED'].includes(s.status))
    .reduce((s, r) => s + Number(r.amount), 0)

  const cols = [
    { key: 'receipt', title: '关联入库单', render: (_: any, row: any) => (
      <span style={{ color: '#156b43', fontWeight: 600 }}>{row.receipt?.no}</span>
    )},
    { key: 'supplier', title: '供应商', render: (_: any, row: any) => row.supplier?.name },
    { key: 'amount', title: '应付金额', render: (v: any) => <b style={{ color: '#d97706' }}>{fmt(v)}</b> },
    { key: 'creditDays', title: '账期', render: (v: number, row: any) => (
      <span style={{ fontSize: 11, color: '#6b7280' }}>
        {{ FIXED_DAYS: `${v}天账期`, MONTHLY: '月结', WEEKLY: '周结', ON_DELIVERY: '到货即付' }[row.supplier?.creditType as string] || `${v}天`}
      </span>
    )},
    { key: 'confirmedAt', title: '确认日期', render: (v: string) => fmtDate(v) },
    { key: 'dueAt', title: '到期日', render: (v: string) => (
      <span style={{ fontWeight: 600, color: dayjs(v).isBefore(dayjs()) ? '#dc2626' : '#374151' }}>
        {fmtDate(v)}
      </span>
    )},
    { key: 'countdown', title: '倒计时', render: (_: any, row: any) => <CountdownBadge dueAt={row.dueAt} status={row.status} /> },
    { key: 'status', title: '状态', render: (v: string) => <Badge status={v} /> },
  ]

  const statusOpts = [
    { value: '', label: '全部' },
    { value: 'PENDING', label: '待付款' },
    { value: 'NOTIFIED', label: '已提醒' },
    { value: 'OVERDUE', label: '逾期' },
    { value: 'PAID', label: '已付款' },
  ]

  return (
    <AppLayout>
      {ToastEl}
      <div style={{ padding: 28 }}>
        <PageHeader title="账期看板" sub="入库确认后自动创建，到期自动提醒付款" />

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14, marginBottom: 20 }}>
          <KpiCard label="待付账期总额" value={fmt(totalAmt)} sub="所有未付账期" color="#d97706" />
          <KpiCard label="账期总数" value={`${total} 笔`} sub="含全部状态" color="#156b43" />
          <KpiCard label="7天内到期" value={`${dueSoon} 笔`} sub="需提前准备资金" color={dueSoon > 0 ? '#d97706' : '#156b43'} />
          <KpiCard label="逾期未付" value={`${overdue} 笔`} sub={overdue > 0 ? '⚠️ 立即处理' : '状态良好'} color={overdue > 0 ? '#dc2626' : '#156b43'} />
        </div>

        {/* 逾期警告 */}
        {overdue > 0 && (
          <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 10, padding: '12px 16px', marginBottom: 16, fontSize: 13, color: '#dc2626', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 18 }}>🚨</span>
            <span>有 <b>{overdue}</b> 笔账期已逾期，请尽快处理以维护供应商关系。逾期账款已通知财务负责人。</span>
          </div>
        )}

        {/* 筛选 */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          {statusOpts.map(o => (
            <div key={o.value} onClick={() => setFilterStatus(o.value)}
              style={{
                padding: '5px 14px', borderRadius: 20, fontSize: 12, cursor: 'pointer', fontWeight: 500,
                background: filterStatus === o.value ? '#156b43' : '#fff',
                color: filterStatus === o.value ? '#fff' : '#6b7280',
                border: `1px solid ${filterStatus === o.value ? '#156b43' : '#e5e7eb'}`,
              }}>
              {o.label}
            </div>
          ))}
        </div>

        <Card style={{ padding: loading ? 16 : 0 }}>
          {loading ? <TableSkeleton rows={8} /> : <Table columns={cols} data={schedules} />}
        </Card>

        <div style={{ marginTop: 14, padding: '10px 14px', background: '#f9fafb', borderRadius: 8, fontSize: 11.5, color: '#6b7280' }}>
          💡 账期引擎每天凌晨 01:00 自动扫描 · T-3天和T-1天自动推送提醒 · 开启自动付款后到期自动转账
        </div>
      </div>
    </AppLayout>
  )
}
