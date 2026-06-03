/**
 * 财务 PC Web · 会计凭证列表
 *
 * Phase 3 P0 — 月结时财务最高频使用页面.
 * 接 /api/vouchers?from&to&status&pageSize=500
 *
 * PC 端 UX vs 手机:
 *   - 表格 (一屏 50+ 行) vs 手机卡片
 *   - 批量勾选 + sticky 底栏 + 全选/取消全选
 *   - 顶部: 月份选择 + 状态 tabs + Hero 统计 + 一键导出 Excel
 *   - 单条点击跳详情页 (不开 drawer, 因为详情信息密度大)
 *   - 批量过账 (POSTED), 一键审本月草稿, 单条快捷操作
 */
'use client'
import { useEffect, useMemo, useState } from 'react'
import dayjs from 'dayjs'
import { Chip, MonthPicker } from '@/components/v2'
import { apiFetch, getToken } from '@/lib/v2-auth'
import FinanceTopNav from '../_topnav'

type Entry = {
  id: string; lineNo: number; summary: string
  accountCode: string; accountName: string
  debit: string; credit: string
}
type Voucher = {
  id: string; no: string; date: string; word: string; summary: string
  sourceType?: string | null
  totalDebit: string; totalCredit: string
  status: 'DRAFT' | 'POSTED' | 'VOIDED'
  postedAt?: string | null
  exportedAt?: string | null
  entries: Entry[]
}

const STATUS_LABEL: Record<string, string> = { DRAFT: '草稿', POSTED: '已审', VOIDED: '已作废' }
const SOURCE_LABEL: Record<string, string> = {
  Receipt: '收货', Payment: '付款', LossClaim: '报损', Revenue: '营业额',
  CapitalExpense: '资本支出', InvoicePayment: '发票付款', CmbInternalTransfer: '内部转账',
  PaymentSchedule: '账期付款', Manual: '手工',
}

