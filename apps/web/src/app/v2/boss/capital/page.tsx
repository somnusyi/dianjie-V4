/**
 * 老板/财务 · 总部代付项目列表
 *
 * 用途: 看每个新店筹建/升级项目的总投入 / 已还 / 待还
 * 入口: /v2/me 或 /v2/finance/home 入口
 */
'use client'
import { useEffect, useMemo, useState } from 'react'
import { apiFetch } from '@/lib/v2-auth'
import { Chip } from '@/components/v2'

type Project = {
  id: string; name: string
  type: 'NEW_STORE'|'RENOVATION'|'EQUIPMENT'|'OTHER'
  status: 'PREPARING'|'OPERATING'|'REPAID'|'CANCELED'
  budget?: string | number | null
  spent: string | number
  repaidAmount: string | number
  remainingDebt: number
  progressPct: number | null
  startedAt: string
  openedAt?: string | null
  store?: { id: string; name: string; no: string } | null
  _count: { contracts: number; expenses: number; repayments: number }
}

const TYPE_LABEL: Record<string, string> = {
  NEW_STORE: '新店筹建', RENOVATION: '翻新升级', EQUIPMENT: '设备投入', OTHER: '其他',
}
const STATUS_LABEL: Record<string, string> = {
  PREPARING: '筹建中', OPERATING: '已开业', REPAID: '已还清', CANCELED: '已取消',
}
const STATUS_TONE: Record<string, 'orange'|'green'|'gray'> = {
  PREPARING: 'orange', OPERATING: 'green', REPAID: 'gray', CANCELED: 'gray',
}

