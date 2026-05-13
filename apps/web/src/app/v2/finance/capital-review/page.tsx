/**
 * 老板 / 财务 · 代付申请审批 + 付款
 * 显示所有店的 CapitalExpense:
 *   - PENDING_APPROVAL: 老板/财务 审批 (APPROVE/REJECT)
 *   - APPROVED:        财务 付款 (走 cmb 或手工)
 *   - PAID/REJECTED/CANCELED: 历史
 */
'use client'
import { useEffect, useMemo, useState } from 'react'
import { apiFetch } from '@/lib/v2-auth'
import { Chip } from '@/components/v2'
import { ConfirmSheet, useConfirmSheet } from '@/components/v2/confirm-sheet'

type Project = {
  id: string; name: string
  store?: { id: string; name: string; no: string } | null
  expenses: Expense[]
}
type Expense = {
  id: string; vendor: string; category: string
  amount: string | number; requestedAt: string
  status: 'PENDING_APPROVAL'|'APPROVED'|'PAID'|'REJECTED'|'CANCELED'|'FAILED'
  rejectReason?: string | null; approvalNote?: string | null
  paidAt?: string | null; bankTxNo?: string | null
  fileUrl?: string | null; note?: string | null
  contract?: { vendor: string; category: string } | null
  // 我们扩展从父级 inject
  projectName?: string
  storeName?: string
  projectId?: string
}

const CATEGORY_LABEL: Record<string, string> = {
  RENT: '租金', DECORATION: '装修', EQUIPMENT: '设备',
  PAYROLL: '人员', LEGAL: '证照', MARKETING: '营销', OTHER: '其他',
}
const STATUS_LABEL: Record<string, string> = {
  PENDING_APPROVAL: '待审批',
  APPROVED: '待付款',
  PAID: '已付款',
  REJECTED: '已驳回',
  CANCELED: '已撤回',
  FAILED: '付款失败',
}
const STATUS_TONE: Record<string, 'orange'|'green'|'red'|'gray'> = {
  PENDING_APPROVAL: 'orange', APPROVED: 'orange', PAID: 'green',
  REJECTED: 'red', CANCELED: 'gray', FAILED: 'red',
}

