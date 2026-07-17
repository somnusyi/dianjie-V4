'use client'

import { useEffect, useState } from 'react'
import dayjs from 'dayjs'
import { BottomNav, Chip } from '@/components/v2'
import { apiDownload, apiFetch } from '@/lib/v2-auth'

type StatementLine = {
  receiptId: string
  receiptNo: string
  deliveryDate: string
  store: { id: string; name: string }
  purchaseOrder: { id: string; no: string } | null
  deliveryOrder: { id: string; no: string } | null
  orderedAmount: number | null
  shipmentAmount: number | null
  receivedAmount: number
  payableAmount: number | null
  payableAdjustment: number | null
  schedule: { status: string; dueAt: string; paidAt: string | null; bankTxNo: string | null } | null
  differences: Array<{ id: string; no: string; kind: string; status: string; amount: number }>
  differenceAmount: number
}

type Statement = {
  supplier: { id: string; no: string; name: string }
  month: string
  summary: {
    receiptCount: number; purchaseOrderCount: number
    orderedAmount: number; shipmentAmount: number; receivedAmount: number; payableAmount: number
    payableAdjustment: number; differenceCount: number; differenceAmount: number
    missingScheduleCount: number; onHoldCount: number
  }
  lines: StatementLine[]
}

const STATUS_LABEL: Record<string, string> = {
  PENDING: '待付', PENDING_APPROVAL: '待财务审批', APPROVED: '已核准', REJECTED: '付款驳回',
  NOTIFIED: '已通知', PROCESSING: '付款中', PAID: '已付', OVERDUE: '逾期',
  CANCELLED: '已取消', ON_HOLD: '争议冻结',
}