function fmt(iso: string) {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export default function CapitalListPage() {
  const [items, setItems] = useState<Project[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<'ALL'|'PREPARING'|'OPERATING'|'REPAID'>('ALL')
  const [showNew, setShowNew] = useState(false)
  const [form, setForm] = useState({ name: '', type: 'NEW_STORE', budget: '', repaymentTerms: '', note: '' })
  const [submitting, setSubmitting] = useState(false)

  function load() {
    apiFetch<Project[]>('/api/capital/projects')
      .then(setItems)
      .catch(e => setError(e.message))
  }
  useEffect(() => { load() }, [])

  const visible = useMemo(() => {
    if (!items) return []
    return filter === 'ALL' ? items : items.filter(p => p.status === filter)
  }, [items, filter])

  const stats = useMemo(() => {
    if (!items) return { totalSpent: 0, totalRepaid: 0, totalDebt: 0, count: 0 }
    return items.reduce((s, p) => ({
      totalSpent: s.totalSpent + Number(p.spent),
      totalRepaid: s.totalRepaid + Number(p.repaidAmount),
      totalDebt:  s.totalDebt + Number(p.remainingDebt),
      count: s.count + (p.status !== 'REPAID' && p.status !== 'CANCELED' ? 1 : 0),
    }), { totalSpent: 0, totalRepaid: 0, totalDebt: 0, count: 0 })
  }, [items])

  async function create() {
    if (!form.name.trim()) { alert('请填项目名'); return }
    setSubmitting(true)
    try {
      const p = await apiFetch<Project>('/api/capital/projects', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name, type: form.type,
          budget: form.budget ? Number(form.budget) : null,
          repaymentTerms: form.repaymentTerms || null,
          note: form.note || null,
        }),
      })
      setShowNew(false)
      setForm({ name: '', type: 'NEW_STORE', budget: '', repaymentTerms: '', note: '' })
      location.href = `/v2/boss/capital/${p.id}`
    } catch (e: any) { alert(e.message || '立项失败') }
    setSubmitting(false)
  }

  return (
    <div className="min-h-screen bg-bg pb-12">
      <header className="px-4 pt-4 pb-2 flex items-center gap-3">
        <button onClick={() => history.back()} className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center">‹</button>
        <div className="flex-1">
          <h1 className="text-h1">代付项目</h1>
          <p className="text-caption text-gray3">新店筹建 / 升级 · 合同 + 支出可追溯</p>
        </div>
        <button onClick={() => setShowNew(true)}
                className="px-3 h-9 rounded-cta bg-amber text-white text-button">＋ 立项</button>
      </header>

      {/* 总览 */}
      <div className="mx-4 mt-3 bg-ink text-white rounded-card p-4">
        <div className="flex items-baseline justify-between mb-1">
          <span className="text-caption text-white/70">总部待收回</span>
          <span className="font-num text-h1">¥{stats.totalDebt.toLocaleString()}</span>
        </div>
        <div className="flex items-center gap-3 mt-2 text-caption">
          <div className="flex-1">
            <div className="text-micro text-white/60">活跃项目</div>
            <div className="font-num text-button">{stats.count} 个</div>
          </div>
          <div className="flex-1">
            <div className="text-micro text-white/60">总投入</div>
            <div className="font-num text-button">¥{stats.totalSpent.toLocaleString()}</div>
          </div>
          <div className="flex-1">
            <div className="text-micro text-white/60">已收回</div>
            <div className="font-num text-button text-amber">¥{stats.totalRepaid.toLocaleString()}</div>
          </div>
        </div>
      </div>

      {error && <div className="mx-4 mt-3 bg-red-bg text-red-fg rounded-card p-3 text-caption">{error}</div>}

      <div className="px-4 mt-4 flex gap-2 overflow-x-auto">
        {(['ALL','PREPARING','OPERATING','REPAID'] as const).map(f => (
          <button key={f} onClick={() => setFilter(f)}
            className={`shrink-0 px-3 py-1.5 rounded-cta text-button ${filter === f ? 'bg-ink text-white' : 'bg-white border border-border text-gray2'}`}>
            {f === 'ALL' ? '全部' : STATUS_LABEL[f]}
          </button>
        ))}
      </div>

      <ul className="px-4 mt-3 space-y-2">
        {items === null && <li className="text-caption text-gray3 text-center py-12">加载中…</li>}
        {visible.length === 0 && items !== null && (
          <li className="text-caption text-gray3 text-center py-12">{filter === 'ALL' ? '暂无项目, 点右上立项' : '无记录'}</li>
        )}
        {visible.map(p => {
          const spent = Number(p.spent)
          const repaid = Number(p.repaidAmount)
          const budget = p.budget ? Number(p.budget) : null
          const repaidPct = spent > 0 ? Math.round(repaid / spent * 100) : 0
          return (
            <li key={p.id}>
              <a href={`/v2/boss/capital/${p.id}`} className="block bg-white rounded-card border border-border p-3">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <Chip tone={STATUS_TONE[p.status]}>{STATUS_LABEL[p.status]}</Chip>
                  <span className="text-micro text-gray3">{TYPE_LABEL[p.type]}</span>
                  <span className="text-micro text-gray3 ml-auto">{fmt(p.startedAt)}</span>
                </div>
                <div className="text-h2 mb-1">{p.name}</div>
                {p.store && <p className="text-caption text-gray2">{p.store.name} · {p.store.no}</p>}
                <div className="flex items-baseline justify-between mt-2">
                  <span className="text-caption text-gray3">已投入</span>
                  <span className="font-num text-h2">
                    ¥{spent.toLocaleString()}
                    {budget && <span className="text-caption text-gray3 ml-1">/¥{budget.toLocaleString()}</span>}
                  </span>
                </div>
                {/* 还款进度 */}
                {spent > 0 && (
                  <>
                    <div className="h-1.5 bg-bg rounded-full overflow-hidden mt-2">
                      <div className="h-full bg-amber transition-all" style={{ width: `${repaidPct}%` }} />
                    </div>
                    <p className="text-micro text-gray3 mt-1">已收回 ¥{repaid.toLocaleString()} ({repaidPct}%) · 待收 ¥{Number(p.remainingDebt).toLocaleString()}</p>
                  </>
                )}
                <p className="text-micro text-gray3 mt-2">{p._count.contracts} 合同 · {p._count.expenses} 笔支出 · {p._count.repayments} 次还款</p>
              </a>
            </li>
          )
        })}
      </ul>

      {/* 新建抽屉 */}
      {showNew && (
        <div className="fixed inset-0 z-50" onClick={() => !submitting && setShowNew(false)}>
          <div className="absolute inset-0 bg-ink/60" />
          <div className="absolute bottom-0 left-0 right-0 bg-white rounded-t-card max-h-[85vh] overflow-auto" onClick={e => e.stopPropagation()}>
            <div className="w-12 h-1 bg-gray5 rounded-full mx-auto mt-2" />
            <div className="px-4 pt-3 pb-2">
              <h3 className="text-h2">立新项目</h3>
              <p className="text-caption text-gray3">下一步: 录合同 → 录支出 → 开业后还款</p>
            </div>
            <div className="px-4 pb-3 space-y-3">
              <Field label="项目名称 *">
                <input value={form.name} onChange={e => setForm(s => ({...s, name: e.target.value}))}
                       placeholder="南京新街口店 · 筹建" className={IN} />
              </Field>
              <Field label="类型">
                <select value={form.type} onChange={e => setForm(s => ({...s, type: e.target.value}))} className={IN}>
                  <option value="NEW_STORE">新店筹建</option>
                  <option value="RENOVATION">翻新升级</option>
                  <option value="EQUIPMENT">设备投入</option>
                  <option value="OTHER">其他</option>
                </select>
              </Field>
              <Field label="预算 (可选)">
                <input type="number" step="100" value={form.budget} onChange={e => setForm(s => ({...s, budget: e.target.value}))}
                       placeholder="800000" className={IN + ' font-num'} />
              </Field>
              <Field label="还款约定 (可选)" hint="例: 每月营收 10% / 固定每月 ¥10K">
                <input value={form.repaymentTerms} onChange={e => setForm(s => ({...s, repaymentTerms: e.target.value}))}
                       placeholder="开业后每月营收 10%" className={IN} />
              </Field>
              <Field label="备注 (可选)">
                <textarea rows={2} value={form.note} onChange={e => setForm(s => ({...s, note: e.target.value}))}
                          className={IN + ' resize-none'} />
              </Field>
            </div>
            <div className="border-t border-border p-3 flex gap-3">
              <button onClick={() => setShowNew(false)} disabled={submitting}
                      className="px-4 py-3 bg-white border border-border rounded-cta text-button text-gray2">取消</button>
              <button onClick={create} disabled={submitting}
                      className="flex-1 py-3 bg-ink text-white rounded-cta text-button disabled:opacity-40">
                {submitting ? '创建中…' : '立项'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const IN = 'w-full bg-bg rounded-chip px-3 py-2 outline-none text-body'

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-micro text-gray3 block mb-1">{label}</label>
      {children}
      {hint && <p className="text-micro text-gray4 mt-1">{hint}</p>}
    </div>
  )
}
