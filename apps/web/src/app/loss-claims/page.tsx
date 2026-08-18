'use client'
import { useEffect, useMemo, useState } from 'react'
import AppLayout from '@/components/AppLayout'
import { Table, Btn, Modal, Field, Input, Select, fmt, fmtDate, useToast } from '@/components/ui'
import api from '@/lib/api'

const STATUS_INFO: Record<string, { label: string; color: string; bg: string }> = {
  PENDING:      { label: '待供应商处理', color: '#854f0b', bg: '#faeeda' },
  APPROVED:     { label: '已同意扣款',  color: '#1d9e75', bg: '#eaf3de' },
  AUTO_APPROVED:{ label: '超时自动同意', color: '#1d9e75', bg: '#eaf3de' },
  REJECTED:     { label: '供应商拒绝',  color: '#a32d2d', bg: '#fcebeb' },
  NEGOTIATING:  { label: '协商中',      color: '#185fa5', bg: '#e7eef6' },
  RESOLVED:     { label: '已解决',      color: '#888780', bg: '#f2f1eb' },
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

export default function LossClaimsPage() {
  const [claims, setClaims] = useState<any[]>([])
  const [orders, setOrders] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [user, setUser] = useState<any>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [handleOpen, setHandleOpen] = useState(false)
  const [current, setCurrent] = useState<any>(null)
  const [handleAction, setHandleAction] = useState<'approve'|'reject'>('approve')
  const [handleNote, setHandleNote] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const { show, ToastEl } = useToast()

  // 新建表单
  const [form, setForm] = useState({ purchaseOrderId: '', description: '', evidenceImages: [] as string[] })
  const [lossItems, setLossItems] = useState<any[]>([])

  useEffect(() => {
    setUser(safeUser())
    load()
  }, [filterStatus])

  const load = async () => {
    setLoading(true)
    try {
      const params = filterStatus ? `?status=${filterStatus}` : ''
      const [c, o] = await Promise.all([
        api.get(`/api/loss-claims${params}`),
        api.get('/api/orders?status=RECEIVED'),
      ])
      setClaims(Array.isArray(c.data) ? c.data : c.data.items || [])
      setOrders(Array.isArray(o.data) ? o.data : o.data.items || [])
    } catch { show('报损数据读取失败', 'error') }
    setLoading(false)
  }

  const selectOrder = (orderId: string) => {
    const order = orders.find(o => o.id === orderId)
    setForm({ ...form, purchaseOrderId: orderId })
    if (order) {
      setLossItems(order.items.map((i: any) => ({
        productId: i.productId,
        productName: i.product?.name,
        unit: i.product?.unit,
        orderedQty: Number(i.quantity),
        receivedQty: Number(i.receivedQty ?? i.quantity),
        unitPrice: Number(i.unitPrice),
      })))
    }
  }

  const submit = async () => {
    if (!form.purchaseOrderId || !form.description) return show('请填写完整信息', 'error')
    if (!form.evidenceImages.length) return show('请上传证据图片', 'error')
    const lossData = lossItems.filter(i => i.receivedQty < i.orderedQty)
    if (!lossData.length) return show('没有检测到损耗数量', 'error')

    try {
      await api.post('/api/loss-claims', {
        ...form,
        items: lossData.map(i => ({
          productId: i.productId,
          orderedQty: i.orderedQty,
          receivedQty: i.receivedQty,
          unitPrice: i.unitPrice,
        })),
      })
      show('报损申请已提交，供应商将在24小时内处理')
      setCreateOpen(false)
      load()
    } catch (e: any) { show(e.response?.data?.error || '提交失败', 'error') }
  }

  const handleClaim = async () => {
    try {
      await api.patch(`/api/loss-claims/${current.id}/handle`, { action: handleAction, note: handleNote })
      show(handleAction === 'approve' ? '已同意报损，账期金额已扣减' : '已拒绝，门店将收到通知')
      setHandleOpen(false); load()
    } catch (e: any) { show(e.response?.data?.error || '操作失败', 'error') }
  }

  // 模拟图片上传（实际接入OSS）
  const addImage = () => {
    const url = prompt('请输入图片URL（实际版本将支持直接拍照上传）')
    if (url) setForm({ ...form, evidenceImages: [...form.evidenceImages, url] })
  }

  const summary = useMemo(() => {
    const pendingItems = claims.filter(c => c.status === 'PENDING')
    const approvedItems = claims.filter(c => ['APPROVED', 'AUTO_APPROVED'].includes(c.status))
    const rejectedItems = claims.filter(c => c.status === 'REJECTED')
    return {
      pending: pendingItems.length,
      totalLoss: approvedItems.reduce((s, c) => s + Math.max(0, Number(c.totalLossAmount || 0)), 0),
      pendingAmount: pendingItems.reduce((s, c) => s + Math.max(0, Number(c.totalLossAmount || 0)), 0),
      rejected: rejectedItems.length,
      resolved: claims.filter(c => c.status === 'RESOLVED').length,
    }
  }, [claims])

  const cols = [
    { key: 'no', title: '报损单号', render: (v: string) => <span className="dj-table-strong">{v}</span> },
    { key: 'purchaseOrder', title: '采购订单', render: (_: any, row: any) => row.purchaseOrder?.no },
    { key: 'store', title: '门店', render: (_: any, row: any) => row.store?.name?.replace('滇界·', '') },
    { key: 'supplier', title: '供应商', render: (_: any, row: any) => row.supplier?.name },
    { key: 'totalLossAmount', title: '损失金额', render: (v: any) => <b className="is-red">{fmt(v)}</b> },
    { key: 'description', title: '说明', render: (v: string) => <span style={{ fontSize: 11, color: '#6b7280' }}>{v?.slice(0, 30)}{v?.length > 30 ? '...' : ''}</span> },
    { key: 'status', title: '状态', render: (v: string) => {
      const s = STATUS_INFO[v] || { label: v, color: '#6b7280', bg: '#f3f4f6' }
      return <span className="dj-chip" style={{ background: s.bg, color: s.color }}>{s.label}</span>
    }},
    { key: 'createdAt', title: '提交时间', render: (v: string) => fmtDate(v) },
    { key: 'actions', title: '操作', render: (_: any, row: any) => (
      <div style={{ display: 'flex', gap: 6 }}>
        {row.status === 'PENDING' && ['SUPPLIER_STAFF', 'ADMIN'].includes(user?.role) && (
          <>
            <Btn size="sm" variant="primary" onClick={() => { setCurrent(row); setHandleAction('approve'); setHandleNote(''); setHandleOpen(true) }}>同意扣款</Btn>
            <Btn size="sm" variant="danger" onClick={() => { setCurrent(row); setHandleAction('reject'); setHandleNote(''); setHandleOpen(true) }}>拒绝</Btn>
          </>
        )}
        {row.status === 'REJECTED' && row.evidenceImages?.length > 0 && (
          <Btn size="sm" onClick={() => { setCurrent(row); setHandleOpen(true) }}>查看证据</Btn>
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
            <span>报损协同 · 供应商争议处理</span>
            <h1>报损处理台</h1>
            <p>门店提交证据，供应商确认扣款，系统自动调整账期金额</p>
          </div>
          {['MANAGER', 'ADMIN'].includes(user?.role) && (
            <Btn variant="primary" onClick={() => setCreateOpen(true)}>新建报损申请</Btn>
          )}
        </div>

        <section className="dj-hero loss-hero">
          <div className="dj-hero-meta">
            <span>报损争议 <i /> 账期扣减</span>
            <span>{new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
          </div>
          <div className="dj-hero-main">
            <strong>{summary.pending} 笔</strong>
            <em className={summary.pending ? 'is-orange' : 'is-green'}>{summary.pending ? '等待供应商处理' : '暂无待处理'}</em>
          </div>
          <p>待确认扣款 {fmt(summary.pendingAmount).replace('.00', '')} · 已扣减 {fmt(summary.totalLoss).replace('.00', '')} · 拒绝 {summary.rejected} 笔</p>
          <div className="loss-proof-grid">
            <span>门店举证</span>
            <span>供应商确认</span>
            <span>账期扣减</span>
          </div>
          <div className="dj-hero-stats">
            <div><span>待处理</span><strong className={summary.pending ? 'is-orange' : ''}>{summary.pending} 笔</strong></div>
            <div><span>已确认损失</span><strong className="is-red">{fmt(summary.totalLoss).replace('.00', '')}</strong></div>
            <div><span>已解决</span><strong>{summary.resolved} 笔</strong></div>
          </div>
        </section>

        <section className="dj-metric-grid">
          <article className={summary.pending > 0 ? 'tone-orange' : 'tone-green'}>
            <span>待供应商处理</span>
            <strong>{summary.pending} 笔</strong>
            <em>超时会进入自动同意策略</em>
          </article>
          <article className="tone-red">
            <span>待确认扣款</span>
            <strong>{fmt(summary.pendingAmount).replace('.00', '')}</strong>
            <em>影响本期应付金额</em>
          </article>
          <article>
            <span>已确认扣减</span>
            <strong>{fmt(summary.totalLoss).replace('.00', '')}</strong>
            <em>已从账期扣除</em>
          </article>
          <article className={summary.rejected > 0 ? 'tone-red' : 'tone-green'}>
            <span>供应商拒绝</span>
            <strong>{summary.rejected} 笔</strong>
            <em>需要协商或复核证据</em>
          </article>
        </section>

        <section className="dj-dashboard-grid dj-section">
          <div>
            <div className="dj-section-title">
              <h2>报损单处理台</h2>
              <span>{loading ? '读取中' : `${claims.length} 条记录`}</span>
            </div>
            <div className="finance-filter">
              {['', 'PENDING', 'APPROVED', 'REJECTED', 'RESOLVED'].map(s => (
                <button key={s} className={filterStatus === s ? 'active' : ''} onClick={() => setFilterStatus(s)}>
                  {{ '': '全部', PENDING: '待处理', APPROVED: '已同意', REJECTED: '已拒绝', RESOLVED: '已解决' }[s]}
                </button>
              ))}
            </div>
            <div className="dj-card finance-table-card">
              <Table columns={cols} data={claims} loading={loading} />
            </div>
          </div>

          <aside>
            <div className="dj-section-title">
              <h2>处理原则</h2>
              <span>供应商协同</span>
            </div>
            <div className="dj-card receipt-decision-card">
              <article>
                <strong>证据充分</strong>
                <span>同意报损，系统从账期金额中自动扣减。</span>
              </article>
              <article>
                <strong>证据不足</strong>
                <span>拒绝并写明原因，门店可补充证据复核。</span>
              </article>
              <article>
                <strong>超时未处理</strong>
                <span>进入自动同意策略，避免账期长期悬挂。</span>
              </article>
            </div>

            <div className="dj-section-title finance-side-title">
              <h2>争议链路</h2>
              <span>证据到扣款</span>
            </div>
            <div className="dj-card order-timeline">
              {['店长提交报损', '上传照片与数量差异', '供应商同意或拒绝', '系统调整账期', '财务按新金额付款'].map((text, i) => (
                <article key={text} className={i <= 3 ? 'active' : ''}>
                  <i>{i + 1}</i>
                  <span>{text}</span>
                </article>
              ))}
            </div>
          </aside>
        </section>
      </main>

      {/* 新建报损申请 */}
      <Modal open={createOpen} title="新建报损申请" onClose={() => setCreateOpen(false)} width={620}>
        <Field label="关联采购订单" required>
          <Select value={form.purchaseOrderId} onChange={selectOrder}
            options={orders.map(o => ({ value: o.id, label: `${o.no} · ${o.supplier?.name}` }))} placeholder="选择已收货的采购订单" />
        </Field>

        {lossItems.length > 0 && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>核对实际收货数量（修改有损耗的商品）</div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
              <thead>
                <tr style={{ background: '#f9fafb' }}>
                  {['商品', '下单', '实收', '损耗', '损失金额'].map(h => (
                    <th key={h} style={{ padding: '6px 10px', textAlign: 'left', fontSize: 11, color: '#6b7280' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {lossItems.map((item, i) => {
                  const loss = item.orderedQty - item.receivedQty
                  return (
                    <tr key={i} style={{ borderBottom: '1px solid #f3f4f6' }}>
                      <td style={{ padding: '8px 10px' }}>{item.productName}</td>
                      <td style={{ padding: '8px 10px', color: '#6b7280' }}>{item.orderedQty} {item.unit}</td>
                      <td style={{ padding: '8px 10px' }}>
                        <input type="number" value={item.receivedQty} max={item.orderedQty} min={0}
                          onChange={e => { const n=[...lossItems]; n[i]={...n[i],receivedQty:Number(e.target.value)}; setLossItems(n) }}
                          style={{ width: 70, border: '1.5px solid #e5e7eb', borderRadius: 6, padding: '3px 7px', fontSize: 12 }} />
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
            <div style={{ textAlign: 'right', marginTop: 8, fontSize: 13, fontWeight: 700, color: '#dc2626' }}>
              损失合计：{fmt(lossItems.reduce((s, i) => s + Math.max(0, i.orderedQty - i.receivedQty) * i.unitPrice, 0))}
            </div>
          </div>
        )}

        <Field label="损耗说明" required>
          <textarea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })}
            placeholder="详细描述损耗情况，如：野生菌到货时部分已腐烂，约5kg无法使用..." rows={3}
            style={{ width: '100%', border: '1.5px solid #e5e7eb', borderRadius: 7, padding: '8px 10px', fontSize: 13, resize: 'vertical', boxSizing: 'border-box' }} />
        </Field>

        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 500, color: '#374151', marginBottom: 8 }}>
            证据图片 <span style={{ color: '#dc2626' }}>*</span>
            <span style={{ fontSize: 11, color: '#9ca3af', marginLeft: 8 }}>（实际版本支持手机拍照直传）</span>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {form.evidenceImages.map((url, i) => (
              <div key={i} style={{ position: 'relative' }}>
                <img src={url} style={{ width: 80, height: 80, objectFit: 'cover', borderRadius: 8, border: '1px solid #e5e7eb' }} />
                <span onClick={() => setForm({ ...form, evidenceImages: form.evidenceImages.filter((_, idx) => idx !== i) })}
                  style={{ position: 'absolute', top: -6, right: -6, background: '#dc2626', color: '#fff', borderRadius: '50%', width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, cursor: 'pointer' }}>×</span>
              </div>
            ))}
            <div onClick={addImage} style={{ width: 80, height: 80, border: '2px dashed #d1d5db', borderRadius: 8, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#9ca3af', fontSize: 11 }}>
              <span style={{ fontSize: 20 }}>📷</span>
              上传图片
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20, paddingTop: 16, borderTop: '1px solid #e5e7eb' }}>
          <Btn onClick={() => setCreateOpen(false)}>取消</Btn>
          <Btn variant="primary" onClick={submit}>提交报损申请</Btn>
        </div>
      </Modal>

      {/* 供应商处理报损 */}
      <Modal open={handleOpen} title={handleAction === 'approve' ? '同意报损申请' : '拒绝报损申请'} onClose={() => setHandleOpen(false)}>
        {current && (
          <>
            <div style={{ background: '#f9fafb', borderRadius: 10, padding: '12px 14px', marginBottom: 14 }}>
              <div style={{ fontSize: 13, marginBottom: 6 }}><span style={{ color: '#9ca3af' }}>报损金额：</span><b style={{ color: '#dc2626', fontSize: 16 }}>{fmt(current.totalLossAmount)}</b></div>
              <div style={{ fontSize: 12, color: '#374151', marginBottom: 8 }}><span style={{ color: '#9ca3af' }}>说明：</span>{current.description}</div>
              {current.evidenceImages?.length > 0 && (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {current.evidenceImages.map((url: string, i: number) => (
                    <img key={i} src={url} style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 6, border: '1px solid #e5e7eb' }} />
                  ))}
                </div>
              )}
            </div>
            {handleAction === 'approve' && (
              <div style={{ background: '#edfaf3', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#156b43', marginBottom: 14 }}>
                ✓ 同意后，账期金额将自动扣减 {fmt(current.totalLossAmount)}
              </div>
            )}
            <Field label={handleAction === 'approve' ? '处理备注（可选）' : '拒绝原因（必填）'}>
              <Input value={handleNote} onChange={setHandleNote} placeholder={handleAction === 'reject' ? '请说明拒绝原因...' : '可留空'} />
            </Field>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20, paddingTop: 16, borderTop: '1px solid #e5e7eb' }}>
              <Btn onClick={() => setHandleOpen(false)}>取消</Btn>
              <Btn variant={handleAction === 'approve' ? 'primary' : 'danger'} onClick={handleClaim}>
                {handleAction === 'approve' ? '✓ 确认同意' : '✕ 确认拒绝'}
              </Btn>
            </div>
          </>
        )}
      </Modal>
    </AppLayout>
  )
}
