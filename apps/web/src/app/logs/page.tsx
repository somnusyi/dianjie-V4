'use client'
import { useEffect, useState } from 'react'
import AppLayout from '@/components/AppLayout'
import { PageHeader, Card, Table, fmtDatetime } from '@/components/ui'
import api from '@/lib/api'

export default function LogsPage() {
  const [logs, setLogs] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [total, setTotal] = useState(0)

  const load = async () => {
    setLoading(true)
    try { const r = await api.get('/api/logs?pageSize=100'); setLogs(r.data.items); setTotal(r.data.total) }
    catch {}
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  const cols = [
    { key: 'createdAt', title: '时间', render: (v: string) => <span style={{ fontSize: 11, color: '#9ca3af' }}>{fmtDatetime(v)}</span>, width: 160 },
    { key: 'user', title: '操作人', render: (_: any, row: any) => (
      <span style={{ fontSize: 12 }}>
        {row.isAi ? <span style={{ background: '#eff6ff', color: '#2563eb', padding: '1px 6px', borderRadius: 3, fontSize: 10, fontWeight: 700, marginRight: 5 }}>AI</span> : null}
        {row.user?.name || '系统'}
      </span>
    ), width: 100 },
    { key: 'role', title: '角色', render: (v: string) => <span style={{ fontSize: 11, color: '#6b7280' }}>{{ ADMIN:'管理员', FINANCE:'财务', MANAGER:'店长', PURCHASER:'采购' }[v] || v || '-'}</span>, width: 80 },
    { key: 'action', title: '操作', render: (v: string) => <span style={{ fontWeight: 500 }}>{v}</span> },
    { key: 'target', title: '关联单号', render: (v: string) => v ? <span style={{ color: '#156b43', fontSize: 11 }}>{v}</span> : '-', width: 130 },
  ]

  return (
    <AppLayout>
      <div style={{ padding: 28 }}>
        <PageHeader title="操作日志" sub={`共 ${total} 条记录，含 AI 自动操作`} />
        <Card style={{ padding: 0 }}><Table columns={cols} data={logs} loading={loading} /></Card>
      </div>
    </AppLayout>
  )
}
