/**
 * 财务 · 凭证模板管理
 * 周期性建凭证 (房租/水电/折旧 月度)
 * 每天 01:00 系统自动扫描, 到 dayOfMonth 且当月未跑就建草稿
 */
'use client'
import { useEffect, useState } from 'react'
import dayjs from 'dayjs'
import { Chip } from '@/components/v2'
import { ErrorScreen } from '@/components/v2/use-dashboard'
import { apiFetch } from '@/lib/v2-auth'

type TemplateEntry = {
  accountCode: string; accountName: string
  debit?: number; credit?: number
  summary?: string
}
type Template = {
  id: string; tenantId: string; name: string; description?: string | null
  dayOfMonth: number; summary: string
  entriesJson: TemplateEntry[]
  enabled: boolean
  lastRunAt?: string | null
  lastVoucherId?: string | null
}

// 预置模板示例 (餐饮常见)
const PRESET = [
  {
    name: '门店租金', dayOfMonth: 1,
    summary: '{YYYY-MM} 门店租金',
    entries: [
      { accountCode: '560117', accountName: '门店租金', debit: 8000 },
      { accountCode: '2241', accountName: '其他应付款', credit: 8000 },
    ],
  },
  {
    name: '固定资产折旧', dayOfMonth: 25,
    summary: '{YYYY-MM} 固定资产折旧计提',
    entries: [
      { accountCode: '560207', accountName: '固定资产折旧', debit: 2000 },
      { accountCode: '1602', accountName: '累计折旧', credit: 2000 },
    ],
  },
  {
    name: '长期待摊摊销', dayOfMonth: 25,
    summary: '{YYYY-MM} 装修摊销',
    entries: [
      { accountCode: '560208', accountName: '长期待摊费用摊销', debit: 3000 },
      { accountCode: '1701', accountName: '长期待摊费用', credit: 3000 },
    ],
  },
]

