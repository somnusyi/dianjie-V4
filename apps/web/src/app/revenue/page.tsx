'use client'
import { useEffect, useState } from 'react'
import AppLayout from '@/components/AppLayout'
import { fmt, useToast } from '@/components/ui'
import api from '@/lib/api'
import dayjs from 'dayjs'

const MONTHS = Array.from({ length: 12 }, (_, i) => {
  const d = dayjs().subtract(i, 'month')
  return { value: d.format('YYYY-MM'), label: d.format('YYYY年M月') }
})

// 收入渠道配置
const CHANNELS = [
  { key: 'meituan',  label: '美团团购', color: '#f59e0b' },
  { key: 'douyin',   label: '抖音团购', color: '#111827' },
  { key: 'maidan',   label: '买单',     color: '#2563eb' },
  { key: 'wechat',   label: '微信/支付宝/银联', color: '#10b981' },
  { key: 'cash',     label: '现金',     color: '#6b7280' },
]

const emptyChannels = () => Object.fromEntries(CHANNELS.map(c => [c.key, '']))

export default function RevenuePage() {
  const [records, setRecords] = useState<any[]>([])
  const [stores, setStores] = useState<any[]>([])
  const [user, setUser] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [month, setMonth] = useState(dayjs().format('YYYY-MM'))
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ storeId: '', date: dayjs().format('YYYY-MM-DD'), channels: emptyChannels() })
  const [allMonthData, setAllMonthData] = useState<any[]>([])
  const { show, ToastEl } = useToast()

  useEffect(() => {
    const u = localStorage.getItem('dj_user')
    if (u) {
      const parsed = JSON.parse(u)
      setUser(parsed)
      if (parsed.role === 'MANAGER' && parsed.store?.id) {
        setForm(f => ({ ...f, storeId: parsed.store?.id || '' }))
      }
    }
    loadAll()
  }, [])

  useEffect(() => { load() }, [month])

  const loadAll = async () => {
    try {
      const results = await Promise.all(MONTHS.slice(0, 6).map(m => api.get(`/api/revenue?month=${m.value}`)))
      const data = MONTHS.slice(0, 6).map((m, i) => {
        const recs = Array.isArray(results[i].data) ? results[i].data : []
        const total = recs.reduce((s: number, r: any) => s + Number(r.amount), 0)
        return { month: m.value, label: m.label, total, count: recs.length }
      }).reverse()
      setAllMonthData(data)
    } catch {}
  }

  const load = async () => {
    setLoading(true)
    try {
      const [rv, st] = await Promise.all([api.get(`/api/revenue?month=${month}`), api.get('/api/stores')])
      setRecords(Array.isArray(rv.data) ? rv.data : [])
      setStores(st.data || [])
    } catch { setRecords([]) }
    setLoading(false)
  }

  const channelTotal = Object.values(form.channels).reduce((s, v) => s + (Number(v) || 0), 0)

  const submit = async () => {
    if (!form.storeId) return show('请选择门店', 'error')
    if (channelTotal <= 0) return show('请至少填写一个渠道金额', 'error')
    try {
      await api.post('/api/revenue', { storeId: form.storeId, date: form.date, channels: form.channels })
      show('营业额已录入')
      setShowForm(false)
      setForm(f => ({ ...f, channels: emptyChannels(), date: dayjs().format('YYYY-MM-DD') }))
      load(); loadAll()
    } catch (e: any) { show(e.response?.data?.error || '录入失败', 'error') }
  }

  const isManager = user?.role === 'MANAGER'
  const totalRevenue = records.reduce((s, r) => s + Number(r.amount), 0)
  const prevMonthData = allMonthData.find(d => d.month === dayjs(month).subtract(1, 'month').format('YYYY-MM'))
  const growth = prevMonthData && prevMonthData.total > 0
    ? ((totalRevenue - prevMonthData.total) / prevMonthData.total * 100).toFixed(1) : null
  const maxTrend = Math.max(...allMonthData.map(d => d.total), 1)

  // 当月各渠道汇总
  const channelSummary: Record<string, number> = {}
  records.forEach(r => {
    const ch = (r.rawData as any)?.channels
    if (ch) {
      CHANNELS.forEach(c => { channelSummary[c.key] = (channelSummary[c.key] || 0) + (Number(ch[c.key]) || 0) })
    }
  })
  const hasChannelData = Object.values(channelSummary).some(v => v > 0)

  // 按门店分组
  const byStore: Record<string, { name: string; total: number }> = {}
  records.forEach(r => {
    if (!byStore[r.storeId]) byStore[r.storeId] = { name: r.store?.name || r.storeId, total: 0 }
    byStore[r.storeId].total += Number(r.amount)
  })

  return (
    <AppLayout>
      {ToastEl}
      <div style={{ padding: 20, maxWidth: 800, margin: '0 auto' }}>

        <div style={{ marginBottom: 16 }}>
          <h1 style={{ fontSize: 18, fontWeight: 700, color: '#111827', margin: 0 }}>💹 营业额</h1>
          <p style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>
            {isManager ? '门店营业额记录' : '各门店营业额汇总'}
          </p>
        </div>

        {/* 月份选择 */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 16, overflowX: 'auto', paddingBottom: 4 }}>
          {MONTHS.slice(0, 6).map(m => (
            <button key={m.value} onClick={() => setMonth(m.value)} style={{
              padding: '6px 14px', borderRadius: 20, fontSize: 12, cursor: 'pointer',
              fontWeight: month === m.value ? 700 : 400,
              background: month === m.value ? '#156b43' : '#fff',
              color: month === m.value ? '#fff' : '#6b7280',
              border: `1px solid ${month === m.value ? '#156b43' : '#e5e7eb'}`,
              whiteSpace: 'nowrap', flexShrink: 0,
            }}>{m.label.replace('年', '.').replace('月', '')}</button>
          ))}
        </div>

        {/* 当月汇总卡片 */}
        <div style={{
          background: 'linear-gradient(135deg, #0c1a12 0%, #1a3a24 100%)',
          borderRadius: 16, padding: 20, marginBottom: 16, color: '#fff',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 4 }}>
                {MONTHS.find(m2 => m2.value === month)?.label} 营业额
              </div>
              <div style={{ fontSize: 32, fontWeight: 800, letterSpacing: -1 }}>{fmt(totalRevenue)}</div>
            </div>
            {growth !== null && (
              <div style={{
                background: Number(growth) >= 0 ? 'rgba(220,38,38,.2)' : 'rgba(21,107,67,.3)',
                padding: '6px 12px', borderRadius: 20, fontSize: 13, fontWeight: 600,
                color: Number(growth) >= 0 ? '#fca5a5' : '#6ee7b7',
              }}>
                {Number(growth) >= 0 ? '↑' : '↓'} {Math.abs(Number(growth))}%
              </div>
            )}
          </div>

          {/* 渠道占比条 */}
          {hasChannelData && totalRevenue > 0 && (
            <div>
              <div style={{ display: 'flex', height: 6, borderRadius: 3, overflow: 'hidden', marginBottom: 8, gap: 1 }}>
                {CHANNELS.map(c => {
                  const pct = channelSummary[c.key] / totalRevenue * 100
                  return pct > 0 ? (
                    <div key={c.key} style={{ width: `${pct}%`, background: c.color, minWidth: 2 }} />
                  ) : null
                })}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px' }}>
                {CHANNELS.filter(c => channelSummary[c.key] > 0).map(c => (
                  <div key={c.key} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, opacity: 0.8 }}>
                    <div style={{ width: 6, height: 6, borderRadius: '50%', background: c.color }} />
                    <span>{c.label} {fmt(channelSummary[c.key])}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* 近6月趋势 */}
        {allMonthData.some(d => d.total > 0) && (
          <div style={{ background: '#fff', borderRadius: 12, padding: 16, marginBottom: 16, border: '1px solid #e5e7eb' }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 14 }}>近6个月趋势</div>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 80 }}>
              {allMonthData.map(d => {
                const pct = d.total / maxTrend
                const isSelected = d.month === month
                return (
                  <div key={d.month} onClick={() => setMonth(d.month)}
                    style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', cursor: 'pointer', gap: 4 }}>
                    <div style={{ fontSize: 10, color: '#9ca3af', fontWeight: 500 }}>
                      {d.total > 0 ? `${(d.total / 10000).toFixed(0)}万` : '-'}
                    </div>
                    <div style={{
                      width: '100%', borderRadius: '4px 4px 0 0',
                      height: `${Math.max(pct * 56, d.total > 0 ? 4 : 0)}px`,
                      background: isSelected ? '#156b43' : d.total > 0 ? '#a7f3d0' : '#f3f4f6',
                    }} />
                    <div style={{ fontSize: 10, color: isSelected ? '#156b43' : '#9ca3af', fontWeight: isSelected ? 700 : 400 }}>
                      {d.month.slice(5)}月
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* 各门店汇总（总部） */}
        {!isManager && stores.length > 0 && (
          <div style={{ background: '#fff', borderRadius: 12, padding: 16, marginBottom: 16, border: '1px solid #e5e7eb' }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 12 }}>各门店录入情况</div>
            {stores.map(store => {
              const sd = byStore[store.id]
              return (
                <div key={store.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid #f9fafb' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: sd ? '#156b43' : '#e5e7eb' }} />
                    <span style={{ fontSize: 13, color: '#374151' }}>{store.name.replace('滇界·', '')}</span>
                  </div>
                  {sd ? <span style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>{fmt(sd.total)}</span>
                      : <span style={{ fontSize: 12, color: '#9ca3af' }}>未录入</span>}
                </div>
              )
            })}
          </div>
        )}

        {/* 录入按钮 */}
        <button onClick={() => setShowForm(!showForm)} style={{
          width: '100%', padding: 14, background: showForm ? '#f3f4f6' : '#156b43',
          color: showForm ? '#374151' : '#fff', border: 'none', borderRadius: 12,
          fontSize: 15, fontWeight: 600, cursor: 'pointer', marginBottom: 16,
        }}>
          {showForm ? '取消' : '＋ 录入营业额'}
        </button>

        {/* 录入表单 */}
        {showForm && (
          <div style={{ background: '#fff', borderRadius: 12, padding: 16, marginBottom: 16, border: '1px solid #e5e7eb' }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 16 }}>录入营业额</div>

            {/* 门店选择（总部） */}
            {!isManager && (
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 5, fontWeight: 500 }}>门店 *</div>
                <select value={form.storeId} onChange={e => setForm({ ...form, storeId: e.target.value })}
                  style={{ width: '100%', padding: '10px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 14, background: '#fff' }}>
                  <option value="">请选择门店</option>
                  {stores.map(s => <option key={s.id} value={s.id}>{s.name.replace('滇界·', '')}</option>)}
                </select>
              </div>
            )}

            {/* 日期 */}
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 5, fontWeight: 500 }}>日期 *</div>
              <input type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })}
                style={{ width: '100%', padding: '10px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 14, boxSizing: 'border-box' as any }} />
            </div>

            {/* 渠道明细 */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 10, fontWeight: 500 }}>各渠道收入（元）</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                {CHANNELS.map(c => (
                  <div key={c.key}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 4 }}>
                      <div style={{ width: 6, height: 6, borderRadius: '50%', background: c.color }} />
                      <span style={{ fontSize: 11, color: '#6b7280' }}>{c.label}</span>
                    </div>
                    <input type="number" min="0" placeholder="0"
                      value={form.channels[c.key]}
                      onChange={e => setForm({ ...form, channels: { ...form.channels, [c.key]: e.target.value } })}
                      style={{ width: '100%', padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 14, boxSizing: 'border-box' as any }} />
                  </div>
                ))}
              </div>
            </div>

            {/* 合计展示 */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 14px', background: channelTotal > 0 ? '#edfaf3' : '#f9fafb', borderRadius: 10, marginBottom: 14 }}>
              <span style={{ fontSize: 13, color: '#6b7280' }}>合计营业额</span>
              <span style={{ fontSize: 20, fontWeight: 800, color: channelTotal > 0 ? '#156b43' : '#9ca3af' }}>{fmt(channelTotal)}</span>
            </div>

            <button onClick={submit} disabled={channelTotal <= 0} style={{
              width: '100%', padding: 13, background: channelTotal > 0 ? '#156b43' : '#d1d5db',
              color: '#fff', border: 'none', borderRadius: 10, fontSize: 15, fontWeight: 600,
              cursor: channelTotal > 0 ? 'pointer' : 'not-allowed',
            }}>确认录入</button>
          </div>
        )}

        {/* 近期记录 */}
        <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb', overflow: 'hidden' }}>
          <div style={{ padding: '14px 16px', borderBottom: '1px solid #f3f4f6', fontSize: 13, fontWeight: 600, color: '#374151' }}>
            {MONTHS.find(m2 => m2.value === month)?.label} 记录
          </div>
          {loading ? (
            <div style={{ padding: 20, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>加载中...</div>
          ) : records.length === 0 ? (
            <div style={{ padding: 32, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
              <div style={{ fontSize: 32, marginBottom: 8 }}>📊</div>本月暂无记录
            </div>
          ) : records.map((r, i) => {
            const channels = (r.rawData as any)?.channels
            return (
              <div key={r.id || i} style={{ padding: '12px 16px', borderBottom: i < records.length - 1 ? '1px solid #f9fafb' : 'none' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: channels ? 8 : 0 }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 500, color: '#374151' }}>
                      {r.store?.name?.replace('滇界·', '') || '本店'} · {dayjs(r.date).format('MM月DD日')}
                    </div>
                  </div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: '#156b43' }}>{fmt(r.amount)}</div>
                </div>
                {channels && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 10px' }}>
                    {CHANNELS.filter(c => Number(channels[c.key]) > 0).map(c => (
                      <span key={c.key} style={{ fontSize: 11, color: '#6b7280' }}>
                        <span style={{ display: 'inline-block', width: 5, height: 5, borderRadius: '50%', background: c.color, marginRight: 3, verticalAlign: 'middle' }} />
                        {c.label} {fmt(channels[c.key])}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </AppLayout>
  )
}
