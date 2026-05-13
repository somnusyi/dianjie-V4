'use client'
import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import AppLayout from '@/components/AppLayout'
import { Table, Btn, Modal, Field, Input, Select, fmt, fmtDate, useToast, Pagination } from '@/components/ui'
import api from '@/lib/api'
import dayjs from 'dayjs'
import { z } from 'zod'

const orderSchema = z.object({
  supplierId: z.string().min(1, '请选择供应商'),
  storeId: z.string().min(1, '请选择门店'),
  expectedDate: z.string().min(1, '请选择期望到货日期').refine(
    v => dayjs(v).isAfter(dayjs().subtract(1, 'day')),
    '期望到货日期不能早于今天'
  ),
})

const itemSchema = z.object({
  productId: z.string().min(1, '请选择商品'),
  quantity: z.string().refine(v => Number(v) > 0, '数量必须大于 0'),
  unitPrice: z.string().refine(v => Number(v) > 0, '单价必须大于 0'),
})

const STATUS_FLOW: Record<string, { label: string; color: string; bg: string }> = {
  DRAFT:           { label: '草稿',       color: '#888780', bg: '#f2f1eb' },
  SUBMITTED:       { label: '待供应商接单', color: '#185fa5', bg: '#e7eef6' },
  CONFIRMED:       { label: '已接单',     color: '#185fa5', bg: '#e7eef6' },
  DELIVERING:      { label: '配送中',     color: '#854f0b', bg: '#faeeda' },
  PENDING_CONFIRM: { label: '已送达',     color: '#854f0b', bg: '#faeeda' },
  RECEIVED:        { label: '已收货',     color: '#854f0b', bg: '#faeeda' },
  COMPLETED:       { label: '已完成',     color: '#1d9e75', bg: '#eaf3de' },
  CANCELLED:       { label: '已取消',     color: '#888780', bg: '#f2f1eb' },
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

export default function OrdersPage() {
  const router = useRouter()
  const [orders, setOrders] = useState<any[]>([])
  const [suppliers, setSuppliers] = useState<any[]>([])
  const [stores, setStores] = useState<any[]>([])
  const [products, setProducts] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [user, setUser] = useState<any>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [filterStatus, setFilterStatus] = useState('')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const PAGE_SIZE = 20
  const { show, ToastEl } = useToast()
  const [form, setForm] = useState({ storeId: '', supplierId: '', expectedDate: '', note: '' })
  const [items, setItems] = useState([{ productId: '', quantity: '', unitPrice: '' }])
  const [errors, setErrors] = useState<Record<string, string>>({})

  useEffect(() => {
    setUser(safeUser())
    load(1)
  }, [filterStatus])

  const load = async (p = page) => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ page: String(p), pageSize: String(PAGE_SIZE) })
      if (filterStatus) params.set('status', filterStatus)
      const [o, s, st, pr] = await Promise.all([
        api.get(`/api/orders?${params}`),
        api.get('/api/suppliers?status=ENABLED'),
        api.get('/api/stores'),
        api.get('/api/products?status=ENABLED'),
      ])
      const data = o.data
      setOrders(Array.isArray(data) ? data : data.items || [])
      setTotal(data.total || 0)
      setPage(p)
      setSuppliers(s.data); setStores(st.data); setProducts(pr.data)
    } catch { show('采购数据读取失败', 'error') }
    setLoading(false)
  }

  const ship = async (id: string, note = '') => {
    try {
      await api.patch(`/api/orders/${id}/ship`, { note })
      show('已标记送达，入库单已自动生成，等待门店确认')
      load()
    } catch (e: any) { show(e.response?.data?.error || '操作失败', 'error') }
  }

  const submit = async () => {
    // 表单整体验证
    const formResult = orderSchema.safeParse(form)
    const newErrors: Record<string, string> = {}
    if (!formResult.success) {
      formResult.error.errors.forEach(e => { newErrors[e.path[0] as string] = e.message })
    }
    // 明细验证
    const itemErrors: string[] = []
    items.forEach((item, i) => {
      const r = itemSchema.safeParse(item)
      if (!r.success) itemErrors.push(`第 ${i + 1} 行：${r.error.errors[0].message}`)
    })
    if (items.length === 0) itemErrors.push('请至少添加一条采购明细')
    if (itemErrors.length) newErrors['items'] = itemErrors[0]
    setErrors(newErrors)
    if (Object.keys(newErrors).length > 0) return

    try {
      await api.post('/api/orders', {
        ...form,
        items: items.map(i => ({ productId: i.productId, quantity: Number(i.quantity), unitPrice: Number(i.unitPrice) }))
      })
      show('采购订单已提交给供应商')
      setCreateOpen(false)
      setErrors({})
      setForm({ storeId: '', supplierId: '', expectedDate: '', note: '' })
      setItems([{ productId: '', quantity: '', unitPrice: '' }])
      load()
    } catch (e: any) { show(e.response?.data?.error || '创建失败', 'error') }
  }

  const totalAmt = items.reduce((s, i) => s + (Number(i.quantity) || 0) * (Number(i.unitPrice) || 0), 0)
  const isOverdue = (order: any) => dayjs().isAfter(dayjs(order.expectedDate).add(1, 'day'))
  const summary = useMemo(() => {
    const active = orders.filter(o => !['COMPLETED', 'CANCELLED'].includes(o.status))
    const overdue = orders.filter(o => isOverdue(o) && !['RECEIVED','COMPLETED','CANCELLED','PENDING_CONFIRM'].includes(o.status))
    const pendingReceive = orders.filter(o => o.status === 'PENDING_CONFIRM')
    const supplierWaiting = orders.filter(o => ['SUBMITTED', 'CONFIRMED', 'DELIVERING'].includes(o.status))
    const activeTotal = active.reduce((sum, o) => sum + Math.max(0, Number(o.totalAmount || 0)), 0)
    return {
      activeTotal,
      activeCount: active.length,
      overdueCount: overdue.length,
      pendingReceiveCount: pendingReceive.length,
      supplierWaitingCount: supplierWaiting.length,
      completedCount: orders.filter(o => o.status === 'COMPLETED').length,
    }
  }, [orders])

  const statusFilters = ['', 'SUBMITTED', 'PENDING_CONFIRM', 'RECEIVED', 'COMPLETED', 'CANCELLED']
  const statusLabels: Record<string, string> = {
    '': '全部', SUBMITTED: '待接单', PENDING_CONFIRM: '已送达', RECEIVED: '已收货', COMPLETED: '已完成', CANCELLED: '已取消'
  }

  const cols = [
    { key: 'no', title: '订单号', render: (v: string) => <span className="dj-table-strong">{v}</span> },
    { key: 'store', title: '门店', render: (_: any, r: any) => r.store?.name?.replace('滇界·', '') },
    { key: 'supplier', title: '供应商', render: (_: any, r: any) => r.supplier?.name },
    { key: 'expectedDate', title: '期望到货', render: (v: string, r: any) => {
      const over = isOverdue(r) && !['RECEIVED','COMPLETED','CANCELLED','PENDING_CONFIRM'].includes(r.status)
      return <span className={over ? 'is-red' : ''}>{fmtDate(v)}{over && ' 超期'}</span>
    }},
    { key: 'totalAmount', title: '金额', render: (v: any) => Number(v) < 0 ? <span className="dj-chip dj-chip-red">金额异常</span> : <b>{fmt(v)}</b> },
    { key: 'status', title: '状态', render: (v: string) => {
      const s = STATUS_FLOW[v] || { label: v, color: '#6b7280', bg: '#f3f4f6' }
      return <span className="dj-chip" style={{ background: s.bg, color: s.color }}>{s.label}</span>
    }},
    { key: 'receiptLink', title: '入库单', render: (_: any, r: any) => {
      if (r.status === 'PENDING_CONFIRM') return (
        <span onClick={() => router.push('/receipts')} style={{ color: '#d97706', fontSize: 12, fontWeight: 600, cursor: 'pointer', textDecoration: 'underline' }}>
          去入库管理
        </span>
      )
      if (r.status === 'RECEIVED') return <span style={{ color: '#d97706', fontSize: 11 }}>报损处理中</span>
      if (r.status === 'COMPLETED') return <span style={{ color: '#156b43', fontSize: 11 }}>已完成</span>
      return <span style={{ color: '#9ca3af', fontSize: 11 }}>-</span>
    }},
    { key: 'actions', title: '操作', render: (_: any, row: any) => (
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {/* 供应商：确认送达 */}
        {['SUBMITTED','CONFIRMED'].includes(row.status) && user?.role === 'SUPPLIER_STAFF' && (
          <Btn size="sm" variant="primary" onClick={() => {
            if (window.confirm('确认货物已送达门店？')) ship(row.id)
          }}>确认送达</Btn>
        )}
        {/* 店长：超期未送达，主动发起 */}
        {row.status === 'SUBMITTED' && ['MANAGER','ADMIN'].includes(user?.role) && isOverdue(row) && (
          <Btn size="sm" style={{ background: '#fef9c3', color: '#92400e', border: '1px solid #fde68a', fontSize: 11 }}
            onClick={() => { if (window.confirm('供应商未标记送达，确认货物已到？')) { ship(row.id, '店长主动发起'); setTimeout(() => router.push('/receipts'), 1000) } }}>
            货已到，发起收货
          </Btn>
        )}
        {/* 取消 */}
        {!['RECEIVED','COMPLETED','CANCELLED','PENDING_CONFIRM'].includes(row.status) && ['MANAGER','ADMIN'].includes(user?.role) && (
          <Btn size="sm" variant="danger" onClick={async () => {
            if (!window.confirm('确认取消？')) return
            try { await api.patch(`/api/orders/${row.id}/cancel`); load() } catch {}
          }}>取消</Btn>
        )}
        {row.lossClaims?.length > 0 && (
          <span onClick={() => router.push('/loss-claims')} style={{ fontSize: 10, color: '#dc2626', fontWeight: 600, cursor: 'pointer' }}>有报损</span>
        )}
      </div>
    )},
  ]

  return (
    <AppLayout>
      {ToastEl}
      <main className="dj-page">
        <div className="dj-topbar">
          <div>
            <span>采购订单 · 供应商履约链路</span>
            <h1>采购作战台</h1>
            <p>从门店发起采购，到供应商送达，再进入入库确认与账期生成</p>
          </div>
          {['MANAGER','ADMIN','PURCHASER'].includes(user?.role) && (
            <Btn variant="primary" onClick={() => setCreateOpen(true)}>新建采购订单</Btn>
          )}
        </div>

        <section className="dj-hero order-hero">
          <div className="dj-hero-meta">
            <span>采购履约 <i /> 实时跟踪</span>
            <span>{dayjs().format('HH:mm')}</span>
          </div>
          <div className="dj-hero-main">
            <strong>{summary.activeCount} 单</strong>
            <em className={summary.overdueCount ? 'is-red' : 'is-green'}>{summary.overdueCount ? `${summary.overdueCount} 单超期` : '履约正常'}</em>
          </div>
          <p>在途采购 {fmt(summary.activeTotal).replace('.00', '')} · 待供应商动作 {summary.supplierWaitingCount} 单 · 待入库 {summary.pendingReceiveCount} 单</p>
          <div className="order-flow">
            <span className="active">发起采购</span>
            <i />
            <span className={summary.supplierWaitingCount ? 'active' : ''}>供应商确认</span>
            <i />
            <span className={summary.pendingReceiveCount ? 'active warn' : ''}>门店入库</span>
            <i />
            <span>生成账期</span>
          </div>
          <div className="dj-hero-stats">
            <div><span>待供应商</span><strong>{summary.supplierWaitingCount} 单</strong></div>
            <div><span>待入库</span><strong className={summary.pendingReceiveCount ? 'is-orange' : ''}>{summary.pendingReceiveCount} 单</strong></div>
            <div><span>已完成</span><strong>{summary.completedCount} 单</strong></div>
          </div>
        </section>

        <section className="dj-metric-grid">
          <article>
            <span>在途采购金额</span>
            <strong>{fmt(summary.activeTotal).replace('.00', '')}</strong>
            <em>未完成订单合计</em>
          </article>
          <article className={summary.supplierWaitingCount > 0 ? 'tone-blue' : 'tone-green'}>
            <span>待供应商动作</span>
            <strong>{summary.supplierWaitingCount} 单</strong>
            <em>接单、配送、送达</em>
          </article>
          <article className={summary.pendingReceiveCount > 0 ? 'tone-orange' : 'tone-green'}>
            <span>待入库确认</span>
            <strong>{summary.pendingReceiveCount} 单</strong>
            <em>店长确认数量与报损</em>
          </article>
          <article className={summary.overdueCount > 0 ? 'tone-red' : 'tone-green'}>
            <span>超期未达</span>
            <strong>{summary.overdueCount} 单</strong>
            <em>影响门店备货安全</em>
          </article>
        </section>

        <section className="dj-dashboard-grid dj-section">
          <div>
            <div className="dj-section-title">
              <h2>订单处理台</h2>
              <span>{loading ? '读取中' : `${total} 条记录`}</span>
            </div>
            <div className="finance-filter">
              {statusFilters.map(s => (
                <button key={s} className={filterStatus === s ? 'active' : ''} onClick={() => setFilterStatus(s)}>{statusLabels[s]}</button>
              ))}
            </div>
            <div className="dj-card finance-table-card">
              <Table columns={cols} data={orders} loading={loading} />
              <div className="finance-pagination">
                <Pagination page={page} pageSize={PAGE_SIZE} total={total} onChange={p => load(p)} />
              </div>
            </div>
          </div>

          <aside>
            <div className="dj-section-title">
              <h2>下一步动作</h2>
              <span>按履约风险</span>
            </div>
            <div className="dj-card order-action-card">
              <button onClick={() => setCreateOpen(true)}>
                <strong>门店补货</strong>
                <span>发起新的采购订单</span>
              </button>
              <button onClick={() => router.push('/receipts')}>
                <strong>入库确认</strong>
                <span>处理已送达订单</span>
              </button>
              <button onClick={() => router.push('/loss-claims')}>
                <strong>报损协同</strong>
                <span>跟进缺货、破损、短斤</span>
              </button>
            </div>

            <div className="dj-section-title finance-side-title">
              <h2>供应商履约</h2>
              <span>链路时间线</span>
            </div>
            <div className="dj-card order-timeline">
              {['门店提交采购需求', '供应商确认并备货', '配送到店并标记送达', '店长入库确认', '系统生成账期'].map((text, i) => (
                <article key={text} className={i <= 2 ? 'active' : ''}>
                  <i>{i + 1}</i>
                  <span>{text}</span>
                </article>
              ))}
            </div>
          </aside>
        </section>
      </main>

      <Modal open={createOpen} title="新建采购订单" onClose={() => { setCreateOpen(false); setErrors({}) }} width={640}>
        <div className="finance-form-grid">
          <Field label="门店" required error={errors.storeId}>
            <Select value={form.storeId} onChange={v => { setForm({ ...form, storeId: v }); setErrors(e => ({ ...e, storeId: '' })) }}
              options={stores.map(s => ({ value: s.id, label: s.name.replace('滇界·', '') }))} placeholder="选择门店" />
          </Field>
          <Field label="供应商" required error={errors.supplierId}>
            <Select value={form.supplierId} onChange={v => { setForm({ ...form, supplierId: v }); setErrors(e => ({ ...e, supplierId: '' })) }}
              options={suppliers.map(s => ({ value: s.id, label: s.name }))} placeholder="选择供应商" />
          </Field>
          <Field label="期望到货日期" required error={errors.expectedDate}>
            <Input type="date" value={form.expectedDate} onChange={v => { setForm({ ...form, expectedDate: v }); setErrors(e => ({ ...e, expectedDate: '' })) }}
              error={!!errors.expectedDate} />
          </Field>
          <Field label="备注"><Input value={form.note} onChange={v => setForm({ ...form, note: v })} placeholder="可选" /></Field>
        </div>
        <div style={{ marginTop: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>采购明细</span>
            <Btn size="sm" onClick={() => setItems([...items, { productId: '', quantity: '', unitPrice: '' }])}>添加</Btn>
          </div>
          {errors.items && <div style={{ fontSize: 11, color: '#dc2626', marginBottom: 8 }}>{errors.items}</div>}
          {items.map((item, i) => (
            <div key={i} className="order-item-row">
              <Select value={item.productId} onChange={v => {
                const next = [...items]; next[i] = { ...next[i], productId: v }
                const p = products.find(p => p.id === v)
                if (p) next[i].unitPrice = String(p.price)
                setItems(next)
              }} options={products.map(p => ({ value: p.id, label: `${p.name} (${p.unit})` }))} placeholder="选择商品" />
              <Input value={item.quantity} onChange={v => { const n=[...items]; n[i]={...n[i],quantity:v}; setItems(n) }} placeholder="数量" type="number" />
              <Input value={item.unitPrice} onChange={v => { const n=[...items]; n[i]={...n[i],unitPrice:v}; setItems(n) }} placeholder="单价" type="number" />
              <Btn size="sm" variant="danger" onClick={() => setItems(items.filter((_, idx) => idx !== i))}>删</Btn>
            </div>
          ))}
          <div className="order-total">合计：{fmt(totalAmt)}</div>
        </div>
        <div className="finance-modal-actions">
          <Btn onClick={() => setCreateOpen(false)}>取消</Btn>
          <Btn variant="primary" onClick={submit}>提交采购订单</Btn>
        </div>
      </Modal>
    </AppLayout>
  )
}
