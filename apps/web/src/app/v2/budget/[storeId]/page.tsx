/**
 * v2 建店资金台账 (一店一份)
 * - 财务/老板可改, 工程部只读 (服务端校验)
 * - 支持上传 Excel 一键导入 (按用户标准模板格式解析, 客户端 SheetJS)
 * - 单行编辑 / 凭证图上传 (OSS) / 删除
 */
'use client'
import { useEffect, useState, useRef } from 'react'
import { getUser, getToken } from '@/lib/v2-auth'
import * as XLSX from 'xlsx'

const CATEGORY_LABEL: Record<string, string> = {
  CONTRACT: '合同', CONSTRUCTION: '装修工程', FIRE: '消防',
  HVAC: '空调', VENTILATION: '油烟排风', EQUIPMENT: '设备',
  MARKETING: '市场', HR: '人事', OTHER: '其它',
}
const CATEGORY_ORDER = ['CONTRACT','CONSTRUCTION','FIRE','HVAC','VENTILATION','EQUIPMENT','MARKETING','HR','OTHER']
const CATEGORY_VALUES = CATEGORY_ORDER

const CATEGORY_COLOR: Record<string, string> = {
  CONTRACT: 'bg-blue-50 text-blue-700',
  CONSTRUCTION: 'bg-amber/20 text-amber-fg',
  FIRE: 'bg-red-bg text-red-fg',
  HVAC: 'bg-cyan-50 text-cyan-700',
  VENTILATION: 'bg-purple-50 text-purple-700',
  EQUIPMENT: 'bg-gray-100 text-gray-700',
  MARKETING: 'bg-pink-50 text-pink-700',
  HR: 'bg-indigo-50 text-indigo-700',
  OTHER: 'bg-bg text-gray2',
}

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

const fmt = (n: number | null | undefined) => {
  if (n == null) return '—'
  return Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
// 大数字简短显示 (万为单位), 用于顶部 3 列汇总避免溢出
const fmtBig = (n: number | null | undefined) => {
  if (n == null || isNaN(Number(n))) return '0'
  const v = Number(n)
  if (Math.abs(v) >= 10000) {
    return (v / 10000).toFixed(1) + '万'
  }
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

function parseBudgetExcel(file: File): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('文件读取失败'))
    reader.onload = (e) => {
      try {
        const buf = e.target?.result as ArrayBuffer
        const wb = XLSX.read(buf, { type: 'array' })
        const sheet = wb.Sheets[wb.SheetNames[0]]
        const rows: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' })
        let headerRow = -1
        for (let i = 0; i < rows.length; i++) {
          if (String(rows[i][0]).trim() === '类别' && String(rows[i][1]).trim() === '明细') {
            headerRow = i; break
          }
        }
        if (headerRow < 0) return reject(new Error('找不到表头, 请用标准模板 (类别|明细|预算金额|实付金额|已付金额|备注|审批编号)'))

        const items: any[] = []
        let currentCat = ''
        for (let i = headerRow + 1; i < rows.length; i++) {
          const row = rows[i]
          const cat = String(row[0] || '').trim()
          const name = String(row[1] || '').trim()
          if (cat) currentCat = cat
          if (!name) continue
          if (name.includes('总计') || name.includes('合计')) continue
          // 过滤 WPS DISPIMG 占位符 (Excel 嵌入图片公式, 不是真实文本)
          const cleanText = (v: any) => {
            const s = String(v || '').trim()
            if (!s) return null
            if (/^=?DISPIMG\(/i.test(s)) return null
            // 如果文本里夹带 DISPIMG, 把它去掉
            const stripped = s.replace(/=?DISPIMG\("[^"]+",\s*\d+\)/gi, '').trim()
            return stripped || null
          }
          items.push({
            category: mapCategory(currentCat),
            name,
            budget: parseAmount(row[2]),
            contractAmount: parseAmount(row[3]),
            paidAmount: parseAmount(row[4]),
            note: cleanText(row[5]),
            approvalNo: cleanText(row[6]),
          })
        }
        resolve(items)
      } catch (err: any) {
        reject(new Error(err?.message || 'Excel 解析失败'))
      }
    }
    reader.readAsArrayBuffer(file)
  })
}