export default function VoucherTemplatesPage() {
  const [list, setList] = useState<Template[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Template | null>(null)

  async function reload() {
    try {
      const d = await apiFetch<Template[]>('/api/voucher-templates')
      setList(d)
    } catch (e: any) {
      setError(e.message)
    }
  }
  useEffect(() => { reload() }, [])

  async function toggleEnabled(t: Template) {
    setBusy(true)
    try {
      await apiFetch(`/api/voucher-templates/${t.id}`, {
        method: 'PUT', body: JSON.stringify({ enabled: !t.enabled }),
      })
      await reload()
    } catch (e: any) { alert(e.message) } finally { setBusy(false) }
  }
  async function del(t: Template) {
    if (!confirm(`删除模板「${t.name}」?`)) return
    setBusy(true)
    try {
      await apiFetch(`/api/voucher-templates/${t.id}`, { method: 'DELETE' })
      await reload()
    } catch (e: any) { alert(e.message) } finally { setBusy(false) }
  }
  async function runNow() {
    if (!confirm('立即扫描所有模板,本月未跑的将自动建草稿凭证')) return
    setBusy(true)
    try {
      const r = await apiFetch<any>('/api/voucher-templates/run-now', { method: 'POST' })
      alert(`生成 ${r.run} 笔凭证, 跳过 ${r.skipped} 笔`)
      await reload()
    } catch (e: any) { alert(e.message) } finally { setBusy(false) }
  }
  async function createFromPreset(p: typeof PRESET[number]) {
    setBusy(true)
    try {
      await apiFetch('/api/voucher-templates', {
        method: 'POST',
        body: JSON.stringify({
          name: p.name, dayOfMonth: p.dayOfMonth, summary: p.summary, entries: p.entries,
        }),
      })
      await reload()
    } catch (e: any) { alert(e.message) } finally { setBusy(false) }
  }

  if (error) return <ErrorScreen message={error} />

  return (
    <div className="min-h-screen bg-bg pb-32">
      <header className="px-4 pt-4 pb-2">
        <h1 className="text-h1">凭证模板</h1>
        <p className="text-caption text-gray3">每月自动建草稿 · 系统每天 01:00 扫描</p>
      </header>

      {/* 顶部操作 */}
      <div className="mx-4 mt-3 flex gap-2 flex-wrap">
        <button onClick={() => { setEditing(null); setShowForm(true) }}
                className="px-3 py-2 bg-ink text-white rounded-cta text-button">
          + 新建模板
        </button>
        <button onClick={runNow} disabled={busy}
                className="px-3 py-2 bg-amber/10 text-amber-fg rounded-cta text-button disabled:opacity-40">
          立即扫描
        </button>
      </div>

      {/* 列表 */}
      <ul className="px-4 mt-3 space-y-2">
        {list === null && <li className="text-caption text-gray3 text-center py-12">加载中…</li>}
        {list !== null && list.length === 0 && (
          <li className="bg-white rounded-card border border-border p-6 text-center">
            <p className="text-caption text-gray3 mb-3">还没有任何模板</p>
            <p className="text-micro text-gray3">下方有 3 个常用预置,点一下就能用</p>
          </li>
        )}
        {(list || []).map(t => {
          const entries = Array.isArray(t.entriesJson) ? t.entriesJson : []
          const totalAmount = entries.reduce((s, e: any) => s + Number(e.debit || 0), 0)
          const thisMonth = dayjs().format('YYYY-MM')
          const ranThisMonth = t.lastRunAt && dayjs(t.lastRunAt).format('YYYY-MM') === thisMonth
          return (
            <li key={t.id} className="bg-white rounded-card border border-border p-3">
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <Chip tone={t.enabled ? 'green' : 'gray'}>{t.enabled ? '启用' : '已停'}</Chip>
                {ranThisMonth && <Chip tone="blue">本月已跑</Chip>}
                <span className="text-micro text-gray3 ml-auto">每月 {t.dayOfMonth} 号</span>
              </div>
              <div className="flex items-baseline justify-between">
                <span className="text-h2">{t.name}</span>
                <span className="font-num text-body">¥{totalAmount.toLocaleString()}</span>
              </div>
              <p className="text-caption text-gray2 mt-1">{t.summary}</p>
              <p className="text-micro text-gray3 mt-1">
                {entries.slice(0, 2).map((e: any) =>
                  `${e.accountCode} ${e.accountName} ${Number(e.debit) > 0 ? '借 ¥' + e.debit : '贷 ¥' + e.credit}`
                ).join(' / ')}
              </p>
              <div className="mt-2 flex gap-2">
                <button onClick={() => toggleEnabled(t)} disabled={busy}
                        className="px-3 py-1 bg-white border border-border rounded-cta text-micro disabled:opacity-40">
                  {t.enabled ? '停用' : '启用'}
                </button>
                <button onClick={() => del(t)} disabled={busy}
                        className="px-3 py-1 border border-red text-red rounded-cta text-micro disabled:opacity-40">
                  删除
                </button>
                {t.lastVoucherId && (
                  <a href={`/v2/finance/vouchers/${t.lastVoucherId}`}
                     className="px-3 py-1 bg-amber/10 text-amber-fg rounded-cta text-micro ml-auto">看最近</a>
                )}
              </div>
            </li>
          )
        })}
      </ul>

      {/* 预置模板速建 */}
      {list && list.length < PRESET.length && (
        <div className="mx-4 mt-4 bg-bg-warm rounded-card border border-border p-3">
          <div className="text-h2 mb-2">餐饮常用模板</div>
          <p className="text-micro text-gray3 mb-2">点一下快速加入,金额可后续在凭证里改</p>
          {PRESET.filter(p => !list.find(t => t.name === p.name)).map(p => (
            <button key={p.name} onClick={() => createFromPreset(p)} disabled={busy}
                    className="block w-full text-left bg-white rounded-card border border-border p-3 mb-2 disabled:opacity-40">
              <div className="flex justify-between items-center">
                <div>
                  <div className="text-body">{p.name}</div>
                  <div className="text-micro text-gray3 mt-0.5">每月 {p.dayOfMonth} 号 · 默认 ¥{(p.entries[0]?.debit || 0).toLocaleString()}</div>
                </div>
                <span className="text-amber-fg text-button">+ 加</span>
              </div>
            </button>
          ))}
        </div>
      )}

      {showForm && (
        <TemplateForm
          template={editing}
          onClose={() => setShowForm(false)}
          onSaved={async () => { setShowForm(false); await reload() }}
        />
      )}
    </div>
  )
}

function TemplateForm({ template, onClose, onSaved }: {
  template: Template | null; onClose: () => void; onSaved: () => void
}) {
  const [name, setName] = useState(template?.name || '')
  const [dayOfMonth, setDay] = useState(template?.dayOfMonth || 1)
  const [summary, setSummary] = useState(template?.summary || '{YYYY-MM} ')
  const [entries, setEntries] = useState<TemplateEntry[]>(
    template?.entriesJson || [
      { accountCode: '', accountName: '', debit: 0 },
      { accountCode: '', accountName: '', credit: 0 },
    ]
  )
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const sumD = entries.reduce((s, e) => s + Number(e.debit || 0), 0)
  const sumC = entries.reduce((s, e) => s + Number(e.credit || 0), 0)
  const isBalanced = Math.abs(sumD - sumC) < 0.01

  async function save() {
    if (!name.trim()) { setErr('请填模板名'); return }
    if (!summary.trim()) { setErr('请填摘要'); return }
    if (!isBalanced) { setErr('借贷不平'); return }
    if (sumD < 0.01) { setErr('金额为 0'); return }
    setErr(null); setBusy(true)
    try {
      const payload = { name, dayOfMonth, summary, entries }
      if (template) {
        await apiFetch(`/api/voucher-templates/${template.id}`, { method: 'PUT', body: JSON.stringify(payload) })
      } else {
        await apiFetch('/api/voucher-templates', { method: 'POST', body: JSON.stringify(payload) })
      }
      onSaved()
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-50 bg-ink/60 flex items-end" onClick={onClose}>
      <div className="bg-white w-full rounded-t-card max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="w-12 h-1 bg-gray5 rounded-full mx-auto mt-2" />
        <div className="px-4 pt-3 pb-2">
          <h3 className="text-h2">{template ? '编辑' : '新建'}凭证模板</h3>
        </div>
        <div className="px-4 space-y-3 pb-3">
          <div>
            <label className="text-micro text-gray3 block mb-1">模板名</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="如 门店租金"
                   className="w-full bg-bg rounded-cta px-3 py-2 text-body" />
          </div>
          <div>
            <label className="text-micro text-gray3 block mb-1">执行日 (每月)</label>
            <input type="number" min={1} max={28} value={dayOfMonth} onChange={e => setDay(Number(e.target.value))}
                   className="w-full bg-bg rounded-cta px-3 py-2 text-body font-num" />
          </div>
          <div>
            <label className="text-micro text-gray3 block mb-1">摘要 (可用 {'{YYYY-MM}'} 占位)</label>
            <input value={summary} onChange={e => setSummary(e.target.value)}
                   className="w-full bg-bg rounded-cta px-3 py-2 text-body" />
          </div>
          <div>
            <label className="text-micro text-gray3 block mb-1">借贷分录</label>
            {entries.map((e, i) => (
              <div key={i} className="grid grid-cols-12 gap-1 mb-1.5">
                <input value={e.accountCode} placeholder="科目码"
                       onChange={ev => setEntries(arr => arr.map((x, j) => j === i ? { ...x, accountCode: ev.target.value } : x))}
                       className="col-span-3 bg-bg rounded-chip px-2 py-1 text-caption font-num" />
                <input value={e.accountName} placeholder="科目名"
                       onChange={ev => setEntries(arr => arr.map((x, j) => j === i ? { ...x, accountName: ev.target.value } : x))}
                       className="col-span-4 bg-bg rounded-chip px-2 py-1 text-caption" />
                <input type="number" value={e.debit || ''} placeholder="借"
                       onChange={ev => setEntries(arr => arr.map((x, j) => j === i ? { ...x, debit: Number(ev.target.value) } : x))}
                       className="col-span-2 bg-bg rounded-chip px-2 py-1 text-caption font-num text-right" />
                <input type="number" value={e.credit || ''} placeholder="贷"
                       onChange={ev => setEntries(arr => arr.map((x, j) => j === i ? { ...x, credit: Number(ev.target.value) } : x))}
                       className="col-span-2 bg-bg rounded-chip px-2 py-1 text-caption font-num text-right" />
                <button onClick={() => setEntries(arr => arr.filter((_, j) => j !== i))}
                        disabled={entries.length <= 2}
                        className="col-span-1 text-gray3 disabled:opacity-30">×</button>
              </div>
            ))}
            <button onClick={() => setEntries([...entries, { accountCode: '', accountName: '', debit: 0 }])}
                    className="text-caption text-amber-fg">+ 加一行</button>
          </div>

          <div className={`flex justify-between p-2 rounded-cta ${isBalanced ? 'bg-green-bg' : 'bg-red-bg'}`}>
            <span className="text-caption">{isBalanced ? '✓ 借贷平' : '⚠ 借贷不平'}</span>
            <span className="font-num text-caption">借 ¥{sumD.toFixed(2)} / 贷 ¥{sumC.toFixed(2)}</span>
          </div>

          {err && <div className="bg-red-bg text-red-fg rounded-card p-2 text-caption">{err}</div>}

          <div className="flex gap-2 pt-2">
            <button onClick={onClose} className="flex-1 py-3 bg-white border border-border rounded-cta text-button text-gray2">取消</button>
            <button onClick={save} disabled={busy || !isBalanced} className="flex-1 py-3 bg-ink text-white rounded-cta text-button disabled:opacity-40">
              {busy ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
