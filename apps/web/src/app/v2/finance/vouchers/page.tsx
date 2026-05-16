/**
 * 财务 · 凭证列表
 * - 按月份/状态过滤
 * - 批量审核 / 一键全审
 * - 一键导出当月 Excel (好会计兼容)
 */
'use client'
import { useEffect, useMemo, useState } from 'react'
import dayjs from 'dayjs'
import { Chip } from '@/components/v2'
import { ErrorScreen } from '@/components/v2/use-dashboard'
import { apiFetch, getToken } from '@/lib/v2-auth'

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

const STATUS_LABEL: Record<string, string> = {
  DRAFT: '草稿', POSTED: '已审', VOIDED: '已作废',
}
const SOURCE_LABEL: Record<string, string> = {
  Receipt: '收货', Payment: '付款', LossClaim: '报损', Revenue: '营业额', Manual: '手工',
}

export default function FinanceVouchersPage() {
  const [month, setMonth] = useState(() => dayjs().format('YYYY-MM'))
  const [status, setStatus] = useState<'ALL' | 'DRAFT' | 'POSTED' | 'VOIDED'>('ALL')
  const [data, setData] = useState<Voucher[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  async function reload() {
    setError(null)
    setData(null)
    const from = dayjs(month + '-01').startOf('month').format('YYYY-MM-DD')
    const to = dayjs(month + '-01').endOf('month').format('YYYY-MM-DD')
    try {
      const r = await apiFetch<{ items: Voucher[] }>(`/api/vouchers?from=${from}&to=${to}&status=${status}&pageSize=200`)
      setData(r.items || [])
    } catch (e: any) {
      setError(e.message || String(e))
    }
  }
  useEffect(() => { reload() }, [month, status])

  const list = data || []
  const stats = useMemo(() => {
    const total = list.length
    const draft = list.filter(v => v.status === 'DRAFT').length
    const posted = list.filter(v => v.status === 'POSTED').length
    const sumDebit = list.reduce((s, v) => s + Number(v.totalDebit), 0)
    return { total, draft, posted, sumDebit }
  }, [list])

  async function postOne(id: string) {
    setBusy(true)
    try {
      await apiFetch(`/api/vouchers/${id}/post`, { method: 'PATCH' })
      await reload()
    } catch (e: any) {
      alert(e.message)
    } finally { setBusy(false) }
  }
  async function postAll() {
    if (stats.draft === 0) return
    if (!confirm(`确定批量审核本月 ${stats.draft} 笔草稿凭证吗?`)) return
    setBusy(true)
    try {
      for (const v of list.filter(v => v.status === 'DRAFT')) {
        await apiFetch(`/api/vouchers/${v.id}/post`, { method: 'PATCH' })
      }
      setSelected(new Set())
      await reload()
    } catch (e: any) {
      alert(e.message)
    } finally { setBusy(false) }
  }
  async function postSelected() {
    const ids = Array.from(selected)
    if (ids.length === 0) return
    if (!confirm(`确定审核选中 ${ids.length} 笔凭证?`)) return
    setBusy(true)
    try {
      for (const id of ids) {
        const v = list.find(x => x.id === id)
        if (v?.status === 'DRAFT') {
          await apiFetch(`/api/vouchers/${id}/post`, { method: 'PATCH' })
        }
      }
      setSelected(new Set())
      await reload()
    } catch (e: any) { alert(e.message) } finally { setBusy(false) }
  }
  function toggleSelect(id: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  function selectAllDraft() {
    setSelected(new Set(list.filter(v => v.status === 'DRAFT').map(v => v.id)))
  }
  function clearSelection() { setSelected(new Set()) }
  async function exportExcel(scope: 'all' | 'posted') {
    const from = dayjs(month + '-01').startOf('month').format('YYYY-MM-DD')
    const to = dayjs(month + '-01').endOf('month').format('YYYY-MM-DD')
    const params = new URLSearchParams({ from, to, status: scope === 'posted' ? 'POSTED' : 'ALL' })
    const token = getToken()
    const res = await fetch(`/api/vouchers/export?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) {
      alert('导出失败')
      return
    }
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `凭证_${month}_${scope === 'posted' ? '已审' : '全部'}.xlsx`
    a.click()
    URL.revokeObjectURL(url)
    await reload()  // 刷新已导出时间
  }

  if (error) return <ErrorScreen message={error} />

  return (
    <div className="min-h-screen bg-bg pb-32">
      <header className="px-4 pt-4 pb-2">
        <h1 className="text-h1">会计凭证</h1>
        <p className="text-caption text-gray3">自动生成 · 好会计 Excel 一键导出</p>
      </header>

      {/* 月份 + 状态过滤 */}
      <div className="px-4 mt-3 flex items-center gap-2">
        <input
          type="month"
          value={month}
          onChange={e => setMonth(e.target.value)}
          className="bg-white border border-border rounded-cta px-3 py-1.5 text-body"
        />
        <div className="flex gap-1.5 overflow-x-auto">
          {(['ALL','DRAFT','POSTED','VOIDED'] as const).map(s => (
            <button key={s} onClick={() => setStatus(s)}
                    className={`shrink-0 px-3 py-1.5 rounded-cta text-button ${status === s ? 'bg-ink text-white' : 'bg-white border border-border text-gray2'}`}>
              {s === 'ALL' ? '全部' : STATUS_LABEL[s]}
              {s === 'DRAFT' && stats.draft > 0 && <span className="ml-1 font-num">{stats.draft}</span>}
            </button>
          ))}
        </div>
      </div>

      {/* hero */}
      <div className="mx-4 mt-3 bg-bg-warm rounded-card border border-border p-3 grid grid-cols-3 gap-2">
        <div>
          <div className="text-micro text-gray3">本月凭证</div>
          <div className="text-h2 font-num">{stats.total}<span className="text-caption text-gray3 ml-1">笔</span></div>
        </div>
        <div>
          <div className="text-micro text-gray3">借方合计</div>
          <div className="text-h2 font-num">¥{stats.sumDebit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
        </div>
        <div>
          <div className="text-micro text-gray3">草稿待审</div>
          <div className={`text-h2 font-num ${stats.draft > 0 ? 'text-red-fg' : ''}`}>{stats.draft}</div>
        </div>
      </div>

      {/* 批量操作 */}
      <div className="mx-4 mt-3 flex gap-2 flex-wrap">
        {selected.size > 0 ? (
          <>
            <button onClick={postSelected} disabled={busy}
                    className="px-3 py-2 bg-ink text-white rounded-cta text-button disabled:opacity-40">
              审选中 {selected.size} 笔
            </button>
            <button onClick={clearSelection} disabled={busy}
                    className="px-3 py-2 bg-white border border-border text-gray2 rounded-cta text-button">
              取消选择
            </button>
          </>
        ) : (
          <>
            <button onClick={postAll} disabled={busy || stats.draft === 0}
                    className="px-3 py-2 bg-amber/10 text-amber-fg rounded-cta text-button disabled:opacity-40">
              一键审 {stats.draft} 笔草稿
            </button>
            {stats.draft > 1 && (
              <button onClick={selectAllDraft} disabled={busy}
                      className="px-3 py-2 bg-white border border-border text-gray2 rounded-cta text-button">
                选草稿
              </button>
            )}
          </>
        )}
        <button onClick={() => exportExcel('posted')} disabled={busy || stats.posted === 0}
                className="px-3 py-2 bg-ink text-white rounded-cta text-button disabled:opacity-40 ml-auto">
          导出已审 ({stats.posted})
        </button>
      </div>

      {/* 列表 */}
      <ul className="px-4 mt-3 space-y-2">
        {data === null && <li className="text-caption text-gray3 text-center py-12">加载中…</li>}
        {data !== null && list.length === 0 && (
          <li className="text-caption text-gray3 text-center py-12">本月{status !== 'ALL' ? STATUS_LABEL[status] + '状态' : ''}暂无凭证</li>
        )}
        {list.map(v => {
          const tone = v.status === 'POSTED' ? 'green' : v.status === 'VOIDED' ? 'gray' : 'red'
          const isSelected = selected.has(v.id)
          return (
            <li key={v.id} className="flex items-start gap-2">
              {v.status === 'DRAFT' && (
                <button
                  type="button"
                  onClick={() => toggleSelect(v.id)}
                  className={`mt-3 w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 ${
                    isSelected ? 'bg-ink border-ink text-white' : 'bg-white border-border'
                  }`}
                  aria-label="选择"
                >
                  {isSelected && <span className="text-micro">✓</span>}
                </button>
              )}
              {v.status !== 'DRAFT' && <div className="w-5 shrink-0" />}
              <a href={`/v2/finance/vouchers/${v.id}`} className={`flex-1 block rounded-card border p-3 hover:bg-bg-warm transition ${isSelected ? 'bg-amber/5 border-amber/30' : 'bg-white border-border'}`}>
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <Chip tone={tone as any}>{STATUS_LABEL[v.status]}</Chip>
                  {v.sourceType && <Chip tone="amber">{SOURCE_LABEL[v.sourceType] || v.sourceType}</Chip>}
                  {v.exportedAt && <Chip tone="gray">已导</Chip>}
                  <span className="text-micro text-gray3 ml-auto">{dayjs(v.date).format('MM/DD')}</span>
                </div>
                <div className="flex items-baseline justify-between">
                  <span className="text-h2 font-num">{v.no}</span>
                  <span className="font-num text-h2">¥{Number(v.totalDebit).toLocaleString()}</span>
                </div>
                <p className="text-caption text-gray2 truncate mt-0.5">{v.summary}</p>
                <p className="text-micro text-gray3 mt-1 truncate">
                  {v.entries.slice(0, 2).map(e =>
                    `${e.accountCode} ${e.accountName} ${Number(e.debit) > 0 ? '借' : '贷'} ¥${Number(e.debit) || Number(e.credit)}`
                  ).join(' / ')}
                  {v.entries.length > 2 && ` 等 ${v.entries.length} 行`}
                </p>
                {v.status === 'DRAFT' && (
                  <div className="mt-2 flex justify-end">
                    <button
                      onClick={(e) => { e.preventDefault(); postOne(v.id) }}
                      disabled={busy}
                      className="px-3 py-1 bg-ink text-white rounded-cta text-micro disabled:opacity-40"
                    >审核</button>
                  </div>
                )}
              </a>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