export default function BudgetPage({ params }: { params: { storeId: string } }) {
  const { storeId } = params
  const [u, setU] = useState<any>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [storeName, setStoreName] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [importPreview, setImportPreview] = useState<any[] | null>(null)
  const [importing, setImporting] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  // 编辑行
  const [editing, setEditing] = useState<Row | null>(null)
  const [editForm, setEditForm] = useState({ name: '', category: 'OTHER', budget: '', contractAmount: '', paidAmount: '', approvalNo: '', note: '' })

  // 新增行
  const [addOpen, setAddOpen] = useState(false)
  const [addForm, setAddForm] = useState({ name: '', category: 'OTHER', budget: '', contractAmount: '', paidAmount: '', approvalNo: '', note: '' })

  // 凭证上传
  const voucherFileRef = useRef<HTMLInputElement>(null)
  const [voucherTarget, setVoucherTarget] = useState<Row | null>(null)

  const canWrite = !!u && ['FINANCE', 'ADMIN', 'SUPER_ADMIN'].includes(u.role)

  useEffect(() => {
    setU(getUser())
    refresh()
  }, [storeId])

  async function refresh() {
    setLoading(true); setError(null)
    try {
      const t = getToken()
      const headers = { Authorization: `Bearer ${t}` }
      const [list, summ, store] = await Promise.all([
        fetch(`/api/budgets?storeId=${storeId}`, { headers }).then(r => r.json()),
        fetch(`/api/budgets/summary?storeId=${storeId}`, { headers }).then(r => r.json()),
        fetch(`/api/stores`, { headers }).then(r => r.json()),
      ])
      if (list.error) throw new Error(list.error)
      setRows(Array.isArray(list) ? list : [])
      setSummary(summ.error ? null : summ)
      const all = Array.isArray(store) ? store : (store.items || [])
      setStoreName(all.find((s: any) => s.id === storeId)?.name || '')
    } catch (e: any) {
      setError(e.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }

  async function onPickExcel(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setError(null)
    try {
      const items = await parseBudgetExcel(file)
      if (items.length === 0) { setError('Excel 里没识别到任何行'); return }
      setImportPreview(items)
    } catch (err: any) {
      setError(err.message || 'Excel 解析失败')
    } finally {
      e.target.value = ''
    }
  }

  async function confirmImport(replace: boolean) {
    if (!importPreview) return
    setImporting(true); setError(null)
    try {
      const t = getToken()
      const r = await fetch('/api/budgets/import-rows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
        body: JSON.stringify({ storeId, rows: importPreview, replace }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || '导入失败')
      setImportPreview(null)
      refresh()
    } catch (e: any) {
      setError(e.message || '导入失败')
    } finally {
      setImporting(false)
    }
  }

  async function saveEdit() {
    if (!editing) return
    setError(null)
    try {
      const t = getToken()
      const r = await fetch(`/api/budgets/${editing.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
        body: JSON.stringify({
          name: editForm.name.trim() || undefined,
          category: editForm.category,
          budget: editForm.budget === '' ? null : Number(editForm.budget),
          contractAmount: editForm.contractAmount === '' ? null : Number(editForm.contractAmount),
          paidAmount: editForm.paidAmount === '' ? null : Number(editForm.paidAmount),
          approvalNo: editForm.approvalNo.trim() || null,
          note: editForm.note.trim() || null,
        }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || '保存失败')
      setEditing(null)
      refresh()
    } catch (e: any) {
      setError(e.message || '保存失败')
    }
  }

  async function deleteRow(row: Row) {
    if (!confirm(`确认删除「${row.name}」?`)) return
    try {
      const t = getToken()
      await fetch(`/api/budgets/${row.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${t}` } })
      refresh()
    } catch (e: any) {
      setError(e.message || '删除失败')
    }
  }

  async function addRow(e: React.FormEvent) {
    e.preventDefault()
    if (!addForm.name.trim()) return
    setError(null)
    try {
      const t = getToken()
      const r = await fetch('/api/budgets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
        body: JSON.stringify({
          storeId,
          name: addForm.name.trim(),
          category: addForm.category,
          budget: addForm.budget === '' ? null : Number(addForm.budget),
          contractAmount: addForm.contractAmount === '' ? null : Number(addForm.contractAmount),
          paidAmount: addForm.paidAmount === '' ? null : Number(addForm.paidAmount),
          approvalNo: addForm.approvalNo.trim() || null,
          note: addForm.note.trim() || null,
        }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || '创建失败')
      setAddForm({ name: '', category: 'OTHER', budget: '', contractAmount: '', paidAmount: '', approvalNo: '', note: '' })
      setAddOpen(false)
      refresh()
    } catch (e: any) {
      setError(e.message || '创建失败')
    }
  }

  async function uploadVoucher(file: File) {
    if (!voucherTarget) return
    try {
      const t = getToken()
      const fd = new FormData()
      fd.append('file', file)
      const r = await fetch('/api/upload?category=invoices', {
        method: 'POST',
        headers: { Authorization: `Bearer ${t}` },
        body: fd,
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || '上传失败')
      // 写回 voucherUrl
      await fetch(`/api/budgets/${voucherTarget.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
        body: JSON.stringify({ voucherUrl: d.url }),
      })
      setVoucherTarget(null)
      refresh()
    } catch (e: any) {
      setError(e.message || '上传失败')
    }
  }

  function startEdit(row: Row) {
    setEditing(row)
    setEditForm({
      name: row.name,
      category: row.category,
      budget: row.budget != null ? String(row.budget) : '',
      contractAmount: row.contractAmount != null ? String(row.contractAmount) : '',
      paidAmount: row.paidAmount != null ? String(row.paidAmount) : '',
      approvalNo: row.approvalNo || '',
      note: row.note || '',
    })
  }

  // 按类目分组
  const grouped: Record<string, Row[]> = {}
  for (const c of CATEGORY_ORDER) grouped[c] = []
  for (const r of rows) (grouped[r.category] || (grouped[r.category] = [])).push(r)

  if (!u) return null

  return (
    <div className="min-h-screen bg-bg pb-32">
      <header className="px-4 pt-4 pb-2 flex items-center gap-3">
        <a href={u.role === 'ENGINEERING' ? `/v2/engineer/stores/${storeId}` : '/v2/me'}
           className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center">‹</a>
        <div className="flex-1 min-w-0">
          <h1 className="text-h1 truncate">建店资金台账</h1>
          {storeName && <p className="text-caption text-gray3 mt-0.5 truncate">{storeName}</p>}
        </div>
      </header>

      {/* 汇总 */}
      {summary && (
        <div className="px-4 mt-2">
          <div className="bg-white rounded-card border border-border p-4">
            <div className="grid grid-cols-3 gap-2">
              <div>
                <div className="text-micro text-gray3">预算</div>
                <div className="text-h2 font-num mt-1">¥{fmtBig(summary.totals.budget)}</div>
              </div>
              <div>
                <div className="text-micro text-gray3">实付/合同</div>
                <div className="text-h2 font-num mt-1">¥{fmtBig(summary.totals.contractAmount)}</div>
              </div>
              <div>
                <div className="text-micro text-gray3">已付</div>
                <div className="text-h2 font-num mt-1 text-amber-fg">¥{fmtBig(summary.totals.paidAmount)}</div>
              </div>
            </div>
            {(() => {
              const unpaid = (summary.totals.contractAmount || 0) - (summary.totals.paidAmount || 0)
              if (unpaid > 0) {
                return (
                  <div className="mt-3 pt-3 border-t border-border flex items-center">
                    <span className="text-caption text-red-fg">已签未付</span>
                    <span className="ml-auto font-num text-button text-red-fg">¥{fmt(unpaid)}</span>
                  </div>
                )
              }
              return null
            })()}
          </div>
        </div>
      )}

      {/* 操作栏 */}
      {canWrite && (
        <div className="px-4 mt-3 flex gap-2">
          <input ref={fileRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={onPickExcel} />
          <button onClick={() => fileRef.current?.click()}
            className="flex-1 py-2 bg-amber text-white rounded-cta text-button">
            上传 Excel
          </button>
          <button onClick={() => setAddOpen(true)}
            className="px-4 py-2 bg-white border border-border rounded-cta text-button">
            + 单行
          </button>
        </div>
      )}

      {error && <div className="mx-4 mt-3 bg-red-bg text-red-fg rounded-card p-3 text-caption">{error}</div>}

      {/* 列表按类目分组 */}
      <div className="px-4 mt-3">
        {loading ? (
          <div className="text-caption text-gray3 py-8 text-center">加载中…</div>
        ) : rows.length === 0 ? (
          <div className="bg-white rounded-card border border-border p-8 text-center text-caption text-gray3">
            还没有预算行。{canWrite ? '点上面「上传 Excel」一键导入, 或「+单行」手填。' : '让财务上传 Excel 后再看。'}
          </div>
        ) : (
          <div className="space-y-3">
            {CATEGORY_ORDER.map(cat => {
              const list = grouped[cat] || []
              if (list.length === 0) return null
              const subTotal = list.reduce((s, r) => s + Number(r.contractAmount || 0), 0)
              const subPaid = list.reduce((s, r) => s + Number(r.paidAmount || 0), 0)
              return (
                <div key={cat} className="bg-white rounded-card border border-border">
                  <div className={`px-3 py-2 border-b border-border flex items-center text-button ${CATEGORY_COLOR[cat] || ''}`}>
                    <span>{CATEGORY_LABEL[cat]}</span>
                    <span className="ml-2 text-micro opacity-70">{list.length} 项</span>
                    <span className="ml-auto text-micro font-num">¥{fmt(subPaid)} / ¥{fmt(subTotal)}</span>
                  </div>
                  <ul className="divide-y divide-border">
                    {list.map(r => {
                      const total = Number(r.contractAmount || r.budget || 0)
                      const paid = Number(r.paidAmount || 0)
                      const pct = total > 0 ? Math.min(100, Math.round(paid * 100 / total)) : 0
                      return (
                        <li key={r.id} className="p-3"
                          onClick={canWrite ? () => startEdit(r) : undefined}>
                          <div className="flex items-start gap-2">
                            <div className="flex-1 min-w-0">
                              <div className="text-body">{r.name}</div>
                              <div className="flex items-center gap-2 mt-1 text-micro text-gray3 font-num">
                                <span>预算 ¥{fmt(r.budget)}</span>
                                <span>·</span>
                                <span>合同 ¥{fmt(r.contractAmount)}</span>
                                <span>·</span>
                                <span className="text-amber-fg">已付 ¥{fmt(r.paidAmount)}</span>
                              </div>
                              {total > 0 && (
                                <div className="h-1 bg-bg rounded mt-1.5">
                                  <div className="h-full bg-amber rounded" style={{ width: `${pct}%` }}></div>
                                </div>
                              )}
                              {(r.note || r.approvalNo) && (
                                <div className="mt-1.5 text-micro text-gray3">
                                  {r.approvalNo && <span className="font-num">凭证 {r.approvalNo}</span>}
                                  {r.note && r.approvalNo && <span> · </span>}
                                  {r.note && <span>{r.note}</span>}
                                </div>
                              )}
                            </div>
                            {r.voucherUrl ? (
                              <a href={r.voucherUrl} target="_blank" onClick={e => e.stopPropagation()}
                                className="shrink-0 self-start px-2 py-1 rounded bg-amber/10 text-amber-fg text-micro">凭证</a>
                            ) : canWrite ? (
                              <button onClick={(e) => { e.stopPropagation(); setVoucherTarget(r); voucherFileRef.current?.click() }}
                                className="shrink-0 self-start px-2 py-1 rounded border border-border text-gray3 text-micro">+凭证</button>
                            ) : null}
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* 隐藏的凭证文件 input */}
      <input ref={voucherFileRef} type="file" accept="image/*,application/pdf" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadVoucher(f); e.target.value = '' }} />

      {/* 导入预览 sheet */}
      {importPreview && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end" onClick={() => !importing && setImportPreview(null)}>
          <div className="w-full bg-white rounded-t-2xl p-4 max-h-[85vh] overflow-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center mb-3">
              <h2 className="text-h2 flex-1">解析到 {importPreview.length} 行</h2>
              {!importing && <button onClick={() => setImportPreview(null)} className="text-h2 text-gray3 px-2">×</button>}
            </div>
            <div className="text-caption text-gray3 mb-2">前 5 行预览:</div>
            <ul className="space-y-1 mb-3 max-h-48 overflow-auto">
              {importPreview.slice(0, 5).map((it, i) => (
                <li key={i} className="bg-bg rounded p-2 text-caption">
                  <span className="text-gray3">{CATEGORY_LABEL[it.category] || it.category}</span> · {it.name}
                  <span className="ml-2 font-num text-gray2">预算 ¥{fmt(it.budget)} / 已付 ¥{fmt(it.paidAmount)}</span>
                </li>
              ))}
              {importPreview.length > 5 && <li className="text-micro text-gray3 text-center">...还有 {importPreview.length - 5} 行</li>}
            </ul>
            {error && <div className="bg-red-bg text-red-fg rounded p-2 text-caption mb-3">{error}</div>}
            <div className="space-y-2">
              <button onClick={() => confirmImport(false)} disabled={importing}
                className="w-full py-3 bg-amber text-white rounded-cta text-button disabled:opacity-40">
                {importing ? '导入中…' : '追加到现有 (保留旧数据)'}
              </button>
              <button onClick={() => confirmImport(true)} disabled={importing}
                className="w-full py-2 text-button text-red-fg">
                清空原有再导入
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 编辑行 sheet */}
      {editing && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end" onClick={() => setEditing(null)}>
          <div className="w-full bg-white rounded-t-2xl p-4 max-h-[85vh] overflow-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center mb-3">
              <h2 className="text-h2 flex-1">编辑预算行</h2>
              <button onClick={() => setEditing(null)} className="text-h2 text-gray3 px-2">×</button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-micro text-gray3 block mb-1">明细</label>
                <input value={editForm.name} onChange={e => setEditForm({...editForm, name: e.target.value})}
                  className="w-full bg-bg rounded p-2 outline-none text-body" />
              </div>
              <div>
                <label className="text-micro text-gray3 block mb-1">类别</label>
                <select value={editForm.category} onChange={e => setEditForm({...editForm, category: e.target.value})}
                  className="w-full bg-bg rounded p-2 outline-none text-body">
                  {CATEGORY_VALUES.map(c => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="text-micro text-gray3 block mb-1">预算</label>
                  <input type="number" inputMode="decimal" value={editForm.budget}
                    onChange={e => setEditForm({...editForm, budget: e.target.value})}
                    className="w-full bg-bg rounded p-2 outline-none text-body font-num" />
                </div>
                <div>
                  <label className="text-micro text-gray3 block mb-1">实付/合同</label>
                  <input type="number" inputMode="decimal" value={editForm.contractAmount}
                    onChange={e => setEditForm({...editForm, contractAmount: e.target.value})}
                    className="w-full bg-bg rounded p-2 outline-none text-body font-num" />
                </div>
                <div>
                  <label className="text-micro text-gray3 block mb-1">已付</label>
                  <input type="number" inputMode="decimal" value={editForm.paidAmount}
                    onChange={e => setEditForm({...editForm, paidAmount: e.target.value})}
                    className="w-full bg-bg rounded p-2 outline-none text-body font-num" />
                </div>
              </div>
              <div>
                <label className="text-micro text-gray3 block mb-1">凭证编号</label>
                <input value={editForm.approvalNo} onChange={e => setEditForm({...editForm, approvalNo: e.target.value})}
                  className="w-full bg-bg rounded p-2 outline-none text-body font-num" />
              </div>
              <div>
                <label className="text-micro text-gray3 block mb-1">备注</label>
                <textarea value={editForm.note} onChange={e => setEditForm({...editForm, note: e.target.value})}
                  rows={2} className="w-full bg-bg rounded p-2 outline-none text-body resize-none" />
              </div>
              {error && <div className="bg-red-bg text-red-fg rounded p-2 text-caption">{error}</div>}
              <button onClick={saveEdit} className="w-full py-3 bg-amber text-white rounded-cta text-button">保存</button>
              <div className="pt-3 mt-3 border-t border-border">
                <button onClick={() => { if (editing) { deleteRow(editing); setEditing(null) } }}
                  className="w-full py-2 text-button text-red-fg">
                  删除此行
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 新增行 sheet */}
      {addOpen && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end" onClick={() => setAddOpen(false)}>
          <div className="w-full bg-white rounded-t-2xl p-4 max-h-[85vh] overflow-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center mb-3">
              <h2 className="text-h2 flex-1">新增预算行</h2>
              <button onClick={() => setAddOpen(false)} className="text-h2 text-gray3 px-2">×</button>
            </div>
            <form onSubmit={addRow} className="space-y-3">
              <input value={addForm.name} onChange={e => setAddForm({...addForm, name: e.target.value})}
                className="w-full bg-bg rounded p-2 outline-none text-body" placeholder="明细 (例如 灯光系统)" />
              <select value={addForm.category} onChange={e => setAddForm({...addForm, category: e.target.value})}
                className="w-full bg-bg rounded p-2 outline-none text-body">
                {CATEGORY_VALUES.map(c => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
              </select>
              <div className="grid grid-cols-3 gap-2">
                <input type="number" inputMode="decimal" value={addForm.budget}
                  onChange={e => setAddForm({...addForm, budget: e.target.value})}
                  className="bg-bg rounded p-2 outline-none text-body font-num" placeholder="预算" />
                <input type="number" inputMode="decimal" value={addForm.contractAmount}
                  onChange={e => setAddForm({...addForm, contractAmount: e.target.value})}
                  className="bg-bg rounded p-2 outline-none text-body font-num" placeholder="实付/合同" />
                <input type="number" inputMode="decimal" value={addForm.paidAmount}
                  onChange={e => setAddForm({...addForm, paidAmount: e.target.value})}
                  className="bg-bg rounded p-2 outline-none text-body font-num" placeholder="已付" />
              </div>
              <input value={addForm.approvalNo} onChange={e => setAddForm({...addForm, approvalNo: e.target.value})}
                className="w-full bg-bg rounded p-2 outline-none text-body font-num" placeholder="凭证编号 (选填)" />
              <textarea value={addForm.note} onChange={e => setAddForm({...addForm, note: e.target.value})}
                rows={2} className="w-full bg-bg rounded p-2 outline-none text-body resize-none" placeholder="备注 (选填)" />
              {error && <div className="bg-red-bg text-red-fg rounded p-2 text-caption">{error}</div>}
              <button type="submit" className="w-full py-3 bg-amber text-white rounded-cta text-button">创建</button>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
