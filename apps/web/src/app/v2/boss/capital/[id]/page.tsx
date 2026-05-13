/**
 * 老板/财务 · 代付项目详情
 *
 * Tab: 概览 · 合同 · 支出 · 还款
 *   - 概览:总投入 / 已还 / 待还, 关联门店, 还款约定
 *   - 合同:按类别分组, 每份合同显示已付/总额
 *   - 支出:每笔实际付款, 含凭证
 *   - 还款:门店向总部偿还历史
 */
'use client'
import { useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { apiFetch } from '@/lib/v2-auth'
import { Chip } from '@/components/v2'

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
  amount: string | number; paidAt: string
  paymentMethod: string; bankTxNo?: string | null
  fileUrl?: string | null; note?: string | null
  status: string
  contract?: { id: string; vendor: string; category: string } | null
}
type Repayment = {
  id: string; amount: string | number; paidAt: string
  source: string; bankTxNo?: string | null; note?: string | null
}
type Project = {
  id: string; name: string; type: string; status: string
  budget?: string | number | null
  spent: string | number; repaidAmount: string | number
  remainingDebt: number; progressPct: number | null
  startedAt: string; openedAt?: string | null; closedAt?: string | null
  repaymentTerms?: string | null; note?: string | null
  store?: { id: string; name: string; no: string } | null
  contracts: Contract[]
  expenses: Expense[]
  repayments: Repayment[]
}

