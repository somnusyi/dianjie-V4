'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import AppLayout from '@/components/AppLayout'
import { fmt, fmtDate, useToast, Btn, Modal, Field, Input } from '@/components/ui'
import api from '@/lib/api'

const HEALTH_CONFIG = {
  good:    { icon: '✅', label: '运营正常', color: '#156b43', bg: '#edfaf3', border: '#a7f3d0' },
  warning: { icon: '⚠️', label: '需要关注', color: '#92400e', bg: '#fffbeb', border: '#fde68a' },
  danger:  { icon: '🚨', label: '需要处理', color: '#dc2626', bg: '#fef2f2', border: '#fecaca' },
}

const ROLE_LABEL: Record<string, string> = {
  MANAGER: '店长', ADMIN: '管理员', FINANCE: '财务', PURCHASER: '采购'
}

export default function StoresPage() {
  const router = useRouter()
  const [stores, setStores] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [user, setUser] = useState<any>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [form, setForm] = useState({ no: '', name: '', address: '', phone: '', managerName: '' })
  const { show, ToastEl } = useToast()

  useEffect(() => {
    const u = localStorage.getItem('dj_user')
    if (u) setUser(JSON.parse(u))
    load()
  }, [])

  const load = async () => {
    setLoading(true)
    try {
      const r = await api.get('/api/stores')
      setStores(Array.isArray(r.data) ? r.data : [])
    } catch {}
    setLoading(false)
  }

  const createStore = async () => {
    if (!form.no || !form.name) return show('请填写门店编号和名称', 'error')
    try {
      await api.post('/api/stores', form)
      show('门店创建成功')
      setCreateOpen(false)
      setForm({ no: '', name: '', address: '', phone: '', managerName: '' })
      load()
    } catch (e: any) { show(e.response?.data?.error || '创建失败', 'error') }
  }

  const isHQ = user?.role !== 'MANAGER'
  const dangerStores = stores.filter(s => s.stats?.health === 'danger').length
  const warningStores = stores.filter(s => s.stats?.health === 'warning').length
  const totalPurchase = stores.reduce((sum, s) => sum + (s.stats?.monthPurchase || 0), 0)

  return (
    <AppLayout>
      {ToastEl}
      <div style={{ padding: 28 }}>

        {/* 页头 */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 700, color: '#111827', margin: 0 }}>
              {isHQ ? '门店管理' : '我的门店'}
            </h1>
            <p style={{ fontSize: 12.5, color: '#9ca3af', marginTop: 4 }}>
              {isHQ ? `共 ${stores.length} 家门店 · 点击门店卡片查看详情` : '门店运营概览'}
            </p>
          </div>
          {isHQ && (
            <Btn variant="primary" onClick={() => setCreateOpen(true)}>＋ 新建门店</Btn>
          )}
        </div>

        {/* 总部汇总栏 */}
        {isHQ && stores.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 24 }}>
            {[
              { label: '门店总数',     value: `${stores.length} 家`,      icon: '🏪', color: '#111827' },
              { label: '本月总采购',   value: fmt(totalPurchase),          icon: '💰', color: '#d97706' },
              { label: '需要处理',     value: `${dangerStores} 家`,        icon: '🚨', color: dangerStores > 0 ? '#dc2626' : '#156b43' },
              { label: '需要关注',     value: `${warningStores} 家`,       icon: '⚠️', color: warningStores > 0 ? '#92400e' : '#156b43' },
            ].map(c => (
              <div key={c.label} style={{ background: '#fff', borderRadius: 12, padding: '14px 18px', border: '1px solid #e5e7eb' }}>
                <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 6, display: 'flex', justifyContent: 'space-between' }}>
                  {c.label} <span>{c.icon}</span>
                </div>
                <div style={{ fontSize: 22, fontWeight: 800, color: c.color }}>{c.value}</div>
              </div>
            ))}
          </div>
        )}

        {/* 门店卡片列表 */}
        {loading ? (
          <div style={{ textAlign: 'center', padding: 60, color: '#9ca3af' }}>加载中...</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 16 }}>
            {stores.map(store => {
              const h = HEALTH_CONFIG[store.stats?.health as 'good' | 'warning' | 'danger'] || HEALTH_CONFIG.good
              const manager = store.users?.find((u: any) => u.role === 'MANAGER')

              return (
                <div key={store.id}
                  onClick={() => router.push(`/stores/${store.id}`)}
                  style={{
                    background: '#fff', borderRadius: 16, padding: '20px 22px',
                    border: `1.5px solid ${store.stats?.health !== 'good' ? h.border : '#e5e7eb'}`,
                    cursor: 'pointer', transition: 'all .2s',
                    boxShadow: '0 1px 4px rgba(0,0,0,.05)',
                  }}
                  onMouseOver={e => {
                    const el = e.currentTarget as HTMLElement
                    el.style.transform = 'translateY(-2px)'
                    el.style.boxShadow = '0 8px 24px rgba(0,0,0,.1)'
                  }}
                  onMouseOut={e => {
                    const el = e.currentTarget as HTMLElement
                    el.style.transform = 'translateY(0)'
                    el.style.boxShadow = '0 1px 4px rgba(0,0,0,.05)'
                  }}
                >
                  {/* 门店头部 */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
                    <div>
                      <div style={{ fontSize: 15, fontWeight: 700, color: '#111827', marginBottom: 3 }}>
                        {store.name.replace('滇界·', '')}
                      </div>
                      <div style={{ fontSize: 11, color: '#9ca3af' }}>
                        {store.no} · {manager?.name || store.managerName || '暂无店长'}
                      </div>
                    </div>
                    <span style={{
                      fontSize: 11, fontWeight: 600, padding: '4px 10px', borderRadius: 20,
                      background: h.bg, color: h.color, border: `1px solid ${h.border}`,
                      whiteSpace: 'nowrap',
                    }}>
                      {h.icon} {h.label}
                    </span>
                  </div>

                  {/* 核心指标 2x2 */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 16 }}>
                    {[
                      { label: '本月采购', value: fmt(store.stats?.monthPurchase || 0), highlight: false },
                      { label: '待收货',   value: `${store.stats?.pendingReceiptCount || 0} 笔`, highlight: store.stats?.pendingReceiptCount > 0 },
                      { label: '逾期账期', value: `${store.stats?.overdueCount || 0} 笔`, highlight: store.stats?.overdueCount > 0, danger: true },
                      { label: '本月报损', value: fmt(store.stats?.lossAmount || 0), sub: `${store.stats?.lossRate || 0}%`, highlight: Number(store.stats?.lossRate) > 10 },
                    ].map(metric => (
                      <div key={metric.label} style={{
                        background: metric.danger && metric.highlight ? '#fef2f2' : metric.highlight ? '#fffbeb' : '#f9fafb',
                        borderRadius: 10, padding: '10px 12px',
                      }}>
                        <div style={{ fontSize: 10, color: '#9ca3af', marginBottom: 4 }}>{metric.label}</div>
                        <div style={{ fontSize: 15, fontWeight: 700, color: metric.danger && metric.highlight ? '#dc2626' : metric.highlight ? '#d97706' : '#374151' }}>
                          {metric.value}
                          {metric.sub && <span style={{ fontSize: 10, color: '#9ca3af', marginLeft: 4 }}>报损率 {metric.sub}</span>}
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* 告警提示 */}
                  {store.stats?.health !== 'good' && (
                    <div style={{ background: h.bg, borderRadius: 8, padding: '8px 12px', fontSize: 11.5, color: h.color, marginBottom: 14 }}>
                      {store.stats?.overdueCount > 0 && `🚨 有 ${store.stats.overdueCount} 笔账期逾期未付`}
                      {store.stats?.overdueCount === 0 && store.stats?.pendingReceiptCount > 2 && `⚠️ 有 ${store.stats.pendingReceiptCount} 笔待收货超时未处理`}
                      {store.stats?.overdueCount === 0 && store.stats?.pendingReceiptCount <= 2 && Number(store.stats?.lossRate) > 10 && `⚠️ 本月报损率 ${store.stats.lossRate}%，高于警戒线`}
                    </div>
                  )}

                  {/* 底部 */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 12, borderTop: '1px solid #f3f4f6' }}>
                    <div style={{ display: 'flex', gap: 6 }}>
                      {store.users?.slice(0, 3).map((u: any) => (
                        <div key={u.id} style={{
                          width: 26, height: 26, borderRadius: '50%',
                          background: u.role === 'MANAGER' ? '#156b43' : '#e5e7eb',
                          color: u.role === 'MANAGER' ? '#fff' : '#6b7280',
                          fontSize: 11, fontWeight: 600,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }} title={`${u.name}（${ROLE_LABEL[u.role] || u.role}）`}>
                          {u.name[0]}
                        </div>
                      ))}
                      {store.users?.length > 3 && (
                        <div style={{ width: 26, height: 26, borderRadius: '50%', background: '#f3f4f6', color: '#9ca3af', fontSize: 10, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          +{store.users.length - 3}
                        </div>
                      )}
                    </div>
                    <span style={{ fontSize: 12, color: '#156b43', fontWeight: 600 }}>查看详情 →</span>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* 新建门店 */}
      <Modal open={createOpen} title="新建门店" onClose={() => setCreateOpen(false)}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="门店编号" required><Input value={form.no} onChange={v => setForm({ ...form, no: v })} placeholder="如 DJ004" /></Field>
          <Field label="门店名称" required><Input value={form.name} onChange={v => setForm({ ...form, name: v })} placeholder="如 滇界·西双版纳店" /></Field>
          <Field label="店长姓名"><Input value={form.managerName} onChange={v => setForm({ ...form, managerName: v })} /></Field>
          <Field label="联系电话"><Input value={form.phone} onChange={v => setForm({ ...form, phone: v })} /></Field>
        </div>
        <Field label="地址">
          <Input value={form.address} onChange={v => setForm({ ...form, address: v })} placeholder="详细地址" />
        </Field>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20, paddingTop: 14, borderTop: '1px solid #e5e7eb' }}>
          <Btn onClick={() => setCreateOpen(false)}>取消</Btn>
          <Btn variant="primary" onClick={createStore}>创建门店</Btn>
        </div>
      </Modal>
    </AppLayout>
  )
}
