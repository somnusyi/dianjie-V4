'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { apiFetch } from '@/lib/v2-auth'
import { clientRequestId } from '@/lib/client-id'
import {
  money,
  shortDate,
  statusTone,
  UPSTREAM_CLAIM_STATUS_LABEL,
  UPSTREAM_ORDER_STATUS_LABEL,
  UPSTREAM_SETTLEMENT_STATUS_LABEL,
} from '@/lib/upstream-procurement'

type Tab = 'orders' | 'shipments' | 'claims' | 'settlements'
type OrderLine = {
  id: string
  productNameSnapshot: string
  productSpecSnapshot?: string | null
  purchaseUnit: string
  orderedQty: string | number
  confirmedQty?: string | number | null
  shippedQty: string | number
  unitPrice: string | number
}
type Order = {
  id: string
  no: string
  status: string
  totalAmount: string | number
  expectedArrivalAt?: string | null
  warehouse: { id: string; name: string }
  lines?: OrderLine[]
  _count?: { lines: number; shipments: number; receipts: number }
}
type Shipment = {
  id: string
  no: string
  status: string
  expectedArrivalAt?: string | null
  carrierName?: string | null
  trackingNo?: string | null
  purchaseOrder: { id: string; no: string; status: string }
  lines: Array<{ id: string; shippedQty: string | number; purchaseUnit: string; purchaseOrderLine: { productNameSnapshot: string } }>
}
type Claim = {
  id: string
  no: string
  type: string
  status: string
  claimedAmount: string | number
  description: string
  purchaseOrder: { no: string }
  receipt: { no: string }
  lines: Array<{ id: string; affectedQty: string | number; purchaseUnit: string; product: { name: string } }>
}
type Statement = {
  id: string
  no: string
  status: string
  periodStart: string
  periodEnd: string
  receiptAmount: string | number
  deductionAmount: string | number
  payableAmount: string | number
  version: number
  _count: { lines: number; invoiceAllocations: number }
}

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'orders', label: '待接采购单' },
  { key: 'shipments', label: '发货单' },
  { key: 'claims', label: '到货差异' },
  { key: 'settlements', label: '月度对账' },
]

function Badge({ status, labels }: { status: string; labels: Record<string, string> }) {
  return <span className={`rounded-full px-2.5 py-1 text-micro font-medium ${statusTone(status)}`}>{labels[status] || status}</span>
}

function Button({ children, onClick, disabled, secondary, danger }: { children: ReactNode; onClick: () => void; disabled?: boolean; secondary?: boolean; danger?: boolean }) {
  const style = danger ? 'border-red-200 text-red-700' : secondary ? 'border-border bg-white text-gray1' : 'border-gray1 bg-gray1 text-white'
  return <button onClick={onClick} disabled={disabled} className={`rounded-xl border px-4 py-2.5 text-button disabled:opacity-40 ${style}`}>{children}</button>
}

