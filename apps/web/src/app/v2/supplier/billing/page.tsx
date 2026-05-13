/**
 * 供应商 App · 账单 (按发票视角 + 付款进度)
 *
 * 月度场景下, "账单 = 发票" — 看每张发票的:
 *   - 开票金额
 *   - 已付 / 剩余
 *   - 付款历史(分次)
 *   - 关联订单 N 单
 */
'use client'
import { useEffect, useMemo, useState } from 'react'
import { BlackHero, BottomNav, Chip } from '@/components/v2'
import { apiFetch, getUser } from '@/lib/v2-auth'

type Receipt = { id: string; no: string; totalAmount: string | number; store?: { name: string } | null }
type Payment = {
  id: string; amount: string | number
  status: 'PENDING'|'SUCCESS'|'FAILED'|'CANCELED'
  paidAt?: string | null; createdAt: string; note?: string | null
}
type Invoice = {
  id: string; invoiceNo: string
  amount: string | number
  paidAmount: string | number
  status: 'PENDING'|'VERIFIED'|'REJECTED'
  fullyPaidAt?: string | null
  issueDate: string
  uploadedAt: string
  fileUrl: string
  reviewNote?: string | null
  receipts: Receipt[]
  payments: Payment[]
}

const STATUS_LABEL: Record<string, string> = {
  PENDING:  '待审核',
  VERIFIED: '已审核',
  REJECTED: '已驳回',
}
const STATUS_TONE: Record<string, 'orange'|'green'|'red'> = {
  PENDING: 'orange', VERIFIED: 'green', REJECTED: 'red',
}
const PAY_LABEL: Record<string, string> = {
  PENDING:  '处理中',
  SUCCESS:  '已到账',
  FAILED:   '失败',
  CANCELED: '已取消',
}

