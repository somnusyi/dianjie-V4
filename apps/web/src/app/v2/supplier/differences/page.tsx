'use client'

import { useEffect, useMemo, useState } from 'react'
import dayjs from 'dayjs'
import { BottomNav, Chip } from '@/components/v2'
import { ConfirmSheet, useConfirmSheet } from '@/components/v2/confirm-sheet'
import { apiDownload, apiFetch, getUser } from '@/lib/v2-auth'
import {
  supplierLossClaimKindMeta,
  supplierLossClaimResponsibility,
  supplierLossClaimSettlementHint,
} from '@/lib/supplier-domain'

type Claim = {
  id: string; no: string; status: string; kind: string; payableBasis: string
  totalLossAmount: string | number; description: string; createdAt: string
  store: { name: string }
  purchaseOrder: { id: string; no: string } | null
  deliveryOrder: { id: string; no: string } | null
  receipt: { id: string; no: string } | null
  items: Array<{
    product: { name: string; unit: string; spec?: string | null }
    lossQty: string | number; lossAmount: string | number
  }>
}

const STATUS_OPTIONS = [
  ['', '全部责任节点'], ['PENDING', '待供应商确认'], ['REJECTED', '待总厨仲裁'],
  ['NEGOTIATING', '协商处理中'], ['APPROVED', '供应商已确认'],
  ['AUTO_APPROVED', '超时自动确认'], ['RESOLVED', '总厨已裁定'],
] as const

const KIND_OPTIONS = [
  ['', '全部差异类型'], ['ARRIVAL_SHORTAGE', '到货短缺'], ['ARRIVAL_DAMAGE', '破损 / 品质异常'],
  ['LEGACY_UNRESOLVED', '历史待核'],
] as const

function tone(status: string): 'red' | 'orange' | 'green' | 'blue' | 'gray' {
  if (status === 'PENDING') return 'red'
  if (status === 'REJECTED' || status === 'NEGOTIATING') return 'orange'
  if (status === 'APPROVED' || status === 'AUTO_APPROVED') return 'green'
  if (status === 'RESOLVED') return 'blue'
  return 'gray'
}

