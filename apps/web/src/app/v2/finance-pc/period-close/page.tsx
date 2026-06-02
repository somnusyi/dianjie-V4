/**
 * 财务 PC Web · 月结锁账中心
 *
 * Phase 4
 * 接 GET /api/vouchers/periods
 *     POST /api/vouchers/periods/close   {month, closeNote?, withCarryover?}
 *     POST /api/vouchers/periods/reopen  {month, reopenNote}
 *
 * PC UX:
 *   - 表格列出最近 24 个月期间 (OPEN / CLOSED / REOPENED)
 *   - 关账按钮: 自动跑期末结转 (carryover) + 锁定凭证操作
 *   - 重开按钮: 必须填原因 (审计)
 *   - 显示关账人 / 关账时间 / carryover 凭证号
 */
'use client'
import { useEffect, useState } from 'react'
import dayjs from 'dayjs'
import { Chip } from '@/components/v2'
import { apiFetch } from '@/lib/v2-auth'
import FinanceTopNav from '../_topnav'

type Period = {
  id: string
  month: string
  status: 'OPEN' | 'CLOSED' | 'REOPENED'
  closedAt?: string | null
  closedById?: string | null
  closeNote?: string | null
  reopenedAt?: string | null
  reopenedById?: string | null
  reopenNote?: string | null
  carryoverVoucherId?: string | null
  createdAt: string
  updatedAt: string
}

const STATUS_LABEL: Record<string, string> = { OPEN: '未锁', CLOSED: '已关账', REOPENED: '已重开' }
const STATUS_TONE: Record<string, 'green' | 'red' | 'amber'> = {
  OPEN: 'green', CLOSED: 'red', REOPENED: 'amber',
}