const CATEGORY_LABEL: Record<string, string> = {
  RENT: '租金', DECORATION: '装修', EQUIPMENT: '设备',
  PAYROLL: '人员', LEGAL: '证照', MARKETING: '营销', OTHER: '其他',
}
const CATEGORY_TONE: Record<string, string> = {
  RENT: 'bg-blue-500', DECORATION: 'bg-orange', EQUIPMENT: 'bg-amber',
  PAYROLL: 'bg-green', LEGAL: 'bg-red', MARKETING: 'bg-amber', OTHER: 'bg-gray3',
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

export default function CapitalDetailPage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const id = params?.id as string
  const [data, setData] = useState<Project | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<'OVERVIEW'|'CONTRACTS'|'EXPENSES'|'REPAYMENTS'>('OVERVIEW')
  const [drawer, setDrawer] = useState<'CONTRACT'|'EXPENSE'|'REPAYMENT'|null>(null)

  function load() {
    apiFetch<Project>(`/api/capital/projects/${id}`).then(setData).catch(e => setError(e.message))
  }
  useEffect(() => { if (id) load() }, [id])

  // 合同按类别分组
  const grouped = useMemo(() => {
    if (!data) return []
    const map: Record<string, Contract[]> = {}
    data.contracts.forEach(c => {
      if (!map[c.category]) map[c.category] = []
      map[c.category].push(c)
    })
    return Object.entries(map)
  }, [data])

  if (!data) {
    return (
      <div className="min-h-screen bg-bg flex items-center justify-center">
        {error ? <div className="bg-red-bg text-red-fg rounded-card p-3 text-caption">{error}</div> : <span className="text-caption text-gray3">加载中…</span>}
      </div>
    )
  }

  const spent = Number(data.spent)
  const repaid = Number(data.repaidAmount)
  const repaidPct = spent > 0 ? Math.round(repaid / spent * 100) : 0

  return (
    <div className="min-h-screen bg-bg pb-20">
      <header className="px-4 pt-4 pb-2 flex items-center gap-3">
        <button onClick={() => router.back()} className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center">‹</button>
        <div className="flex-1 min-w-0">
          <h1 className="text-h1 truncate">{data.name}</h1>
          <p className="text-caption text-gray3">{data.store?.name || '未关联门店'}</p>
        </div>
        <Chip tone={STATUS_TONE[data.status]}>{STATUS_LABEL[data.status]}</Chip>
      </header>

      {/* Hero 数字 */}
      <div className="mx-4 mt-3 bg-ink text-white rounded-card p-4">
        <div className="flex items-baseline justify-between mb-1">
          <span className="text-caption text-white/70">总部待收回</span>
          <span className="font-num text-h1">¥{data.remainingDebt.toLocaleString()}</span>
        </div>
        <div className="grid grid-cols-3 gap-3 mt-3 text-caption">
          <div>
            <div className="text-micro text-white/60">总投入</div>
            <div className="font-num text-button">¥{spent.toLocaleString()}</div>
          </div>
          <div>
            <div className="text-micro text-white/60">已收回</div>
            <div className="font-num text-button text-amber">¥{repaid.toLocaleString()}</div>
          </div>
          <div>
            <div className="text-micro text-white/60">回款率</div>
            <div className="font-num text-button">{repaidPct}%</div>
          </div>
        </div>
        {/* 进度条 */}
        {spent > 0 && (
          <div className="h-1.5 bg-white/10 rounded-full overflow-hidden mt-3">
            <div className="h-full bg-amber transition-all" style={{ width: `${repaidPct}%` }} />
          </div>
        )}
      </div>

      {/* Tab */}
      <div className="px-4 mt-3 flex gap-2 overflow-x-auto">
        {([
          {k:'OVERVIEW',  l:'概览'},
          {k:'CONTRACTS', l:`合同 ${data.contracts.length}`},
          {k:'EXPENSES',  l:`支出 ${data.expenses.length}`},
          {k:'REPAYMENTS',l:`还款 ${data.repayments.length}`},
        ] as const).map(t => (
          <button key={t.k} onClick={() => setTab(t.k)}
            className={`shrink-0 px-3 py-1.5 rounded-cta text-button ${tab === t.k ? 'bg-ink text-white' : 'bg-white border border-border text-gray2'}`}>
            {t.l}
          </button>
        ))}
      </div>

      {tab === 'OVERVIEW' && (
        <div className="px-4 mt-3 space-y-3">
          <Card>
            <Row label="预算" value={data.budget ? `¥${Number(data.budget).toLocaleString()}` : '未设'} />
            <Row label="还款约定" value={data.repaymentTerms || '未设'} />
            <Row label="立项日" value={fmt(data.startedAt)} />
            <Row label="开业日" value={data.openedAt ? fmt(data.openedAt) : '—'} />
            {data.note && <Row label="备注" value={data.note} />}
          </Card>
          {/* 类别小计 */}
          <Card title="按类别小计">
            {Object.entries(CATEGORY_LABEL).map(([k, label]) => {
              const sum = data.expenses.filter(e => e.category === k).reduce((s, e) => s + Number(e.amount), 0)
              if (sum === 0) return null
              const pct = spent > 0 ? Math.round(sum / spent * 100) : 0
              return (
                <div key={k} className="px-3 py-2 border-b border-border last:border-b-0">
                  <div className="flex items-center justify-between">
                    <span className="text-body">{label}</span>
                    <span className="font-num text-body">¥{sum.toLocaleString()} <span className="text-micro text-gray3">{pct}%</span></span>
                  </div>
                  <div className="h-1 bg-bg rounded-full overflow-hidden mt-1">
                    <div className={`h-full ${CATEGORY_TONE[k] || 'bg-gray3'}`} style={{ width: `${pct}%` }} />
                  </div>
                </div>
              )
            })}
            {data.expenses.length === 0 && (
              <p className="text-caption text-gray3 text-center py-3">还无支出</p>
            )}
          </Card>
        </div>
      )}

      {tab === 'CONTRACTS' && (
        <div className="px-4 mt-3 space-y-2">
          {grouped.length === 0 && <p className="text-caption text-gray3 text-center py-12">还无合同, 点底部按钮录入</p>}
          {grouped.map(([cat, list]) => (
            <div key={cat}>
              <h3 className="text-button text-gray2 my-2 px-1">{CATEGORY_LABEL[cat]} ({list.length})</h3>
              <ul className="bg-white rounded-card border border-border divide-y divide-border">
                {list.map(c => {
                  const total = Number(c.totalAmount)
                  const paid = Number(c.paidAmount)
                  const pct = total > 0 ? Math.round(paid / total * 100) : 0
                  return (
                    <li key={c.id} className="px-3 py-3">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-h2">{c.vendor}</span>
                        {c.status === 'COMPLETED' && <Chip tone="green">已付清</Chip>}
                        {c.status === 'TERMINATED' && <Chip tone="gray">已终止</Chip>}
                      </div>
                      {c.contractNo && <p className="text-micro text-gray3 font-num">#{c.contractNo}</p>}
                      <div className="flex items-baseline justify-between mt-1">
                        <span className="text-caption text-gray3">已付 / 总额</span>
                        <span className="font-num">¥{paid.toLocaleString()} / ¥{total.toLocaleString()}</span>
                      </div>
                      <div className="h-1.5 bg-bg rounded-full overflow-hidden mt-1">
                        <div className="h-full bg-amber" style={{ width: `${pct}%` }} />
                      </div>
                      <p className="text-micro text-gray3 mt-1">{c._count.expenses} 笔支出</p>
                      {c.fileUrl && <a href={c.fileUrl} target="_blank" rel="noreferrer" className="text-micro text-amber-fg mt-1 inline-block">查看合同 ↗</a>}
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </div>
      )}

      {tab === 'EXPENSES' && (
        <div className="px-4 mt-3">
          {data.expenses.length === 0 ? (
            <p className="text-caption text-gray3 text-center py-12">还无支出</p>
          ) : (
            <ul className="bg-white rounded-card border border-border divide-y divide-border">
              {data.expenses.map(e => (
                <li key={e.id} className="px-3 py-3">
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <Chip tone="gray">{CATEGORY_LABEL[e.category] || e.category}</Chip>
                      <span className="text-h2">{e.vendor}</span>
                    </div>
                    <span className="font-num text-h2">¥{Number(e.amount).toLocaleString()}</span>
                  </div>
                  <p className="text-caption text-gray2">
                    {fmt(e.paidAt)} · {e.paymentMethod}
                    {e.bankTxNo && <span className="ml-2 font-num">流水 {e.bankTxNo.slice(0, 12)}</span>}
                  </p>
                  {e.contract && (
                    <p className="text-micro text-gray3 mt-0.5">关联合同: {e.contract.vendor}</p>
                  )}
                  {e.note && <p className="text-micro text-gray3 mt-0.5">{e.note}</p>}
                  {e.fileUrl && <a href={e.fileUrl} target="_blank" rel="noreferrer" className="text-micro text-amber-fg mt-1 inline-block">凭证 ↗</a>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {tab === 'REPAYMENTS' && (
        <div className="px-4 mt-3">
          {data.repayments.length === 0 ? (
            <p className="text-caption text-gray3 text-center py-12">还无还款</p>
          ) : (
            <ul className="bg-white rounded-card border border-border divide-y divide-border">
              {data.repayments.map(r => (
                <li key={r.id} className="px-3 py-3">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-h2">还款</span>
                    <span className="font-num text-h2 text-amber-fg">+¥{Number(r.amount).toLocaleString()}</span>
                  </div>
                  <p className="text-caption text-gray2">
                    {fmt(r.paidAt)} · {r.source}
                    {r.bankTxNo && <span className="ml-2 font-num">流水 {r.bankTxNo.slice(0, 12)}</span>}
                  </p>
                  {r.note && <p className="text-micro text-gray3 mt-0.5">{r.note}</p>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* 浮动操作按钮 */}
      <div className="fixed bottom-4 left-4 right-4 flex gap-2">
        <button onClick={() => setDrawer('CONTRACT')}
                className="flex-1 py-3 bg-white border border-border rounded-cta text-button text-gray2">＋ 合同</button>
        <button onClick={() => setDrawer('EXPENSE')}
                className="flex-1 py-3 bg-ink text-white rounded-cta text-button">＋ 支出</button>
        <button onClick={() => setDrawer('REPAYMENT')}
                className="flex-1 py-3 bg-amber text-white rounded-cta text-button">＋ 还款</button>
      </div>

      {drawer && (
        <Drawer
          type={drawer}
          project={data}
          onClose={() => setDrawer(null)}
          onSuccess={() => { setDrawer(null); load() }}
        />
      )}
    </div>
  )
}

function Card({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div>
      {title && <h3 className="text-button text-gray2 my-2 px-1">{title}</h3>}
      <div className="bg-white rounded-card border border-border divide-y divide-border">{children}</div>
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

// 操作抽屉
function Drawer({ type, project, onClose, onSuccess }: {
  type: 'CONTRACT'|'EXPENSE'|'REPAYMENT'
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
      } else if (type === 'EXPENSE') {
        if (!form.vendor?.trim() || !form.amount) throw new Error('请填供应商和金额')
        await apiFetch('/api/capital/expenses', {
          method: 'POST',
          body: JSON.stringify({
            projectId: project.id,
            contractId: form.contractId || null,
            category: form.category || 'OTHER',
            vendor: form.vendor,
            amount: Number(form.amount),
            paidAt: form.paidAt || new Date().toISOString().slice(0, 10),
            paymentMethod: form.paymentMethod || 'cmb',
            bankTxNo: form.bankTxNo,
            note: form.note,
          }),
        })
      } else if (type === 'REPAYMENT') {
        if (!form.amount) throw new Error('请填还款金额')
        if (!project.store) throw new Error('项目未关联门店, 不能还款')
        await apiFetch('/api/capital/repayments', {
          method: 'POST',
          body: JSON.stringify({
            projectId: project.id,
            storeId: project.store.id,
            amount: Number(form.amount),
            paidAt: form.paidAt || new Date().toISOString().slice(0, 10),
            source: form.source || 'MANUAL',
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
          <h3 className="text-h2">
            {type === 'CONTRACT' ? '录合同' : type === 'EXPENSE' ? '录支出' : '录还款'}
          </h3>
        </div>

        <div className="px-4 pb-3 space-y-3">
          {(type === 'CONTRACT' || type === 'EXPENSE') && (
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
          )}
          {type === 'EXPENSE' && project.contracts.length > 0 && (
            <Field label="关联合同 (可选)" hint="选合同则会累加合同已付金额">
              <select value={form.contractId || ''} onChange={e => {
                const c = project.contracts.find(x => x.id === e.target.value)
                setForm((s: any) => ({...s, contractId: e.target.value, vendor: c?.vendor || s.vendor, category: c?.category || s.category}))
              }} className={IN}>
                <option value="">无关联</option>
                {project.contracts.filter(c => c.status === 'ACTIVE').map(c => (
                  <option key={c.id} value={c.id}>{CATEGORY_LABEL[c.category]} · {c.vendor} (剩 ¥{(Number(c.totalAmount) - Number(c.paidAmount)).toLocaleString()})</option>
                ))}
              </select>
            </Field>
          )}
          {(type === 'CONTRACT' || type === 'EXPENSE') && (
            <Field label="供应商/收款方 *">
              <input value={form.vendor || ''} onChange={e => setForm((s: any) => ({...s, vendor: e.target.value}))}
                     placeholder="例: 房东张三 / XX 装饰公司" className={IN} />
            </Field>
          )}
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
            <>
              <Field label="本次付款金额 *">
                <input type="number" step="100" value={form.amount || ''} onChange={e => setForm((s: any) => ({...s, amount: e.target.value}))}
                       className={IN + ' font-num'} placeholder="例: 80000" />
              </Field>
              <Field label="付款日">
                <input type="date" value={form.paidAt || new Date().toISOString().slice(0, 10)}
                       onChange={e => setForm((s: any) => ({...s, paidAt: e.target.value}))} className={IN} />
              </Field>
              <Field label="付款方式">
                <select value={form.paymentMethod || 'cmb'} onChange={e => setForm((s: any) => ({...s, paymentMethod: e.target.value}))} className={IN}>
                  <option value="cmb">招行 cmb 转账</option>
                  <option value="manual">手工记账</option>
                  <option value="wechat">微信</option>
                  <option value="alipay">支付宝</option>
                </select>
              </Field>
              <Field label="银行流水号 (可选)">
                <input value={form.bankTxNo || ''} onChange={e => setForm((s: any) => ({...s, bankTxNo: e.target.value}))} className={IN + ' font-num'} />
              </Field>
            </>
          )}
          {type === 'REPAYMENT' && (
            <>
              <Field label="还款金额 *" hint={`待还 ¥${project.remainingDebt.toLocaleString()}`}>
                <input type="number" step="100" value={form.amount || ''} onChange={e => setForm((s: any) => ({...s, amount: e.target.value}))}
                       max={project.remainingDebt} className={IN + ' font-num'} />
              </Field>
              <Field label="还款日">
                <input type="date" value={form.paidAt || new Date().toISOString().slice(0, 10)}
                       onChange={e => setForm((s: any) => ({...s, paidAt: e.target.value}))} className={IN} />
              </Field>
              <Field label="来源">
                <select value={form.source || 'MANUAL'} onChange={e => setForm((s: any) => ({...s, source: e.target.value}))} className={IN}>
                  <option value="MANUAL">手工录入</option>
                  <option value="AUTO_FROM_PROFIT">自动 (利润抽成)</option>
                  <option value="TRANSFER">银行转账</option>
                </select>
              </Field>
            </>
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
            {submitting ? '提交中…' : '保存'}
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
