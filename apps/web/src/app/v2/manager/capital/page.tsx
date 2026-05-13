/**
 * 店长 · 本店代付项目
 *
 * 流程: 店长立项 → 录合同 → 申请支出 (PENDING_APPROVAL)
 *      → 老板/财务审批 → 财务付款 → PAID
 *      → 开业后录还款(财务做)
 */
'use client'
import { useEffect, useMemo, useState } from 'react'
import { apiFetch, getUser } from '@/lib/v2-auth'
import { Chip } from '@/components/v2'
import { SkeletonList, FriendlyError, EmptyState } from '@/components/v2/skeleton'

type Project = {
  id: string; name: string; type: string; status: string
  budget?: string | number | null
  spent: string | number; repaidAmount: string | number
  remainingDebt: number; progressPct: number | null
  startedAt: string; openedAt?: string | null
  store?: { id: string; name: string; no: string } | null
  _count: { contracts: number; expenses: number; repayments: number }
}

const STATUS_LABEL: Record<string, string> = {
  PREPARING: '筹建中', OPERATING: '已开业', REPAID: '已还清', CANCELED: '已取消',
}
const STATUS_TONE: Record<string, 'orange'|'green'|'gray'> = {
  PREPARING: 'orange', OPERATING: 'green', REPAID: 'gray', CANCELED: 'gray',
}
const TYPE_LABEL: Record<string, string> = {
  NEW_STORE: '新店筹建', RENOVATION: '翻新升级', EQUIPMENT: '设备投入', OTHER: '其他',
}

export default function ManagerCapitalPage() {
  const [items, setItems] = useState<Project[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [storeName, setStoreName] = useState('本店')
  const [storeId, setStoreId] = useState<string | null>(null)
  const [showNew, setShowNew] = useState(false)
  const [form, setForm] = useState({ name: '', type: 'NEW_STORE', budget: '', repaymentTerms: '', note: '' })
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    const u = getUser()
    setStoreName(u?.store?.name || '本店')
    setStoreId(u?.storeId || u?.store?.id || null)
    apiFetch<Project[]>('/api/capital/projects').then(setItems).catch(e => setError(e.message))
  }, [])

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
      location.href = `/v2/manager/capital/${p.id}`
    } catch (e: any) { alert(e.message || '立项失败') }
    setSubmitting(false)
  }

  return (
    <div className="min-h-screen bg-bg pb-12">
      <header className="px-4 pt-4 pb-2 flex items-center gap-3">
        <button onClick={() => history.back()} className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center">‹</button>
        <div className="flex-1">
          <h1 className="text-h1">筹建 / 代付</h1>
          <p className="text-caption text-gray3">{storeName} · 合同 + 申请支出</p>
        </div>
        <button onClick={() => setShowNew(true)} className="px-3 h-9 rounded-cta bg-amber text-white text-button">＋ 立项</button>
      </header>

      <div className="mx-4 mt-3 bg-bg-warm rounded-card border border-border p-3 text-caption text-gray2">
        <p><span className="text-amber-fg">流程</span>: 立项 → 录合同(租金/装修/...) → 申请支出 → 老板审批 → 总部代付</p>
        <p className="text-micro text-gray3 mt-1">⏰ 建议把每张合同(房东/装修/设备)分别录入, 每笔支出关联到对应合同</p>
      </div>

      {error && (
        <div className="mx-4 mt-3">
          <FriendlyError message={error} hint="此功能需总部更新后台后启用 · 已经在配置中" />
        </div>
      )}

      <div className="px-4 mt-3">
        {!error && items === null && <SkeletonList count={2} />}
        {!error && items?.length === 0 && (
          <EmptyState
            icon="🏗"
            title="本店还无代付项目"
            hint="点右上「+ 立项」开始,后续合同/支出都挂在这里"
          />
        )}
      </div>

      <ul className="px-4 mt-3 space-y-2">
        {/* 列表占位放空, 真实项目用下方 .map */}
        {items?.map(p => {
          const spent = Number(p.spent)
          const repaid = Number(p.repaidAmount)
          const budget = p.budget ? Number(p.budget) : null
          const repaidPct = spent > 0 ? Math.round(repaid / spent * 100) : 0
          return (
            <li key={p.id}>
              <a href={`/v2/manager/capital/${p.id}`} className="block bg-white rounded-card border border-border p-3">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <Chip tone={STATUS_TONE[p.status]}>{STATUS_LABEL[p.status]}</Chip>
                  <span className="text-micro text-gray3">{TYPE_LABEL[p.type]}</span>
                </div>
                <div className="text-h2 mb-1">{p.name}</div>
                <div className="flex items-baseline justify-between mt-2">
                  <span className="text-caption text-gray3">已投入</span>
                  <span className="font-num text-h2">
                    ¥{spent.toLocaleString()}
                    {budget && <span className="text-caption text-gray3 ml-1">/¥{budget.toLocaleString()}</span>}
                  </span>
                </div>
                {spent > 0 && (
                  <>
                    <div className="h-1.5 bg-bg rounded-full overflow-hidden mt-2">
                      <div className="h-full bg-amber" style={{ width: `${repaidPct}%` }} />
                    </div>
                    <p className="text-micro text-gray3 mt-1">已还总部 ¥{repaid.toLocaleString()} · 待还 ¥{Number(p.remainingDebt).toLocaleString()}</p>
                  </>
                )}
                <p className="text-micro text-gray3 mt-2">{p._count.contracts} 合同 · {p._count.expenses} 笔支出 · {p._count.repayments} 次还款</p>
              </a>
            </li>
          )
        })}
      </ul>

      {/* 立项抽屉 */}
      {showNew && (
        <div className="fixed inset-0 z-50" onClick={() => !submitting && setShowNew(false)}>
          <div className="absolute inset-0 bg-ink/60" />
          <div className="absolute bottom-0 left-0 right-0 bg-white rounded-t-card max-h-[85vh] overflow-auto" onClick={e => e.stopPropagation()}>
            <div className="w-12 h-1 bg-gray5 rounded-full mx-auto mt-2" />
            <div className="px-4 pt-3 pb-2">
              <h3 className="text-h2">立新项目</h3>
              <p className="text-caption text-gray3">绑定 {storeName} · 后续合同/支出都挂这里</p>
            </div>
            <div className="px-4 pb-3 space-y-3">
              <Field label="项目名称 *">
                <input value={form.name} onChange={e => setForm(s => ({...s, name: e.target.value}))}
                       placeholder={`${storeName} · 筹建`} className={IN} />
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
                <textarea rows={2} value={form.note} onChange={e => setForm(s => ({...s, note: e.target.value}))} className={IN + ' resize-none'} />
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