function money(value: number | null) {
  return value == null
    ? '—'
    : `¥${value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function statusTone(status?: string): 'green' | 'orange' | 'red' | 'gray' {
  if (status === 'PAID') return 'green'
  if (status === 'ON_HOLD' || status === 'OVERDUE' || status === 'REJECTED') return 'red'
  if (!status || status === 'CANCELLED') return 'gray'
  return 'orange'
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

export default function SupplierReconciliationPage() {
  const [month, setMonth] = useState(() => {
    if (typeof window === 'undefined') return dayjs().format('YYYY-MM')
    return new URLSearchParams(window.location.search).get('month') || dayjs().format('YYYY-MM')
  })
  const [statement, setStatement] = useState<Statement | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)

  useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)
    apiFetch<Statement>(`/api/reconciliations/supplier-statement?month=${encodeURIComponent(month)}`)
      .then(data => { if (active) setStatement(data) })
      .catch(reason => { if (active) { setStatement(null); setError(reason.message || '月度对账加载失败') } })
      .finally(() => { if (active) setLoading(false) })
    history.replaceState(null, '', `/v2/supplier/reconciliation?month=${month}`)
    return () => { active = false }
  }, [month])

  const summary = statement?.summary

  async function exportStatement() {
    if (exporting) return
    setExporting(true)
    setError(null)
    try {
      const file = await apiDownload(
        `/api/reconciliations/supplier-statement/export?month=${encodeURIComponent(month)}`,
        `月度对账_${month}.csv`,
      )
      saveBlob(file.blob, file.filename)
    } catch (reason: any) {
      setError(reason.message || '月度对账导出失败')
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="min-h-screen bg-bg pb-20">
      <header className="px-4 pt-4 lg:px-0 lg:pt-0">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <a href="/v2/supplier/billing" className="text-caption text-gray3">‹ 返回账单</a>
            <h1 className="mt-1 text-h1">月度对账</h1>
            <p className="text-caption text-gray3">{statement?.supplier.name || '供应商'} · 逐笔核对，不改变现有付款状态</p>
          </div>
          <div className="flex items-center gap-2">
            <label className="rounded-card border border-border bg-white px-3 py-2 text-caption text-gray2">
              对账月份
              <input
                type="month" value={month} max={dayjs().format('YYYY-MM')}
                onChange={event => setMonth(event.target.value)}
                className="ml-2 bg-transparent font-num text-ink outline-none"
              />
            </label>
            <button type="button" onClick={exportStatement} disabled={exporting} className="rounded-cta border border-border bg-white px-3 py-2 text-button text-gray2 disabled:opacity-40">
              {exporting ? '导出中…' : '导出全部'}
            </button>
          </div>
        </div>
      </header>

      {error && <div className="mx-4 mt-4 rounded-card bg-red-bg p-3 text-caption text-red-fg lg:mx-0">{error}</div>}
      {loading && <div className="mx-4 mt-4 rounded-card border border-border bg-white p-10 text-center text-caption text-gray3 lg:mx-0">加载月度单据链…</div>}

      {!loading && summary && (
        <>
          <section className="mx-4 mt-4 grid grid-cols-2 gap-2 lg:mx-0 lg:grid-cols-5">
            {[
              ['订货金额', summary.orderedAmount],
              ['实发金额', summary.shipmentAmount],
              ['实收金额', summary.receivedAmount],
              ['应付金额', summary.payableAmount],
              ['应付调整', summary.payableAdjustment],
            ].map(([label, value]) => (
              <div key={String(label)} className="rounded-card border border-border bg-white p-3">
                <div className="text-micro text-gray3">{label}</div>
                <div className="mt-1 font-num text-h2">{money(Number(value))}</div>
              </div>
            ))}
          </section>

          <div className={`mx-4 mt-3 rounded-card border p-3 text-caption lg:mx-0 ${summary.onHoldCount || summary.missingScheduleCount ? 'border-red/30 bg-red-bg/40 text-red-fg' : 'border-green/30 bg-green-bg text-green-fg'}`}>
            {summary.receiptCount} 张入库单 · {summary.purchaseOrderCount} 张订货单 · {summary.differenceCount} 笔到货差异（涉及 {money(summary.differenceAmount)}）
            {summary.onHoldCount > 0 && ` · ${summary.onHoldCount} 笔争议冻结`}
            {summary.missingScheduleCount > 0 && ` · ${summary.missingScheduleCount} 笔尚未生成应付`}
          </div>

          {statement.lines.length === 0 ? (
            <div className="mx-4 mt-4 rounded-card border border-border bg-white p-12 text-center text-caption text-gray3 lg:mx-0">该月没有已确认入库单</div>
          ) : (
            <>
              <section className="mx-4 mt-4 hidden overflow-hidden rounded-card border border-border bg-white lg:mx-0 lg:block">
                <table className="w-full text-caption">
                  <thead className="border-b border-border bg-bg text-left text-gray3">
                    <tr>
                      <th className="px-3 py-3 font-medium">日期 / 门店 / 单据</th>
                      <th className="px-3 py-3 text-right font-medium">订货</th>
                      <th className="px-3 py-3 text-right font-medium">实发</th>
                      <th className="px-3 py-3 text-right font-medium">实收</th>
                      <th className="px-3 py-3 text-right font-medium">应付</th>
                      <th className="px-3 py-3 font-medium">付款状态</th>
                      <th className="px-3 py-3 font-medium">到货差异</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {statement.lines.map(line => (
                      <tr key={line.receiptId} className="hover:bg-bg/60">
                        <td className="px-3 py-3">
                          <div className="text-ink">{dayjs(line.deliveryDate).format('MM/DD')} · {line.store.name}</div>
                          <div className="mt-0.5 text-micro text-gray3">
                            {line.purchaseOrder ? <a className="text-amber-fg" href={`/v2/supplier/orders/${line.purchaseOrder.id}`}>{line.purchaseOrder.no}</a> : '无订货单'}
                            {' · '}{line.deliveryOrder?.no || '无配送单'}{' · '}{line.receiptNo}
                          </div>
                        </td>
                        <td className="px-3 py-3 text-right font-num">{money(line.orderedAmount)}</td>
                        <td className="px-3 py-3 text-right font-num">{money(line.shipmentAmount)}</td>
                        <td className="px-3 py-3 text-right font-num">{money(line.receivedAmount)}</td>
                        <td className="px-3 py-3 text-right font-num">{money(line.payableAmount)}</td>
                        <td className="px-3 py-3"><Chip tone={statusTone(line.schedule?.status)}>{STATUS_LABEL[line.schedule?.status || ''] || '待生成应付'}</Chip></td>
                        <td className="px-3 py-3">
                          {line.differences.length
                            ? <span className="text-red-fg">{line.differences.length} 笔 · {money(line.differenceAmount)}</span>
                            : <span className="text-green-fg">无差异</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>

              <ul className="mx-4 mt-4 space-y-2 lg:hidden">
                {statement.lines.map(line => (
                  <li key={line.receiptId} className="rounded-card border border-border bg-white p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="text-h2">{line.store.name}</div>
                        <div className="text-micro text-gray3">{dayjs(line.deliveryDate).format('YYYY-MM-DD')} · {line.receiptNo}</div>
                      </div>
                      <Chip tone={statusTone(line.schedule?.status)}>{STATUS_LABEL[line.schedule?.status || ''] || '待生成应付'}</Chip>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2 text-caption">
                      <span className="text-gray3">实发 <b className="float-right font-num text-ink">{money(line.shipmentAmount)}</b></span>
                      <span className="text-gray3">实收 <b className="float-right font-num text-ink">{money(line.receivedAmount)}</b></span>
                      <span className="text-gray3">应付 <b className="float-right font-num text-ink">{money(line.payableAmount)}</b></span>
                      <span className="text-gray3">差异 <b className={`float-right font-num ${line.differences.length ? 'text-red-fg' : 'text-green-fg'}`}>{line.differences.length ? money(line.differenceAmount) : '无'}</b></span>
                    </div>
                    {line.purchaseOrder && <a href={`/v2/supplier/orders/${line.purchaseOrder.id}`} className="mt-3 block border-t border-border pt-2 text-right text-caption text-amber-fg">查看 {line.purchaseOrder.no} ›</a>}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}

      <BottomNav
        tabs={[
          { key: 'home', label: '首页', icon: '⌂' },
          { key: 'orders', label: '订单', icon: '☷' },
          { key: 'inventory', label: '库存', icon: '▦' },
          { key: 'billing', label: '账单', icon: '⛁' },
          { key: 'me', label: '我的', icon: '◐' },
        ]}
        activeKey="billing"
        onChange={key => {
          if (key === 'home') location.href = '/v2/supplier/home'
          if (key === 'orders') location.href = '/v2/supplier/orders'
          if (key === 'inventory') location.href = '/v2/supplier/inventory'
          if (key === 'billing') location.href = '/v2/supplier/billing'
          if (key === 'me') location.href = '/v2/supplier/history'
        }}
      />
    </div>
  )
}
