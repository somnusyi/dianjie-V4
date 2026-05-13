/**
 * 供应商 · 全量库存清单导入
 *
 * 跟「↓ 入库」的区别:
 *   入库 = 在原有库存上 +N (日常到货, 增量)
 *   导入 = 把库存设置到 Excel 里的目标值 (首次系统化 / 月末盘点 / 第三方迁移, 一次性)
 *
 * 处理逻辑:
 *   - SKU 已存在 (按品名匹配): 调整库存到目标数 → ADJUSTMENT 流水
 *   - SKU 不存在: 自动创建 (price=0, 后续可单条改价) → INITIAL 流水
 *   - 库存已经等于目标数: 跳过, 无变化
 */
'use client'
import { useState } from 'react'
import { apiFetch } from '@/lib/v2-auth'
import * as XLSX from 'xlsx'

type Row = {
  __row: number; name: string; spec?: string; category?: string; unit?: string; qty: number
  __error?: string
}

const HEADER_MAP: Record<string, string> = {
  '品项名称': 'name', '商品名称': 'name', '名称': 'name', '品名': 'name', '物品名称': 'name',
  '规格型号': 'spec', '规格': 'spec',
  '采购单位': 'unit', '单位': 'unit',
  '类目': 'category', '类别': 'category', '分类': 'category', '物品类别': 'category',
  '初始库存': 'qty', '当前库存': 'qty', '库存': 'qty', '库存量': 'qty',
  '数量': 'qty', '盘点数量': 'qty', 'qty': 'qty',
}