function fmt(iso: string) {
  const d = new Date(iso)
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

export default function SupplierBillingPage() {
  const [tab] = useState('billing')
  const [items, setItems] = useState<Invoice[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [supplierName, setSupplierName] = useState('')
  const [filter, setFilter] = useState<'未付清' | '已付清' | '审核中' | '全部'>('未付清')

  useEffect(() => {
    const u = getUser()
    setSupplierName(u?.supplier?.name || '供应商')
    apiFetch<Invoice[]>('/api/invoices')
      .then(setItems)
      .catch(e => setError(e.message))
  }, [])

  const visible = useMemo(() => {
    if (!items) return []
    return items.filter(i => {
      if (filter === '审核中') return i.status === 'PENDING'
      if (filter === '已付清') return i.status === 'VERIFIED' && i.fullyPaidAt
      if (filter === '未付清') return i.status === 'VERIFIED' && !i.fullyPaidAt
      return true
    })
  }, [items, filter])

  const stats = useMemo(() => {
    const init = { invoiced: 0, paid: 0, remaining: 0, pending: 0, count: 0 }
    if (!items) return init
    items.forEach(i => {
      if (i.status === 'PENDING') { init.pending += Number(i.amount); init.count++ }
      if (i.status === 'VERIFIED') {
        init.invoiced += Number(i.amount)
        init.paid     += Number(i.paidAmount)
        init.remaining += Number(i.amount) - Number(i.paidAmount)
        init.count++
      }
    })
    return init
  }, [items])

  return (
    <div className="min-h-screen bg-bg pb-20">
      <header className="px-4 pt-4 pb-2 flex items-center justify-between">
        <div>
          <h1 className="text-h1">账单</h1>
          <p className="text-caption text-gray3">{supplierName} · 按发票看付款进度</p>
        </div>
      </header>

      {/* 上传发票引导 */}
      <div className="mx-4 mt-3 bg-amber/10 border border-amber/30 rounded-card p-3 flex items-center gap-3">
        <span className="text-amber-fg text-h2">📃</span>
        <div className="flex-1">
          <div className="text-button">月底统一开票</div>
          <p className="text-micro text-gray3">关联多笔订单合并 1 张发票, 财务审核后分次付款</p>
        </div>
        <a href="/v2/supplier/invoices" className="px-3 py-1.5 bg-ink text-white rounded-cta text-button shrink-0">上传发票</a>
      </div>

      {/* Hero 总览 */}
      <div className="px-4 mt-3">
        <BlackHero
          label="待回款"
          value={items === null ? '加载中…' : `¥${stats.remaining.toLocaleString()}`}
          delta={stats.pending > 0
            ? { text: `审核中 ¥${stats.pending.toLocaleString()}`, trend: 'flat' }
            : undefined}
          meta={`已开票 ¥${stats.invoiced.toLocaleString()} · 已付 ¥${stats.paid.toLocaleString()}`}
          stats={[
            { label: '待付清', value: `¥${stats.remaining.toLocaleString()}`, tone: stats.remaining > 0 ? 'orange' as any : 'default' as any },
            { label: '已付', value: `¥${stats.paid.toLocaleString()}`, tone: 'green' },
            { label: '票数', value: String(stats.count), tone: 'default' as any },
          ]}
        />
      </div>

      {error && <div className="mx-4 mt-3 bg-red-bg text-red-fg rounded-card p-3 text-caption">{error}</div>}

      {/* 过滤 */}
      <div className="px-4 mt-4 flex gap-2 overflow-x-auto">
        {(['未付清', '已付清', '审核中', '全部'] as const).map(f => (
          <button key={f} onClick={() => setFilter(f)}
            className={`shrink-0 px-3 py-1.5 rounded-cta text-button ${filter === f ? 'bg-ink text-white' : 'bg-white border border-border text-gray2'}`}>
            {f}
          </button>
        ))}
      </div>

      <ul className="px-4 mt-3 space-y-2">
        {items === null && <li className="text-caption text-gray3 text-center py-12">加载中…</li>}
        {visible.length === 0 && items !== null && (
          <li className="text-caption text-gray3 text-center py-12">{filter === '未付清' ? '无未付清账单 ✓' : '无记录'}</li>
        )}
        {visible.map(inv => {
          const paid = Number(inv.paidAmount)
          const total = Number(inv.amount)
          const remaining = total - paid
          const paidPct = total > 0 ? Math.round(paid / total * 100) : 0
          const isPaid = !!inv.fullyPaidAt
          return (
            <li key={inv.id} className="bg-white rounded-card border border-border p-3">
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <Chip tone={STATUS_TONE[inv.status]}>{STATUS_LABEL[inv.status]}</Chip>
                {inv.status === 'VERIFIED' && (
                  isPaid
                    ? <Chip tone="green">已付清</Chip>
                    : paid > 0 ? <Chip tone="orange">部分已付</Chip> : <Chip tone="gray">待付</Chip>
                )}
                <span className="text-caption text-gray3 font-num">#{inv.invoiceNo}</span>
                <span className="text-micro text-gray3 ml-auto">{fmt(inv.uploadedAt)} 上传</span>
              </div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-h2 font-num">¥{total.toLocaleString()}</span>
                {!isPaid && inv.status === 'VERIFIED' && (
                  <span className="font-num text-h2 text-orange-fg">剩 ¥{remaining.toLocaleString()}</span>
                )}
              </div>
              <p className="text-caption text-gray2">关联 {inv.receipts.length} 单 · 开票 {fmt(inv.issueDate)}</p>

              {/* 付款进度 */}
              {inv.status === 'VERIFIED' && total > 0 && (
                <>
                  <div className="h-1.5 bg-bg rounded-full overflow-hidden mt-2">
                    <div className="h-full bg-amber transition-all" style={{ width: `${paidPct}%` }} />
                  </div>
                  <p className="text-micro text-gray3 mt-1">已收 ¥{paid.toLocaleString()} / ¥{total.toLocaleString()} ({paidPct}%)</p>
                </>
              )}

              {/* 付款历史 */}
              {inv.payments.length > 0 && (
                <ul className="mt-2 text-micro text-gray2 space-y-0.5 pl-2 border-l-2 border-border">
                  {inv.payments.map(p => (
                    <li key={p.id} className="flex items-center gap-2">
                      <span>{p.status === 'SUCCESS' ? '✓' : p.status === 'PENDING' ? '⏳' : '✗'}</span>
                      <span className="font-num">¥{Number(p.amount).toLocaleString()}</span>
                      <span>{PAY_LABEL[p.status]}</span>
                      <span className="ml-auto">{fmt(p.paidAt || p.createdAt)}</span>
                    </li>
                  ))}
                </ul>
              )}

              {inv.status === 'REJECTED' && inv.reviewNote && (
                <p className="text-micro text-red-fg mt-2">驳回: {inv.reviewNote}</p>
              )}
              <a href={inv.fileUrl} target="_blank" rel="noreferrer" className="text-micro text-amber-fg mt-2 inline-block">查看原票 ↗</a>
            </li>
          )
        })}
      </ul>

      <BottomNav
        tabs={[
          { key: 'home',    label: '首页', icon: '⌂' },
          { key: 'orders',  label: '订单', icon: '☷' },
          { key: 'inventory', label: '库存', icon: '▦' },
          { key: 'billing', label: '账单', icon: '⛁' },
          { key: 'me',      label: '我的', icon: '◐' },
        ]}
        activeKey={tab}
        onChange={(k) => {
          if (k === 'home')    location.href = '/v2/supplier/home'
          if (k === 'orders')  location.href = '/v2/supplier/orders'
          if (k === 'inventory') location.href = '/v2/supplier/inventory'
          if (k === 'me')      location.href = '/v2/me'
        }}
      />
    </div>
  )
}
