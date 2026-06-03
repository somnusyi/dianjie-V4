/**
 * 财务 PC · 建店成本台账 - 门店选择 + 单店详情
 *
 * 复刻同事 /v2/budget + /v2/budget/[storeId] 手机端到 PC.
 * 数据接同样的 /api/budgets/* endpoints.
 *
 * 单店模式默认只显示一家店, 自动展开
 */
'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { apiFetch } from '@/lib/v2-auth'
import * as XLSX from 'xlsx'
import { Chip } from '@/components/v2'
import FinanceTopNav from '../_topnav'

const CATEGORY_LABEL: Record<string, string> = {
  CONTRACT: '合同', CONSTRUCTION: '装修工程', FIRE: '消防',
  HVAC: '空调', VENTILATION: '油烟排风', EQUIPMENT: '设备',
  MARKETING: '市场', HR: '人事', OTHER: '其它',
}
const CATEGORY_ORDER = ['CONTRACT','CONSTRUCTION','FIRE','HVAC','VENTILATION','EQUIPMENT','MARKETING','HR','OTHER']

type Row = {
  id: string; category: string; name: string
  budget: number | null; contractAmount: number | null; paidAmount: number | null
  approvalNo: string | null; note: string | null; voucherUrl: string | null
  rowOrder: number
}
type Summary = {
  totals: { budget: number; contractAmount: number; paidAmount: number; rowCount: number }
  byCategory: Array<{ category: string; budget: number; contractAmount: number; paidAmount: number; count: number }>
}
type Store = { id: string; name: string; no: string }

const fmt = (n: number | null | undefined) => n == null ? '—' : Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtBig = (n: number | null | undefined) => {
  if (n == null) return '0'
  const v = Number(n)
  if (Math.abs(v) >= 10000) return (v / 10000).toFixed(1) + '万'
  return v.toLocaleString('zh-CN', { maximumFractionDigits: 0 })
}

function mapCategory(s: string): string {
  const m: Record<string, string> = {
    '合同': 'CONTRACT', '装修工程': 'CONSTRUCTION', '消防': 'FIRE',
    '空调': 'HVAC', '油烟排风': 'VENTILATION', '其它': 'OTHER', '其他': 'OTHER',
    '设备': 'EQUIPMENT', '市场': 'MARKETING', '人事': 'HR',
  }
  return m[s.trim()] || 'OTHER'
}
function parseAmount(v: any): number | null {
  if (v == null || v === '') return null
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^\d.\-]/g, ''))
  return isNaN(n) ? null : n
}

