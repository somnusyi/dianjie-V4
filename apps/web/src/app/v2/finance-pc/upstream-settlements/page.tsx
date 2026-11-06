'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import FinanceTopNav from '../_topnav'
import { apiFetch } from '@/lib/v2-auth'
import { loadUpstreamSettlementStatements } from '@/lib/upstream-settlement-list'
import {
  settlementMoney as money,
  sumSettlementAmounts,
  shortDate,
  statusTone,
  UPSTREAM_SETTLEMENT_STATUS_LABEL,
} from '@/lib/upstream-procurement'
import { confirmDialog } from '@/lib/ui-dialogs'


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
  supplier: { id: string; no: string; name: string }
  _count: { lines: number; invoiceAllocations: number }
}

export default function UpstreamSettlementsPage() {
  const [items, setItems] = useState<Statement[] | null>(null)
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [working, setWorking] = useState<string | null>(null)
  const [focusedStatementId, setFocusedStatementId] = useState<string | null>(null)
  const loadRequest = useRef(0)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    setFocusedStatementId(new URLSearchParams(window.location.search).get('statementId'))
  }, [])

  const load = useCallback(async () => {
    const request = ++loadRequest.current
    setLoading(true)
    setItems(null)
    setError(null)
    try {
      const rows = await loadUpstreamSettlementStatements<Statement>()
      if (request === loadRequest.current) setItems(rows)
    } catch (reason: any) {
      if (request !== loadRequest.current) return
      setError(reason?.message || '上游采购对账单加载失败')
      setItems(null)
    } finally {
      if (request === loadRequest.current) setLoading(false)
    }
  }, [])

  useEffect(() => { void load(); return () => { loadRequest.current++ } }, [load])

  useEffect(() => {
    if (!focusedStatementId || !items?.some(item => item.id === focusedStatementId)) return
    document.getElementById(`settlement-${focusedStatementId}`)?.scrollIntoView({ block: 'center' })
  }, [focusedStatementId, items])

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    if (!keyword) return items || []
    return (items || []).filter(item =>
      item.no.toLowerCase().includes(keyword)
      || item.supplier.name.toLowerCase().includes(keyword)
      || item.supplier.no.toLowerCase().includes(keyword))
  }, [items, query])

  const summary = useMemo(() => (items || []).reduce((result, item) => ({
    confirmed: result.confirmed + (item.status === 'CONFIRMED' ? 1 : 0),
    locked: result.locked + (['LOCKED', 'INVOICED', 'PAID'].includes(item.status) ? 1 : 0),
    payable: item.status === 'CONFIRMED' ? sumSettlementAmounts([result.payable, item.payableAmount]) : result.payable,
  }), { confirmed: 0, locked: 0, payable: '0.0000' }), [items])

  async function lockStatement(statement: Statement) {
    if (!(await confirmDialog(`确认锁定对账单 ${statement.no}？锁定后本期金额不能再修改。`))) return
    setWorking(statement.id)
    setError(null)
    setNotice(null)
    try {
      await apiFetch(`/api/upstream/settlement-statements/${statement.id}/lock`, { method: 'POST' })
      setNotice(`${statement.no} 已由财务锁定`)
      await load()
    } catch (reason: any) {
      setError(reason?.message || '锁定失败')
    } finally {
      setWorking(null)
    }
  }

  return (
    <div className="min-h-screen bg-bg">
      <FinanceTopNav />
      <main className="mx-auto max-w-[1440px] px-6 py-6">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-h1">上游采购对账</h1>
            <p className="mt-1 text-caption text-gray3">供应链生成 → 供应商确认 → 财务复核并锁定</p>
          </div>
          <div className="flex gap-2">
            <input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索供应商 / 对账单号" className="w-72 rounded-cta border border-border bg-white px-3 py-2 text-button" />
            <button onClick={() => void load()} disabled={loading} className="rounded-cta border border-border bg-white px-4 py-2 text-button disabled:opacity-40">刷新</button>
          </div>
        </div>

        {error && <div className="mb-4 rounded-card bg-red-bg p-3 text-caption text-red-fg">{error}</div>}
        {notice && <div className="mb-4 rounded-card bg-green-bg p-3 text-caption text-green-fg">{notice}</div>}

        <section className="mb-4 grid gap-3 sm:grid-cols-3">
          <Stat label="待财务锁定" value={items ? `${summary.confirmed} 单` : '—'} danger={summary.confirmed > 0} />
          <Stat label="待锁定应付" value={items ? money(summary.payable) : '—'} danger={summary.confirmed > 0} />
          <Stat label="已锁定/已开票" value={items ? `${summary.locked} 单` : '—'} />
        </section>

        <section className="overflow-hidden rounded-card border border-border bg-white">
          <table className="w-full min-w-[980px]">
            <thead className="bg-bg/50 text-left text-micro text-gray3">
              <tr>
                <th className="px-4 py-3 font-normal">对账单</th>
                <th className="px-4 py-3 font-normal">供应商</th>
                <th className="px-4 py-3 font-normal">结算周期</th>
                <th className="px-4 py-3 text-right font-normal">收货金额</th>
                <th className="px-4 py-3 text-right font-normal">差异扣款</th>
                <th className="px-4 py-3 text-right font-normal">应付</th>
                <th className="px-4 py-3 font-normal">状态</th>
                <th className="px-4 py-3 text-right font-normal">操作</th>
              </tr>
            </thead>
            <tbody>
              {items === null && <tr><td colSpan={8} className="px-4 py-10 text-center text-caption text-gray3">{error ? '加载失败，请刷新重试' : '加载中…'}</td></tr>}
              {items !== null && filtered.length === 0 && <tr><td colSpan={8} className="px-4 py-10 text-center text-caption text-gray3">暂无上游采购对账单</td></tr>}
              {filtered.map(item => <tr id={`settlement-${item.id}`} key={item.id} className={`border-t border-border hover:bg-[#FAF8F2] ${focusedStatementId === item.id ? 'bg-amber/10 ring-1 ring-inset ring-amber/40' : ''}`}>
                <td className="px-4 py-3"><b className="font-num text-body">{item.no}</b><div className="text-micro text-gray3">V{item.version} · {item._count.lines} 条</div></td>
                <td className="px-4 py-3 text-caption">{item.supplier.name}<div className="text-micro text-gray3">{item.supplier.no}</div></td>
                <td className="px-4 py-3 font-num text-caption">{shortDate(item.periodStart)}—{shortDate(item.periodEnd)}</td>
                <td className="px-4 py-3 text-right font-num text-caption">{money(item.receiptAmount)}</td>
                <td className="px-4 py-3 text-right font-num text-caption text-red-fg">{money(item.deductionAmount)}</td>
                <td className="px-4 py-3 text-right font-num text-body">{money(item.payableAmount)}</td>
                <td className="px-4 py-3"><span className={`rounded-full px-2.5 py-1 text-micro ${statusTone(item.status)}`}>{UPSTREAM_SETTLEMENT_STATUS_LABEL[item.status] || item.status}</span></td>
                <td className="px-4 py-3 text-right">{item.status === 'CONFIRMED'
                  ? <button onClick={() => void lockStatement(item)} disabled={working === item.id} className="rounded-cta bg-ink px-4 py-2 text-button text-white disabled:opacity-40">{working === item.id ? '锁定中…' : '复核并锁定'}</button>
                  : <span className="text-micro text-gray3">{item.status === 'SENT_TO_SUPPLIER' ? '等待供应商确认' : '—'}</span>}</td>
              </tr>)}
            </tbody>
          </table>
        </section>
      </main>
    </div>
  )
}

function Stat({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return <div className="rounded-card border border-border bg-white p-4"><div className="text-caption text-gray3">{label}</div><div className={`mt-1 text-h2 font-num ${danger ? 'text-red-fg' : 'text-ink'}`}>{value}</div></div>
}
