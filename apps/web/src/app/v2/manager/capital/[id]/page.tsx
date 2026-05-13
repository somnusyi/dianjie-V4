/**
 * 店长 · 代付项目详情
 *
 * 店长能做:
 *   - 录合同 (POST /api/capital/contracts)
 *   - 申请支出 (POST /api/capital/expenses, status=PENDING_APPROVAL)
 *   - 撤回未审批的申请 (PATCH /api/capital/expenses/:id/cancel)
 *   - 查看审批状态、驳回原因
 *
 * 店长不能做:
 *   - 审批支出(老板/财务)
 *   - 付款(财务)
 *   - 录还款(财务)
 */
'use client'
import { useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { apiFetch } from '@/lib/v2-auth'
import { Chip } from '@/components/v2'
import { ConfirmSheet, useConfirmSheet } from '@/components/v2/confirm-sheet'

type Contract = {
  id: string; category: string; vendor: string
  contractNo?: string | null
  totalAmount: string | number; paidAmount: string | number
  status: 'ACTIVE'|'COMPLETED'|'TERMINATED'
  startDate?: string | null; endDate?: string | null
  fileUrl?: string | null; note?: string | null
  _count: { expenses: number }
}
type Expense = {
  id: string; category: string; vendor: string
  amount: string | number; requestedAt: string
  status: 'PENDING_APPROVAL'|'APPROVED'|'PAID'|'REJECTED'|'CANCELED'|'FAILED'
  rejectReason?: string | null; approvalNote?: string | null
  paidAt?: string | null; bankTxNo?: string | null
  fileUrl?: string | null; note?: string | null
  contract?: { id: string; vendor: string; category: string } | null
}
type Project = {
  id: string; name: string; type: string; status: string
  budget?: string | number | null
  spent: string | number; repaidAmount: string | number
  remainingDebt: number
  startedAt: string; openedAt?: string | null
  repaymentTerms?: string | null; note?: string | null
  store?: { id: string; name: string; no: string } | null
  contracts: Contract[]
  expenses: Expense[]
  repayments: Array<{ id: string; amount: string | number; paidAt: string; source: string }>
}

const CATEGORY_LABEL: Record<string, string> = {
  RENT: '租金', DECORATION: '装修', EQUIPMENT: '设备',
  PAYROLL: '人员', LEGAL: '证照', MARKETING: '营销', OTHER: '其他',
}
const EXP_STATUS_LABEL: Record<string, string> = {
  PENDING_APPROVAL: '待审批',
  APPROVED: '已批 · 待付款',
  PAID: '已付款',
  REJECTED: '已驳回',
  CANCELED: '已撤回',
  FAILED: '付款失败',
}
const EXP_STATUS_TONE: Record<string, 'orange'|'green'|'red'|'gray'> = {
  PENDING_APPROVAL: 'orange', APPROVED: 'orange', PAID: 'green',
  REJECTED: 'red', CANCELED: 'gray', FAILED: 'red',
}

function fmt(iso: string) {
  const d = new Date(iso)
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

export default function ManagerCapitalDetailPage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const id = params?.id as string
  const [data, setData] = useState<Project | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<'OVERVIEW'|'CONTRACTS'|'EXPENSES'>('OVERVIEW')
  const [drawer, setDrawer] = useState<'CONTRACT'|'EXPENSE'|null>(null)
  const [confirmState, openConfirm] = useConfirmSheet()

  function load() {
    apiFetch<Project>(`/api/capital/projects/${id}`).then(setData).catch(e => setError(e.message))
  }
  useEffect(() => { if (id) load() }, [id])

  function cancelExp(expId: string) {
    openConfirm({
      title: '撤回这笔申请?',
      body: '撤回后将无法恢复，需重新提交。',
      confirmLabel: '撤回',
      tone: 'danger',
      onConfirm: async () => {
        try {
          await apiFetch(`/api/capital/expenses/${expId}/cancel`, { method: 'PATCH' })
          load()
        } catch (e: any) {
          alert(e.message || '撤回失败')
          throw e
        }
      },
    })
  }

  if (!data) {
    return (
      <div className="min-h-screen bg-bg flex items-center justify-center">
        {error ? <div className="bg-red-bg text-red-fg rounded-card p-3 text-caption">{error}</div> : <span className="text-caption text-gray3">加载中…</span>}
      </div>
    )
  }

  const spent = Number(data.spent)
  const pendingExpSum = data.expenses
    .filter(e => e.status === 'PENDING_APPROVAL')
    .reduce((s, e) => s + Number(e.amount), 0)
  const approvedExpSum = data.expenses
    .filter(e => e.status === 'APPROVED')
    .reduce((s, e) => s + Number(e.amount), 0)

  return (
    <div className="min-h-screen bg-bg pb-24">
      <header className="px-4 pt-4 pb-2 flex items-center gap-3">
        <button onClick={() => router.back()} className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center">‹</button>
        <div className="flex-1 min-w-0">
          <h1 className="text-h1 truncate">{data.name}</h1>
          <p className="text-caption text-gray3">{data.store?.name || '未关联门店'}</p>
        </div>
        <Chip tone={data.status === 'PREPARING' ? 'orange' : data.status === 'OPERATING' ? 'green' : 'gray'}>
          {data.status === 'PREPARING' ? '筹建中' : data.status === 'OPERATING' ? '已开业' : data.status === 'REPAID' ? '已还清' : '已取消'}
        </Chip>
      </header>

      {/* 概览数字 */}
      <div className="mx-4 mt-3 bg-ink text-white rounded-card p-4">
        <div className="flex items-baseline justify-between mb-1">
          <span className="text-caption text-white/70">已总部代付</span>
          <span className="font-num text-h1">¥{spent.toLocaleString()}</span>
        </div>
        <div className="grid grid-cols-3 gap-3 mt-3 text-caption">
          <div>
            <div className="text-micro text-white/60">合同数</div>
            <div className="font-num text-button">{data.contracts.length}</div>
          </div>
          <div>
            <div className="text-micro text-white/60">待审批</div>
            <div className="font-num text-button text-orange-fg">¥{pendingExpSum.toLocaleString()}</div>
          </div>
          <div>
            <div className="text-micro text-white/60">已批待付</div>
            <div className="font-num text-button text-amber">¥{approvedExpSum.toLocaleString()}</div>
          </div>
        </div>
      </div>

      <div className="px-4 mt-3 flex gap-2 overflow-x-auto">
        {([
          {k:'OVERVIEW',  l:'概览'},
          {k:'CONTRACTS', l:`合同 ${data.contracts.length}`},
          {k:'EXPENSES',  l:`支出 ${data.expenses.length}`},
        ] as const).map(t => (
          <button key={t.k} onClick={() => setTab(t.k)}
            className={`shrink-0 px-3 py-1.5 rounded-cta text-button ${tab === t.k ? 'bg-ink text-white' : 'bg-white border border-border text-gray2'}`}>
            {t.l}
          </button>
        ))}
      </div>

      {tab === 'OVERVIEW' && (
        <div className="px-4 mt-3 space-y-3">
          <div className="bg-white rounded-card border border-border divide-y divide-border">
            <Row label="预算" value={data.budget ? `¥${Number(data.budget).toLocaleString()}` : '未设'} />
            <Row label="还款约定" value={data.repaymentTerms || '未设'} />
            <Row label="立项日" value={fmt(data.startedAt)} />
            <Row label="开业日" value={data.openedAt ? fmt(data.openedAt) : '—'} />
            {data.note && <Row label="备注" value={data.note} />}
          </div>
        </div>
      )}

      {tab === 'CONTRACTS' && (
        <div className="px-4 mt-3 space-y-2">
          {data.contracts.length === 0 && <p className="text-caption text-gray3 text-center py-12">还无合同, 点底部「+ 合同」</p>}
          {data.contracts.map(c => {
            const total = Number(c.totalAmount)
            const paid = Number(c.paidAmount)
            const pct = total > 0 ? Math.round(paid / total * 100) : 0
            return (
              <div key={c.id} className="bg-white rounded-card border border-border p-3">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <Chip tone="gray">{CATEGORY_LABEL[c.category] || c.category}</Chip>
                  {c.status === 'COMPLETED' && <Chip tone="green">已付清</Chip>}
                </div>
                <div className="text-h2">{c.vendor}</div>
                {c.contractNo && <p className="text-micro text-gray3 font-num">#{c.contractNo}</p>}
                <div className="flex items-baseline justify-between mt-1">
                  <span className="text-caption text-gray3">已付 / 总额</span>
                  <span className="font-num">¥{paid.toLocaleString()} / ¥{total.toLocaleString()}</span>
                </div>
                <div className="h-1.5 bg-bg rounded-full overflow-hidden mt-1">
                  <div className="h-full bg-amber" style={{ width: `${pct}%` }} />
                </div>
                {c.fileUrl && <a href={c.fileUrl} target="_blank" rel="noreferrer" className="text-micro text-amber-fg mt-1 inline-block">查看合同 ↗</a>}
              </div>
            )
          })}
        </div>
      )}

      {tab === 'EXPENSES' && (
        <div className="px-4 mt-3 space-y-2">
          {data.expenses.length === 0 && <p className="text-caption text-gray3 text-center py-12">还无申请, 点底部「+ 申请支出」</p>}
          {data.expenses.map(e => (
            <div key={e.id} className="bg-white rounded-card border border-border p-3">
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <Chip tone={EXP_STATUS_TONE[e.status]}>{EXP_STATUS_LABEL[e.status]}</Chip>
                <Chip tone="gray">{CATEGORY_LABEL[e.category] || e.category}</Chip>
                <span className="text-micro text-gray3 ml-auto">{fmt(e.requestedAt)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-h2">{e.vendor}</span>
                <span className="font-num text-h2">¥{Number(e.amount).toLocaleString()}</span>
              </div>
              {e.contract && <p className="text-micro text-gray3 mt-0.5">关联合同: {e.contract.vendor}</p>}
              {e.note && <p className="text-caption text-gray2 mt-0.5">{e.note}</p>}
              {e.status === 'REJECTED' && e.rejectReason && (
                <p className="text-micro text-red-fg mt-1">驳回: {e.rejectReason}</p>
              )}
              {e.status === 'PAID' && e.paidAt && (
                <p className="text-micro text-green-fg mt-1">✓ {fmt(e.paidAt)} 已付款 {e.bankTxNo && <span className="font-num ml-1">流水 {e.bankTxNo.slice(0, 12)}</span>}</p>
              )}
              {e.status === 'PENDING_APPROVAL' && (
                <button onClick={() => cancelExp(e.id)}
                        className="mt-2 px-3 py-1.5 border border-border rounded-cta text-button text-gray2">
                  撤回申请
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* 浮动操作按钮 */}
      <div className="fixed bottom-4 left-4 right-4 flex gap-2">
        <button onClick={() => setDrawer('CONTRACT')}
                className="flex-1 py-3 bg-white border border-border rounded-cta text-button text-gray2">＋ 合同</button>
        <button onClick={() => setDrawer('EXPENSE')}
                className="flex-1 py-3 bg-ink text-white rounded-cta text-button">＋ 申请支出</button>
      </div>

      {drawer && (
        <Drawer
          type={drawer}
          project={data}
          onClose={() => setDrawer(null)}
          onSuccess={() => { setDrawer(null); load() }}
        />
      )}

      <ConfirmSheet {...confirmState} />
    </div>
  )
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="px-3 py-2.5 flex items-center">
      <span className="text-caption text-gray3 w-20">{label}</span>
      <span className="flex-1 text-body">{value}</span>
    </div>
  )
}

function Drawer({ type, project, onClose, onSuccess }: {
  type: 'CONTRACT'|'EXPENSE'
  project: Project
  onClose: () => void
  onSuccess: () => void
}) {
  const [form, setForm] = useState<any>({})
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setError(null); setSubmitting(true)
    try {
      if (type === 'CONTRACT') {
        if (!form.vendor?.trim() || !form.totalAmount) throw new Error('请填供应商和总额')
        await apiFetch('/api/capital/contracts', {
          method: 'POST',
          body: JSON.stringify({
            projectId: project.id,
            category: form.category || 'OTHER',
            vendor: form.vendor,
            contractNo: form.contractNo,
            totalAmount: Number(form.totalAmount),
            startDate: form.startDate, endDate: form.endDate,
            note: form.note,
          }),
        })
      } else {
        if (!form.vendor?.trim() || !form.amount) throw new Error('请填收款方和金额')
        await apiFetch('/api/capital/expenses', {
          method: 'POST',
          body: JSON.stringify({
            projectId: project.id,
            contractId: form.contractId || null,
            category: form.category || 'OTHER',
            vendor: form.vendor,
            amount: Number(form.amount),
            note: form.note,
          }),
        })
      }
      onSuccess()
    } catch (e: any) { setError(e.message || '提交失败') }
    setSubmitting(false)
  }

  return (
    <div className="fixed inset-0 z-50" onClick={() => !submitting && onClose()}>
      <div className="absolute inset-0 bg-ink/60" />
      <div className="absolute bottom-0 left-0 right-0 bg-white rounded-t-card max-h-[85vh] overflow-auto" onClick={e => e.stopPropagation()}>
        <div className="w-12 h-1 bg-gray5 rounded-full mx-auto mt-2" />
        <div className="px-4 pt-3 pb-2">
          <h3 className="text-h2">{type === 'CONTRACT' ? '录合同' : '申请支出'}</h3>
          {type === 'EXPENSE' && <p className="text-caption text-gray3 mt-0.5">提交后由老板/财务审批, 通过后由总部代付</p>}
        </div>

        <div className="px-4 pb-3 space-y-3">
          <Field label="类别 *">
            <select value={form.category || ''} onChange={e => setForm((s: any) => ({...s, category: e.target.value}))} className={IN}>
              <option value="">请选择</option>
              <option value="RENT">租金</option>
              <option value="DECORATION">装修</option>
              <option value="EQUIPMENT">设备</option>
              <option value="PAYROLL">人员</option>
              <option value="LEGAL">证照</option>
              <option value="MARKETING">营销</option>
              <option value="OTHER">其他</option>
            </select>
          </Field>

          {type === 'EXPENSE' && project.contracts.length > 0 && (
            <Field label="关联合同 (推荐)" hint="不关联也可, 但合同对账更清楚">
              <select value={form.contractId || ''} onChange={e => {
                const c = project.contracts.find(x => x.id === e.target.value)
                setForm((s: any) => ({...s, contractId: e.target.value, vendor: c?.vendor || s.vendor, category: c?.category || s.category}))
              }} className={IN}>
                <option value="">无关联</option>
                {project.contracts.filter(c => c.status === 'ACTIVE').map(c => (
                  <option key={c.id} value={c.id}>
                    {CATEGORY_LABEL[c.category]} · {c.vendor} (剩 ¥{(Number(c.totalAmount) - Number(c.paidAmount)).toLocaleString()})
                  </option>
                ))}
              </select>
            </Field>
          )}

          <Field label={type === 'CONTRACT' ? '供应商/收款方 *' : '收款方 *'}>
            <input value={form.vendor || ''} onChange={e => setForm((s: any) => ({...s, vendor: e.target.value}))}
                   placeholder="例: 房东张三 / XX 装饰公司" className={IN} />
          </Field>

          {type === 'CONTRACT' && (
            <>
              <Field label="合同编号 (可选)">
                <input value={form.contractNo || ''} onChange={e => setForm((s: any) => ({...s, contractNo: e.target.value}))} className={IN + ' font-num'} />
              </Field>
              <Field label="合同总额 *">
                <input type="number" step="100" value={form.totalAmount || ''} onChange={e => setForm((s: any) => ({...s, totalAmount: e.target.value}))}
                       className={IN + ' font-num'} placeholder="240000" />
              </Field>
              <Field label="起止日期">
                <div className="flex gap-2">
                  <input type="date" value={form.startDate || ''} onChange={e => setForm((s: any) => ({...s, startDate: e.target.value}))} className={IN} />
                  <input type="date" value={form.endDate || ''} onChange={e => setForm((s: any) => ({...s, endDate: e.target.value}))} className={IN} />
                </div>
              </Field>
            </>
          )}

          {type === 'EXPENSE' && (
            <Field label="申请金额 *">
              <input type="number" step="100" value={form.amount || ''} onChange={e => setForm((s: any) => ({...s, amount: e.target.value}))}
                     className={IN + ' font-num'} placeholder="80000" />
            </Field>
          )}

          <Field label="备注 (可选)">
            <textarea rows={2} value={form.note || ''} onChange={e => setForm((s: any) => ({...s, note: e.target.value}))} className={IN + ' resize-none'} />
          </Field>

          {error && <div className="bg-red-bg text-red-fg rounded-card p-3 text-caption">{error}</div>}
        </div>

        <div className="border-t border-border p-3 flex gap-3">
          <button onClick={onClose} disabled={submitting}
                  className="px-4 py-3 bg-white border border-border rounded-cta text-button text-gray2">取消</button>
          <button onClick={submit} disabled={submitting}
                  className="flex-1 py-3 bg-ink text-white rounded-cta text-button disabled:opacity-40">
            {submitting ? '提交中…' : (type === 'CONTRACT' ? '保存合同' : '提交申请')}
          </button>
        </div>
      </div>
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