export default function FinancePCPeriodClosePage() {
  const [periods, setPeriods] = useState<Period[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [closeFor, setCloseFor] = useState<string | null>(null)
  const [reopenFor, setReopenFor] = useState<Period | null>(null)
  const [closeNote, setCloseNote] = useState('')
  const [reopenNote, setReopenNote] = useState('')

  function load() {
    apiFetch<Period[]>('/api/vouchers/periods')
      .then(setPeriods).catch(e => setError(e.message))
  }
  useEffect(() => { load() }, [])

  // 生成近 12 个月候选 (包含未在 DB 的月份)
  const candidateMonths: string[] = []
  for (let i = 0; i < 12; i++) {
    candidateMonths.push(dayjs().subtract(i, 'month').format('YYYY-MM'))
  }
  const byMonth = new Map<string, Period>()
  periods?.forEach(p => byMonth.set(p.month, p))
  // 合并: 候选月 + DB 中其他更老的 CLOSED 月
  const allMonths = new Set<string>([...candidateMonths])
  periods?.forEach(p => allMonths.add(p.month))
  const sortedMonths = Array.from(allMonths).sort().reverse()

  async function doClose(month: string) {
    if (busy) return
    if (!confirm(`关账 ${month}?\n\n会自动:\n• 生成期末结转凭证 (主营业务收入 → 本年利润)\n• 锁定当月凭证 (不可改/反审/作废)\n\n确认?`)) return
    setBusy(true)
    try {
      const r: any = await apiFetch('/api/vouchers/periods/close', {
        method: 'POST', body: JSON.stringify({ month, closeNote: closeNote || null, withCarryover: true }),
      })
      alert(`✓ ${month} 已关账${r.carryoverVoucherId ? ', 期末结转凭证已生成' : ' (本月无损益, 未生成结转凭证)'}`)
      setCloseFor(null); setCloseNote('')
      load()
    } catch (e: any) { alert(e.message || '关账失败') }
    finally { setBusy(false) }
  }

  async function doReopen() {
    if (!reopenFor || busy) return
    if (!reopenNote.trim()) { alert('请填重开原因 (审计留痕)'); return }
    setBusy(true)
    try {
      await apiFetch('/api/vouchers/periods/reopen', {
        method: 'POST', body: JSON.stringify({ month: reopenFor.month, reopenNote }),
      })
      alert(`✓ ${reopenFor.month} 已重开`)
      setReopenFor(null); setReopenNote('')
      load()
    } catch (e: any) { alert(e.message || '重开失败') }
    finally { setBusy(false) }
  }

  return (
    <div className="min-h-screen bg-bg">
      <FinanceTopNav />
      <main className="max-w-[1440px] mx-auto px-6 py-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-h1">月结锁账中心</h1>
            <p className="text-caption text-gray3">关账后凭证不可改/反审/作废 · 自动跑期末结转 (损益 → 本年利润)</p>
          </div>
          <a href="/v2/finance-pc/reports/tax"
             className="px-3 py-2 bg-white border border-border rounded-cta text-button text-gray2">报税报表 →</a>
        </div>

        {error && <div className="bg-red-bg text-red-fg rounded-card p-3 text-caption mb-4">{error}</div>}

        <div className="bg-amber/10 border border-amber/30 rounded-card p-3 mb-4 text-caption text-gray2">
          📌 关账流程: ① 先确认本月所有凭证已 POSTED (导出过最稳); ② 关账 → 自动期末结转 → 锁; ③ 异常情况只有财务长可重开 (留痕).
        </div>

        <div className="bg-white rounded-card border border-border overflow-hidden">
          <table className="w-full">
            <thead className="bg-bg/40">
              <tr className="text-micro text-gray3 text-left">
                <th className="px-3 py-2 font-normal w-24">月份</th>
                <th className="px-3 py-2 font-normal w-28">状态</th>
                <th className="px-3 py-2 font-normal">关账信息</th>
                <th className="px-3 py-2 font-normal">结转凭证</th>
                <th className="px-3 py-2 font-normal text-right w-48">操作</th>
              </tr>
            </thead>
            <tbody>
              {periods === null && (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-caption text-gray3">加载中…</td></tr>
              )}
              {sortedMonths.map(m => {
                const p = byMonth.get(m)
                const status: Period['status'] = p?.status || 'OPEN'
                const isClosed = status === 'CLOSED'
                const isOpenable = status === 'OPEN' || status === 'REOPENED'
                return (
                  <tr key={m} className={`border-t border-border hover:bg-[#FAF8F2] ${isClosed ? 'bg-red-bg/15' : ''}`}>
                    <td className="px-3 py-2.5 font-num font-medium">{m}</td>
                    <td className="px-3 py-2.5"><Chip tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Chip></td>
                    <td className="px-3 py-2.5">
                      {p?.closedAt && (
                        <div className="text-caption text-gray2">
                          关账: {dayjs(p.closedAt).format('YYYY-MM-DD HH:mm')}
                          {p.closeNote && <span className="text-micro text-gray3 ml-2">{p.closeNote}</span>}
                        </div>
                      )}
                      {p?.reopenedAt && (
                        <div className="text-caption text-amber-fg mt-0.5">
                          重开: {dayjs(p.reopenedAt).format('YYYY-MM-DD HH:mm')} - {p.reopenNote}
                        </div>
                      )}
                      {!p && <span className="text-micro text-gray3">未关账</span>}
                    </td>
                    <td className="px-3 py-2.5">
                      {p?.carryoverVoucherId ? (
                        <a href={`/v2/finance-pc/vouchers/${p.carryoverVoucherId}`}
                           className="text-caption text-amber-fg font-num">凭证 #{p.carryoverVoucherId.slice(-8)}</a>
                      ) : <span className="text-micro text-gray3">—</span>}
                    </td>
                    <td className="px-3 py-2.5 text-right whitespace-nowrap">
                      {isOpenable && (
                        <button onClick={() => setCloseFor(m)}
                                disabled={busy}
                                className="px-3 py-1.5 bg-red text-white rounded-cta text-button disabled:opacity-40">关账</button>
                      )}
                      {isClosed && p && (
                        <button onClick={() => setReopenFor(p)} disabled={busy}
                                className="px-3 py-1.5 bg-white border border-border text-gray2 rounded-cta text-button disabled:opacity-40">重开</button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </main>

      {/* 关账 confirm drawer */}
      {closeFor && (
        <div className="fixed inset-0 z-50" onClick={() => !busy && setCloseFor(null)}>
          <div className="absolute inset-0 bg-ink/40" />
          <div className="absolute right-0 top-0 bottom-0 w-[480px] bg-white shadow-xl" onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 border-b border-border flex items-center justify-between">
              <h3 className="text-h2">关账 {closeFor}</h3>
              <button onClick={() => setCloseFor(null)} className="text-h2 text-gray3">×</button>
            </div>
            <div className="px-6 py-4 space-y-3">
              <div className="bg-red-bg/30 border border-red/30 rounded-card p-3 text-caption text-red-fg">
                ⚠ 关账后本月凭证不可改/反审/作废; 业务自动事件会顺延到下月.
              </div>
              <div>
                <label className="text-micro text-gray3 block mb-1">关账备注 (选填)</label>
                <textarea rows={3} value={closeNote} onChange={e => setCloseNote(e.target.value)}
                          placeholder="例: 已与好会计对账完毕, 凭证全部 POSTED 并导出."
                          className="w-full bg-bg rounded-chip px-3 py-2 outline-none text-body resize-none" />
              </div>
              <div className="bg-amber/10 rounded-card p-3 text-caption text-gray2">
                ✓ 关账时自动生成期末结转凭证 (5xxx 损益 → 4103 本年利润)
              </div>
            </div>
            <div className="border-t border-border px-6 py-3 flex gap-3">
              <button onClick={() => setCloseFor(null)} disabled={busy}
                      className="px-4 py-3 bg-white border border-border rounded-cta text-button text-gray2">取消</button>
              <button onClick={() => doClose(closeFor)} disabled={busy}
                      className="flex-1 py-3 bg-red text-white rounded-cta text-button disabled:opacity-40">
                {busy ? '关账中…' : '确认关账'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 重开 drawer */}
      {reopenFor && (
        <div className="fixed inset-0 z-50" onClick={() => !busy && setReopenFor(null)}>
          <div className="absolute inset-0 bg-ink/40" />
          <div className="absolute right-0 top-0 bottom-0 w-[480px] bg-white shadow-xl" onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 border-b border-border flex items-center justify-between">
              <h3 className="text-h2">重开 {reopenFor.month}</h3>
              <button onClick={() => setReopenFor(null)} className="text-h2 text-gray3">×</button>
            </div>
            <div className="px-6 py-4 space-y-3">
              <div className="bg-amber/10 border border-amber/30 rounded-card p-3 text-caption text-gray2">
                ⚠ 审计留痕: 重开操作会记录到 OpLog; 完成调整后请重新关账 (会重生成 carryover).
              </div>
              <div>
                <label className="text-micro text-gray3 block mb-1">重开原因 *</label>
                <textarea rows={4} value={reopenNote} onChange={e => setReopenNote(e.target.value)}
                          placeholder="例: 5/15 一笔报损凭证遗漏, 需补登"
                          className="w-full bg-bg rounded-chip px-3 py-2 outline-none text-body resize-none" />
              </div>
            </div>
            <div className="border-t border-border px-6 py-3 flex gap-3">
              <button onClick={() => setReopenFor(null)} disabled={busy}
                      className="px-4 py-3 bg-white border border-border rounded-cta text-button text-gray2">取消</button>
              <button onClick={doReopen} disabled={busy || !reopenNote.trim()}
                      className="flex-1 py-3 bg-amber text-white rounded-cta text-button disabled:opacity-40">
                {busy ? '提交中…' : '确认重开'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
