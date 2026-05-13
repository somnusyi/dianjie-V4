/**
 * 供应商 · 入库 (v1.1)
 *
 * 两种模式:
 *  A. 手动单/多条 — 选 SKU + 数量 + 生产日期 + 保质期
 *  B. Excel 批量 — 上传, 后端按名称匹配
 *
 * 新增能力:
 *  - 入库时如果 SKU 不存在, 弹「+ 新建 SKU」小窗即时创建
 *  - 每行可填生产日期 + 保质期(天) → 自动算到期日 → 流水里留痕
 */
'use client'
import { useEffect, useState } from 'react'
import { apiFetch } from '@/lib/v2-auth'
import * as XLSX from 'xlsx'

type Sku = { id: string; code: string; name: string; spec: string | null; unit: string; stock: number; shelfDays?: number }
type Row = {
  __row: number; productId: string; name: string; matchedSku?: Sku
  qty: string
  manufactureDate?: string  // YYYY-MM-DD
  shelfDaysAtBatch?: string // 这批的保质期天数 (可改, 默认拿 SKU 的)
  reason?: string
  __error?: string
}

function todayStr() {
  return new Date().toISOString().slice(0, 10)
}
function addDays(date: string, days: number) {
  const d = new Date(date)
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

export default function InboundPage() {
  const [skus, setSkus] = useState<Sku[]>([])
  const [mode, setMode] = useState<'manual'|'excel'>('manual')
  const [rows, setRows] = useState<Row[]>([{ __row: 1, productId: '', name: '', qty: '', manufactureDate: todayStr() }])
  const [batchReason, setBatchReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [newSkuOpen, setNewSkuOpen] = useState<{ rowIdx: number } | null>(null)
  const [newSku, setNewSku] = useState({ name: '', spec: '', unit: '件', price: '', shelfDays: '7' })
  const [creatingSku, setCreatingSku] = useState(false)

  function reload() {
    apiFetch<any[]>('/api/products')
      .then(d => setSkus(d.map((s: any) => ({
        id: s.id, code: s.code, name: s.name, spec: s.spec, unit: s.unit,
        stock: Number(s.stock), shelfDays: s.shelfDays,
      }))))
      .catch(e => setError(e.message))
  }
  useEffect(reload, [])

  function addRow() { setRows(r => [...r, { __row: r.length + 1, productId: '', name: '', qty: '', manufactureDate: todayStr() }]) }
  function removeRow(i: number) { setRows(r => r.filter((_, idx) => idx !== i)) }

  function selectSku(rowIdx: number, productId: string) {
    const sku = skus.find(s => s.id === productId)
    setRows(rs => rs.map((x,i) => i===rowIdx ? {
      ...x,
      productId,
      name: sku?.name || '',
      matchedSku: sku,
      shelfDaysAtBatch: sku?.shelfDays ? String(sku.shelfDays) : '',
    } : x))
  }

  async function createSku() {
    if (!newSku.name.trim() || !newSku.price) { setError('品名 + 单价 必填'); return }
    setCreatingSku(true); setError(null)
    try {
      const created: any = await apiFetch('/api/products', {
        method: 'POST',
        body: JSON.stringify({
          name: newSku.name.trim(),
          spec: newSku.spec.trim() || undefined,
          unit: newSku.unit.trim() || '件',
          price: Number(newSku.price),
          shelfDays: Number(newSku.shelfDays) || 7,
          stock: 0, minStock: 0,
        }),
      })
      // 刷新 SKU 列表 + 自动选中刚建的
      await new Promise(r => setTimeout(r, 200))
      const fresh: any[] = await apiFetch('/api/products')
      const newList = fresh.map(s => ({ id: s.id, code: s.code, name: s.name, spec: s.spec, unit: s.unit, stock: Number(s.stock), shelfDays: s.shelfDays }))
      setSkus(newList)
      const just = newList.find(s => s.name === newSku.name.trim())
      if (just && newSkuOpen) selectSku(newSkuOpen.rowIdx, just.id)
      setNewSkuOpen(null)
      setNewSku({ name: '', spec: '', unit: '件', price: '', shelfDays: '7' })
    } catch (e: any) { setError(e.message || '创建 SKU 失败') }
    finally { setCreatingSku(false) }
  }

  async function parseExcel(file: File) {
    const buf = await file.arrayBuffer()
    const wb = XLSX.read(buf, { type: 'array' })
    const sheet = wb.Sheets[wb.SheetNames[0]]
    const aoa: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' })
    let headerIdx = -1
    for (let i = 0; i < Math.min(aoa.length, 10); i++) {
      const r = aoa[i].map(v => String(v || '').trim())
      if (r.some(c => /品项名称|商品名称|名称|品名/.test(c))) { headerIdx = i; break }
    }
    if (headerIdx === -1) { setError('找不到表头, 需含「品项名称」+「入库数量」 (这是入库表, 不是报价单)'); return }
    const header = aoa[headerIdx].map(v => String(v || '').trim())
    const nameCol = header.findIndex(c => /品项名称|商品名称|名称|品名/.test(c))
    const qtyCol  = header.findIndex(c => /入库数量|数量|qty|库存/i.test(c))
    const mDateCol = header.findIndex(c => /生产日期|生产/.test(c))
    const expCol  = header.findIndex(c => /到期|过期|保质期/.test(c))
    if (qtyCol === -1) {
      setError('找不到数量列。入库 Excel 至少要 2 列: 「品项名称」+「入库数量」(或 数量/库存/qty). 如果你想上传的是【报价单】(只有品名+价格), 请去「商品报价表」页面上传, 那里负责创建 SKU; 这里负责录入实际仓库数量.')
      return
    }

    const newRows: Row[] = []
    for (let i = headerIdx + 1; i < aoa.length; i++) {
      const arr = aoa[i] || []
      const name = String(arr[nameCol] || '').trim()
      const qty  = arr[qtyCol]
      if (!name && !qty) continue
      const matched = skus.find(s => s.name === name)
      const qNum = Number(qty)
      const r: Row = {
        __row: i + 1,
        productId: matched?.id || '',
        name,
        matchedSku: matched,
        qty: String(qty || ''),
        manufactureDate: mDateCol >= 0 && arr[mDateCol] ? String(arr[mDateCol]) : todayStr(),
        shelfDaysAtBatch: matched?.shelfDays ? String(matched.shelfDays) : '',
      }
      if (!name) r.__error = '名称为空'
      else if (!matched) r.__error = '未找到 SKU (手动模式可建新)'
      else if (!Number.isFinite(qNum) || qNum <= 0) r.__error = '数量必须 > 0'
      newRows.push(r)
    }
    setRows(newRows)
    setError(null)
  }

  async function submit() {
    setError(null); setResult(null)
    const valid = rows.filter(r => !r.__error && r.productId && Number(r.qty) > 0)
    if (valid.length === 0) { setError('没有有效行'); return }
    setSubmitting(true)
    try {
      const items = valid.map(r => {
        const item: any = { productId: r.productId, qty: Number(r.qty), reason: r.reason?.trim() || undefined }
        if (r.manufactureDate) {
          item.manufactureDate = r.manufactureDate
          const days = Number(r.shelfDaysAtBatch || 0)
          if (Number.isFinite(days) && days > 0) item.expiryDate = addDays(r.manufactureDate, days)
        }
        return item
      })
      const res = await apiFetch<any>('/api/supplier/stock/inbound', {
        method: 'POST',
        body: JSON.stringify({ source: mode === 'excel' ? 'EXCEL' : 'MANUAL', reason: batchReason.trim() || undefined, items }),
      })
      setResult(`✓ 入库成功 ${res.count} 条`)
      setRows([{ __row: 1, productId: '', name: '', qty: '', manufactureDate: todayStr() }])
      setBatchReason('')
      reload()
    } catch (e: any) {
      setError(e.message || '入库失败')
    } finally {
      setSubmitting(false)
    }
  }

  const validCount = rows.filter(r => !r.__error && r.productId && Number(r.qty) > 0).length

  return (
    <div className="min-h-screen bg-bg pb-32">
      <header className="px-4 pt-4 pb-2 flex items-center gap-3">
        <a href="/v2/supplier/inventory" className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center">‹</a>
        <h1 className="text-h1 flex-1">入库</h1>
      </header>

      {skus.length === 0 && (
        <div className="mx-4 mt-3 bg-amber/10 border border-amber/30 rounded-card p-3 text-caption text-amber-fg">
          ⚠ 你还没有任何 SKU. 请先去「<a href="/v2/supplier/products" className="underline font-medium">商品报价表</a>」上传报价单, 再回来录入库存.
        </div>
      )}

      <div className="px-4 mt-2 flex gap-2">
        <button onClick={() => setMode('manual')} className={`px-3 py-1.5 rounded-full text-caption ${mode==='manual'?'bg-ink text-white':'bg-white border border-border text-gray2'}`}>手动录入</button>
        <button onClick={() => setMode('excel')} className={`px-3 py-1.5 rounded-full text-caption ${mode==='excel'?'bg-ink text-white':'bg-white border border-border text-gray2'}`}>Excel 批量</button>
      </div>

      {mode === 'excel' && (
        <div className="px-4 mt-3">
          <label className="block bg-white rounded-card border border-border p-4 text-center cursor-pointer">
            <span className="text-h2">📁 选择 Excel</span>
            <p className="text-micro text-gray3 mt-1">列名: 品项名称 + 数量 (可选: 生产日期 / 保质期)</p>
            <input type="file" accept=".xlsx,.xls" className="hidden" onChange={e => e.target.files?.[0] && parseExcel(e.target.files[0])} />
          </label>
        </div>
      )}

      <div className="px-4 mt-3">
        <label className="text-micro text-gray3 block mb-1">本批备注 (选填)</label>
        <input value={batchReason} onChange={e => setBatchReason(e.target.value)} maxLength={120}
          className="w-full bg-white rounded-card border border-border p-2 text-body" placeholder="如: 3/5 早班到货" />
      </div>

      <ul className="px-4 mt-3 space-y-2">
        {rows.map((r, idx) => (
          <li key={idx} className={`bg-white rounded-card border p-3 ${r.__error ? 'border-red/30 bg-red-bg/40' : 'border-border'}`}>
            {mode === 'manual' ? (
              <div className="space-y-2">
                <div className="flex gap-2">
                  <select value={r.productId} onChange={e => selectSku(idx, e.target.value)}
                    className="flex-1 bg-bg border border-border rounded p-2 text-body">
                    <option value="">— 选 SKU —</option>
                    {skus.map(s => <option key={s.id} value={s.id}>{s.name} ({s.code}, 现 {s.stock} {s.unit})</option>)}
                  </select>
                  <button onClick={() => { setNewSkuOpen({ rowIdx: idx }); setNewSku({ name: '', spec: '', unit: '件', price: '', shelfDays: '7' }) }}
                    className="px-3 py-2 bg-amber/10 text-amber-fg border border-amber/30 rounded text-caption">+ 新 SKU</button>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <label className="text-micro text-gray3">入库数量</label>
                    <input type="number" step="0.01" min="0" value={r.qty}
                      onChange={e => setRows(rs => rs.map((x,i) => i===idx ? { ...x, qty: e.target.value } : x))}
                      className="w-full bg-bg border border-border rounded p-2 text-body font-num" />
                  </div>
                  <div>
                    <label className="text-micro text-gray3">生产日期</label>
                    <input type="date" value={r.manufactureDate || ''}
                      onChange={e => setRows(rs => rs.map((x,i) => i===idx ? { ...x, manufactureDate: e.target.value } : x))}
                      className="w-full bg-bg border border-border rounded p-2 text-body font-num" />
                  </div>
                  <div>
                    <label className="text-micro text-gray3">保质期(天)</label>
                    <input type="number" min="0" value={r.shelfDaysAtBatch || ''}
                      placeholder={r.matchedSku?.shelfDays ? String(r.matchedSku.shelfDays) : '7'}
                      onChange={e => setRows(rs => rs.map((x,i) => i===idx ? { ...x, shelfDaysAtBatch: e.target.value } : x))}
                      className="w-full bg-bg border border-border rounded p-2 text-body font-num" />
                  </div>
                </div>
                {r.manufactureDate && r.shelfDaysAtBatch && Number(r.shelfDaysAtBatch) > 0 && (
                  <div className="text-micro text-amber-fg">
                    → 到期日: {addDays(r.manufactureDate, Number(r.shelfDaysAtBatch))}
                  </div>
                )}
                <div className="flex gap-2">
                  <input value={r.reason || ''} placeholder="本条备注 (选填)"
                    onChange={e => setRows(rs => rs.map((x,i) => i===idx ? { ...x, reason: e.target.value } : x))}
                    className="flex-1 bg-bg border border-border rounded p-2 text-caption" />
                  {rows.length > 1 && <button onClick={() => removeRow(idx)} className="px-2 text-gray3">×</button>}
                </div>
              </div>
            ) : (
              <div className="text-caption">
                <div className="flex items-baseline gap-2">
                  <span className="text-body">{r.name || '(空)'}</span>
                  {r.matchedSku && <span className="text-micro text-gray3">→ {r.matchedSku.code} 现 {r.matchedSku.stock} {r.matchedSku.unit}</span>}
                </div>
                <div className="font-num mt-1">入库 <b>{r.qty}</b>
                  {r.manufactureDate && <span className="text-micro text-gray3 ml-2">生产 {r.manufactureDate}</span>}
                  {r.manufactureDate && r.shelfDaysAtBatch && Number(r.shelfDaysAtBatch) > 0 && (
                    <span className="text-micro text-amber-fg ml-2">→ 到期 {addDays(r.manufactureDate, Number(r.shelfDaysAtBatch))}</span>
                  )}
                </div>
                {r.__error && <div className="text-red-fg mt-1">⚠ {r.__error}</div>}
              </div>
            )}
          </li>
        ))}
      </ul>

      {mode === 'manual' && (
        <div className="px-4 mt-2">
          <button onClick={addRow} className="w-full py-2 bg-white border border-border rounded-cta text-caption text-gray2">+ 加一行</button>
        </div>
      )}

      {error && <div className="mx-4 mt-3 bg-red-bg text-red-fg rounded-card p-3 text-caption">{error}</div>}
      {result && <div className="mx-4 mt-3 bg-green-bg text-green-fg rounded-card p-3 text-caption">{result}</div>}

      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-border p-4"
           style={{ paddingBottom: 'calc(16px + env(safe-area-inset-bottom))' }}>
        <button onClick={submit} disabled={submitting || validCount === 0}
          className="w-full py-3 bg-ink text-white rounded-cta text-button disabled:opacity-40">
          {submitting ? '提交中…' : `确认入库 ${validCount} 条`}
        </button>
      </div>

      {/* 新建 SKU 小窗 */}
      {newSkuOpen && (
        <div className="fixed inset-0 z-50 bg-ink/40 flex items-end" onClick={() => setNewSkuOpen(null)}>
          <div className="w-full bg-white rounded-t-2xl p-4" onClick={e => e.stopPropagation()}
               style={{ paddingBottom: 'calc(28px + env(safe-area-inset-bottom))' }}>
            <h2 className="text-h2">新建 SKU 并入库</h2>
            <p className="text-caption text-gray3 mt-1">建好后回到入库会自动选中此 SKU</p>
            <div className="grid grid-cols-2 gap-2 mt-3">
              <div className="col-span-2">
                <label className="text-micro text-gray3">品项名称 *</label>
                <input value={newSku.name} onChange={e => setNewSku({...newSku, name: e.target.value})}
                  className="w-full bg-bg border border-border rounded p-2 text-body" placeholder="例: 见手青啤酒" />
              </div>
              <div>
                <label className="text-micro text-gray3">规格</label>
                <input value={newSku.spec} onChange={e => setNewSku({...newSku, spec: e.target.value})}
                  className="w-full bg-bg border border-border rounded p-2 text-body" placeholder="24瓶*330ml/件" />
              </div>
              <div>
                <label className="text-micro text-gray3">单位</label>
                <input value={newSku.unit} onChange={e => setNewSku({...newSku, unit: e.target.value})}
                  className="w-full bg-bg border border-border rounded p-2 text-body" />
              </div>
              <div>
                <label className="text-micro text-gray3">单价 *</label>
                <input type="number" step="0.01" value={newSku.price} onChange={e => setNewSku({...newSku, price: e.target.value})}
                  className="w-full bg-bg border border-border rounded p-2 text-body font-num" />
              </div>
              <div>
                <label className="text-micro text-gray3">默认保质期(天)</label>
                <input type="number" value={newSku.shelfDays} onChange={e => setNewSku({...newSku, shelfDays: e.target.value})}
                  className="w-full bg-bg border border-border rounded p-2 text-body font-num" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 mt-4">
              <button onClick={() => setNewSkuOpen(null)} className="py-3 bg-white border border-border rounded-cta text-button text-gray2">取消</button>
              <button onClick={createSku} disabled={creatingSku} className="py-3 bg-amber text-white rounded-cta text-button disabled:opacity-40">
                {creatingSku ? '创建中…' : '创建 + 选中'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
