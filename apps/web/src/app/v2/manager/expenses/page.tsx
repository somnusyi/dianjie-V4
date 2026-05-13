/**
 * 店长 · 录入门店月度杂费
 * 4 类: LABOR / SALES / MGMT / FINANCE · 选高频项即可
 * GET  /api/profit/store/:storeId?month=YYYY-MM  → 回填
 * POST /api/profit/store/:storeId/expenses { month, expenses: { item: amount } }
 */
'use client'
import { useEffect, useMemo, useState } from 'react'
import { apiFetch, getUser } from '@/lib/v2-auth'

// 高频项, 与后端 EXPENSE_ITEMS 名称一一对应
const GROUPS = [
  { key: 'LABOR', label: '人工',
    items: ['工资成本', '提成奖金', '社保成本', '员工福利费'] },
  { key: 'SALES', label: '销售/门店',
    items: ['门店租金', '门店物业费', '水费', '电费', '燃气费', '运费', '维修费', '推广费'] },
  { key: 'MGMT',  label: '管理',
    items: ['办公费', '通讯费', '门店保险费', '其他费用'] },
  { key: 'FINANCE', label: '财务费用',
    items: ['银行手续费'] },
] as const

function thisMonth() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export default function ManagerExpensesPage() {
  const [month, setMonth] = useState(thisMonth())
  const [vals, setVals] = useState<Record<string, string>>({})
  const [storeId, setStoreId] = useState<string | null>(null)
  const [storeName, setStoreName] = useState('本店')
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [openGroup, setOpenGroup] = useState<string>('LABOR')

  useEffect(() => {
    const u = getUser()
    if (u) { setStoreId(u.storeId || u.store?.id || null); setStoreName(u.store?.name || '本店') }
  }, [])

  // 回填
  useEffect(() => {
    if (!storeId || !month) return
    setLoading(true); setError(null)
    apiFetch<any>(`/api/profit/store/${storeId}?month=${month}`)
      .then(d => {
        // labor/sales/mgmt/finance 各自的 items 是同一个 expenseByItem dict
        const dict = d?.cost?.labor?.items || {}
        const m: Record<string,string> = {}
        Object.entries(dict).forEach(([k, v]) => { if (Number(v) > 0) m[k] = String(v) })
        setVals(m)
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [storeId, month])

  const total = useMemo(() => {
    return Object.values(vals).reduce((s, v) => s + (Number(v) || 0), 0)
  }, [vals])

  const groupTotal = (g: typeof GROUPS[number]) =>
    g.items.reduce((s, it) => s + (Number(vals[it]) || 0), 0)

  async function submit() {
    if (!storeId) return
    setError(null); setSubmitting(true)
    try {
      const expenses: Record<string, number> = {}
      Object.entries(vals).forEach(([k, v]) => {
        const n = Number(v) || 0
        if (n > 0) expenses[k] = n
      })
      await apiFetch(`/api/profit/store/${storeId}/expenses`, {
        method: 'POST',
        body: JSON.stringify({ month, expenses }),
      })
      location.href = '/v2/manager/ops'
    } catch (e: any) { setError(e.message); setSubmitting(false) }
  }

  return (
    <div className="min-h-screen bg-bg pb-24">
      <header className="px-4 pt-4 pb-2 flex items-center gap-3">
        <button onClick={() => history.back()} className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center" aria-label="返回">‹</button>
        <div className="flex-1">
          <h1 className="text-h1">月度杂费</h1>
          <p className="text-caption text-gray3">{storeName} · 仅录入本月新增项</p>
        </div>
      </header>

      <div className="px-4 mt-2 space-y-3">
        <div className="bg-white rounded-card border border-border p-3 flex items-center gap-3">
          <label className="text-micro text-gray3 shrink-0">月份</label>
          <input type="month" value={month} max={thisMonth()} onChange={e => setMonth(e.target.value)}
                 className="text-body bg-transparent outline-none font-num" />
          {loading && <span className="text-micro text-gray3 ml-auto">加载中…</span>}
        </div>

        {GROUPS.map(g => {
          const isOpen = openGroup === g.key
          const gt = groupTotal(g)
          return (
            <div key={g.key} className="bg-white rounded-card border border-border overflow-hidden">
              <button
                onClick={() => setOpenGroup(isOpen ? '' : g.key)}
                className="w-full flex items-center justify-between px-3 py-3"
              >
                <div className="flex items-center gap-2">
                  <span className="text-h2">{g.label}</span>
                  <span className="text-micro text-gray3">{g.items.length} 项</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-num text-h2 text-gray2">¥{gt.toLocaleString()}</span>
                  <span className={`text-gray3 transition-transform ${isOpen ? 'rotate-90' : ''}`}>›</span>
                </div>
              </button>
              {isOpen && (
                <div className="border-t border-border">
                  {g.items.map((it, i) => (
                    <div key={it} className={`flex items-center px-3 py-2.5 ${i < g.items.length - 1 ? 'border-b border-border' : ''}`}>
                      <div className="flex-1 text-body">{it}</div>
                      <div className="flex items-center">
                        <span className="text-gray3 mr-1 font-num">¥</span>
                        <input
                          type="number" inputMode="decimal" min="0" step="0.01"
                          value={vals[it] || ''}
                          onChange={e => setVals(v => ({ ...v, [it]: e.target.value }))}
                          placeholder="0"
                          className="w-28 text-right font-num text-body bg-transparent outline-none"
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}

        <div className="bg-ink text-white rounded-card p-3 flex items-center justify-between">
          <span className="text-caption text-white/70">本月杂费合计</span>
          <span className="font-num text-h1">¥{total.toLocaleString()}</span>
        </div>

        {error && <div className="bg-red-bg text-red-fg rounded-card p-3 text-caption">{error}</div>}
      </div>

      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-border p-3">
        <button onClick={submit} disabled={submitting}
                className="w-full py-3 bg-ink text-white rounded-cta text-button disabled:opacity-40">
          {submitting ? '提交中…' : `保存 · ¥${total.toLocaleString()}`}
        </button>
      </div>
    </div>
  )
}
