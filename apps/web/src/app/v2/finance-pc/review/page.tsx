/**
 * 财务 PC Web · 初审 Tab
 * 2026-06-02 Phase 2 改造: 接真 API
 *
 * 数据源: /api/payment-requests?status=PENDING (Document.type='PAYMENT_REQUEST' + status='PENDING')
 * 单条审批: POST /api/documents/:id/decisions { decision, comment }
 * 批量审批: 前端勾选后 loop 调上面接口
 *
 * 单店业务 (合肥瑶海店) 不做门店 filter, 只搜索 + 批量勾选 + 批量过
 */
'use client'
import { useEffect, useMemo, useState } from 'react'
import { Chip } from '@/components/v2'
import { apiFetch } from '@/lib/v2-auth'
import dayjs from 'dayjs'
import FinanceTopNav from '../_topnav'

type Doc = {
  id: string; no: string; type: string; title: string
  amount?: string | number | null
  status: string; createdAt: string
  initiator?: { name: string } | null
  store?: { name: string } | null
  isOverThreshold?: boolean
  thresholdRule?: string | null
  payload?: any
}

const fmtMoney = (n: number) => `¥${Math.round(n).toLocaleString()}`

export default function FinancePCReviewPage() {
  const [items, setItems] = useState<Doc[] | null>(null)
  const [total, setTotal] = useState(0)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    apiFetch<{ items: Doc[]; total: number }>('/api/payment-requests?status=PENDING&pageSize=100')
      .then(d => { setItems(d.items || []); setTotal(d.total || 0); setSelected(new Set()) })
      .catch(e => setError(String(e?.message || e)))
  }, [refreshKey])

  const filtered = useMemo(() => {
    if (!items) return []
    const q = search.trim().toLowerCase()
    if (!q) return items
    return items.filter(i =>
      i.title?.toLowerCase().includes(q) ||
      i.no?.toLowerCase().includes(q) ||
      i.initiator?.name?.toLowerCase().includes(q)
    )
  }, [items, search])

  const allSelected = filtered.length > 0 && filtered.every(i => selected.has(i.id))
  const someSelected = !allSelected && filtered.some(i => selected.has(i.id))
  const selectedSum = filtered.filter(i => selected.has(i.id)).reduce((s, i) => s + Number(i.amount || 0), 0)

  const toggleOne = (id: string) => {
    const s = new Set(selected)
    if (s.has(id)) s.delete(id); else s.add(id)
    setSelected(s)
  }
  const toggleAll = () => {
    if (allSelected) setSelected(new Set())
    else setSelected(new Set(filtered.map(i => i.id)))
  }

  async function bulkApprove() {
    if (selected.size === 0 || submitting) return
    if (!confirm(`确认批量通过 ${selected.size} 单 (合计 ${fmtMoney(selectedSum)})?`)) return
    setSubmitting(true)
    setError(null)
    const ids = Array.from(selected)
    let ok = 0, fail = 0
    const failMsg: string[] = []
    // 串行 (避免并发太多), 100 个上限不会太久
    for (const id of ids) {
      try {
        await apiFetch(`/api/documents/${id}/decisions`, {
          method: 'POST',
          body: JSON.stringify({ decision: 'APPROVE', comment: 'PC 批量初审通过' }),
        })
        ok++
      } catch (e: any) {
        fail++
        failMsg.push(`${id.slice(-8)}: ${e?.message || e}`)
      }
    }
    setSubmitting(false)
    setSelected(new Set())
    setRefreshKey(k => k + 1)
    if (fail > 0) setError(`通过 ${ok} 单, 失败 ${fail} 单. 失败原因: ${failMsg.slice(0, 3).join(' | ')}`)
  }

  async function singleDecision(id: string, decision: 'APPROVE' | 'REJECT') {
    let comment = ''
    if (decision === 'REJECT') {
      const reason = window.prompt('请填写驳回原因:')
      if (!reason?.trim()) return
      comment = reason.trim()
    }
    setSubmitting(true)
    try {
      await apiFetch(`/api/documents/${id}/decisions`, {
        method: 'POST',
        body: JSON.stringify({ decision, comment }),
      })
      setRefreshKey(k => k + 1)
    } catch (e: any) {
      alert(`${decision === 'APPROVE' ? '通过' : '驳回'} 失败: ${e?.message || e}`)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen bg-bg">
      <FinanceTopNav />
      <main className="max-w-[1440px] mx-auto px-6 py-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-h1">初审</h1>
            <p className="text-caption text-gray3">
              {items === null ? '加载中…' : `${total} 单待初审 · 累计 ${fmtMoney(filtered.reduce((s, i) => s + Number(i.amount || 0), 0))}`}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="px-3 py-2 rounded-cta border border-border bg-white text-button w-72"
              placeholder="搜索 (标题 / 单号 / 发起人)"
            />
            <button
              onClick={() => setRefreshKey(k => k + 1)}
              className="px-4 py-2 bg-white border border-border rounded-cta text-button text-gray2">
              ↻ 刷新
            </button>
          </div>
        </div>

        {error && (
          <div className="bg-red-bg text-red-fg rounded-card p-3 text-caption mb-4">{error}</div>
        )}

        <div className="bg-white rounded-card border border-border overflow-hidden">
          <table className="w-full">
            <thead className="bg-bg/40">
              <tr className="text-micro text-gray3 text-left">
                <th className="px-3 py-2 w-10">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    ref={el => { if (el) el.indeterminate = someSelected }}
                    onChange={toggleAll}
                  />
                </th>
                <th className="px-3 py-2 font-normal">单号 / 标题</th>
                <th className="px-3 py-2 font-normal">发起人 / 时间</th>
                <th className="px-3 py-2 font-normal text-right">金额</th>
                <th className="px-3 py-2 font-normal">阈值</th>
                <th className="px-3 py-2 font-normal text-right w-44">操作</th>
              </tr>
            </thead>
            <tbody>
              {items === null && (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-caption text-gray3">加载中…</td></tr>
              )}
              {items !== null && filtered.length === 0 && (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-caption text-gray3">
                  {search ? '无匹配单子' : '✓ 没有待初审单, 一切已处理'}
                </td></tr>
              )}
              {filtered.map(d => {
                const checked = selected.has(d.id)
                const amt = Number(d.amount || 0)
                const overThreshold = !!d.isOverThreshold
                const ageHours = dayjs().diff(d.createdAt, 'hour')
                const stale = ageHours >= 24
                return (
                  <tr
                    key={d.id}
                    className={`border-t border-border hover:bg-[#FAF8F2] ${overThreshold ? 'bg-red-bg/30' : stale ? 'bg-orange-bg/30' : ''}`}
                  >
                    <td className="px-3 py-2">
                      <input type="checkbox" checked={checked} onChange={() => toggleOne(d.id)} />
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="text-micro text-gray3 font-num">{d.no}</div>
                      <div className="text-body">{d.title}</div>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="text-body">{d.initiator?.name || '—'}</div>
                      <div className="text-micro text-gray3">{dayjs(d.createdAt).format('MM/DD HH:mm')} · {ageHours} 小时前</div>
                    </td>
                    <td className="px-3 py-2.5 font-num text-right">{fmtMoney(amt)}</td>
                    <td className="px-3 py-2.5">
                      {overThreshold
                        ? <Chip tone="red">超阈值</Chip>
                        : <Chip tone="green">阈值内</Chip>}
                    </td>
                    <td className="px-3 py-2.5 text-right whitespace-nowrap">
                      <a href={`/v2/finance/payment-requests/${d.id}`} className="px-2 py-1 text-caption text-gray2 hover:text-ink">详情</a>
                      <button
                        onClick={() => singleDecision(d.id, 'REJECT')}
                        disabled={submitting}
                        className="ml-1 px-2 py-1 text-caption text-red-fg hover:bg-red-bg rounded">
                        驳回
                      </button>
                      <button
                        onClick={() => singleDecision(d.id, 'APPROVE')}
                        disabled={submitting}
                        className="ml-1 px-3 py-1.5 bg-ink text-white rounded-cta text-button disabled:opacity-40">
                        通过
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {/* 批量底栏 */}
        <div className="mt-3 sticky bottom-3 bg-white rounded-cta border border-border px-4 py-3 flex items-center justify-between shadow-fab">
          <span className="text-caption text-gray2">
            已选 {selected.size} 单
            {selected.size > 0 && ` · 合计 ${fmtMoney(selectedSum)}`}
            {' · 批量通过会跳过需驳回单子, 失败的会单独提示'}
          </span>
          <button
            onClick={bulkApprove}
            disabled={selected.size === 0 || submitting}
            className="px-4 py-2 bg-ink text-white rounded-cta text-button disabled:opacity-40">
            {submitting ? '处理中…' : `批量通过 (${selected.size})`}
          </button>
        </div>
      </main>
    </div>
  )
}
