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
import { useEffect, useMemo, useState } from 'react'
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

type WizardData = {
  pendingApproval: number       // 待审付款申请
  costCheckRemaining: number    // 待 4 方核对完毕
  pendingInvoice: number        // 已付未开票 (信息备查, 不阻塞关账)
  pettyCashReconciling: number  // 备用金待财务关账
  payrollDraftCount: number     // 工资单 DRAFT/APPROVED 未发
  voucherDraftCount: number     // 凭证草稿数
}

export default function FinancePCPeriodClosePage() {
  const [periods, setPeriods] = useState<Period[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [closeFor, setCloseFor] = useState<string | null>(null)
  const [reopenFor, setReopenFor] = useState<Period | null>(null)
  const [closeNote, setCloseNote] = useState('')
  const [reopenNote, setReopenNote] = useState('')
  const [preview, setPreview] = useState<any | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [wizard, setWizard] = useState<WizardData | null>(null)
  const currentMonth = dayjs().subtract(1, 'month').format('YYYY-MM')   // 默认聚焦上个月 (实际要关账的月)

  function load() {
    apiFetch<Period[]>('/api/vouchers/periods')
      .then(setPeriods).catch(e => setError(e.message))
  }
  useEffect(() => { load() }, [])

  // 关账前清单数据 (并发拉)
  useEffect(() => {
    const monthFrom = `${currentMonth}-01`
    const monthTo = dayjs(currentMonth + '-01').endOf('month').format('YYYY-MM-DD')
    Promise.all([
      apiFetch<{ total: number }>('/api/payment-requests?status=PENDING&pageSize=1').catch(() => ({ total: 0 })),
      apiFetch<any>(`/api/finance/cost-check?month=${currentMonth}`).catch(() => ({ total: { count: 0, allVerifiedCount: 0 } })),
      apiFetch<any>('/api/invoices/pending-from-finance').catch(() => ({ summary: { paidCount: 0 } })),
      apiFetch<any[]>(`/api/petty-cash?status=RECONCILING`).catch(() => []),
      apiFetch<any[]>(`/api/payroll?month=${currentMonth}`).catch(() => []),
      apiFetch<{ items: any[] }>(`/api/vouchers?from=${monthFrom}&to=${monthTo}&status=DRAFT&pageSize=200`).catch(() => ({ items: [] })),
    ]).then(([pr, cc, pInv, pcRec, pr2, vou]) => {
      setWizard({
        pendingApproval: pr.total || 0,
        costCheckRemaining: cc.total ? (cc.total.count - cc.total.allVerifiedCount) : 0,
        pendingInvoice: pInv.summary?.paidCount || 0,
        pettyCashReconciling: Array.isArray(pcRec) ? pcRec.length : 0,
        payrollDraftCount: Array.isArray(pr2) ? pr2.filter((p: any) => ['DRAFT', 'APPROVED'].includes(p.status)).length : 0,
        voucherDraftCount: vou.items?.length || 0,
      })
    }).catch(() => {})
  }, [currentMonth])

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

  async function loadPreview(month: string, includeDraft = false) {
    setPreview(null); setPreviewLoading(true)
    try {
      const url = `/api/vouchers/periods/preview?month=${month}${includeDraft ? '&includeDraft=1' : ''}`
      const p = await apiFetch<any>(url)
      setPreview({ ...p, _month: month })
    } catch (e: any) { alert(e.message || '预览失败') }
    finally { setPreviewLoading(false) }
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

        {/* 关账前清单 wizard (聚焦上月 = 实际要关账的月) */}
        <section className="bg-white rounded-card border border-border p-4 mb-4">
          <header className="flex items-center justify-between mb-3">
            <div>
              <h2 className="text-h2">{currentMonth} 关账前清单</h2>
              <p className="text-caption text-gray3">完成下方 6 项再关账, 避免数据缺失或对账错位</p>
            </div>
            {wizard && (() => {
              const blockers = [
                wizard.pendingApproval,
                wizard.costCheckRemaining,
                wizard.pettyCashReconciling,
                wizard.payrollDraftCount,
                wizard.voucherDraftCount,
              ].filter(n => n > 0).length
              return (
                <div className="text-right">
                  <div className="text-h2 font-num">{5 - blockers} / 5</div>
                  <div className="text-micro text-gray3">已完成 (待开票不阻塞)</div>
                </div>
              )
            })()}
          </header>
          <div className="grid grid-cols-3 gap-2">
            <WizardCheck title="① 报销/付款审批" count={wizard?.pendingApproval}
                         href="/v2/finance-pc/payment-requests" hint="待审单数" required />
            <WizardCheck title="② 入库 4 方核对" count={wizard?.costCheckRemaining}
                         href="/v2/finance-pc/cost-check" hint="未对账完笔数" required />
            <WizardCheck title="③ 待开票跟踪" count={wizard?.pendingInvoice}
                         href="/v2/finance-pc/invoices-pending" hint="已付未开张数" optional />
            <WizardCheck title="④ 备用金归档" count={wizard?.pettyCashReconciling}
                         href="/v2/finance-pc/petty-cash" hint="待财务关账笔数" required />
            <WizardCheck title="⑤ 工资发放" count={wizard?.payrollDraftCount}
                         href="/v2/finance-pc/payroll" hint="未发放工资单数" required />
            <WizardCheck title="⑥ 本月凭证" count={wizard?.voucherDraftCount}
                         href="/v2/finance-pc/vouchers" hint="草稿数 (需 POSTED)" required />
          </div>
          <div className="mt-3 text-caption text-gray3">
            📌 红色 = 待办, 绿色 = 已完成 / 灰色 = 可选 · 6 项做完才点 "关账"
          </div>
        </section>

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
                      <button onClick={() => loadPreview(m)} disabled={busy}
                              className="px-3 py-1.5 bg-white border border-border text-gray2 rounded-cta text-button disabled:opacity-40">预览结转</button>
                      {isOpenable && (
                        <button onClick={() => setCloseFor(m)}
                                disabled={busy}
                                className="ml-2 px-3 py-1.5 bg-red text-white rounded-cta text-button disabled:opacity-40">关账</button>
                      )}
                      {isClosed && p && (
                        <button onClick={() => setReopenFor(p)} disabled={busy}
                                className="ml-2 px-3 py-1.5 bg-white border border-border text-gray2 rounded-cta text-button disabled:opacity-40">重开</button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </main>

      {/* 预览结转 drawer (dry-run, 不落库) */}
      {(preview || previewLoading) && (
        <div className="fixed inset-0 z-50" onClick={() => { setPreview(null) }}>
          <div className="absolute inset-0 bg-ink/40" />
          <div className="absolute right-0 top-0 bottom-0 w-[640px] bg-white shadow-xl overflow-auto" onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 border-b border-border flex items-center justify-between sticky top-0 bg-white">
              <h3 className="text-h2">期末结转预览 {preview?.month}</h3>
              <button onClick={() => setPreview(null)} className="text-h2 text-gray3">×</button>
            </div>
            <div className="px-6 py-4 space-y-4">
              {previewLoading && <div className="text-center py-12 text-caption text-gray3">加载中…</div>}
              {preview && (
                <>
                  <div className={`rounded-card border p-3 text-caption ${preview.balanced ? 'bg-green-bg/30 border-green/30 text-green-fg' : 'bg-red-bg/30 border-red/30 text-red-fg'}`}>
                    {preview.balanced ? '✓ 借贷平账' : '✗ 不平!'} · 借 ¥{preview.totalDebit.toFixed(2)} {preview.balanced ? '=' : '≠'} 贷 ¥{preview.totalCredit.toFixed(2)}
                    {preview.includedDraft && <span className="ml-2 text-amber-fg">(含 DRAFT, 假设全 POST 场景)</span>}
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => loadPreview(preview._month, false)}
                            className={`px-3 py-1.5 rounded-cta text-button ${!preview.includedDraft ? 'bg-ink text-white' : 'bg-white border border-border text-gray2'}`}>
                      仅 POSTED
                    </button>
                    <button onClick={() => loadPreview(preview._month, true)}
                            className={`px-3 py-1.5 rounded-cta text-button ${preview.includedDraft ? 'bg-amber text-white' : 'bg-white border border-border text-gray2'}`}>
                      含 DRAFT (预演)
                    </button>
                  </div>
                  <div className="bg-bg-warm rounded-card border border-border p-3">
                    <div className="text-micro text-gray3">本月净利</div>
                    <div className={`text-h1 font-num ${preview.profitNet < 0 ? 'text-red-fg' : 'text-green-fg'}`}>
                      ¥{preview.profitNet.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </div>
                    <div className="text-micro text-gray3 mt-1">结转目标科目: {preview.profitAccount.code} {preview.profitAccount.name}</div>
                  </div>
                  <div>
                    <div className="text-h2 mb-2">损益归集 ({preview.buckets.filter((b: any) => Math.abs(b.net) > 0.01).length} 个 bucket)</div>
                    {preview.buckets.filter((b: any) => Math.abs(b.net) > 0.01).map((b: any) => (
                      <div key={b.key} className="flex items-center justify-between py-1.5 border-b border-border text-caption">
                        <div>
                          <span className={b.side === 'revenue' ? 'text-green-fg' : 'text-amber-fg'}>{b.name}</span>
                          <span className="text-micro text-gray3 ml-1">[{b.prefixesHit.join(',') || '—'}]</span>
                        </div>
                        <span className={`font-num ${b.net < 0 ? 'text-red-fg' : ''}`}>{b.side === 'revenue' ? '收入' : '费用'} ¥{b.net.toFixed(2)}</span>
                      </div>
                    ))}
                    {preview.buckets.filter((b: any) => Math.abs(b.net) > 0.01).length === 0 && (
                      <div className="text-caption text-gray3 py-4 text-center">本月无可结转损益 (无 POSTED 凭证涉及 5xxx/6xxx 损益类科目)</div>
                    )}
                  </div>
                  {preview.entries.length > 0 && (
                    <div>
                      <div className="text-h2 mb-2">将生成的分录 ({preview.entries.length} 行)</div>
                      <table className="w-full">
                        <thead className="bg-bg/40">
                          <tr className="text-micro text-gray3 text-left">
                            <th className="px-2 py-1.5 font-normal">科目</th>
                            <th className="px-2 py-1.5 font-normal text-right">借</th>
                            <th className="px-2 py-1.5 font-normal text-right">贷</th>
                          </tr>
                        </thead>
                        <tbody>
                          {preview.entries.map((e: any, i: number) => (
                            <tr key={i} className="border-t border-border">
                              <td className="px-2 py-1.5 text-caption"><span className="font-num text-gray3">{e.accountCode}</span> {e.accountName}</td>
                              <td className="px-2 py-1.5 text-right font-num text-caption">{e.debit > 0 ? `¥${e.debit.toFixed(2)}` : ''}</td>
                              <td className="px-2 py-1.5 text-right font-num text-caption">{e.credit > 0 ? `¥${e.credit.toFixed(2)}` : ''}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <div className="bg-amber/10 rounded-card p-3 text-caption text-gray2">
                    💡 这是 dry-run 预览, 没落库. 真关账请点列表里的 "关账" 按钮.
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

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

function WizardCheck({ title, count, href, hint, required, optional }: {
  title: string
  count?: number
  href: string
  hint: string
  required?: boolean
  optional?: boolean
}) {
  const loading = count === undefined
  const done = !loading && count === 0
  const cls = loading ? 'bg-bg border-border'
    : done ? 'bg-green-bg/40 border-green/30'
    : optional ? 'bg-bg border-border'
    : 'bg-red-bg/30 border-red/30'
  return (
    <a href={href}
       className={`flex items-start gap-3 p-3 rounded-card border transition hover:bg-white ${cls}`}>
      <span className={`w-7 h-7 rounded-full shrink-0 flex items-center justify-center text-button ${
        loading ? 'bg-bg text-gray3'
        : done ? 'bg-green-bg text-green-fg'
        : optional ? 'bg-bg text-gray2'
        : 'bg-red-bg text-red-fg'
      }`}>{loading ? '·' : done ? '✓' : count}</span>
      <div className="flex-1 min-w-0">
        <div className="text-button text-ink">{title}</div>
        <p className="text-micro text-gray3 mt-0.5">
          {loading ? '加载中…' : done ? '已完成' : `${hint}: ${count}`}
        </p>
      </div>
    </a>
  )
}