export default function ImportSnapshotPage() {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [filename, setFilename] = useState('')
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)

  async function parseFile(file: File) {
    setError(null); setResult(null)
    setFilename(file.name)
    const buf = await file.arrayBuffer()
    const wb = XLSX.read(buf, { type: 'array' })
    const sheet = wb.Sheets[wb.SheetNames[0]]
    const aoa: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' })
    let headerIdx = -1
    for (let i = 0; i < Math.min(aoa.length, 10); i++) {
      const r = aoa[i].map(v => String(v || '').trim())
      const hasName = r.some(c => HEADER_MAP[c] === 'name')
      const hasQty  = r.some(c => HEADER_MAP[c] === 'qty')
      if (hasName && hasQty) { headerIdx = i; break }
    }
    if (headerIdx === -1) { setError('找不到表头. 至少需要 「物品名称/品项名称」 + 「库存量/数量」 两列'); return }
    const header = aoa[headerIdx].map(v => String(v || '').trim())
    const keys = header.map(h => HEADER_MAP[h])

    const parsed: Row[] = []
    for (let i = headerIdx + 1; i < aoa.length; i++) {
      const arr = aoa[i] || []
      const r: any = { __row: i + 1 }
      keys.forEach((k, idx) => {
        if (k && arr[idx] !== '' && arr[idx] != null) r[k] = arr[idx]
      })
      if (!r.name) continue   // 跳过空行
      const q = Number(r.qty)
      if (!Number.isFinite(q) || q < 0) {
        parsed.push({ ...r, qty: r.qty, __error: '数量无效或为负' })
      } else {
        parsed.push({ ...r, qty: q })
      }
    }
    setRows(parsed)
  }

  async function submit() {
    if (!rows || rows.length === 0) return
    const valid = rows.filter(r => !r.__error)
    if (valid.length === 0) { setError('没有有效行'); return }
    setSubmitting(true); setError(null)
    try {
      const res = await apiFetch<any>('/api/supplier/stock/import-snapshot', {
        method: 'POST',
        body: JSON.stringify({
          items: valid.map(r => ({
            name: r.name.trim(),
            spec: r.spec?.toString().trim() || undefined,
            category: r.category?.toString().trim() || undefined,
            unit: r.unit?.toString().trim() || '件',
            qty: r.qty,
          })),
          reason: reason.trim() || `导入 ${filename || '库存清单'}`,
        }),
      })
      setResult(res)
    } catch (e: any) {
      setError(e.message || '导入失败')
    } finally {
      setSubmitting(false)
    }
  }

  const validCount = rows ? rows.filter(r => !r.__error).length : 0
  const errorCount = rows ? rows.filter(r => r.__error).length : 0

  return (
    <div className="min-h-screen bg-bg pb-32">
      <header className="px-4 pt-4 pb-2 flex items-center gap-3">
        <a href="/v2/supplier/inventory" className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center">‹</a>
        <h1 className="text-h1 flex-1">导入库存清单</h1>
      </header>

      <div className="mx-4 mt-2 bg-bg-warm border border-border rounded-card p-3 text-caption text-gray2">
        <p>本功能用于<b>首次系统化 / 月末盘点 / 第三方系统迁移</b> — 把整批库存一次性导入。</p>
        <p className="mt-1">日常到货增量请走「<a href="/v2/supplier/inventory/inbound" className="text-amber-fg underline">↓ 入库</a>」。</p>
        <p className="mt-1 text-micro text-gray3">Excel 列名（必填）: 物品名称 / 品项名称 + 库存量 / 数量。可选: 规格 / 类别 / 单位</p>
      </div>

      <div className="px-4 mt-3">
        <label className="block bg-white rounded-card border border-border p-4 text-center cursor-pointer">
          <span className="text-h2">📁 选择 Excel</span>
          {filename && <p className="text-caption text-gray2 mt-1">{filename}</p>}
          <input type="file" accept=".xlsx,.xls" className="hidden" onChange={e => e.target.files?.[0] && parseFile(e.target.files[0])} />
        </label>
      </div>

      <div className="px-4 mt-3">
        <label className="text-micro text-gray3 block mb-1">本次导入备注</label>
        <input value={reason} onChange={e => setReason(e.target.value)} maxLength={120}
          placeholder={`如: ${new Date().toISOString().slice(0,10)} 月末盘点 / 系统首次导入`}
          className="w-full bg-white rounded-card border border-border p-2 text-body" />
      </div>

      {rows && rows.length > 0 && (
        <div className="px-4 mt-3">
          <div className="flex items-baseline gap-2 mb-2">
            <span className="text-caption text-gray2">解析 {rows.length} 行</span>
            {validCount > 0 && <span className="text-caption text-green-fg">· 有效 {validCount}</span>}
            {errorCount > 0 && <span className="text-caption text-red-fg">· 异常 {errorCount}</span>}
          </div>
          <ul className="bg-white rounded-card border border-border divide-y divide-border max-h-96 overflow-auto">
            {rows.slice(0, 50).map((r, i) => (
              <li key={i} className={`p-2 text-caption flex items-center gap-2 ${r.__error ? 'text-red-fg bg-red-bg/40' : ''}`}>
                <span className="text-micro text-gray3 w-8">行{r.__row}</span>
                <span className="flex-1 truncate">{r.name}</span>
                {r.spec && <span className="text-micro text-gray3 hidden sm:inline">{r.spec}</span>}
                <span className="font-num">{r.qty}</span>
                {r.__error && <span className="text-micro">{r.__error}</span>}
              </li>
            ))}
            {rows.length > 50 && (
              <li className="p-2 text-caption text-gray3 text-center">… 还有 {rows.length - 50} 行未显示</li>
            )}
          </ul>
        </div>
      )}

      {error && <div className="mx-4 mt-3 bg-red-bg text-red-fg rounded-card p-3 text-caption">{error}</div>}

      {result && (
        <div className="mx-4 mt-3 bg-green-bg text-green-fg rounded-card p-3 text-caption">
          <div className="text-h2">✓ 导入完成</div>
          <ul className="mt-2 space-y-0.5">
            <li>· 总行数: <b className="font-num">{result.summary.total}</b></li>
            <li>· 新建 SKU: <b className="font-num">{result.summary.created}</b></li>
            <li>· 调整库存: <b className="font-num">{result.summary.adjusted}</b></li>
            <li>· 已是目标值跳过: <b className="font-num">{result.summary.skipped}</b></li>
            {result.summary.failed > 0 && <li className="text-red-fg">· 失败: <b className="font-num">{result.summary.failed}</b></li>}
          </ul>
          <a href="/v2/supplier/inventory" className="block mt-3 py-2 bg-amber text-white rounded-cta text-button text-center">回到库存总览</a>
          <p className="mt-2 text-micro text-gray3">⚠ 自动新建的 SKU 价格为 0, 请去「商品报价表」单条改价。</p>
        </div>
      )}

      {rows && rows.length > 0 && !result && (
        <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-border p-4"
             style={{ paddingBottom: 'calc(16px + env(safe-area-inset-bottom))' }}>
          <button onClick={submit} disabled={submitting || validCount === 0}
            className="w-full py-3 bg-ink text-white rounded-cta text-button disabled:opacity-40">
            {submitting ? '导入中…' : `确认导入 ${validCount} 条`}
          </button>
        </div>
      )}
    </div>
  )
}