export default function BudgetPCPage() {
  const [stores, setStores] = useState<Store[]>([])
  const [storeId, setStoreId] = useState<string>('')
  const [rows, setRows] = useState<Row[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<Row | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [importPreview, setImportPreview] = useState<any[] | null>(null)
  const [importing, setImporting] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    apiFetch<Store[] | { items: Store[] }>('/api/stores').then(d => {
      const arr = Array.isArray(d) ? d : (d.items || [])
      setStores(arr)
      if (arr.length === 1) setStoreId(arr[0].id)
    }).catch(() => {}).finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (!storeId) { setRows([]); setSummary(null); return }
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId])

  async function refresh() {
    setError(null)
    try {
      const [list, summ] = await Promise.all([
        apiFetch<Row[]>(`/api/budgets?storeId=${storeId}`),
        apiFetch<Summary>(`/api/budgets/summary?storeId=${storeId}`).catch(() => null),
      ])
      setRows(Array.isArray(list) ? list : [])
      setSummary(summ)
    } catch (e: any) { setError(e?.message || '加载失败') }
  }

  async function onPickExcel(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setError(null)
    try {
      const buf = await file.arrayBuffer()
      const wb = XLSX.read(buf, { type: 'array' })
      const sheet = wb.Sheets[wb.SheetNames[0]]
      const rs: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' })
      let headerRow = -1
      for (let i = 0; i < rs.length; i++) {
        if (String(rs[i][0]).trim() === '类别' && String(rs[i][1]).trim() === '明细') {
          headerRow = i; break
        }
      }
      if (headerRow < 0) throw new Error('找不到表头, 标准模板需 类别|明细|预算金额|实付金额|已付金额|备注|审批编号')
      const items: any[] = []
      let currentCat = ''
      for (let i = headerRow + 1; i < rs.length; i++) {
        const row = rs[i]
        const cat = String(row[0] || '').trim()
        const name = String(row[1] || '').trim()
        if (cat) currentCat = cat
        if (!name || name.includes('总计') || name.includes('合计')) continue
        items.push({
          category: mapCategory(currentCat), name,
          budget: parseAmount(row[2]),
          contractAmount: parseAmount(row[3]),
          paidAmount: parseAmount(row[4]),
          note: row[5] ? String(row[5]).trim() : null,
          approvalNo: row[6] ? String(row[6]).trim() : null,
        })
      }
      if (items.length === 0) throw new Error('Excel 里没识别到任何行')
      setImportPreview(items)
    } catch (err: any) {
      setError(err?.message || 'Excel 解析失败')
    } finally {
      e.target.value = ''
    }
  }

  async function confirmImport(replace: boolean) {
    if (!importPreview) return
    setImporting(true); setError(null)
    try {
      await apiFetch('/api/budgets/import-rows', {
        method: 'POST',
        body: JSON.stringify({ storeId, rows: importPreview, replace }),
      })
      setImportPreview(null)
      await refresh()
    } catch (e: any) { setError(e?.message || '导入失败') }
    finally { setImporting(false) }
  }

  async function deleteRow(row: Row) {
    if (!confirm(`确认删除「${row.name}」?`)) return
    try {
      await apiFetch(`/api/budgets/${row.id}`, { method: 'DELETE' })
      await refresh()
    } catch (e: any) { alert(e?.message || '删除失败') }
  }

  // 按 category 分组
  const groupedRows = useMemo(() => {
    const m = new Map<string, Row[]>()
    rows.forEach(r => {
      if (!m.has(r.category)) m.set(r.category, [])
      m.get(r.category)!.push(r)
    })
    return CATEGORY_ORDER.filter(k => m.has(k)).map(k => ({ category: k, items: m.get(k)!.sort((a, b) => a.rowOrder - b.rowOrder) }))
  }, [rows])

  const remaining = summary ? summary.totals.budget - summary.totals.paidAmount : 0
  const progress = summary && summary.totals.budget > 0 ? (summary.totals.paidAmount / summary.totals.budget) * 100 : 0

  return (
    <div className="min-h-screen bg-bg">
      <FinanceTopNav />
      <main className="max-w-[1600px] mx-auto px-6 py-6">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <div>
            <h1 className="text-h1">建店成本台账</h1>
            <p className="text-caption text-gray3">各项目预算 / 合同额 / 已付 / 待付, 实时台账 (财务/老板可改)</p>
          </div>
          {storeId && (
            <div className="flex items-center gap-2">
              <select value={storeId} onChange={e => setStoreId(e.target.value)}
                      className="px-3 py-2 rounded-cta border border-border bg-white text-button">
                {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <label className="px-3 py-2 bg-amber/10 text-amber-fg border border-amber/30 rounded-cta text-button cursor-pointer">
                📂 上传 Excel
                <input ref={fileRef} type="file" accept=".xlsx,.xls" onChange={onPickExcel} className="hidden" />
              </label>
              <button onClick={() => setAddOpen(true)}
                      className="px-3 py-2 bg-ink text-white rounded-cta text-button">+ 加一行</button>
            </div>
          )}
        </div>

        {error && <div className="bg-red-bg text-red-fg rounded-card p-3 text-caption mb-4">{error}</div>}

        {!storeId && (
          <div className="bg-white rounded-card border border-border p-6 text-center">
            <p className="text-caption text-gray3 mb-4">请选择一家门店查看建店成本台账</p>
            <div className="grid grid-cols-3 gap-3 max-w-2xl mx-auto">
              {stores.map(s => (
                <button key={s.id} onClick={() => setStoreId(s.id)}
                        className="bg-bg rounded-card border border-border p-3 hover:bg-white transition">
                  <div className="text-body">{s.name}</div>
                  <div className="text-micro text-gray3 font-num mt-0.5">{s.no}</div>
                </button>
              ))}
            </div>
          </div>
        )}

        {storeId && summary && (
          <>
            {/* 总览 4 卡 */}
            <div className="grid grid-cols-4 gap-3 mb-4">
              <Stat label="预算总额" value={`¥${fmtBig(summary.totals.budget)}`} hint={`${summary.totals.rowCount} 项`} />
              <Stat label="合同总额" value={`¥${fmtBig(summary.totals.contractAmount)}`} />
              <Stat label="已付累计" value={`¥${fmtBig(summary.totals.paidAmount)}`} tone="green" hint={`${progress.toFixed(0)}% 完成`} />
              <Stat label="待付" value={`¥${fmtBig(remaining)}`} tone={remaining > 0 ? 'orange' : 'gray'} />
            </div>

            {/* 进度条 */}
            <div className="bg-white rounded-card border border-border p-3 mb-4">
              <div className="flex items-center justify-between mb-1.5 text-caption">
                <span className="text-gray3">总体进度</span>
                <span className="font-num">¥{fmt(summary.totals.paidAmount)} / ¥{fmt(summary.totals.budget)}</span>
              </div>
              <div className="h-2 bg-bg rounded-full overflow-hidden">
                <div className={`h-full ${progress >= 100 ? 'bg-green-fg' : progress > 50 ? 'bg-amber' : 'bg-orange'}`}
                     style={{ width: `${Math.min(100, progress)}%` }} />
              </div>
            </div>

            {/* 分类汇总 */}
            <div className="grid grid-cols-9 gap-2 mb-4">
              {summary.byCategory.map(c => (
                <div key={c.category} className="bg-white rounded-card border border-border p-2.5">
                  <div className="text-micro text-gray3">{CATEGORY_LABEL[c.category] || c.category}</div>
                  <div className="font-num text-button mt-0.5">¥{fmtBig(c.budget)}</div>
                  <div className="text-micro text-gray3">付 ¥{fmtBig(c.paidAmount)}</div>
                </div>
              ))}
            </div>

            {/* 表格 (按 category 分组) */}
            {groupedRows.map(g => (
              <section key={g.category} className="bg-white rounded-card border border-border overflow-hidden mb-3">
                <header className="px-4 py-2 border-b border-border flex items-center justify-between bg-bg/40">
                  <h3 className="text-button">{CATEGORY_LABEL[g.category] || g.category} ({g.items.length})</h3>
                </header>
                <table className="w-full">
                  <thead className="bg-bg/20">
                    <tr className="text-micro text-gray3 text-left">
                      <th className="px-3 py-2 font-normal">项目</th>
                      <th className="px-3 py-2 font-normal text-right w-32">预算</th>
                      <th className="px-3 py-2 font-normal text-right w-32">合同额</th>
                      <th className="px-3 py-2 font-normal text-right w-32">已付</th>
                      <th className="px-3 py-2 font-normal text-right w-32">剩余</th>
                      <th className="px-3 py-2 font-normal">备注</th>
                      <th className="px-3 py-2 font-normal text-right w-32">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.items.map(r => {
                      const left = (r.budget || 0) - (r.paidAmount || 0)
                      return (
                        <tr key={r.id} className="border-t border-border hover:bg-bg/40">
                          <td className="px-3 py-2.5">
                            <div className="text-body">{r.name}</div>
                            {r.approvalNo && <div className="text-micro text-gray3 font-num">{r.approvalNo}</div>}
                          </td>
                          <td className="px-3 py-2.5 font-num text-right text-caption">¥{fmt(r.budget)}</td>
                          <td className="px-3 py-2.5 font-num text-right text-caption">¥{fmt(r.contractAmount)}</td>
                          <td className="px-3 py-2.5 font-num text-right text-button text-green-fg">¥{fmt(r.paidAmount)}</td>
                          <td className={`px-3 py-2.5 font-num text-right text-caption ${left > 0 ? 'text-orange-fg' : 'text-gray3'}`}>¥{fmt(left)}</td>
                          <td className="px-3 py-2.5 text-micro text-gray3">{r.note || '—'}</td>
                          <td className="px-3 py-2.5 text-right">
                            <button onClick={() => setEditing(r)}
                                    className="px-2.5 py-1 bg-white border border-border rounded text-caption text-gray2">编辑</button>
                            <button onClick={() => deleteRow(r)}
                                    className="ml-1.5 px-2.5 py-1 text-caption text-red-fg">删除</button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </section>
            ))}

            {rows.length === 0 && (
              <div className="bg-white rounded-card border border-border p-8 text-center">
                <p className="text-caption text-gray3 mb-3">本店暂无台账数据</p>
                <p className="text-micro text-gray3">点 "+ 加一行" 或 "📂 上传 Excel" 开始</p>
              </div>
            )}
          </>
        )}

        {/* Import preview modal */}
        {importPreview && (
          <div className="fixed inset-0 z-50 bg-ink/40 flex items-center justify-center" onClick={() => setImportPreview(null)}>
            <div className="bg-white rounded-card max-w-4xl w-full mx-4 max-h-[80vh] overflow-auto" onClick={e => e.stopPropagation()}>
              <div className="px-5 py-3 border-b border-border flex items-center justify-between sticky top-0 bg-white">
                <h3 className="text-h2">导入预览 ({importPreview.length} 行)</h3>
                <button onClick={() => setImportPreview(null)} className="text-gray3 text-h2">×</button>
              </div>
              <div className="p-5">
                <table className="w-full mb-4">
                  <thead className="bg-bg/40">
                    <tr className="text-micro text-gray3 text-left">
                      <th className="px-2 py-1 font-normal">类别</th>
                      <th className="px-2 py-1 font-normal">明细</th>
                      <th className="px-2 py-1 font-normal text-right">预算</th>
                      <th className="px-2 py-1 font-normal text-right">合同</th>
                      <th className="px-2 py-1 font-normal text-right">已付</th>
                    </tr>
                  </thead>
                  <tbody>
                    {importPreview.map((it, i) => (
                      <tr key={i} className="border-t border-border">
                        <td className="px-2 py-1 text-micro">{CATEGORY_LABEL[it.category] || it.category}</td>
                        <td className="px-2 py-1 text-caption">{it.name}</td>
                        <td className="px-2 py-1 text-caption font-num text-right">{fmt(it.budget)}</td>
                        <td className="px-2 py-1 text-caption font-num text-right">{fmt(it.contractAmount)}</td>
                        <td className="px-2 py-1 text-caption font-num text-right">{fmt(it.paidAmount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="flex justify-end gap-2">
                  <button onClick={() => setImportPreview(null)}
                          className="px-4 py-2 bg-white border border-border rounded-cta text-button text-gray2">取消</button>
                  <button onClick={() => confirmImport(false)} disabled={importing}
                          className="px-4 py-2 bg-amber text-white rounded-cta text-button disabled:opacity-40">
                    追加 (保留现有)
                  </button>
                  <button onClick={() => confirmImport(true)} disabled={importing}
                          className="px-4 py-2 bg-red text-white rounded-cta text-button disabled:opacity-40">
                    覆盖 (清空旧的)
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Add / Edit modal */}
        {(addOpen || editing) && (
          <EditRowModal
            row={editing}
            storeId={storeId}
            onClose={() => { setEditing(null); setAddOpen(false) }}
            onSaved={async () => { setEditing(null); setAddOpen(false); await refresh() }}
          />
        )}
      </main>
    </div>
  )
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'green' | 'orange' | 'red' | 'gray' }) {
  const cls = tone === 'green' ? 'text-green-fg' : tone === 'orange' ? 'text-orange-fg' : tone === 'red' ? 'text-red-fg' : tone === 'gray' ? 'text-gray3' : ''
  return (
    <div className="bg-white rounded-card border border-border p-3">
      <div className="text-micro text-gray3">{label}</div>
      <div className={`text-h1 font-num mt-0.5 ${cls}`}>{value}</div>
      {hint && <div className="text-micro text-gray3 mt-0.5">{hint}</div>}
    </div>
  )
}

function EditRowModal({ row, storeId, onClose, onSaved }: {
  row: Row | null; storeId: string; onClose: () => void; onSaved: () => void
}) {
  const [form, setForm] = useState({
    name: row?.name || '',
    category: row?.category || 'OTHER',
    budget: row?.budget != null ? String(row.budget) : '',
    contractAmount: row?.contractAmount != null ? String(row.contractAmount) : '',
    paidAmount: row?.paidAmount != null ? String(row.paidAmount) : '',
    approvalNo: row?.approvalNo || '',
    note: row?.note || '',
  })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function save() {
    if (!form.name.trim()) { setErr('项目名必填'); return }
    setBusy(true); setErr(null)
    const body: any = {
      name: form.name.trim(),
      category: form.category,
      budget: form.budget === '' ? null : Number(form.budget),
      contractAmount: form.contractAmount === '' ? null : Number(form.contractAmount),
      paidAmount: form.paidAmount === '' ? null : Number(form.paidAmount),
      approvalNo: form.approvalNo.trim() || null,
      note: form.note.trim() || null,
    }
    try {
      if (row) {
        await apiFetch(`/api/budgets/${row.id}`, { method: 'PATCH', body: JSON.stringify(body) })
      } else {
        await apiFetch('/api/budgets', { method: 'POST', body: JSON.stringify({ ...body, storeId }) })
      }
      onSaved()
    } catch (e: any) { setErr(e?.message || '保存失败'); setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-50 bg-ink/40 flex items-center justify-center" onClick={onClose}>
      <div className="bg-white rounded-card max-w-2xl w-full mx-4" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-border flex items-center justify-between">
          <h3 className="text-h2">{row ? '编辑' : '新增'}建店成本项</h3>
          <button onClick={onClose} className="text-gray3 text-h2">×</button>
        </div>
        <div className="p-5 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-micro text-gray3 block mb-1">项目名 *</label>
              <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
                     placeholder="如 工程装修费"
                     className="w-full px-3 py-2 rounded-cta border border-border bg-white text-button" />
            </div>
            <div>
              <label className="text-micro text-gray3 block mb-1">类别</label>
              <select value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}
                      className="w-full px-3 py-2 rounded-cta border border-border bg-white text-button">
                {CATEGORY_ORDER.map(c => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
              </select>
            </div>
            <div>
              <label className="text-micro text-gray3 block mb-1">预算金额</label>
              <input type="number" step="0.01" value={form.budget}
                     onChange={e => setForm({ ...form, budget: e.target.value })}
                     className="w-full px-3 py-2 rounded-cta border border-border bg-white text-button font-num text-right" />
            </div>
            <div>
              <label className="text-micro text-gray3 block mb-1">合同金额</label>
              <input type="number" step="0.01" value={form.contractAmount}
                     onChange={e => setForm({ ...form, contractAmount: e.target.value })}
                     className="w-full px-3 py-2 rounded-cta border border-border bg-white text-button font-num text-right" />
            </div>
            <div>
              <label className="text-micro text-gray3 block mb-1">已付金额</label>
              <input type="number" step="0.01" value={form.paidAmount}
                     onChange={e => setForm({ ...form, paidAmount: e.target.value })}
                     className="w-full px-3 py-2 rounded-cta border border-border bg-white text-button font-num text-right" />
            </div>
            <div>
              <label className="text-micro text-gray3 block mb-1">审批编号 (可选)</label>
              <input value={form.approvalNo} onChange={e => setForm({ ...form, approvalNo: e.target.value })}
                     placeholder="如 20260310123"
                     className="w-full px-3 py-2 rounded-cta border border-border bg-white text-button font-num" />
            </div>
          </div>
          <div>
            <label className="text-micro text-gray3 block mb-1">备注 (可选)</label>
            <textarea value={form.note} onChange={e => setForm({ ...form, note: e.target.value })} rows={2}
                      placeholder="如 第一批款50% 已付 / 2026.3.1-5.31"
                      className="w-full px-3 py-2 rounded-cta border border-border bg-white text-button resize-none" />
          </div>
          {err && <div className="bg-red-bg text-red-fg rounded-card p-2 text-caption">{err}</div>}
        </div>
        <div className="px-5 py-3 border-t border-border flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 bg-white border border-border rounded-cta text-button text-gray2">取消</button>
          <button onClick={save} disabled={busy}
                  className="px-4 py-2 bg-ink text-white rounded-cta text-button disabled:opacity-40">
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