export default function SupplierUpstreamPage() {
  const [tab, setTab] = useState<Tab>('orders')
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [orders, setOrders] = useState<Order[]>([])
  const [shipments, setShipments] = useState<Shipment[]>([])
  const [claims, setClaims] = useState<Claim[]>([])
  const [statements, setStatements] = useState<Statement[]>([])
  const [editingOrder, setEditingOrder] = useState<Order | null>(null)
  const [editMode, setEditMode] = useState<'change' | 'ship' | null>(null)
  const [lineValues, setLineValues] = useState<Record<string, string>>({})
  const [changeReason, setChangeReason] = useState('')
  const [shipping, setShipping] = useState({ carrierName: '', trackingNo: '', expectedArrivalAt: '' })
  const [respondingClaim, setRespondingClaim] = useState<Claim | null>(null)
  const [claimResponse, setClaimResponse] = useState('')
  const [claimEvidence, setClaimEvidence] = useState<Array<{ url: string; name: string }>>([])
  const [uploadingClaimEvidence, setUploadingClaimEvidence] = useState(false)
  const shipmentRequestKeysRef = useRef<Record<string, string>>({})

  useEffect(() => {
    const requested = window.location.hash.replace('#', '') as Tab
    if (TABS.some(item => item.key === requested)) setTab(requested)
  }, [])

  const loadAll = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [orderRows, shipmentRows, claimRows, statementRows] = await Promise.all([
        apiFetch<Order[]>('/api/upstream/purchase-orders'),
        apiFetch<Shipment[]>('/api/upstream/shipments'),
        apiFetch<Claim[]>('/api/upstream/arrival-claims'),
        apiFetch<Statement[]>('/api/upstream/settlement-statements'),
      ])
      setOrders(orderRows)
      setShipments(shipmentRows)
      setClaims(claimRows)
      setStatements(statementRows)
    } catch (reason: any) {
      setError(reason?.message || '供应商协同数据加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void loadAll() }, [loadAll])

  // 采购方会推进单据状态: 回到本页自动刷新, 避免按旧状态操作
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') void loadAll()
    }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [loadAll])

  async function run(key: string, task: () => Promise<unknown>, success: string) {
    setWorking(key)
    setError(null)
    setNotice(null)
    try {
      await task()
      setNotice(success)
      await loadAll()
      return true
    } catch (reason: any) {
      setError(reason?.message || '操作失败')
      return false
    } finally {
      setWorking(null)
    }
  }

  async function openOrderForm(order: Order, mode: 'change' | 'ship') {
    setError(null)
    try {
      const detail = await apiFetch<Order>(`/api/upstream/purchase-orders/${order.id}`)
      setEditingOrder(detail)
      setEditMode(mode)
      setChangeReason('')
      setShipping({ carrierName: '', trackingNo: '', expectedArrivalAt: detail.expectedArrivalAt?.slice(0, 10) || '' })
      setLineValues(Object.fromEntries((detail.lines || []).map(line => {
        const target = Number(line.confirmedQty ?? line.orderedQty)
        const value = mode === 'ship' ? Math.max(0, target - Number(line.shippedQty)) : target
        return [line.id, String(value)]
      })))
      if (mode === 'ship') shipmentRequestKeysRef.current[detail.id] ||= clientRequestId()
    } catch (reason: any) {
      setError(reason?.message || '采购单明细加载失败')
    }
  }

  async function submitChange() {
    if (!editingOrder || !changeReason.trim()) return setError('请填写改单原因')
    const lines = (editingOrder.lines || []).map(line => ({ lineId: line.id, quantity: Number(lineValues[line.id]) }))
    await run(editingOrder.id, () => apiFetch(`/api/upstream/purchase-orders/${editingOrder.id}/propose-change`, {
      method: 'POST', body: JSON.stringify({ reason: changeReason.trim(), lines }),
    }), '改单申请已提交，等待采购方审核')
    setEditingOrder(null)
    setEditMode(null)
  }

  async function createShipment() {
    if (!editingOrder) return
    const lines = (editingOrder.lines || []).filter(line => Number(lineValues[line.id]) > 0).map(line => ({ purchaseOrderLineId: line.id, shippedQty: Number(lineValues[line.id]) }))
    if (!lines.length) return setError('至少填写一个商品的发货数量')
    const orderId = editingOrder.id
    const succeeded = await run(orderId, () => apiFetch(`/api/upstream/purchase-orders/${orderId}/shipments`, {
      method: 'POST', body: JSON.stringify({
        ...shipping,
        expectedArrivalAt: shipping.expectedArrivalAt || undefined,
        idempotencyKey: shipmentRequestKeysRef.current[orderId] || (shipmentRequestKeysRef.current[orderId] = clientRequestId()),
        lines,
      }),
    }), '发货单草稿已生成，请核对后点击发车')
    if (succeeded) {
      delete shipmentRequestKeysRef.current[orderId]
      setEditingOrder(null)
      setEditMode(null)
      setTab('shipments')
    }
  }

  async function uploadClaimEvidence(file: File) {
    if (claimEvidence.length >= 4) return setError('举证材料最多上传 4 个文件')
    setUploadingClaimEvidence(true)
    setError(null)
    try {
      const form = new FormData()
      form.append('file', file)
      const uploaded = await apiFetch<{ url: string }>('/api/upload?category=loss-claims', { method: 'POST', body: form })
      setClaimEvidence(current => [...current, { url: uploaded.url, name: file.name }].slice(0, 4))
    } catch (reason: any) {
      setError(reason?.message || '举证材料上传失败')
    } finally {
      setUploadingClaimEvidence(false)
    }
  }

  async function respondClaim(decision: 'ACCEPT' | 'REJECT') {
    if (!respondingClaim || !claimResponse.trim()) return setError('请填写确认说明')
    if (decision === 'REJECT' && claimEvidence.length === 0) return setError('提出异议时至少上传 1 张举证照片')
    await run(respondingClaim.id, () => apiFetch(`/api/upstream/arrival-claims/${respondingClaim.id}/respond`, {
      method: 'POST', body: JSON.stringify({
        decision,
        response: claimResponse.trim(),
        evidence: claimEvidence.map(item => ({ url: item.url, name: item.name })),
      }),
    }), decision === 'ACCEPT' ? '差异已接受，等待采购方办结' : '已提出异议，等待采购方处理')
    setRespondingClaim(null)
    setClaimResponse('')
    setClaimEvidence([])
  }

  const pendingOrders = orders.filter(order => ['SUBMITTED_TO_SUPPLIER', 'SUPPLIER_ACCEPTED', 'PARTIALLY_SHIPPED', 'PARTIALLY_RECEIVED', 'CHANGE_PROPOSED'].includes(order.status)).length
  const pendingClaims = claims.filter(claim => claim.status === 'PENDING_SUPPLIER').length
  const pendingStatements = statements.filter(statement => statement.status === 'SENT_TO_SUPPLIER').length

  return <div className="min-h-screen bg-bg px-4 py-5 lg:px-6 lg:py-2">
    <style jsx global>{`.supplier-input{width:100%;border:1px solid #ddd6c9;border-radius:12px;background:#fff;padding:10px 12px;color:#29231d;outline:none}.supplier-input:focus{border-color:#c96f32;box-shadow:0 0 0 3px rgba(201,111,50,.12)}`}</style>
    <header className="border-b border-border pb-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between"><div><p className="text-caption text-gray3">供应商协同 · 仅显示本公司的总仓采购业务</p><h1 className="mt-1 text-h1">总仓采购</h1><p className="mt-1 text-caption text-gray2">接单、申请改单、按实际发货、处理差异并确认月度账单</p></div><Button secondary onClick={() => void loadAll()} disabled={loading}>刷新</Button></div>
      <div className="mt-5 grid gap-3 sm:grid-cols-3"><Summary label="待接单/发货" value={pendingOrders} /><Summary label="待确认差异" value={pendingClaims} urgent={pendingClaims > 0} /><Summary label="待确认对账" value={pendingStatements} urgent={pendingStatements > 0} /></div>
    </header>

    <main className="py-5">
      {error && <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-caption text-red-700">{error}</div>}
      {notice && <div className="mb-4 rounded-xl border border-green/20 bg-green/10 px-4 py-3 text-caption text-green">{notice}</div>}
      <div className="mb-5 flex gap-2 overflow-x-auto">{TABS.map(item => <button key={item.key} onClick={() => setTab(item.key)} className={`whitespace-nowrap rounded-full px-4 py-2 text-button ${tab === item.key ? 'bg-gray1 text-white' : 'border border-border bg-white text-gray2'}`}>{item.label}</button>)}</div>
      {loading && <Empty text="正在加载总仓采购业务…" />}

      {editingOrder && <Panel title={`${editMode === 'change' ? '申请改单' : '新建发货单'} · ${editingOrder.no}`} onClose={() => { setEditingOrder(null); setEditMode(null) }}>
        {editMode === 'change' && <label className="mb-4 block"><span className="mb-1 block text-micro text-gray3">改单原因</span><textarea className="supplier-input min-h-20" value={changeReason} onChange={event => setChangeReason(event.target.value)} placeholder="说明缺货、规格或到货期变化" /></label>}
        {editMode === 'ship' && <div className="mb-4 grid gap-3 sm:grid-cols-3"><Field label="承运/配送方"><input className="supplier-input" value={shipping.carrierName} onChange={event => setShipping(value => ({ ...value, carrierName: event.target.value }))} /></Field><Field label="运单号"><input className="supplier-input" value={shipping.trackingNo} onChange={event => setShipping(value => ({ ...value, trackingNo: event.target.value }))} /></Field><Field label="预计到仓"><input type="date" className="supplier-input" value={shipping.expectedArrivalAt} onChange={event => setShipping(value => ({ ...value, expectedArrivalAt: event.target.value }))} /></Field></div>}
        <div className="overflow-x-auto"><table className="w-full text-caption"><thead><tr className="border-b text-left"><th className="p-2">商品</th><th className="p-2">订单数量</th><th className="p-2">已发</th><th className="p-2">{editMode === 'change' ? '申请数量' : '本次发货'}</th></tr></thead><tbody>{editingOrder.lines?.map(line => <tr key={line.id} className="border-b border-border"><td className="p-2"><b>{line.productNameSnapshot}</b><div className="text-gray3">{line.productSpecSnapshot || '—'}</div></td><td className="p-2">{String(line.confirmedQty ?? line.orderedQty)} {line.purchaseUnit}</td><td className="p-2">{String(line.shippedQty)} {line.purchaseUnit}</td><td className="p-2"><input type="number" min="0" step="any" className="supplier-input w-32" value={lineValues[line.id] || ''} onChange={event => setLineValues(value => ({ ...value, [line.id]: event.target.value }))} /></td></tr>)}</tbody></table></div>
        <div className="mt-4 flex justify-end">{editMode === 'change' ? <Button onClick={() => void submitChange()} disabled={working === editingOrder.id}>提交改单申请</Button> : <Button onClick={() => void createShipment()} disabled={working === editingOrder.id}>保存发货单草稿</Button>}</div>
      </Panel>}

      {respondingClaim && <Panel title={`确认到货差异 · ${respondingClaim.no}`} onClose={() => setRespondingClaim(null)}><p className="mb-3 text-caption text-gray2">{respondingClaim.description} · 申请金额 {money(respondingClaim.claimedAmount)}</p><textarea className="supplier-input min-h-24" value={claimResponse} onChange={event => setClaimResponse(event.target.value)} placeholder="填写核对结果、接受说明或异议理由" /><div className="mt-3"><span className="mb-1 block text-micro text-gray3">举证照片（提出异议时至少 1 张，最多 4 个文件）</span><div className="flex flex-wrap items-center gap-2">{claimEvidence.map((item, index) => <span key={index} className="rounded-lg bg-bg px-2 py-1 text-micro text-gray2">{item.name}<button className="ml-1 text-red-700" onClick={() => setClaimEvidence(current => current.filter((_, i) => i !== index))}>×</button></span>)}<label className={`cursor-pointer rounded-lg border border-dashed border-border px-3 py-1.5 text-caption ${uploadingClaimEvidence ? 'text-gray3' : 'text-accent'}`}>{uploadingClaimEvidence ? '上传中…' : '+ 上传照片'}<input type="file" accept="image/*" className="hidden" disabled={uploadingClaimEvidence} onChange={event => { const file = event.target.files?.[0]; if (file) void uploadClaimEvidence(file); event.target.value = '' }} /></label></div></div><div className="mt-4 flex justify-end gap-2"><Button danger onClick={() => void respondClaim('REJECT')} disabled={working === respondingClaim.id}>提出异议</Button><Button onClick={() => void respondClaim('ACCEPT')} disabled={working === respondingClaim.id}>接受差异</Button></div></Panel>}

      {!loading && tab === 'orders' && <section className="space-y-3">{orders.length === 0 ? <Empty text="暂无总仓采购单" /> : orders.map(order => <article key={order.id} className="rounded-2xl border border-border bg-white p-4"><div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><div className="flex flex-wrap items-center gap-2"><b className="text-h3">{order.no}</b><Badge status={order.status} labels={UPSTREAM_ORDER_STATUS_LABEL} /></div><p className="mt-1 text-caption text-gray2">送达 {order.warehouse.name} · {order._count?.lines || 0} 项 · 期望 {shortDate(order.expectedArrivalAt)}</p><p className="mt-1 text-h3">{money(order.totalAmount)}</p></div><div className="flex flex-wrap gap-2">{order.status === 'SUBMITTED_TO_SUPPLIER' && <><Button secondary onClick={() => void openOrderForm(order, 'change')}>申请改单</Button><Button onClick={() => window.confirm('确认可按采购单履约并接单？') && void run(order.id, () => apiFetch(`/api/upstream/purchase-orders/${order.id}/accept`, { method: 'POST' }), '采购单已接单')} disabled={working === order.id}>确认接单</Button></>}{['SUPPLIER_ACCEPTED', 'PARTIALLY_SHIPPED', 'PARTIALLY_RECEIVED'].includes(order.status) && <Button onClick={() => void openOrderForm(order, 'ship')}>新建发货单</Button>}{order.status === 'SUPPLIER_ACCEPTED' && <Button secondary onClick={() => void openOrderForm(order, 'change')}>申请改单</Button>}</div></div></article>)}</section>}

      {!loading && tab === 'shipments' && <section className="space-y-3">{shipments.length === 0 ? <Empty text="暂无发货单" /> : shipments.map(shipment => <article key={shipment.id} className="rounded-2xl border border-border bg-white p-4"><div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><div className="flex items-center gap-2"><b className="text-h3">{shipment.no}</b><Badge status={shipment.status} labels={{ DRAFT: '待发车', SHIPPED: '运输中', PARTIALLY_RECEIVED: '部分收货', RECEIVED: '已收货' }} /></div><p className="mt-1 text-caption text-gray2">采购单 {shipment.purchaseOrder.no} · {shipment.lines.length} 项 · 到仓 {shortDate(shipment.expectedArrivalAt)}</p>{shipment.carrierName && <p className="mt-1 text-caption text-gray3">{shipment.carrierName} {shipment.trackingNo || ''}</p>}</div>{shipment.status === 'DRAFT' && <Button onClick={() => window.confirm('确认商品和数量无误并发车？发车后数量不能修改。') && void run(shipment.id, () => apiFetch(`/api/upstream/shipments/${shipment.id}/dispatch`, { method: 'POST' }), '已确认发车，等待总仓收货')} disabled={working === shipment.id}>确认发车</Button>}</div></article>)}</section>}

      {!loading && tab === 'claims' && <section className="space-y-3">{claims.length === 0 ? <Empty text="暂无到货差异" /> : claims.map(claim => <article key={claim.id} className="rounded-2xl border border-border bg-white p-4"><div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div><div className="flex flex-wrap items-center gap-2"><b className="text-h3">{claim.no}</b><Badge status={claim.status} labels={UPSTREAM_CLAIM_STATUS_LABEL} /><span className="text-caption text-red-700">{money(claim.claimedAmount)}</span></div><p className="mt-2 text-caption text-gray1">{claim.description}</p><p className="mt-1 text-caption text-gray3">采购单 {claim.purchaseOrder.no} · 收货单 {claim.receipt.no}</p><ul className="mt-2 text-caption text-gray2">{claim.lines.map(line => <li key={line.id}>· {line.product.name} {String(line.affectedQty)} {line.purchaseUnit}</li>)}</ul></div>{claim.status === 'PENDING_SUPPLIER' && <Button onClick={() => { setRespondingClaim(claim); setClaimResponse('') }}>立即核对</Button>}</div></article>)}</section>}

      {!loading && tab === 'settlements' && <section className="space-y-3">{statements.length === 0 ? <Empty text="暂无月度对账单" /> : statements.map(statement => <article key={statement.id} className="rounded-2xl border border-border bg-white p-4"><div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><div className="flex items-center gap-2"><b className="text-h3">{statement.no}</b><Badge status={statement.status} labels={UPSTREAM_SETTLEMENT_STATUS_LABEL} /></div><p className="mt-1 text-caption text-gray2">{shortDate(statement.periodStart)}—{shortDate(statement.periodEnd)} · V{statement.version} · {statement._count.lines} 项</p><p className="mt-1 text-caption text-gray3">收货 {money(statement.receiptAmount)} · 扣款 {money(statement.deductionAmount)}</p><p className="mt-1 text-h3">应收 {money(statement.payableAmount)}</p></div>{statement.status === 'SENT_TO_SUPPLIER' && <div className="flex gap-2"><Button danger onClick={() => { const reason = window.prompt('请填写对账异议原因'); if (reason?.trim()) void run(statement.id, () => apiFetch(`/api/upstream/settlement-statements/${statement.id}/dispute`, { method: 'POST', body: JSON.stringify({ reason: reason.trim() }) }), '对账异议已提交') }}>提出异议</Button><Button onClick={() => window.confirm('确认本期收货、扣款和应收金额无误？') && void run(statement.id, () => apiFetch(`/api/upstream/settlement-statements/${statement.id}/confirm`, { method: 'POST' }), '月度对账已确认')} disabled={working === statement.id}>确认对账</Button></div>}</div></article>)}</section>}
    </main>
  </div>
}

function Summary({ label, value, urgent }: { label: string; value: number; urgent?: boolean }) {
  return <div className="rounded-2xl border border-border bg-white p-4"><p className="text-caption text-gray3">{label}</p><strong className={`mt-1 block text-[28px] ${urgent ? 'text-red-700' : 'text-gray1'}`}>{value}</strong></div>
}

function Empty({ text }: { text: string }) {
  return <div className="rounded-2xl border border-dashed border-border bg-white p-10 text-center text-caption text-gray3">{text}</div>
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label><span className="mb-1 block text-micro text-gray3">{label}</span>{children}</label>
}

function Panel({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return <section className="mb-4 rounded-2xl border border-amber/30 bg-white p-4 shadow-sm"><div className="mb-4 flex items-center justify-between"><h2 className="text-h3">{title}</h2><button onClick={onClose} className="text-caption text-gray3">关闭</button></div>{children}</section>
}