function fmt(iso: string) {
  const d = new Date(iso)
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

export default function CapitalReviewPage() {
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<'PENDING_APPROVAL'|'APPROVED'|'PAID'|'ALL'>('PENDING_APPROVAL')
  const [submitting, setSubmitting] = useState<string | null>(null)
  const [confirmState, openConfirm] = useConfirmSheet()

  function load() {
    apiFetch<Project[]>('/api/capital/projects')
      .then(async list => {
        // 详情拉每个项目, 才能拿到 expenses
        const detailed = await Promise.all(
          list.map(p => apiFetch<Project>(`/api/capital/projects/${p.id}`).catch(() => null))
        )
        setProjects(detailed.filter(Boolean) as Project[])
      })
      .catch(e => setError(e.message))
  }
  useEffect(() => { load() }, [])

  // 把所有 expense 拍平 + inject project/store name
  const allExpenses: Expense[] = useMemo(() => {
    if (!projects) return []
    const flat: Expense[] = []
    projects.forEach(p => {
      (p.expenses || []).forEach(e => {
        flat.push({
          ...e,
          projectId: p.id,
          projectName: p.name,
          storeName: p.store?.name || '未关联店',
        })
      })
    })
    return flat.sort((a, b) => new Date(b.requestedAt).getTime() - new Date(a.requestedAt).getTime())
  }, [projects])

  const filtered = useMemo(() => {
    if (filter === 'ALL') return allExpenses
    return allExpenses.filter(e => e.status === filter)
  }, [allExpenses, filter])

  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    allExpenses.forEach(e => { c[e.status] = (c[e.status] || 0) + 1 })
    return c
  }, [allExpenses])

  function approve(e: Expense, decision: 'APPROVE' | 'REJECT') {
    if (submitting) return
    const post = async (note?: string) => {
      setSubmitting(e.id)
      try {
        await apiFetch(`/api/capital/expenses/${e.id}/approve`, {
          method: 'PATCH', body: JSON.stringify({ decision, note }),
        })
        load()
      } catch (err: any) { alert(err.message); throw err }
      finally { setSubmitting(null) }
    }
    if (decision === 'REJECT') {
      openConfirm({
        title: `驳回 ${e.vendor} ¥${Number(e.amount).toLocaleString()}`,
        body: '请简述驳回原因。',
        confirmLabel: '驳回',
        tone: 'danger',
        withInput: true,
        inputRequired: true,
        onConfirm: (note) => post(note),
      })
    } else {
      openConfirm({
        title: `批准付款 ¥${Number(e.amount).toLocaleString()}?`,
        body: `${e.vendor} · 批准后由财务执行付款`,
        confirmLabel: '批准',
        tone: 'primary',
        onConfirm: () => post(),
      })
    }
  }

  function pay(e: Expense) {
    if (submitting) return
    openConfirm({
      title: `付款 ¥${Number(e.amount).toLocaleString()}?`,
      body: `${e.vendor} · 走招行 cmb 自动转账`,
      confirmLabel: '付款',
      tone: 'primary',
      onConfirm: async () => {
        setSubmitting(e.id)
        try {
          await apiFetch(`/api/capital/expenses/${e.id}/pay`, {
            method: 'PATCH', body: JSON.stringify({ paymentMethod: 'cmb' }),
          })
          load()
        } catch (err: any) { alert(err.message); throw err }
        finally { setSubmitting(null) }
      },
    })
  }

  return (
    <div className="min-h-screen bg-bg pb-12">
      <header className="px-4 pt-4 pb-2 flex items-center gap-3">
        <button onClick={() => history.back()} className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center">‹</button>
        <div>
          <h1 className="text-h1">代付审批</h1>
          <p className="text-caption text-gray3">店长申请 → 老板/财务批 → 财务付款</p>
        </div>
      </header>

      {error && <div className="mx-4 mt-3 bg-red-bg text-red-fg rounded-card p-3 text-caption">{error}</div>}

      {/* Tab */}
      <div className="px-4 mt-3 flex gap-2 overflow-x-auto">
        {([
          { k: 'PENDING_APPROVAL', l: '待审批' },
          { k: 'APPROVED',         l: '待付款' },
          { k: 'PAID',             l: '已付款' },
          { k: 'ALL',              l: '全部' },
        ] as const).map(t => {
          const n = t.k === 'ALL' ? allExpenses.length : (counts[t.k] || 0)
          return (
            <button key={t.k} onClick={() => setFilter(t.k)}
              className={`shrink-0 px-3 py-1.5 rounded-cta text-button ${filter === t.k ? 'bg-ink text-white' : 'bg-white border border-border text-gray2'}`}>
              {t.l} {n > 0 && <span className="font-num">{n}</span>}
            </button>
          )
        })}
      </div>

      <ul className="px-4 mt-3 space-y-2">
        {projects === null && <li className="text-caption text-gray3 text-center py-12">加载中…</li>}
        {filtered.length === 0 && projects !== null && (
          <li className="text-caption text-gray3 text-center py-12">无记录</li>
        )}
        {filtered.map(e => (
          <li key={e.id} className="bg-white rounded-card border border-border p-3">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <Chip tone={STATUS_TONE[e.status]}>{STATUS_LABEL[e.status]}</Chip>
              <Chip tone="gray">{CATEGORY_LABEL[e.category] || e.category}</Chip>
              <span className="text-micro text-gray3 ml-auto">{fmt(e.requestedAt)}</span>
            </div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-h2">{e.vendor}</span>
              <span className="font-num text-h2">¥{Number(e.amount).toLocaleString()}</span>
            </div>
            <p className="text-caption text-gray2">
              {e.storeName} · {e.projectName}
              {e.contract && ` · 关联合同: ${e.contract.vendor}`}
            </p>
            {e.note && <p className="text-micro text-gray3 mt-1">{e.note}</p>}
            {e.status === 'REJECTED' && e.rejectReason && (
              <p className="text-micro text-red-fg mt-1">驳回: {e.rejectReason}</p>
            )}
            {e.status === 'PAID' && e.paidAt && (
              <p className="text-micro text-green-fg mt-1">✓ {fmt(e.paidAt)} 已付款 {e.bankTxNo && <span className="font-num ml-1">流水 {e.bankTxNo.slice(0, 12)}</span>}</p>
            )}
            {e.fileUrl && <a href={e.fileUrl} target="_blank" rel="noreferrer" className="text-micro text-amber-fg mt-1 inline-block">凭证 ↗</a>}

            {e.status === 'PENDING_APPROVAL' && (
              <div className="grid grid-cols-2 gap-2 mt-3">
                <button onClick={() => approve(e, 'REJECT')} disabled={submitting === e.id}
                        className="py-2 border border-red text-red rounded-cta text-button disabled:opacity-40">驳回</button>
                <button onClick={() => approve(e, 'APPROVE')} disabled={submitting === e.id}
                        className="py-2 bg-ink text-white rounded-cta text-button disabled:opacity-40">
                  {submitting === e.id ? '提交中…' : '批准'}
                </button>
              </div>
            )}
            {e.status === 'APPROVED' && (
              <button onClick={() => pay(e)} disabled={submitting === e.id}
                      className="w-full py-2 mt-3 bg-amber text-white rounded-cta text-button disabled:opacity-40">
                {submitting === e.id ? '提交中…' : '发起付款'}
              </button>
            )}
          </li>
        ))}
      </ul>

      <ConfirmSheet {...confirmState} />
    </div>
  )
}
