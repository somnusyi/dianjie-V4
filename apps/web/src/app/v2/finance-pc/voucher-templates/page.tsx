/**
 * 财务 PC · 凭证模板管理
 * 复刻 /v2/finance/voucher-templates, PC 桌面布局
 *
 * 周期性建凭证 (房租/水电/折旧 月度), 系统每天 01:00 自动扫描, 到 dayOfMonth 且当月未跑就建草稿
 */
'use client'
import { useEffect, useState } from 'react'
import dayjs from 'dayjs'
import { Chip } from '@/components/v2'
import { apiFetch } from '@/lib/v2-auth'
import FinanceTopNav from '../_topnav'

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

const PRESET = [
  { name: '门店租金',     dayOfMonth: 1,  summary: '{YYYY-MM} 门店租金',
    entries: [
      { accountCode: '560117', accountName: '门店租金',   debit: 8000 },
      { accountCode: '2241',   accountName: '其他应付款', credit: 8000 },
    ] },
  { name: '固定资产折旧', dayOfMonth: 25, summary: '{YYYY-MM} 固定资产折旧计提',
    entries: [
      { accountCode: '560207', accountName: '固定资产折旧', debit: 2000 },
      { accountCode: '1602',   accountName: '累计折旧',     credit: 2000 },
    ] },
  { name: '长期待摊摊销', dayOfMonth: 25, summary: '{YYYY-MM} 装修摊销',
    entries: [
      { accountCode: '560208', accountName: '长期待摊费用摊销', debit: 3000 },
      { accountCode: '1701',   accountName: '长期待摊费用',     credit: 3000 },
    ] },
]