const fmtMoney = (n: number) => `¥${Math.round(n).toLocaleString()}`
const fmtMoney2 = (n: number) => `¥${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export default function FinancePCVouchersPage() {
  const [month, setMonth] = useState(() => dayjs().format('YYYY-MM'))
  const [status, setStatus] = useState<'ALL' | 'DRAFT' | 'POSTED' | 'VOIDED'>('ALL')
  const [data, setData] = useState<Voucher[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')

  async function reload() {
    setError(null)
    setData(null)
    setSelected(new Set())
    const from = dayjs(month + '-01').startOf('month').format('YYYY-MM-DD')
    const to = dayjs(month + '-01').endOf('month').format('YYYY-MM-DD')
    try {
      const r = await apiFetch<{ items: Voucher[] }>(`/api/vouchers?from=${from}&to=${to}&status=${status}&pageSize=500`)
      setData(r.items || [])
    } catch (e: any) {
      setError(e.message || String(e))
    }
  }
  useEffect(() => { reload() }, [month, status])

  const list = data || []

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return list
    return list.filter(v =>
      v.no?.toLowerCase().includes(q) ||
      v.summary?.toLowerCase().includes(q) ||
      v.entries.some(e => e.accountCode.includes(q) || e.accountName.toLowerCase().includes(q))
    )
  }, [list, search])

  const stats = useMemo(() => {
    const total = list.length
    const draft = list.filter(v => v.status === 'DRAFT').length
    const posted = list.filter(v => v.status === 'POSTED').length
    const voided = list.filter(v => v.status === 'VOIDED').length
    const exported = list.filter(v => v.exportedAt).length
    const sumDebit = list.reduce((s, v) => s + Number(v.totalDebit), 0)
    return { total, draft, posted, voided, exported, sumDebit }
  }, [list])

  async function postOne(id: string) {
    setBusy(true)
    try {
      await apiFetch(`/api/vouchers/${id}/post`, { method: 'PATCH' })
      await reload()
    } catch (e: any) { alert(e.message) } finally { setBusy(false) }
  }

  async function postSelected() {
    const ids = Array.from(selected)
    if (ids.length === 0) return
    if (!confirm(`确定审核选中的 ${ids.length} 笔凭证?`)) return
    setBusy(true)
    let ok = 0, fail = 0
    const failMsg: string[] = []
    for (const id of ids) {
      const v = list.find(x => x.id === id)
      if (v?.status !== 'DRAFT') continue
      try {
        await apiFetch(`/api/vouchers/${id}/post`, { method: 'PATCH' })
        ok++
      } catch (e: any) {
        fail++
        failMsg.push(`${v.no}: ${e?.message || e}`)
      }
    }
    setBusy(false)
    if (fail > 0) alert(`✓ ${ok} 笔, ✗ ${fail} 笔失败:\n${failMsg.slice(0, 3).join('\n')}`)
    await reload()
  }

  async function postAllDraft() {
    if (stats.draft === 0) return
    if (!confirm(`确定一键审核本月全部 ${stats.draft} 笔草稿?`)) return
    setBusy(true)
    let ok = 0, fail = 0
    for (const v of list.filter(v => v.status === 'DRAFT')) {
      try {
        await apiFetch(`/api/vouchers/${v.id}/post`, { method: 'PATCH' })
        ok++
      } catch { fail++ }
    }
    setBusy(false)
    if (fail > 0) alert(`✓ ${ok} 笔, ✗ ${fail} 笔失败 (查看草稿状态自查)`)
    await reload()
  }

  async function exportExcel(scope: 'all' | 'posted') {
    const from = dayjs(month + '-01').startOf('month').format('YYYY-MM-DD')
    const to = dayjs(month + '-01').endOf('month').format('YYYY-MM-DD')
    const params = new URLSearchParams({ from, to, status: scope === 'posted' ? 'POSTED' : 'ALL' })
    const token = getToken()
    setBusy(true)
    try {
      const res = await fetch(`/api/vouchers/export?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) { alert('导出失败 ' + res.status); return }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `凭证_${month}_${scope === 'posted' ? '已审' : '全部'}.xlsx`
      a.click()
      URL.revokeObjectURL(url)
      await reload()
    } finally { setBusy(false) }
  }

  const allVisibleDraftSelected = filtered.filter(v => v.status === 'DRAFT').every(v => selected.has(v.id)) && filtered.some(v => v.status === 'DRAFT')
  const someSelected = !allVisibleDraftSelected && filtered.some(v => v.status === 'DRAFT' && selected.has(v.id))

  function toggleSelectAll() {
    if (allVisibleDraftSelected) setSelected(new Set())
    else setSelected(new Set(filtered.filter(v => v.status === 'DRAFT').map(v => v.id)))
  }

  function toggleOne(id: string) {
    const s = new Set(selected)
    if (s.has(id)) s.delete(id); else s.add(id)
    setSelected(s)
  }

  return (
    <div className="min-h-screen bg-bg">
      <FinanceTopNav />
      <main className="max-w-[1440px] mx-auto px-6 py-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-h1">会计凭证</h1>
            <p className="text-caption text-gray3">自动生成 · 一键导好会计 Excel · 月结主战场</p>
          </div>
          <div className="flex items-center gap-3">
            <MonthPicker value={month} onChange={v => setMonth(v || dayjs().format('YYYY-MM'))} />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="搜索 (凭证号 / 摘要 / 科目)"
              className="px-3 py-2 rounded-cta border border-border bg-white text-button w-64"
            />
            <button onClick={() => exportExcel('posted')} disabled={busy || stats.posted === 0}
                    className="px-4 py-2 bg-ink text-white rounded-cta text-button disabled:opacity-40">
              导出已审 ({stats.posted})
            </button>
          </div>
        </div>

        {error && (
          <div className="bg-red-bg text-red-fg rounded-card p-3 text-caption mb-4">{error}</div>
        )}

        {/* Hero 4 卡 */}
        <div className="grid grid-cols-4 gap-3 mb-4">
          <Stat label="本月凭证" value={String(stats.total)} unit="笔" />
          <Stat label="借方合计" value={fmtMoney2(stats.sumDebit)} />
          <Stat label="草稿待审" value={String(stats.draft)} unit="笔" tone={stats.draft > 0 ? 'red' : 'gray'} />
          <Stat label="已导出" value={String(stats.exported)} unit="笔" tone="green" />
        </div>

        {/* 状态 tabs */}
        <div className="flex gap-2 mb-3 flex-wrap">
          {(['ALL', 'DRAFT', 'POSTED', 'VOIDED'] as const).map(s => (
            <button key={s} onClick={() => setStatus(s)}
              className={`px-3 py-1.5 rounded-cta text-button ${status === s ? 'bg-ink text-white' : 'bg-white border border-border text-gray2'}`}>
              {s === 'ALL' ? `全部 ${stats.total}` : `${STATUS_LABEL[s]} ${s === 'DRAFT' ? stats.draft : s === 'POSTED' ? stats.posted : stats.voided}`}
            </button>
          ))}
          {stats.draft > 0 && (
            <button onClick={postAllDraft} disabled={busy}
              className="ml-auto px-3 py-1.5 bg-amber/10 text-amber-fg rounded-cta text-button disabled:opacity-40">
              ⚡ 一键审本月全部草稿 ({stats.draft})
            </button>
          )}
        </div>

        {/* 表格 */}
        <div className="bg-white rounded-card border border-border overflow-hidden">
          <table className="w-full">
            <thead className="bg-bg/40">
              <tr className="text-micro text-gray3 text-left">
                <th className="px-3 py-2 w-10">
                  <input
                    type="checkbox"
                    checked={allVisibleDraftSelected}
                    ref={el => { if (el) el.indeterminate = someSelected }}
                    onChange={toggleSelectAll}
                  />
                </th>
                <th className="px-3 py-2 font-normal w-40">凭证号 / 日期</th>
                <th className="px-3 py-2 font-normal">摘要 / 分录</th>
                <th className="px-3 py-2 font-normal text-right w-32">借/贷合计</th>
                <th className="px-3 py-2 font-normal w-24">状态</th>
                <th className="px-3 py-2 font-normal text-right w-28">操作</th>
              </tr>
            </thead>
            <tbody>
              {data === null && (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-caption text-gray3">加载中…</td></tr>
              )}
              {data !== null && filtered.length === 0 && (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-caption text-gray3">
                  {search ? '无匹配凭证' : status === 'ALL' ? '本月暂无凭证' : `本月暂无${STATUS_LABEL[status]}凭证`}
                </td></tr>
              )}
              {filtered.map(v => {
                const tone = v.status === 'POSTED' ? 'green' : v.status === 'VOIDED' ? 'gray' : 'red'
                const isSelected = selected.has(v.id)
                const balanced = Math.abs(Number(v.totalDebit) - Number(v.totalCredit)) < 0.01
                return (
                  <tr key={v.id} className={`border-t border-border hover:bg-[#FAF8F2] ${isSelected ? 'bg-amber/5' : ''} ${!balanced ? 'bg-red-bg/30' : ''}`}>
                    <td className="px-3 py-2.5">
                      {v.status === 'DRAFT' && (
                        <input type="checkbox" checked={isSelected} onChange={() => toggleOne(v.id)} />
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="text-body font-num">{v.no}</div>
                      <div className="text-micro text-gray3">{dayjs(v.date).format('MM/DD')}</div>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="text-body truncate">{v.summary}</div>
                      <div className="text-micro text-gray3 truncate flex items-center gap-1 flex-wrap">
                        {v.sourceType && <Chip tone="amber">{SOURCE_LABEL[v.sourceType] || v.sourceType}</Chip>}
                        {v.entries.slice(0, 2).map((e, i) => (
                          <span key={i}>{e.accountCode} {e.accountName} {Number(e.debit) > 0 ? '借' : '贷'} ¥{(Number(e.debit) || Number(e.credit)).toFixed(2)}</span>
                        )).reduce((acc: any[], cur, i) => i === 0 ? [cur] : [...acc, ' · ', cur], [])}
                        {v.entries.length > 2 && <span className="text-gray3">…{v.entries.length} 行</span>}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 font-num text-right">
                      <div>{fmtMoney(Number(v.totalDebit))}</div>
                      {!balanced && <div className="text-micro text-red-fg">不平!</div>}
                    </td>
                    <td className="px-3 py-2.5">
                      <Chip tone={tone as any}>{STATUS_LABEL[v.status]}</Chip>
                      {v.exportedAt && <div className="mt-0.5"><Chip tone="gray">已导</Chip></div>}
                    </td>
                    <td className="px-3 py-2.5 text-right whitespace-nowrap">
                      <a href={`/v2/finance-pc/vouchers/${v.id}`}
                        className="px-2 py-1 text-caption text-gray2 hover:text-ink">详情</a>
                      {v.status === 'DRAFT' && (
                        <button
                          onClick={() => postOne(v.id)}
                          disabled={busy}
                          className="ml-1 px-3 py-1.5 bg-ink text-white rounded-cta text-button disabled:opacity-40">
                          审核
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {/* 批量底栏 (有选中时才显示) */}
        {selected.size > 0 && (
          <div className="mt-3 sticky bottom-3 bg-white rounded-cta border border-border px-4 py-3 flex items-center justify-between shadow-fab">
            <span className="text-caption text-gray2">
              已选 {selected.size} 笔 · 仅"草稿"凭证会被审核
            </span>
            <div className="flex gap-2">
              <button onClick={() => setSelected(new Set())}
                className="px-3 py-2 bg-white border border-border text-gray2 rounded-cta text-button">
                取消选择
              </button>
              <button onClick={postSelected} disabled={busy}
                className="px-4 py-2 bg-ink text-white rounded-cta text-button disabled:opacity-40">
                {busy ? '处理中…' : `批量审核 (${selected.size})`}
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}

function Stat({ label, value, unit, tone = 'default' }: { label: string; value: string; unit?: string; tone?: 'default' | 'red' | 'green' | 'gray' }) {
  const cls = tone === 'red' ? 'text-red-fg' : tone === 'green' ? 'text-green-fg' : tone === 'gray' ? 'text-gray3' : ''
  return (
    <div className="bg-white rounded-card border border-border p-3">
      <div className="text-micro text-gray3">{label}</div>
      <div className={`text-h1 font-num mt-0.5 ${cls}`}>
        {value}
        {unit && <span className="text-caption text-gray3 ml-1">{unit}</span>}
      </div>
    </div>
  )
}
