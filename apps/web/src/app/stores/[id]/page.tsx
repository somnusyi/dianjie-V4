'use client'
import { useEffect, useState } from 'react'
import { useRouter, useParams } from 'next/navigation'
import AppLayout from '@/components/AppLayout'
import { fmt, fmtDate, useToast, Btn } from '@/components/ui'
import api from '@/lib/api'
import dayjs from 'dayjs'

const STATUS_COLOR: Record<string, { label: string; color: string }> = {
  CONFIRMED:       { label: '已确认',   color: '#156b43' },
  PENDING_CONFIRM: { label: '待收货',   color: '#d97706' },
  DRAFT:           { label: '草稿',     color: '#6b7280' },
  REJECTED:        { label: '已拒收',   color: '#dc2626' },
  VOID:            { label: '已作废',   color: '#9ca3af' },
  ACCOUNTED:       { label: '已对账',   color: '#2563eb' },
}

const ROLE_LABEL: Record<string, string> = {
  MANAGER: '店长', ADMIN: '管理员', FINANCE: '财务', PURCHASER: '采购', SUPPLIER_STAFF: '供应商'
}

type SectionTab = 'receipts' | 'schedules' | 'loss'

export default function StoreDetailPage() {
  const router = useRouter()
  const params = useParams()
  const storeId = params.id as string

  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<SectionTab>('receipts')
  const { ToastEl } = useToast()

  useEffect(() => { load() }, [storeId])

  const load = async () => {
    setLoading(true)
    try {
      const r = await api.get(`/api/stores/${storeId}`)
      setData(r.data)
    } catch {}
    setLoading(false)
  }

  if (loading) return (
    <AppLayout><div style={{ padding: 28, color: '#9ca3af' }}>加载中...</div></AppLayout>
  )
  if (!data) return (
    <AppLayout><div style={{ padding: 28, color: '#dc2626' }}>门店不存在</div></AppLayout>
  )

  const { store, stats, receipts, schedules, lossClaims, purchaseTrend } = data
  const manager = store.users?.find((u: any) => u.role === 'MANAGER')

  const tabs: { key: SectionTab; label: string; icon: string; count?: number }[] = [
    { key: 'receipts',  label: '入库记录', icon: '📦', count: receipts?.length },
    { key: 'schedules', label: '账期状态', icon: '⏰', count: schedules?.filter((s: any) => s.status !== 'PAID').length },
    { key: 'loss',      label: '报损记录', icon: '⚠️', count: lossClaims?.length },
  ]

  // 采购趋势最大值（用于柱状图）
  const maxTrend = Math.max(...(purchaseTrend?.map((t: any) => t.amount) || [1]))

  return (
    <AppLayout>
      {ToastEl}
      <div style={{ padding: 28, maxWidth: 1100 }}>

        {/* 面包屑 */}
        <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 6 }}>
          <span onClick={() => router.push('/stores')} style={{ cursor: 'pointer', color: '#156b43' }}>门店管理</span>
          <span>›</span>
          <span style={{ color: '#374151' }}>{store.name.replace('滇界·', '')}</span>
        </div>

        {/* 门店头部信息 */}
        <div style={{ background: '#fff', borderRadius: 16, padding: '22px 24px', border: '1px solid #e5e7eb', marginBottom: 20, display: 'flex', gap: 24, alignItems: 'flex-start' }}>
          <div style={{ width: 56, height: 56, borderRadius: 14, background: '#0c1a12', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 26, flexShrink: 0 }}>
            🏪
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
              <h1 style={{ fontSize: 20, fontWeight: 700, color: '#111827', margin: 0 }}>{store.name.replace('滇界·', '')}</h1>
              <span style={{ fontSize: 11, color: '#9ca3af', background: '#f3f4f6', padding: '2px 8px', borderRadius: 4 }}>{store.no}</span>
              <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, background: store.status === 'ENABLED' ? '#edfaf3' : '#fef2f2', color: store.status === 'ENABLED' ? '#156b43' : '#dc2626', fontWeight: 600 }}>
                {store.status === 'ENABLED' ? '营业中' : '已停用'}
              </span>
            </div>
            <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 10 }}>
              {store.address && <span style={{ marginRight: 16 }}>📍 {store.address}</span>}
              {store.phone && <span>📞 {store.phone}</span>}
            </div>
            {/* 人员头像列表 */}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {store.users?.map((u: any) => (
                <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#f9fafb', borderRadius: 20, padding: '4px 10px' }}>
                  <div style={{ width: 22, height: 22, borderRadius: '50%', background: u.role === 'MANAGER' ? '#156b43' : '#e5e7eb', color: u.role === 'MANAGER' ? '#fff' : '#6b7280', fontSize: 10, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {u.name[0]}
                  </div>
                  <span style={{ fontSize: 11, color: '#374151' }}>{u.name}</span>
                  <span style={{ fontSize: 10, color: '#9ca3af' }}>{ROLE_LABEL[u.role] || u.role}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* 本月核心指标 */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
          {[
            { label: '本月采购',   value: fmt(stats?.monthPurchase || 0), icon: '💰', color: '#d97706' },
            { label: '待收货',     value: `${stats?.pendingCount || 0} 笔`, icon: '📦', color: stats?.pendingCount > 0 ? '#d97706' : '#156b43' },
            { label: '逾期账期',   value: `${stats?.overdueCount || 0} 笔`, icon: '🚨', color: stats?.overdueCount > 0 ? '#dc2626' : '#156b43' },
            { label: '本月报损',   value: fmt(stats?.monthLoss || 0), icon: '⚠️', color: stats?.monthLoss > 0 ? '#d97706' : '#156b43' },
          ].map(c => (
            <div key={c.label} style={{ background: '#fff', borderRadius: 12, padding: '14px 18px', border: '1px solid #e5e7eb' }}>
              <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 6, display: 'flex', justifyContent: 'space-between' }}>
                {c.label} <span>{c.icon}</span>
              </div>
              <div style={{ fontSize: 22, fontWeight: 800, color: c.color }}>{c.value}</div>
            </div>
          ))}
        </div>

        {/* 采购趋势 */}
        {purchaseTrend?.length > 0 && (
          <div style={{ background: '#fff', borderRadius: 14, padding: '18px 22px', border: '1px solid #e5e7eb', marginBottom: 20 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 16 }}>📈 近3个月采购趋势</div>
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', height: 80 }}>
              {purchaseTrend.map((t: any) => (
                <div key={t.month} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                  <div style={{ fontSize: 11, color: '#374151', fontWeight: 600 }}>{fmt(t.amount)}</div>
                  <div style={{ width: '100%', background: '#156b43', borderRadius: '4px 4px 0 0', height: Math.max(8, (t.amount / maxTrend) * 60), transition: 'height .4s ease' }} />
                  <div style={{ fontSize: 11, color: '#9ca3af' }}>{t.month}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Tab 区域 */}
        <div style={{ display: 'flex', gap: 4, marginBottom: 14, background: '#f3f4f6', borderRadius: 10, padding: 4, width: 'fit-content' }}>
          {tabs.map(t => (
            <div key={t.key} onClick={() => setTab(t.key)}
              style={{
                padding: '8px 18px', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 500,
                background: tab === t.key ? '#fff' : 'transparent',
                color: tab === t.key ? '#111827' : '#6b7280',
                boxShadow: tab === t.key ? '0 1px 4px rgba(0,0,0,.1)' : 'none',
                display: 'flex', alignItems: 'center', gap: 6,
              }}>
              {t.icon} {t.label}
              {t.count! > 0 && (
                <span style={{ background: '#dc2626', color: '#fff', fontSize: 10, borderRadius: 10, padding: '1px 6px' }}>{t.count}</span>
              )}
            </div>
          ))}
        </div>

        <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #e5e7eb', overflow: 'hidden' }}>

          {/* 入库记录 */}
          {tab === 'receipts' && (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f9fafb' }}>
                  {['入库单号', '供应商', '金额', '状态', '到货日期'].map(h => (
                    <th key={h} style={{ padding: '12px 16px', textAlign: 'left', fontSize: 11, color: '#6b7280', fontWeight: 600 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {receipts?.map((r: any) => {
                  const s = STATUS_COLOR[r.status] || { label: r.status, color: '#6b7280' }
                  return (
                    <tr key={r.id} style={{ borderTop: '1px solid #f3f4f6' }}>
                      <td style={{ padding: '12px 16px', color: '#156b43', fontWeight: 600 }}>{r.no}</td>
                      <td style={{ padding: '12px 16px', color: '#374151' }}>{r.supplier?.name}</td>
                      <td style={{ padding: '12px 16px', fontWeight: 700 }}>{fmt(r.totalAmount)}</td>
                      <td style={{ padding: '12px 16px' }}><span style={{ fontSize: 11, fontWeight: 600, color: s.color }}>{s.label}</span></td>
                      <td style={{ padding: '12px 16px', color: '#9ca3af', fontSize: 11 }}>{fmtDate(r.deliveryDate)}</td>
                    </tr>
                  )
                })}
                {!receipts?.length && <tr><td colSpan={5} style={{ padding: 32, textAlign: 'center', color: '#9ca3af' }}>暂无入库记录</td></tr>}
              </tbody>
            </table>
          )}

          {/* 账期状态 */}
          {tab === 'schedules' && (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f9fafb' }}>
                  {['入库单', '供应商', '金额', '到期日', '状态'].map(h => (
                    <th key={h} style={{ padding: '12px 16px', textAlign: 'left', fontSize: 11, color: '#6b7280', fontWeight: 600 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {schedules?.map((s: any) => {
                  const days = dayjs(s.dueAt).diff(dayjs(), 'day')
                  const isOver = s.status === 'OVERDUE' || days < 0
                  const SMAP: any = {
                    PENDING: ['待付款','#d97706'], OVERDUE: ['已逾期','#dc2626'],
                    PAID: ['已付款','#6b7280'], APPROVED: ['已审批','#156b43'],
                  }
                  const [slabel, scolor] = SMAP[s.status] || [s.status, '#6b7280']
                  return (
                    <tr key={s.id} style={{ borderTop: '1px solid #f3f4f6', background: isOver ? '#fef9f9' : undefined }}>
                      <td style={{ padding: '12px 16px', color: '#156b43', fontWeight: 600 }}>{s.receipt?.no}</td>
                      <td style={{ padding: '12px 16px', color: '#374151' }}>{s.supplier?.name}</td>
                      <td style={{ padding: '12px 16px', fontWeight: 700 }}>{fmt(s.amount)}</td>
                      <td style={{ padding: '12px 16px' }}>
                        <div style={{ fontSize: 12 }}>{fmtDate(s.dueAt)}</div>
                        <div style={{ fontSize: 10, color: isOver ? '#dc2626' : days <= 3 ? '#d97706' : '#9ca3af', fontWeight: 600 }}>
                          {isOver ? `逾期${Math.abs(days)}天` : days === 0 ? '今天到期' : `${days}天后`}
                        </div>
                      </td>
                      <td style={{ padding: '12px 16px' }}><span style={{ fontSize: 11, fontWeight: 600, color: scolor }}>{slabel}</span></td>
                    </tr>
                  )
                })}
                {!schedules?.length && <tr><td colSpan={5} style={{ padding: 32, textAlign: 'center', color: '#9ca3af' }}>暂无账期记录</td></tr>}
              </tbody>
            </table>
          )}

          {/* 报损记录 */}
          {tab === 'loss' && (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f9fafb' }}>
                  {['报损单号', '供应商', '损失金额', '说明', '状态', '时间'].map(h => (
                    <th key={h} style={{ padding: '12px 16px', textAlign: 'left', fontSize: 11, color: '#6b7280', fontWeight: 600 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {lossClaims?.map((l: any) => {
                  const LMAP: any = { PENDING: ['待处理','#d97706'], APPROVED: ['已同意','#156b43'], REJECTED: ['已拒绝','#dc2626'], RESOLVED: ['已解决','#6b7280'] }
                  const [llabel, lcolor] = LMAP[l.status] || [l.status, '#6b7280']
                  return (
                    <tr key={l.id} style={{ borderTop: '1px solid #f3f4f6' }}>
                      <td style={{ padding: '12px 16px', color: '#dc2626', fontWeight: 600 }}>{l.no}</td>
                      <td style={{ padding: '12px 16px', color: '#374151' }}>{l.supplier?.name}</td>
                      <td style={{ padding: '12px 16px', fontWeight: 700, color: '#dc2626' }}>{fmt(l.totalLossAmount)}</td>
                      <td style={{ padding: '12px 16px', color: '#6b7280', fontSize: 11, maxWidth: 160 }}>{l.description?.slice(0, 40)}{l.description?.length > 40 ? '...' : ''}</td>
                      <td style={{ padding: '12px 16px' }}><span style={{ fontSize: 11, fontWeight: 600, color: lcolor }}>{llabel}</span></td>
                      <td style={{ padding: '12px 16px', color: '#9ca3af', fontSize: 11 }}>{fmtDate(l.createdAt)}</td>
                    </tr>
                  )
                })}
                {!lossClaims?.length && <tr><td colSpan={6} style={{ padding: 32, textAlign: 'center', color: '#9ca3af' }}>暂无报损记录</td></tr>}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </AppLayout>
  )
}