export default function VoucherTemplatesPCPage() {
  const [list, setList] = useState<Template[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Template | null>(null)

  async function reload() {
    try { setList(await apiFetch<Template[]>('/api/voucher-templates')) }
    catch (e: any) { setError(e.message) }
  }
  useEffect(() => { void reload() }, [])

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
    if (!confirm('立即扫描所有模板, 本月未跑的将自动建草稿凭证')) return
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
        body: JSON.stringify({ name: p.name, dayOfMonth: p.dayOfMonth, summary: p.summary, entries: p.entries }),
      })
      await reload()
    } catch (e: any) { alert(e.message) } finally { setBusy(false) }
  }

  return (
    <div className="min-h-screen bg-bg">
      <FinanceTopNav />
      <main className="max-w-[1200px] mx-auto px-6 py-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-h1">凭证模板</h1>
            <p className="text-caption text-gray3">每月自动建草稿 · 系统每天 01:00 扫描 · 房租/水电/折旧 等周期性凭证</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={runNow} disabled={busy}
                    className="px-4 py-2 bg-amber/10 text-amber-fg border border-amber/30 rounded-cta text-button disabled:opacity-40">
              立即扫描
            </button>
            <button onClick={() => { setEditing(null); setShowForm(true) }}
                    className="px-4 py-2 bg-ink text-white rounded-cta text-button">+ 新建模板</button>
          </div>
        </div>

        {error && <div className="bg-red-bg text-red-fg rounded-card p-3 text-caption mb-4">{error}</div>}

        {/* 列表 */}
        <div className="bg-white rounded-card border border-border overflow-hidden mb-4">
          <table className="w-full">
            <thead className="bg-bg/40">
              <tr className="text-micro text-gray3 text-left">
                <th className="px-3 py-2 font-normal">模板名 / 摘要</th>
                <th className="px-3 py-2 font-normal w-32">执行日</th>
                <th className="px-3 py-2 font-normal">分录预览</th>
                <th className="px-3 py-2 font-normal text-right w-28">金额</th>
                <th className="px-3 py-2 font-normal w-32">本月</th>
                <th className="px-3 py-2 font-normal text-right w-40">操作</th>
              </tr>
            </thead>
            <tbody>
              {list === null && (
                <tr><td colSpan={6} className="px-4 py-6 text-center text-caption text-gray3">加载中…</td></tr>
              )}
              {list !== null && list.length === 0 && (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-caption text-gray3">还没有任何模板, 用下方预置一键创建</td></tr>
              )}
              {(list || []).map(t => {
                const entries = Array.isArray(t.entriesJson) ? t.entriesJson : []
                const totalAmount = entries.reduce((s, e: any) => s + Number(e.debit || 0), 0)
                const thisMonth = dayjs().format('YYYY-MM')
                const ranThisMonth = t.lastRunAt && dayjs(t.lastRunAt).format('YYYY-MM') === thisMonth
                return (
                  <tr key={t.id} className="border-t border-border hover:bg-bg/40">
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2 mb-0.5">
                        <Chip tone={t.enabled ? 'green' : 'gray'}>{t.enabled ? '启用' : '已停'}</Chip>
                        <div className="text-body">{t.name}</div>
                      </div>
                      <p className="text-micro text-gray3">{t.summary}</p>
                    </td>
                    <td className="px-3 py-2.5 text-caption font-num">每月 {t.dayOfMonth} 号</td>
                    <td className="px-3 py-2.5">
                      <p className="text-micro text-gray3">
                        {entries.slice(0, 2).map((e: any) =>
                          `${e.accountCode} ${e.accountName} ${Number(e.debit) > 0 ? '借¥' + e.debit : '贷¥' + e.credit}`
                        ).join(' / ')}
                      </p>
                    </td>
                    <td className="px-3 py-2.5 font-num text-right">¥{totalAmount.toLocaleString()}</td>
                    <td className="px-3 py-2.5">
                      {ranThisMonth ? <Chip tone="blue">已跑</Chip> : <Chip tone="gray">未跑</Chip>}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <div className="flex justify-end gap-1.5">
                        {t.lastVoucherId && (
                          <a href={`/v2/finance-pc/vouchers/${t.lastVoucherId}`}
                             className="px-2 py-1 bg-amber/10 text-amber-fg rounded text-caption">最近凭证</a>
                        )}
                        <button onClick={() => toggleEnabled(t)} disabled={busy}
                                className="px-2 py-1 bg-white border border-border rounded text-caption text-gray2">
                          {t.enabled ? '停用' : '启用'}
                        </button>
                        <button onClick={() => del(t)} disabled={busy}
                                className="px-2 py-1 text-caption text-red-fg">删除</button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {/* 预置模板速建 */}
        {list && list.length < PRESET.length && (
          <section className="bg-bg-warm rounded-card border border-border p-4">
            <h2 className="text-h2 mb-2">餐饮常用模板 (一键创建)</h2>
            <p className="text-caption text-gray3 mb-3">点一下快速加入, 金额可后续在凭证里改</p>
            <div className="grid grid-cols-3 gap-3">
              {PRESET.filter(p => !list.find(t => t.name === p.name)).map(p => (
                <button key={p.name} onClick={() => createFromPreset(p)} disabled={busy}
                        className="bg-white rounded-card border border-border p-3 text-left hover:border-ink transition disabled:opacity-40">
                  <div className="flex items-center justify-between mb-1">
                    <div className="text-body">{p.name}</div>
                    <span className="text-amber-fg text-button">+ 加</span>
                  </div>
                  <div className="text-micro text-gray3">每月 {p.dayOfMonth} 号 · 默认 ¥{(p.entries[0]?.debit || 0).toLocaleString()}</div>
                </button>
              ))}
            </div>
          </section>
        )}
      </main>

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
      if (template) await apiFetch(`/api/voucher-templates/${template.id}`, { method: 'PUT', body: JSON.stringify(payload) })
      else await apiFetch('/api/voucher-templates', { method: 'POST', body: JSON.stringify(payload) })
      onSaved()
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-50 bg-ink/40 flex items-center justify-center" onClick={onClose}>
      <div className="bg-white rounded-card max-w-2xl w-full mx-4 max-h-[90vh] overflow-auto" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-border flex items-center justify-between sticky top-0 bg-white z-10">
          <h3 className="text-h2">{template ? '编辑' : '新建'}凭证模板</h3>
          <button onClick={onClose} className="text-gray3 text-h2">×</button>
        </div>
        <div className="p-5 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-micro text-gray3 block mb-1">模板名</label>
              <input value={name} onChange={e => setName(e.target.value)} placeholder="如 门店租金"
                     className="w-full px-3 py-2 rounded-cta border border-border bg-white text-button" />
            </div>
            <div>
              <label className="text-micro text-gray3 block mb-1">执行日 (每月)</label>
              <input type="number" min={1} max={28} value={dayOfMonth} onChange={e => setDay(Number(e.target.value))}
                     className="w-full px-3 py-2 rounded-cta border border-border bg-white text-button font-num" />
            </div>
          </div>
          <div>
            <label className="text-micro text-gray3 block mb-1">摘要 (可用 {'{YYYY-MM}'} 占位)</label>
            <input value={summary} onChange={e => setSummary(e.target.value)}
                   className="w-full px-3 py-2 rounded-cta border border-border bg-white text-button" />
          </div>

          <div>
            <label className="text-micro text-gray3 block mb-2">借贷分录</label>
            <table className="w-full">
              <thead>
                <tr className="text-micro text-gray3 text-left">
                  <th className="px-2 py-1 font-normal w-28">科目码</th>
                  <th className="px-2 py-1 font-normal">科目名</th>
                  <th className="px-2 py-1 font-normal text-right w-28">借 (¥)</th>
                  <th className="px-2 py-1 font-normal text-right w-28">贷 (¥)</th>
                  <th className="px-2 py-1 font-normal w-8"></th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e, i) => (
                  <tr key={i} className="border-t border-border">
                    <td className="px-2 py-1">
                      <input value={e.accountCode} placeholder="科目码"
                             onChange={ev => setEntries(arr => arr.map((x, j) => j === i ? { ...x, accountCode: ev.target.value } : x))}
                             className="w-full px-2 py-1 rounded border border-border bg-white text-caption font-num" />
                    </td>
                    <td className="px-2 py-1">
                      <input value={e.accountName} placeholder="科目名"
                             onChange={ev => setEntries(arr => arr.map((x, j) => j === i ? { ...x, accountName: ev.target.value } : x))}
                             className="w-full px-2 py-1 rounded border border-border bg-white text-caption" />
                    </td>
                    <td className="px-2 py-1">
                      <input type="number" value={e.debit || ''} placeholder="0"
                             onChange={ev => setEntries(arr => arr.map((x, j) => j === i ? { ...x, debit: Number(ev.target.value) } : x))}
                             className="w-full px-2 py-1 rounded border border-border bg-white text-caption font-num text-right" />
                    </td>
                    <td className="px-2 py-1">
                      <input type="number" value={e.credit || ''} placeholder="0"
                             onChange={ev => setEntries(arr => arr.map((x, j) => j === i ? { ...x, credit: Number(ev.target.value) } : x))}
                             className="w-full px-2 py-1 rounded border border-border bg-white text-caption font-num text-right" />
                    </td>
                    <td className="px-2 py-1 text-center">
                      <button onClick={() => setEntries(arr => arr.filter((_, j) => j !== i))}
                              disabled={entries.length <= 2}
                              className="text-red-fg disabled:opacity-30">×</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button onClick={() => setEntries([...entries, { accountCode: '', accountName: '', debit: 0 }])}
                    className="mt-2 px-3 py-1.5 bg-white border border-border rounded text-caption text-amber-fg">+ 加一行</button>
          </div>

          <div className={`flex justify-between items-center p-3 rounded-cta ${isBalanced ? 'bg-green-bg/40' : 'bg-red-bg/40'}`}>
            <span className="text-caption">{isBalanced ? '✓ 借贷平' : '⚠ 借贷不平'}</span>
            <span className="font-num text-caption">借 ¥{sumD.toFixed(2)} / 贷 ¥{sumC.toFixed(2)}</span>
          </div>

          {err && <div className="bg-red-bg text-red-fg rounded-card p-2 text-caption">{err}</div>}
        </div>
        <div className="px-5 py-3 border-t border-border flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 bg-white border border-border rounded-cta text-button text-gray2">取消</button>
          <button onClick={save} disabled={busy || !isBalanced}
                  className="px-4 py-2 bg-ink text-white rounded-cta text-button disabled:opacity-40">
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
