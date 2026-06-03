/**
 * 财务 PC · B2B 平台账单批量导入 (P1-2)
 *
 * 真实业务: 财务从美菜 / 快驴 后台拿一个月账单 (PDF / Excel), 一次性录到系统
 *
 * UX:
 *   1. 选 B2B 供应商 + 门店
 *   2. 上传 Excel (或手工新增行)
 *   3. 预览每行 (日期/总额/品名摘要), 可改, 可删
 *   4. 提交 → 一次性建多张 receipt
 *
 * Excel 格式约定 (示例):
 *   送货日期 | 总金额 | 备注/品名
 *   2026-05-03 | 583.20 | 黄豆×20kg / 香菇×5kg
 *   ...
 */
'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import dayjs from 'dayjs'
import { apiFetch } from '@/lib/v2-auth'
import FinanceTopNav from '../../_topnav'

type Supplier = { id: string; name: string; sourceType?: string | null }
type Store = { id: string; name: string }
type Row = {
  deliveryDate: string
  totalAmount: number
  note: string
}

export default function ImportB2BPage() {
  const router = useRouter()
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [stores, setStores] = useState<Store[]>([])
  const [supplierId, setSupplierId] = useState<string>('')
  const [storeId, setStoreId] = useState<string>('')
  const [rows, setRows] = useState<Row[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [parseError, setParseError] = useState<string | null>(null)
  const [result, setResult] = useState<{ created: string[]; errors: any[]; summary: any } | null>(null)

  useEffect(() => {
    Promise.all([
      apiFetch<Supplier[]>('/api/suppliers'),
      apiFetch<Store[]>('/api/stores'),
    ]).then(([s, st]) => {
      // 仅显示 sourceType=B2B_PLATFORM 的供应商, 但若没有则全部
      const b2bSuppliers = s.filter(x => x.sourceType === 'B2B_PLATFORM')
      setSuppliers(b2bSuppliers.length > 0 ? b2bSuppliers : s)
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
      const parsed: Row[] = raw.map((row, i) => {
        // 兼容列名: 送货日期/日期/date, 总金额/金额/amount, 备注/品名/note
        const dateKey = Object.keys(row).find(k => /日期|date|时间/i.test(k))
        const amtKey = Object.keys(row).find(k => /金额|amount|价/i.test(k))
        const noteKey = Object.keys(row).find(k => /备注|品名|note|明细/i.test(k))
        const dateRaw = dateKey ? row[dateKey] : ''
        const date = typeof dateRaw === 'number'
          // Excel 日期序列号
          ? dayjs('1900-01-01').add(dateRaw - 2, 'day').format('YYYY-MM-DD')
          : String(dateRaw).trim() || ''
        return {
          deliveryDate: date,
          totalAmount: Number(amtKey ? row[amtKey] : 0) || 0,
          note: noteKey ? String(row[noteKey] || '').trim() : '',
        }
      }).filter(r => r.deliveryDate && r.totalAmount > 0)
      if (parsed.length === 0) {
        setParseError('Excel 中找不到有效行 (需含 "日期" + "金额" 列)')
        return
      }
      setRows(parsed)
    } catch (e: any) {
      setParseError('解析失败: ' + (e?.message || e))
    }
  }

  function addEmptyRow() {
    setRows(r => [...r, { deliveryDate: dayjs().format('YYYY-MM-DD'), totalAmount: 0, note: '' }])
  }
  function updateRow(i: number, patch: Partial<Row>) {
    setRows(rs => {
      const next = [...rs]
      next[i] = { ...next[i], ...patch }
      return next
    })
  }
  function removeRow(i: number) {
    setRows(rs => rs.filter((_, idx) => idx !== i))
  }

  const totalSum = rows.reduce((s, r) => s + (r.totalAmount || 0), 0)
  const validRows = rows.filter(r => r.deliveryDate && r.totalAmount > 0)
  const canSubmit = supplierId && storeId && validRows.length > 0 && !submitting

  async function submit() {
    if (!canSubmit) return
    setSubmitting(true); setResult(null)
    try {
      const r = await apiFetch<{ created: string[]; errors: any[]; summary: any }>(
        '/api/finance/b2b/import-rows',
        {
          method: 'POST',
          body: JSON.stringify({ supplierId, storeId, rows: validRows }),
        },
      )
      setResult(r)
      if (r.summary.errorCount === 0) {
        setTimeout(() => router.push('/v2/finance-pc/cost-check'), 2000)
      }
    } catch (e: any) {
      alert(e?.message || '提交失败')
    } finally { setSubmitting(false) }
  }

  return (
    <div className="min-h-screen bg-bg">
      <FinanceTopNav />
      <main className="max-w-[1200px] mx-auto px-6 py-6">
        <div className="flex items-center gap-2 mb-4">
          <a href="/v2/finance-pc/cost-check" className="text-gray2 hover:text-ink text-caption">← 月度成本核对</a>
          <span className="text-gray3">/</span>
          <span className="text-caption text-gray2">导入 B2B 账单</span>
        </div>

        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-h1">导入 B2B 平台账单</h1>
            <p className="text-caption text-gray3">美菜 / 快驴 等平台的月账单, 批量录入</p>
          </div>
          <button onClick={submit} disabled={!canSubmit}
                  className="px-4 py-2 bg-ink text-white rounded-cta text-button disabled:opacity-40">
            {submitting ? '提交中…' : `提交 ${validRows.length} 行`}
          </button>
        </div>

        {/* 步骤 1: 选 supplier + store */}
        <section className="bg-white rounded-card border border-border p-4 mb-4">
          <h2 className="text-h2 mb-3">① 选 平台供应商 + 门店</h2>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-micro text-gray3 block mb-1.5">B2B 供应商</label>
              <select value={supplierId} onChange={e => setSupplierId(e.target.value)}
                      className="w-full px-3 py-2 rounded-cta border border-border bg-white text-button">
                <option value="">— 选择 —</option>
                {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}{s.sourceType === 'B2B_PLATFORM' ? '' : ' (未分类)'}</option>)}
              </select>
              {suppliers.filter(s => s.sourceType === 'B2B_PLATFORM').length === 0 && (
                <p className="text-micro text-amber-fg mt-1">
                  💡 尚无 B2B 平台供应商, 显示全部. 请先去 <a href="/v2/finance-pc/cost-check" className="underline">月度成本核对</a> 给供应商打标.
                </p>
              )}
            </div>
            <div>
              <label className="text-micro text-gray3 block mb-1.5">门店</label>
              <select value={storeId} onChange={e => setStoreId(e.target.value)}
                      className="w-full px-3 py-2 rounded-cta border border-border bg-white text-button">
                <option value="">— 选择 —</option>
                {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          </div>
        </section>

        {/* 步骤 2: 上传 Excel */}
        <section className="bg-white rounded-card border border-border p-4 mb-4">
          <h2 className="text-h2 mb-3">② 上传账单 (Excel) 或手工录入</h2>
          <div className="flex items-center gap-3 flex-wrap">
            <label className="px-4 py-2 bg-amber text-white rounded-cta text-button cursor-pointer">
              📂 选 Excel 文件
              <input type="file" accept=".xlsx,.xls,.csv" onChange={e => e.target.files?.[0] && handleFile(e.target.files[0])} className="hidden" />
            </label>
            <button onClick={addEmptyRow} className="px-4 py-2 bg-white border border-border rounded-cta text-button text-gray2">+ 新增行</button>
            {rows.length > 0 && (
              <button onClick={() => setRows([])} className="px-3 py-2 text-caption text-red-fg">清空</button>
            )}
          </div>
          {parseError && <div className="mt-3 bg-red-bg text-red-fg rounded-cta p-2 text-caption">{parseError}</div>}
          <p className="text-micro text-gray3 mt-2">
            💡 Excel 列名建议: <code>送货日期</code> / <code>总金额</code> / <code>备注</code> (兼容含"日期"/"金额"等关键字的列)
          </p>
        </section>

        {/* 步骤 3: 预览/编辑 */}
        {rows.length > 0 && (
          <section className="bg-white rounded-card border border-border overflow-hidden mb-4">
            <header className="px-4 py-3 border-b border-border flex items-center justify-between">
              <h2 className="text-h2">③ 预览 ({rows.length} 行 · 合计 ¥{totalSum.toLocaleString(undefined, { minimumFractionDigits: 2 })})</h2>
              <span className="text-caption text-gray3">点击任意单元格可改</span>
            </header>
            <table className="w-full">
              <thead className="bg-bg/40">
                <tr className="text-micro text-gray3 text-left">
                  <th className="px-3 py-2 font-normal w-12">#</th>
                  <th className="px-3 py-2 font-normal w-44">送货日期</th>
                  <th className="px-3 py-2 font-normal text-right w-32">总金额 (¥)</th>
                  <th className="px-3 py-2 font-normal">备注 / 品名</th>
                  <th className="px-3 py-2 font-normal w-12"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className={`border-t border-border ${!r.deliveryDate || r.totalAmount <= 0 ? 'bg-red-bg/30' : ''}`}>
                    <td className="px-3 py-1.5 text-caption text-gray3">{i + 1}</td>
                    <td className="px-3 py-1.5">
                      <input type="date" value={r.deliveryDate}
                             onChange={e => updateRow(i, { deliveryDate: e.target.value })}
                             className="px-2 py-1 rounded border border-border bg-white text-caption font-num w-full" />
                    </td>
                    <td className="px-3 py-1.5">
                      <input type="number" step="0.01" value={r.totalAmount || ''}
                             onChange={e => updateRow(i, { totalAmount: Number(e.target.value) || 0 })}
                             className="px-2 py-1 rounded border border-border bg-white text-caption font-num text-right w-full" />
                    </td>
                    <td className="px-3 py-1.5">
                      <input value={r.note} onChange={e => updateRow(i, { note: e.target.value })}
                             className="px-2 py-1 rounded border border-border bg-white text-caption w-full" />
                    </td>
                    <td className="px-3 py-1.5 text-center">
                      <button onClick={() => removeRow(i)} className="text-red-fg hover:bg-red-bg/40 rounded w-6 h-6 text-caption">×</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {/* 结果 */}
        {result && (
          <div className={`rounded-card p-4 ${result.summary.errorCount === 0 ? 'bg-green-bg' : 'bg-red-bg'}`}>
            <div className="text-h2 mb-2">
              {result.summary.errorCount === 0 ? '✓ 全部导入成功' : `⚠ 部分失败`}
            </div>
            <p className="text-caption">
              成功: {result.summary.createdCount} / 失败: {result.summary.errorCount}
              {result.summary.errorCount === 0 && ' · 2 秒后跳回月度成本核对'}
            </p>
            {result.errors.length > 0 && (
              <ul className="mt-2 text-caption space-y-1">
                {result.errors.map((e: any, i: number) => (
                  <li key={i}>第 {e.rowIdx + 1} 行: {e.msg}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </main>
    </div>
  )
}
