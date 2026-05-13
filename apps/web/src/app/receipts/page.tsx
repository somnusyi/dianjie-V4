'use client'
import { useEffect, useMemo, useState } from 'react'
import AppLayout from '@/components/AppLayout'
import { Table, Btn, Modal, Field, Input, Select, fmt, fmtDate, useToast, Pagination } from '@/components/ui'
import api from '@/lib/api'
import { z } from 'zod'

const receiptSchema = z.object({
  supplierId: z.string().min(1, '请选择供应商'),
  storeId: z.string().min(1, '请选择门店'),
  deliveryDate: z.string().min(1, '请选择到货日期'),
})

const itemSchema = z.object({
  productId: z.string().min(1, '请选择商品'),
  quantity: z.string().refine(v => Number(v) > 0, '数量必须大于 0'),
  unitPrice: z.string().refine(v => Number(v) > 0, '单价必须大于 0'),
})

const STATUS_INFO: Record<string, { label: string; color: string; bg: string }> = {
  DRAFT:           { label: '草稿',       color: '#888780', bg: '#f2f1eb' },
  PENDING:         { label: '待确认',     color: '#854f0b', bg: '#faeeda' },
  PENDING_CONFIRM: { label: '待收货操作', color: '#854f0b', bg: '#faeeda' },
  CONFIRMED:       { label: '已确认',     color: '#1d9e75', bg: '#eaf3de' },
  ACCOUNTED:       { label: '已完成',     color: '#1d9e75', bg: '#eaf3de' },
  VOID:            { label: '已作废',     color: '#888780', bg: '#f2f1eb' },
  REJECTED:        { label: '已拒收',     color: '#a32d2d', bg: '#fcebeb' },
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

export default function ReceiptsPage() {
  const [receipts, setReceipts] = useState<any[]>([])
  const [suppliers, setSuppliers] = useState<any[]>([])
  const [stores, setStores] = useState<any[]>([])
  const [products, setProducts] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [user, setUser] = useState<any>(null)
  const [filterStatus, setFilterStatus] = useState('')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const PAGE_SIZE = 20

  // 弹窗状态
  const [createOpen, setCreateOpen] = useState(false)
  const [actionOpen, setActionOpen] = useState(false)
  const [actionType, setActionType] = useState<'confirm' | 'loss' | 'reject'>('confirm')
  const [current, setCurrent] = useState<any>(null)

  // 补录表单
  const [form, setForm] = useState({ storeId: '', supplierId: '', deliveryDate: '', note: '', tempSupplierName: '', tempBankAccount: '', tempBankName: '' })
  const [formItems, setFormItems] = useState([{ productId: '', quantity: '', unitPrice: '' }])
  const [createErrors, setCreateErrors] = useState<Record<string, string>>({})

  // 报损表单
  const [lossDesc, setLossDesc] = useState('')
  const [lossImages, setLossImages] = useState<string[]>([])
  const [lossItems, setLossItems] = useState<any[]>([])

  // 拒收表单
  const [rejectReason, setRejectReason] = useState('')

  const { show, ToastEl } = useToast()

  useEffect(() => {
    setUser(safeUser())
    load(1)
  }, [filterStatus])

  const load = async (p = page) => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ page: String(p), pageSize: String(PAGE_SIZE) })
      if (filterStatus) params.set('status', filterStatus)
      const [r, s, st, pr] = await Promise.all([
        api.get(`/api/receipts?${params}`),
        api.get('/api/suppliers?status=ENABLED'),
        api.get('/api/stores'),
        api.get('/api/products?status=ENABLED'),
      ])
      const data = r.data
      setReceipts(Array.isArray(data) ? data : data.items || [])
      setTotal(data.total || 0)
      setPage(p)
      setSuppliers(s.data); setStores(st.data); setProducts(pr.data)
    } catch { show('入库数据读取失败', 'error') }
    setLoading(false)
  }

  const openAction = (row: any, type: 'confirm' | 'loss' | 'reject') => {
    setCurrent(row)
    setActionType(type)
    if (type === 'loss') {
      setLossItems(row.items?.map((i: any) => ({
        productId: i.productId,
        productName: i.product?.name,
        unit: i.product?.unit,
        orderedQty: Number(i.quantity),
        receivedQty: Number(i.quantity),
        unitPrice: Number(i.unitPrice),
      })) || [])
    }
    setLossDesc(''); setLossImages([]); setRejectReason('')
    setActionOpen(true)
  }

  const doConfirm = async () => {
    try {
      await api.patch(`/api/receipts/${current.id}/confirm`)
      show('确认入库成功，账期已自动创建')
      setActionOpen(false); load()
    } catch (e: any) { show(e.response?.data?.error || '操作失败', 'error') }
  }

  const doLoss = async () => {
    if (!lossDesc) return show('请填写报损说明', 'error')
    if (!lossImages.length) return show('请上传证据图片', 'error')
    try {
      const res = await api.patch(`/api/receipts/${current.id}/confirm-with-loss`, {
        description: lossDesc,
        evidenceImages: lossImages,
        items: lossItems.map(i => ({ productId: i.productId, receivedQty: i.receivedQty })),
      })
      show(`报损入库成功，实收 ${fmt(res.data.actualAmount)}，损耗 ${fmt(res.data.totalLossAmount)}`)
      setActionOpen(false); load()
    } catch (e: any) { show(e.response?.data?.error || '操作失败', 'error') }
  }

  const doReject = async () => {
    if (!rejectReason) return show('请填写拒收原因', 'error')
    try {
      await api.patch(`/api/receipts/${current.id}/reject`, { reason: rejectReason })
      show('已拒收，请联系供应商协商处理')
      setActionOpen(false); load()
    } catch (e: any) { show(e.response?.data?.error || '操作失败', 'error') }
  }

  const doCreate = async () => {
    const formResult = receiptSchema.safeParse(form)
    const newErrors: Record<string, string> = {}
    if (!formResult.success) {
      formResult.error.errors.forEach(e => { newErrors[e.path[0] as string] = e.message })
    }
    const itemErrors: string[] = []
    formItems.forEach((item, i) => {
      const r = itemSchema.safeParse(item)
      if (!r.success) itemErrors.push(`第 ${i + 1} 行：${r.error.errors[0].message}`)
    })
    if (formItems.length === 0) itemErrors.push('请至少添加一条入库明细')
    if (itemErrors.length) newErrors['items'] = itemErrors[0]
    setCreateErrors(newErrors)
    if (Object.keys(newErrors).length > 0) return

    try {
      await api.post('/api/receipts', {
        ...form,
        items: formItems.map(i => ({ productId: i.productId, quantity: Number(i.quantity), unitPrice: Number(i.unitPrice) })),
      })
      show('补录入库单已创建')
      setCreateOpen(false)
      setCreateErrors({})
      setForm({ storeId: '', supplierId: '', deliveryDate: '', note: '', tempSupplierName: '', tempBankAccount: '', tempBankName: '' })
      setFormItems([{ productId: '', quantity: '', unitPrice: '' }])
      load()
    } catch (e: any) { show(e.response?.data?.error || '创建失败', 'error') }
  }

  const addImage = () => {
    const url = prompt('输入图片URL（正式版支持拍照上传）')
    if (url) setLossImages([...lossImages, url])
  }

  const pendingCount = receipts.filter(r => ['PENDING', 'PENDING_CONFIRM'].includes(r.status)).length
  const summary = useMemo(() => {
    const pending = receipts.filter(r => ['PENDING', 'PENDING_CONFIRM'].includes(r.status))
    const confirmed = receipts.filter(r => ['CONFIRMED', 'ACCOUNTED'].includes(r.status))
    const rejected = receipts.filter(r => r.status === 'REJECTED')
    const manual = receipts.filter(r => r.isManual)
    return {
      pendingCount: pending.length,
      pendingAmount: pending.reduce((sum, r) => sum + Math.max(0, Number(r.totalAmount || 0)), 0),
      confirmedCount: confirmed.length,
      rejectedCount: rejected.length,
      manualCount: manual.length,
      totalAmount: receipts.reduce((sum, r) => sum + Math.max(0, Number(r.totalAmount || 0)), 0),
    }
  }, [receipts])

  const cols = [
    { key: 'no', title: '入库单号', render: (v: string, row: any) => (
      <div>
        <span className="dj-table-strong">{v}</span>
        {row.isManual && <span className="dj-chip" style={{ marginLeft: 6 }}>补录</span>}
      </div>
    )},
    { key: 'store', title: '门店', render: (_: any, r: any) => r.store?.name?.replace('滇界·', '') },
    { key: 'supplier', title: '供应商', render: (_: any, r: any) => r.tempSupplierName || r.supplier?.name },
    { key: 'deliveryDate', title: '到货日期', render: (v: string) => fmtDate(v) },
    { key: 'totalAmount', title: '金额', render: (v: any) => Number(v) < 0 ? <span className="dj-chip dj-chip-red">金额异常</span> : <b>{fmt(v)}</b> },
    { key: 'status', title: '状态', render: (v: string) => {
      const s = STATUS_INFO[v] || { label: v, color: '#6b7280', bg: '#f3f4f6' }
      return <span className="dj-chip" style={{ background: s.bg, color: s.color }}>{s.label}</span>
    }},
    { key: 'paymentSchedule', title: '账期', render: (_: any, r: any) => {
      const s = r.paymentSchedule
      if (!s) return <span className="dj-muted">未生成</span>
      return <span className="dj-chip dj-chip-blue">{fmtDate(s.dueAt)} 到期</span>
    }},
    { key: 'actions', title: '操作', render: (_: any, row: any) => {
      if (!['PENDING', 'PENDING_CONFIRM'].includes(row.status)) return null
      return (
        <div style={{ display: 'flex', gap: 6 }}>
          <Btn size="sm" variant="primary" onClick={() => openAction(row, 'confirm')}>确认入库</Btn>
          <Btn size="sm" style={{ background: '#fef9c3', color: '#92400e', border: '1px solid #fde68a' }}
            onClick={() => openAction(row, 'loss')}>报损入库</Btn>
          <Btn size="sm" variant="danger" onClick={() => openAction(row, 'reject')}>拒收</Btn>
        </div>
      )
    }},
  ]

  const statusTabs = [
    { v: '', label: '全部' },
    { v: 'PENDING_CONFIRM', label: `待操作${pendingCount > 0 ? ` (${pendingCount})` : ''}` },
    { v: 'CONFIRMED', label: '已确认' },
    { v: 'ACCOUNTED', label: '已完成' },
    { v: 'REJECTED', label: '已拒收' },
    { v: 'VOID', label: '已作废' },
  ]

  return (
    <AppLayout>
      {ToastEl}
      <main className="dj-page">
        <div className="dj-topbar">
          <div>
            <span>入库管理 · 门店收货工作台</span>
            <h1>入库确认台</h1>
            <p>确认实收、处理报损或拒收，并把有效入库自动转成供应商账期</p>
          </div>
          <Btn variant="primary" onClick={() => setCreateOpen(true)}>补录入库单</Btn>
        </div>

        <section className="dj-hero receipt-hero">
          <div className="dj-hero-meta">
            <span>收货状态 <i /> 实时入库</span>
            <span>{new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
          </div>
          <div className="dj-hero-main">
            <strong>{summary.pendingCount} 笔</strong>
            <em className={summary.pendingCount ? 'is-orange' : 'is-green'}>{summary.pendingCount ? '等待门店处理' : '全部处理完成'}</em>
          </div>
          <p>待确认金额 {fmt(summary.pendingAmount).replace('.00', '')} · 已确认 {summary.confirmedCount} 笔 · 拒收 {summary.rejectedCount} 笔</p>
          <div className="receipt-decision-grid">
            <span>全额入库</span>
            <span>报损入库</span>
            <span>拒收退回</span>
          </div>
          <div className="dj-hero-stats">
            <div><span>待处理</span><strong className={summary.pendingCount ? 'is-orange' : ''}>{summary.pendingCount} 笔</strong></div>
            <div><span>补录单</span><strong>{summary.manualCount} 笔</strong></div>
            <div><span>入库总额</span><strong>{fmt(summary.totalAmount).replace('.00', '')}</strong></div>
          </div>
        </section>

        <section className="dj-metric-grid">
          <article className={summary.pendingCount > 0 ? 'tone-orange' : 'tone-green'}>
            <span>待收货操作</span>
            <strong>{summary.pendingCount} 笔</strong>
            <em>确认、报损或拒收</em>
          </article>
          <article>
            <span>待确认金额</span>
            <strong>{fmt(summary.pendingAmount).replace('.00', '')}</strong>
            <em>确认后进入账期</em>
          </article>
          <article className="tone-green">
            <span>已入库</span>
            <strong>{summary.confirmedCount} 笔</strong>
            <em>已形成有效库存</em>
          </article>
          <article className={summary.rejectedCount > 0 ? 'tone-red' : 'tone-green'}>
            <span>拒收</span>
            <strong>{summary.rejectedCount} 笔</strong>
            <em>需供应商线下协商</em>
          </article>
        </section>

        <section className="dj-dashboard-grid dj-section">
          <div>
            <div className="dj-section-title">
              <h2>收货处理台</h2>
              <span>{loading ? '读取中' : `${total} 条记录`}</span>
            </div>
            <div className="finance-filter">
              {statusTabs.map(t => (
                <button key={t.v} className={filterStatus === t.v ? 'active' : ''} onClick={() => setFilterStatus(t.v)}>{t.label}</button>
              ))}
            </div>
            <div className="dj-card finance-table-card">
              <Table columns={cols} data={receipts} loading={loading} />
              <div className="finance-pagination">
                <Pagination page={page} pageSize={PAGE_SIZE} total={total} onChange={p => load(p)} />
              </div>
            </div>
          </div>

          <aside>
            <div className="dj-section-title">
              <h2>收货决策</h2>
              <span>店长 / 厨师长</span>
            </div>
            <div className="dj-card receipt-decision-card">
              <article>
                <strong>数量与品质一致</strong>
                <span>确认入库，系统按全额生成账期。</span>
              </article>
              <article>
                <strong>部分短缺或破损</strong>
                <span>报损入库，只按实收金额付款。</span>
              </article>
              <article>
                <strong>严重不符</strong>
                <span>拒收退回，供应商重新配送或取消。</span>
              </article>
            </div>

            <div className="dj-section-title finance-side-title">
              <h2>链路影响</h2>
              <span>自动生成</span>
            </div>
            <div className="dj-card order-timeline">
              {['采购订单送达', '门店收货确认', '库存数量更新', '账期自动创建', '进入付款审批'].map((text, i) => (
                <article key={text} className={i <= 3 ? 'active' : ''}>
                  <i>{i + 1}</i>
                  <span>{text}</span>
                </article>
              ))}
            </div>
          </aside>
        </section>
      </main>

      {/* 操作弹窗（确认/报损/拒收） */}
      <Modal open={actionOpen}
        title={actionType === 'confirm' ? '确认入库' : actionType === 'loss' ? '报损入库' : '拒收'}
        onClose={() => setActionOpen(false)} width={actionType === 'loss' ? 640 : 480}>
        {current && actionType === 'confirm' && (
          <>
            <div style={{ background: '#f9fafb', borderRadius: 10, padding: '14px 16px', marginBottom: 16 }}>
              <div style={{ fontSize: 13, marginBottom: 6 }}>入库单：<b>{current.no}</b></div>
              <div style={{ fontSize: 13, marginBottom: 6 }}>供应商：{current.supplier?.name}</div>
              <div style={{ fontSize: 13, marginBottom: 6 }}>金额：<b style={{ color: '#156b43', fontSize: 16 }}>{fmt(current.totalAmount)}</b></div>
              <div style={{ fontSize: 11, color: '#6b7280' }}>确认后将按全额自动生成账期</div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <Btn onClick={() => setActionOpen(false)}>取消</Btn>
              <Btn variant="primary" onClick={doConfirm}>确认全部收货</Btn>
            </div>
          </>
        )}

        {current && actionType === 'loss' && (
          <>
            <p style={{ fontSize: 12.5, color: '#6b7280', marginBottom: 12 }}>
              修改实际收到数量，账期将按实收金额生成（损耗部分不付款）
            </p>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, marginBottom: 14 }}>
              <thead>
                <tr style={{ background: '#f9fafb' }}>
                  {['商品', '下单量', '实收量', '损耗', '损失金额'].map(h => (
                    <th key={h} style={{ padding: '6px 10px', textAlign: 'left', fontSize: 11, color: '#6b7280' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {lossItems.map((item, i) => {
                  const loss = item.orderedQty - item.receivedQty
                  return (
                    <tr key={i} style={{ borderBottom: '1px solid #f3f4f6' }}>
                      <td style={{ padding: '8px 10px' }}>{item.productName} <span style={{ color: '#9ca3af' }}>({item.unit})</span></td>
                      <td style={{ padding: '8px 10px', color: '#6b7280' }}>{item.orderedQty}</td>
                      <td style={{ padding: '8px 10px' }}>
                        <input type="number" value={item.receivedQty} min={0} max={item.orderedQty}
                          onChange={e => { const n = [...lossItems]; n[i] = { ...n[i], receivedQty: Number(e.target.value) }; setLossItems(n) }}
                          style={{ width: 72, border: '1.5px solid #e5e7eb', borderRadius: 6, padding: '3px 7px', fontSize: 12 }} />
                      </td>
                      <td style={{ padding: '8px 10px', color: loss > 0 ? '#dc2626' : '#156b43', fontWeight: 600 }}>
                        {loss > 0 ? `-${loss}` : '✓'}
                      </td>
                      <td style={{ padding: '8px 10px', color: '#dc2626', fontWeight: 600 }}>
                        {loss > 0 ? fmt(loss * item.unitPrice) : '-'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, fontWeight: 700, marginBottom: 14, padding: '8px 10px', background: '#fef9c3', borderRadius: 8 }}>
              <span>实收金额：<span style={{ color: '#156b43' }}>{fmt(lossItems.reduce((s, i) => s + i.receivedQty * i.unitPrice, 0))}</span></span>
              <span>损耗金额：<span style={{ color: '#dc2626' }}>{fmt(lossItems.reduce((s, i) => s + Math.max(0, i.orderedQty - i.receivedQty) * i.unitPrice, 0))}</span></span>
            </div>
            <Field label="损耗说明" required>
              <textarea value={lossDesc} onChange={e => setLossDesc(e.target.value)} rows={2}
                placeholder="详细描述损耗情况..."
                style={{ width: '100%', border: '1.5px solid #e5e7eb', borderRadius: 7, padding: '8px 10px', fontSize: 13, resize: 'vertical', boxSizing: 'border-box' }} />
            </Field>
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 500, color: '#374151', marginBottom: 8 }}>证据图片 <span style={{ color: '#dc2626' }}>*</span></div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {lossImages.map((url, i) => (
                  <div key={i} style={{ position: 'relative' }}>
                    <img src={url} style={{ width: 70, height: 70, objectFit: 'cover', borderRadius: 7, border: '1px solid #e5e7eb' }} />
                    <span onClick={() => setLossImages(lossImages.filter((_, idx) => idx !== i))}
                      style={{ position: 'absolute', top: -6, right: -6, background: '#dc2626', color: '#fff', borderRadius: '50%', width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, cursor: 'pointer' }}>×</span>
                  </div>
                ))}
                <div onClick={addImage} style={{ width: 70, height: 70, border: '2px dashed #d1d5db', borderRadius: 7, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#9ca3af', fontSize: 10 }}>
                  <span style={{ fontSize: 18 }}>📷</span>上传
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <Btn onClick={() => setActionOpen(false)}>取消</Btn>
              <Btn style={{ background: '#fef9c3', color: '#92400e', border: '1px solid #fde68a' }} onClick={doLoss}>确认报损入库</Btn>
            </div>
          </>
        )}

        {current && actionType === 'reject' && (
          <>
            <div style={{ background: '#fef2f2', borderRadius: 8, padding: '12px 14px', marginBottom: 14, fontSize: 12.5, color: '#dc2626' }}>
              拒收后将退回供应商，需要线下协商处理（重新配送或取消订单）
            </div>
            <Field label="拒收原因" required>
              <textarea value={rejectReason} onChange={e => setRejectReason(e.target.value)} rows={3}
                placeholder="如：货物与订单不符、质量问题、数量严重不足..."
                style={{ width: '100%', border: '1.5px solid #e5e7eb', borderRadius: 7, padding: '8px 10px', fontSize: 13, resize: 'vertical', boxSizing: 'border-box' }} />
            </Field>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <Btn onClick={() => setActionOpen(false)}>取消</Btn>
              <Btn variant="danger" onClick={doReject}>确认拒收</Btn>
            </div>
          </>
        )}
      </Modal>

      {/* 补录入库单弹窗 */}
      <Modal open={createOpen} title="补录入库单" onClose={() => { setCreateOpen(false); setCreateErrors({}) }} width={660}>
        <div className="receipt-modal-note">
          补录用于非系统供应商采购，或历史数据录入。如果是系统供应商的食材采购，请通过「采购订单」模块操作。
        </div>
        <div className="finance-form-grid">
          <Field label="门店" required error={createErrors.storeId}>
            <Select value={form.storeId} onChange={v => { setForm({ ...form, storeId: v }); setCreateErrors(e => ({ ...e, storeId: '' })) }}
              options={stores.map(s => ({ value: s.id, label: s.name.replace('滇界·', '') }))} placeholder="选择门店" />
          </Field>
          <Field label="供应商" required error={createErrors.supplierId}>
            <Select value={form.supplierId} onChange={v => { setForm({ ...form, supplierId: v }); setCreateErrors(e => ({ ...e, supplierId: '' })) }}
              options={suppliers.map(s => ({ value: s.id, label: s.name }))} placeholder="选择供应商" />
          </Field>
          <Field label="到货日期" required error={createErrors.deliveryDate}>
            <Input type="date" value={form.deliveryDate} onChange={v => { setForm({ ...form, deliveryDate: v }); setCreateErrors(e => ({ ...e, deliveryDate: '' })) }}
              error={!!createErrors.deliveryDate} />
          </Field>
          <Field label="备注"><Input value={form.note} onChange={v => setForm({ ...form, note: v })} placeholder="可选" /></Field>
        </div>

        <details style={{ marginBottom: 12 }}>
          <summary style={{ fontSize: 12, color: '#6b7280', cursor: 'pointer', padding: '6px 0' }}>
            非系统供应商？展开填写临时收款信息
          </summary>
          <div className="receipt-temp-grid">
            <Field label="供应商名称"><Input value={form.tempSupplierName} onChange={v => setForm({ ...form, tempSupplierName: v })} placeholder="如：昆明某某公司" /></Field>
            <Field label="开户行"><Input value={form.tempBankName} onChange={v => setForm({ ...form, tempBankName: v })} placeholder="如：中国银行昆明支行" /></Field>
            <Field label="收款账号"><Input value={form.tempBankAccount} onChange={v => setForm({ ...form, tempBankAccount: v })} /></Field>
          </div>
        </details>

        <div style={{ marginBottom: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>入库明细</span>
            <Btn size="sm" onClick={() => setFormItems([...formItems, { productId: '', quantity: '', unitPrice: '' }])}>添加</Btn>
          </div>
          {createErrors.items && <div style={{ fontSize: 11, color: '#dc2626', marginBottom: 8 }}>{createErrors.items}</div>}
          {formItems.map((item, i) => (
            <div key={i} className="order-item-row">
              <Select value={item.productId} onChange={v => {
                const n = [...formItems]; n[i] = { ...n[i], productId: v }
                const p = products.find(p => p.id === v)
                if (p) n[i].unitPrice = String(p.price)
                setFormItems(n)
              }} options={products.map(p => ({ value: p.id, label: `${p.name} (${p.unit})` }))} placeholder="选择商品" />
              <Input value={item.quantity} onChange={v => { const n = [...formItems]; n[i] = { ...n[i], quantity: v }; setFormItems(n) }} placeholder="数量" type="number" />
              <Input value={item.unitPrice} onChange={v => { const n = [...formItems]; n[i] = { ...n[i], unitPrice: v }; setFormItems(n) }} placeholder="单价" type="number" />
              <Btn size="sm" variant="danger" onClick={() => setFormItems(formItems.filter((_, idx) => idx !== i))}>删</Btn>
            </div>
          ))}
          <div className="order-total">
            合计：{fmt(formItems.reduce((s, i) => s + (Number(i.quantity) || 0) * (Number(i.unitPrice) || 0), 0))}
          </div>
        </div>

        <div className="finance-modal-actions">
          <Btn onClick={() => setCreateOpen(false)}>取消</Btn>
          <Btn variant="primary" onClick={doCreate}>创建补录入库单</Btn>
        </div>
      </Modal>
    </AppLayout>
  )
}
