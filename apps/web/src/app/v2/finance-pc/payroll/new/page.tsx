/**
 * 财务 PC · 上传工资单 (P2-1)
 *
 * Excel 列名兼容: 姓名/员工/name, 岗位/职位/position, 底薪/基本/baseSalary,
 *   奖金/bonus, 加班/overtime, 社保/socialSec, 个税/tax,
 *   其他扣项/other, 实发/net
 */
'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import dayjs from 'dayjs'
import { MonthPicker } from '@/components/v2'
import { apiFetch } from '@/lib/v2-auth'
import FinanceTopNav from '../../_topnav'

type Store = { id: string; name: string }
type Item = {
  employeeName: string
  position?: string
  baseSalary?: number
  bonus?: number
  overtime?: number
  deductSocialSec?: number
  deductTax?: number
  deductOther?: number
  netAmount: number
  note?: string
}

export default function PayrollNewPage() {
  const router = useRouter()
  const [stores, setStores] = useState<Store[]>([])
  const [storeId, setStoreId] = useState('')
  const [month, setMonth] = useState(dayjs().subtract(1, 'month').format('YYYY-MM'))
  const [items, setItems] = useState<Item[]>([])
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [parseError, setParseError] = useState<string | null>(null)

  useEffect(() => {
    apiFetch<Store[]>('/api/stores').then(st => {
      setStores(st)
      if (st.length === 1) setStoreId(st[0].id)
    }).catch(() => {})
  }, [])

  async function handleFile(file: File) {
    setParseError(null)
    try {
      const XLSX = await import('xlsx')
      const buf = await file.arrayBuffer()
      const wb = XLSX.read(buf)
      const ws = wb.Sheets[wb.SheetNames[0]]
      const raw = XLSX.utils.sheet_to_json<Record<string, any>>(ws, { defval: '' })
      const parsed: Item[] = raw.map(row => {
        const get = (patterns: RegExp[]) => {
          const k = Object.keys(row).find(k => patterns.some(p => p.test(k)))
          return k ? row[k] : ''
        }
        const num = (v: any) => {
          const n = Number(v)
          return Number.isFinite(n) && n > 0 ? n : undefined
        }
        return {
          employeeName: String(get([/姓名|员工|name/i]) || '').trim(),
          position: String(get([/岗位|职位|position/i]) || '').trim() || undefined,
          baseSalary: num(get([/底薪|基本|base/i])),
          bonus: num(get([/奖金|绩效|bonus/i])),
          overtime: num(get([/加班|overtime/i])),
          deductSocialSec: num(get([/社保|养老|公积金|socialSec/i])),
          deductTax: num(get([/个税|个人所得税|tax/i])),
          deductOther: num(get([/其他扣|other/i])),
          netAmount: Number(get([/实发|应发|net|合计/i])) || 0,
          note: String(get([/备注|note/i]) || '').trim() || undefined,
        }
      }).filter(i => i.employeeName && i.netAmount > 0)
      if (parsed.length === 0) {
        setParseError('Excel 中找不到有效行 (需含 "姓名" + "实发" 列, 且实发 > 0)')
        return
      }
      setItems(parsed)
    } catch (e: any) {
      setParseError('解析失败: ' + (e?.message || e))
    }
  }

  function addEmptyRow() {
    setItems(rs => [...rs, { employeeName: '', netAmount: 0 }])
  }
  function updateRow(i: number, patch: Partial<Item>) {
    setItems(rs => { const next = [...rs]; next[i] = { ...next[i], ...patch }; return next })
  }
  function removeRow(i: number) {
    setItems(rs => rs.filter((_, idx) => idx !== i))
  }

  const totalGross = items.reduce((s, i) => s + (i.baseSalary || 0) + (i.bonus || 0) + (i.overtime || 0), 0)
  const totalNet = items.reduce((s, i) => s + (i.netAmount || 0), 0)
  const totalSocialSec = items.reduce((s, i) => s + (i.deductSocialSec || 0), 0)
  const totalTax = items.reduce((s, i) => s + (i.deductTax || 0), 0)
  const validItems = items.filter(i => i.employeeName && i.netAmount > 0)
  const canSubmit = storeId && month && validItems.length > 0 && !submitting

  async function submit() {
    if (!canSubmit) return
    setSubmitting(true)
    try {
      const r = await apiFetch<any>('/api/payroll', {
        method: 'POST',
        body: JSON.stringify({
          storeId, month, items: validItems, note: note || undefined,
        }),
      })
      router.replace('/v2/finance-pc/payroll')
    } catch (e: any) {
      alert(e?.message || '提交失败')
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen bg-bg">
      <FinanceTopNav />
      <main className="max-w-[1400px] mx-auto px-6 py-6">
        <div className="flex items-center gap-2 mb-4">
          <a href="/v2/finance-pc/payroll" className="text-gray2 hover:text-ink text-caption">← 工资管理</a>
          <span className="text-gray3">/</span>
          <span className="text-caption text-gray2">新建工资单</span>
        </div>

        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-h1">新建工资单</h1>
            <p className="text-caption text-gray3">上传 Excel 或手工录入 → 待审批 → 发放后自动生成凭证</p>
          </div>
          <button onClick={submit} disabled={!canSubmit}
                  className="px-4 py-2 bg-ink text-white rounded-cta text-button disabled:opacity-40">
            {submitting ? '提交中…' : `保存草稿 (${validItems.length} 人)`}
          </button>
        </div>

        {/* 步骤 1: 门店 + 月份 */}
        <section className="bg-white rounded-card border border-border p-4 mb-4">
          <h2 className="text-h2 mb-3">① 选门店 + 月份</h2>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="text-micro text-gray3 block mb-1.5">门店</label>
              <select value={storeId} onChange={e => setStoreId(e.target.value)}
                      className="w-full px-3 py-2 rounded-cta border border-border bg-white text-button">
                <option value="">— 选择 —</option>
                {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div>
              <label className="text-micro text-gray3 block mb-1.5">工资月份</label>
              <MonthPicker value={month} onChange={setMonth} />
            </div>
            <div>
              <label className="text-micro text-gray3 block mb-1.5">备注 (可选)</label>
              <input value={note} onChange={e => setNote(e.target.value)}
                     placeholder="如 含年终奖"
                     className="w-full px-3 py-2 rounded-cta border border-border bg-white text-button" />
            </div>
          </div>
        </section>

        {/* 步骤 2: 上传/录入 */}
        <section className="bg-white rounded-card border border-border p-4 mb-4">
          <h2 className="text-h2 mb-3">② 上传 Excel 或手工录入</h2>
          <div className="flex items-center gap-3 flex-wrap">
            <label className="px-4 py-2 bg-amber text-white rounded-cta text-button cursor-pointer">
              📂 选 Excel 文件
              <input type="file" accept=".xlsx,.xls,.csv"
                     onChange={e => e.target.files?.[0] && handleFile(e.target.files[0])}
                     className="hidden" />
            </label>
            <button onClick={addEmptyRow} className="px-4 py-2 bg-white border border-border rounded-cta text-button text-gray2">+ 新增 1 人</button>
            {items.length > 0 && (
              <button onClick={() => setItems([])} className="px-3 py-2 text-caption text-red-fg">清空</button>
            )}
          </div>
          {parseError && <div className="mt-3 bg-red-bg text-red-fg rounded-cta p-2 text-caption">{parseError}</div>}
          <p className="text-micro text-gray3 mt-2">
            💡 Excel 列名建议: <code>姓名</code> / <code>实发</code> 必填. 其他可选: <code>岗位</code> / <code>底薪</code> / <code>奖金</code> / <code>加班</code> / <code>社保</code> / <code>个税</code>
          </p>
        </section>

        {/* 步骤 3: 预览 */}
        {items.length > 0 && (
          <section className="bg-white rounded-card border border-border overflow-hidden mb-4">
            <header className="px-4 py-3 border-b border-border flex items-center justify-between">
              <h2 className="text-h2">③ 预览 ({items.length} 人 · 实发 ¥{totalNet.toLocaleString(undefined, { minimumFractionDigits: 2 })})</h2>
              <div className="text-caption text-gray3 space-x-2">
                {totalGross > 0 && <span>应发 ¥{totalGross.toLocaleString()}</span>}
                {totalSocialSec > 0 && <span>· 社保 ¥{totalSocialSec.toLocaleString()}</span>}
                {totalTax > 0 && <span>· 个税 ¥{totalTax.toLocaleString()}</span>}
              </div>
            </header>
            <table className="w-full">
              <thead className="bg-bg/40">
                <tr className="text-micro text-gray3 text-left">
                  <th className="px-3 py-2 font-normal w-32">姓名</th>
                  <th className="px-3 py-2 font-normal w-24">岗位</th>
                  <th className="px-3 py-2 font-normal text-right w-24">底薪</th>
                  <th className="px-3 py-2 font-normal text-right w-24">奖金</th>
                  <th className="px-3 py-2 font-normal text-right w-24">加班</th>
                  <th className="px-3 py-2 font-normal text-right w-24">社保扣</th>
                  <th className="px-3 py-2 font-normal text-right w-24">个税扣</th>
                  <th className="px-3 py-2 font-normal text-right w-28">实发</th>
                  <th className="px-3 py-2 font-normal w-12"></th>
                </tr>
              </thead>
              <tbody>
                {items.map((it, i) => (
                  <tr key={i} className={`border-t border-border ${!it.employeeName || !it.netAmount ? 'bg-red-bg/30' : ''}`}>
                    <td className="px-3 py-1.5">
                      <input value={it.employeeName} onChange={e => updateRow(i, { employeeName: e.target.value })}
                             className="w-full px-2 py-1 rounded border border-border bg-white text-caption" />
                    </td>
                    <td className="px-3 py-1.5">
                      <input value={it.position || ''} onChange={e => updateRow(i, { position: e.target.value })}
                             className="w-full px-2 py-1 rounded border border-border bg-white text-caption" />
                    </td>
                    <td className="px-3 py-1.5"><NumIn v={it.baseSalary} onChange={v => updateRow(i, { baseSalary: v })} /></td>
                    <td className="px-3 py-1.5"><NumIn v={it.bonus} onChange={v => updateRow(i, { bonus: v })} /></td>
                    <td className="px-3 py-1.5"><NumIn v={it.overtime} onChange={v => updateRow(i, { overtime: v })} /></td>
                    <td className="px-3 py-1.5"><NumIn v={it.deductSocialSec} onChange={v => updateRow(i, { deductSocialSec: v })} /></td>
                    <td className="px-3 py-1.5"><NumIn v={it.deductTax} onChange={v => updateRow(i, { deductTax: v })} /></td>
                    <td className="px-3 py-1.5">
                      <NumIn v={it.netAmount} onChange={v => updateRow(i, { netAmount: v || 0 })} required />
                    </td>
                    <td className="px-3 py-1.5 text-center">
                      <button onClick={() => removeRow(i)} className="text-red-fg hover:bg-red-bg/40 rounded w-6 h-6 text-caption">×</button>
                    </td>
                  </tr>
                ))}
                <tr className="bg-bg/40 font-medium">
                  <td className="px-3 py-2 text-caption text-gray2" colSpan={2}>合计</td>
                  <td className="px-3 py-2 font-num text-right text-caption">{totalGross > 0 ? `¥${totalGross.toLocaleString()}` : '—'}</td>
                  <td className="px-3 py-2"></td>
                  <td className="px-3 py-2"></td>
                  <td className="px-3 py-2 font-num text-right text-caption">{totalSocialSec > 0 ? `¥${totalSocialSec.toLocaleString()}` : ''}</td>
                  <td className="px-3 py-2 font-num text-right text-caption">{totalTax > 0 ? `¥${totalTax.toLocaleString()}` : ''}</td>
                  <td className="px-3 py-2 font-num text-right text-button">¥{totalNet.toLocaleString()}</td>
                  <td></td>
                </tr>
              </tbody>
            </table>
          </section>
        )}
      </main>
    </div>
  )
}

function NumIn({ v, onChange, required }: { v?: number; onChange: (v: number | undefined) => void; required?: boolean }) {
  return (
    <input type="number" step="0.01" value={v || ''}
           onChange={e => {
             const n = Number(e.target.value)
             onChange(n > 0 ? n : (required ? 0 : undefined))
           }}
           placeholder={required ? '必填' : ''}
           className="w-full px-2 py-1 rounded border border-border bg-white text-caption font-num text-right" />
  )
}