export default function SupplierDifferencesPage() {
  const internalSupplyChain = getUser()?.role === 'SUPPLY_CHAIN'
  const [month, setMonth] = useState(dayjs().format('YYYY-MM'))
  const [status, setStatus] = useState('')
  const [kind, setKind] = useState('')
  const [keyword, setKeyword] = useState('')
  const [claims, setClaims] = useState<Claim[] | null>(null)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [confirmState, openConfirm] = useConfirmSheet()

  async function load() {
    const params = new URLSearchParams({ page: '1', pageSize: '100', isManual: 'false' })
    const start = dayjs(`${month}-01`).startOf('month')
    params.set('createdAfter', start.toISOString())
    params.set('createdBefore', start.add(1, 'month').toISOString())
    if (status) params.set('status', status)
    if (kind) params.set('kind', kind)
    if (keyword.trim()) params.set('keyword', keyword.trim())
    setError(null)
    try {
      const response = await apiFetch<{ items: Claim[]; total: number }>(`/api/loss-claims?${params}`)
      setClaims(response.items || [])
      setTotal(response.total || 0)
    } catch (reason: any) {
      setClaims([])
      setTotal(0)
      setError(reason.message || '到货差异加载失败')
    }
  }

  useEffect(() => { void load() }, [month, status, kind])

  const summary = useMemo(() => {
    const rows = claims || []
    return {
      pending: rows.filter(row => row.status === 'PENDING').length,
      arbitration: rows.filter(row => ['REJECTED', 'NEGOTIATING'].includes(row.status)).length,
      closed: rows.filter(row => ['APPROVED', 'AUTO_APPROVED', 'RESOLVED'].includes(row.status)).length,
      amount: rows.reduce((sum, row) => sum + Number(row.totalLossAmount || 0), 0),
    }
  }, [claims])

  function handle(claim: Claim, action: 'approve' | 'reject') {
    const meta = supplierLossClaimKindMeta(claim.kind)
    openConfirm({
      title: action === 'approve' ? `${meta.supplierActionLabel} ${claim.no}` : `对 ${claim.no} 提出异议`,
      body: action === 'approve'
        ? supplierLossClaimSettlementHint(claim.payableBasis)
        : '请填写异议依据。提交后由总厨仲裁，相关应付保持冻结。',
      confirmLabel: action === 'approve' ? meta.supplierActionLabel : '提交异议',
      tone: action === 'approve' ? 'primary' : 'danger',
      withInput: action === 'reject',
      inputRequired: action === 'reject',
      inputPlaceholder: '填写数量、品质或交接依据',
      onConfirm: async note => {
        setSubmitting(claim.id)
        try {
          await apiFetch(`/api/loss-claims/${claim.id}/handle`, {
            method: 'PATCH',
            body: JSON.stringify({
              action,
              note: action === 'approve' ? `已确认${meta.label}` : note,
            }),
          })
          await load()
        } catch (reason: any) {
          alert(reason.message || '处理失败')
          throw reason
        } finally {
          setSubmitting(null)
        }
      },
    })
  }

  async function exportCsv() {
    if (exporting) return
    const params = new URLSearchParams({ isManual: 'false' })
    const start = dayjs(`${month}-01`).startOf('month')
    params.set('createdAfter', start.toISOString())
    params.set('createdBefore', start.add(1, 'month').toISOString())
    if (status) params.set('status', status)
    if (kind) params.set('kind', kind)
    if (keyword.trim()) params.set('keyword', keyword.trim())
    setExporting(true)
    setError(null)
    try {
      const file = await apiDownload(`/api/loss-claims/export?${params}`, `到货差异_${month}.csv`)
      const url = URL.createObjectURL(file.blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = file.filename
      anchor.click()
      URL.revokeObjectURL(url)
    } catch (reason: any) {
      setError(reason.message || '到货差异导出失败')
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className={`min-h-screen bg-bg ${internalSupplyChain ? 'px-4 py-5 lg:px-8 lg:py-7' : 'pb-20'}`}>
      <header className="px-4 pt-4 lg:px-0 lg:pt-0">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-h1">到货差异</h1>
            <p className="text-caption text-gray3">
              {internalSupplyChain
                ? '跨门店查看数量短缺、破损和品质异常；裁决仍由总厨执行'
                : '数量短缺、破损与品质争议的独立处理工作台'}
            </p>
          </div>
          <div className="flex gap-2">
            {internalSupplyChain && <a href="/v2/supply-chain/receipts" className="rounded-cta border border-border bg-white px-3 py-2 text-button text-gray2">查看收货记录</a>}
            <button type="button" onClick={exportCsv} disabled={exporting} className="rounded-cta border border-border bg-white px-3 py-2 text-button text-gray2 disabled:opacity-40">{exporting ? '导出中…' : '导出全部结果'}</button>
          </div>
        </div>
      </header>

      <form onSubmit={event => { event.preventDefault(); void load() }} className="mx-4 mt-4 grid gap-2 rounded-card border border-border bg-white p-3 lg:mx-0 lg:grid-cols-[160px_190px_190px_1fr_100px]">
        <input type="month" value={month} max={dayjs().format('YYYY-MM')} onChange={event => setMonth(event.target.value)} className="rounded-cta border border-border bg-bg px-3 py-2 text-caption" />
        <select value={status} onChange={event => setStatus(event.target.value)} className="rounded-cta border border-border bg-bg px-3 py-2 text-caption">{STATUS_OPTIONS.map(option => <option key={option[0]} value={option[0]}>{option[1]}</option>)}</select>
        <select value={kind} onChange={event => setKind(event.target.value)} className="rounded-cta border border-border bg-bg px-3 py-2 text-caption">{KIND_OPTIONS.map(option => <option key={option[0]} value={option[0]}>{option[1]}</option>)}</select>
        <input value={keyword} onChange={event => setKeyword(event.target.value)} placeholder="差异单 / 订货单 / 配送单 / 入库单 / 门店" className="rounded-cta border border-border bg-bg px-3 py-2 text-caption" />
        <button type="submit" className="rounded-cta bg-ink px-3 py-2 text-button text-white">查询</button>
      </form>

      <section className="mx-4 mt-3 grid grid-cols-2 gap-2 lg:mx-0 lg:grid-cols-4">
        {[
          ['待确认', summary.pending, 'text-red-fg'], ['待仲裁', summary.arbitration, 'text-orange'],
          ['已结案', summary.closed, 'text-green-fg'], ['涉及金额', `¥${summary.amount.toFixed(2)}`, 'text-ink'],
        ].map(([label, value, color]) => <div key={String(label)} className="rounded-card border border-border bg-white p-3"><div className="text-micro text-gray3">{label}</div><div className={`mt-1 font-num text-h2 ${color}`}>{value}</div></div>)}
      </section>

      {total > 100 && <div className="mx-4 mt-3 rounded-card bg-amber/10 p-3 text-caption text-amber-fg lg:mx-0">共有 {total} 条，页面先展示前 100 条；“导出全部结果”由服务端生成完整文件。</div>}
      {error && <div className="mx-4 mt-3 rounded-card bg-red-bg p-3 text-caption text-red-fg lg:mx-0">{error}</div>}
      {claims === null && <div className="mx-4 mt-4 rounded-card border border-border bg-white p-10 text-center text-caption text-gray3 lg:mx-0">加载中…</div>}
      {claims?.length === 0 && <div className="mx-4 mt-4 rounded-card border border-border bg-white p-10 text-center text-caption text-gray3 lg:mx-0">当前条件没有到货差异</div>}

      <ul className="mx-4 mt-4 space-y-2 lg:mx-0">
        {(claims || []).map(claim => {
          const kindMeta = supplierLossClaimKindMeta(claim.kind)
          return (
            <li key={claim.id} className="rounded-card border border-border bg-white p-3 lg:p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Chip tone={tone(claim.status)}>{supplierLossClaimResponsibility(claim.status)}</Chip>
                <Chip tone="blue">{kindMeta.label}</Chip>
                <span className="font-num text-micro text-gray3">#{claim.no}</span>
                <span className="ml-auto font-num text-h2">¥{Number(claim.totalLossAmount || 0).toFixed(2)}</span>
              </div>
              <div className="mt-2 grid gap-2 lg:grid-cols-[1.3fr_1fr_auto] lg:items-end">
                <div>
                  <div className="text-h2">{claim.store.name}</div>
                  <div className="mt-0.5 text-caption text-gray2">{claim.items.map(item => `${item.product.name} ${item.lossQty}${item.product.unit}`).join('、')}</div>
                  <p className="mt-1 text-micro text-gray3">{claim.description}</p>
                </div>
                <div className="text-micro text-gray3">
                  <div>{dayjs(claim.createdAt).format('YYYY-MM-DD HH:mm')}</div>
                  <div className="mt-1">订货 {claim.purchaseOrder?.no || '—'} · 配送 {claim.deliveryOrder?.no || '—'} · 入库 {claim.receipt?.no || '—'}</div>
                </div>
                <div className="flex gap-2">
                  <a href={`/v2/loss-claims/${claim.id}/print`} className="rounded-cta border border-border px-3 py-2 text-caption text-gray2">打印</a>
                  {claim.purchaseOrder && <a href={internalSupplyChain ? `/v2/supply-chain/fulfillment/${claim.purchaseOrder.id}` : `/v2/supplier/orders/${claim.purchaseOrder.id}`} className="rounded-cta border border-border px-3 py-2 text-caption text-gray2">订单</a>}
                  {!internalSupplyChain && claim.status === 'PENDING' && <>
                    <button type="button" disabled={submitting === claim.id} onClick={() => handle(claim, 'reject')} className="rounded-cta border border-red px-3 py-2 text-caption text-red-fg disabled:opacity-40">异议</button>
                    <button type="button" disabled={submitting === claim.id} onClick={() => handle(claim, 'approve')} className="rounded-cta bg-ink px-3 py-2 text-button text-white disabled:opacity-40">确认</button>
                  </>}
                </div>
              </div>
            </li>
          )
        })}
      </ul>

      {!internalSupplyChain && (
        <BottomNav
          tabs={[
            { key: 'home', label: '首页', icon: '⌂' },
            { key: 'orders', label: '订单', icon: '☷' },
            { key: 'inventory', label: '库存', icon: '▦' },
            { key: 'billing', label: '账单', icon: '⛁' },
            { key: 'me', label: '我的', icon: '◐' },
          ]}
          activeKey="orders"
          onChange={key => {
            if (key === 'home') location.href = '/v2/supplier/home'
            if (key === 'orders') location.href = '/v2/supplier/orders'
            if (key === 'inventory') location.href = '/v2/supplier/inventory'
            if (key === 'billing') location.href = '/v2/supplier/billing'
            if (key === 'me') location.href = '/v2/supplier/history'
          }}
        />
      )}

      <ConfirmSheet {...confirmState} />
    </div>
  )
}
