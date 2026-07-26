'use client'

import { useEffect, useState } from 'react'
import { Chip } from '@/components/v2'
import { apiFetch } from '@/lib/v2-auth'
import {
  assertInboundWarehouseResponse,
  withSupplierWarehouseParams,
} from '@/lib/supplier-default-warehouse'

type Supplier = { id: string; no: string; name: string }
type Product = { id: string; code: string; name: string; inventoryUnit?: string | null; unit: string }
type ParsedRow = {
  row: number
  code: string
  name: string
  qty: number
  batchNo?: string
  manufactureDate?: string
  expiryDate?: string
  product?: Product
  error?: string
}

const HEADERS: Record<string, 'code' | 'name' | 'qty' | 'batchNo' | 'manufactureDate' | 'expiryDate'> = {
  商品编码: 'code', 编码: 'code', 物品编码: 'code',
  商品名称: 'name', 品项名称: 'name', 物品名称: 'name', 名称: 'name',
  入库数量: 'qty', 数量: 'qty', 库存量: 'qty',
  批次号: 'batchNo', 生产日期: 'manufactureDate', 到期日期: 'expiryDate',
}

function normalizeDate(value: unknown) {
  if (!value) return undefined
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  const text = String(value).trim()
  return /^\d{4}-\d{1,2}-\d{1,2}$/.test(text)
    ? text.split('-').map((part, index) => index === 0 ? part : part.padStart(2, '0')).join('-')
    : undefined
}

async function parseWorkbook(file: File, products: Product[]): Promise<ParsedRow[]> {
  const XLSX = await import('xlsx')
  const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true })
  const values = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[workbook.SheetNames[0]], { header: 1, defval: '' })
  const headerIndex = values.findIndex(row => Array.isArray(row) && row.some(cell => HEADERS[String(cell).trim()] === 'qty'))
  if (headerIndex < 0) throw new Error('找不到表头，请至少包含“入库数量”，并提供商品编码或名称')
  const keys = values[headerIndex].map(cell => HEADERS[String(cell).trim()] || null)
  const byCode = new Map(products.map(product => [product.code.trim().toLowerCase(), product]))
  const byName = new Map<string, Product[]>()
  for (const product of products) {
    const key = product.name.trim().toLowerCase()
    byName.set(key, [...(byName.get(key) || []), product])
  }
  const rows: ParsedRow[] = []
  for (let index = headerIndex + 1; index < values.length; index++) {
    const source = values[index]
    const raw: Record<string, unknown> = {}
    keys.forEach((key, column) => { if (key) raw[key] = source[column] })
    const code = String(raw.code || '').trim()
    const name = String(raw.name || '').trim()
    if (!code && !name && !raw.qty) continue
    const qty = Number(raw.qty)
    const codeMatch = code ? byCode.get(code.toLowerCase()) : undefined
    const nameMatches = name ? byName.get(name.toLowerCase()) || [] : []
    const product = codeMatch || (nameMatches.length === 1 ? nameMatches[0] : undefined)
    let error = ''
    if (!product) error = nameMatches.length > 1 ? '商品名称重复，请补商品编码' : '未匹配现有商品'
    else if (!Number.isFinite(qty) || qty <= 0) error = '入库数量必须大于 0'
    else if (Math.round(qty * 100) !== qty * 100) error = '数量最多保留 2 位小数'
    rows.push({
      row: index + 1, code, name, qty, product,
      batchNo: String(raw.batchNo || '').trim() || undefined,
      manufactureDate: normalizeDate(raw.manufactureDate),
      expiryDate: normalizeDate(raw.expiryDate),
      error: error || undefined,
    })
  }
  return rows
}

export default function InternalInventoryImportPage() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [supplierId, setSupplierId] = useState('')
  const [products, setProducts] = useState<Product[]>([])
  const [rows, setRows] = useState<ParsedRow[]>([])
  const [filename, setFilename] = useState('')
  const [reason, setReason] = useState('Excel 批量采购入库')
  const [error, setError] = useState('')
  const [done, setDone] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    apiFetch<Supplier[]>('/api/suppliers?status=ENABLED').then(list => {
      const rows = Array.isArray(list) ? list : []
      setSuppliers(rows)
      const requested = new URLSearchParams(window.location.search).get('supplierId') || ''
      setSupplierId(rows.some(item => item.id === requested) ? requested : rows[0]?.id || '')
    }).catch(reasonValue => setError(String(reasonValue?.message || reasonValue)))
  }, [])

  useEffect(() => {
    if (!supplierId) return
    setRows([])
    setFilename('')
    apiFetch<{ items: Product[] }>(`/api/supplier/stock?page=1&pageSize=500&supplierId=${encodeURIComponent(supplierId)}`)
      .then(result => setProducts(result.items || []))
      .catch(reasonValue => setError(String(reasonValue?.message || reasonValue)))
  }, [supplierId])

  async function selectFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setFilename(file.name)
    setDone('')
    setError('')
    try {
      setRows(await parseWorkbook(file, products))
    } catch (reasonValue: any) {
      setRows([])
      setError(String(reasonValue?.message || reasonValue))
    }
  }

  async function submit() {
    const valid = rows.filter(row => !row.error && row.product)
    if (valid.length === 0 || rows.some(row => row.error)) {
      setError('请先修正所有未匹配或数量错误的行；系统不会静默跳过业务库存')
      return
    }
    setSubmitting(true)
    setError('')
    try {
      const res = await apiFetch<any>(withSupplierWarehouseParams('/api/supplier/stock/inbound', supplierId), {
        method: 'POST',
        body: JSON.stringify({
          source: 'EXCEL',
          reason: `${reason.trim() || 'Excel 批量采购入库'} · ${filename}`,
          items: valid.map(row => ({
            productId: row.product!.id,
            qty: row.qty,
            ...(row.batchNo ? { batchNo: row.batchNo } : {}),
            ...(row.manufactureDate ? { manufactureDate: row.manufactureDate } : {}),
            ...(row.expiryDate ? { expiryDate: row.expiryDate } : {}),
          })),
        }),
      })
      const { warehouseName } = assertInboundWarehouseResponse(res)
      setDone(`已增量入库 ${res.count} 个商品（${warehouseName}）；库存和批次流水已同步记录`)
      setRows([])
    } catch (reasonValue: any) {
      setError(String(reasonValue?.message || reasonValue))
    } finally {
      setSubmitting(false)
    }
  }

  const invalid = rows.filter(row => row.error).length
  return (
    <div className="min-h-screen bg-bg px-4 py-5 lg:px-8 lg:py-7">
      <header className="flex flex-col gap-4 border-b border-border pb-5 xl:flex-row xl:items-end xl:justify-between">
        <div><a href="/v2/supply-chain/inventory" className="text-caption text-gray2">‹ 返回仓库库存</a><div className="mt-2 flex items-center gap-2"><Chip tone="green">增量入库</Chip><span className="text-caption text-gray3">不覆盖现有库存，不执行盘点调整</span></div><h1 className="mt-2 text-h1">Excel 批量入库</h1></div>
        <select value={supplierId} onChange={event => setSupplierId(event.target.value)} className="h-10 min-w-72 rounded-cta border border-border bg-white px-3 text-body">{suppliers.map(supplier => <option key={supplier.id} value={supplier.id}>{supplier.no} · {supplier.name}</option>)}</select>
      </header>

      {error && <div className="mt-4 rounded-card border border-red/30 bg-red-bg p-3 text-caption text-red-fg">{error}</div>}
      {done && <div className="mt-4 rounded-card border border-green/30 bg-green/10 p-3 text-caption text-green-fg">{done}</div>}

      <section className="mt-5 grid gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
        <div className="space-y-4">
          <div className="rounded-card border border-border bg-white p-4">
            <h2 className="text-h2">文件规则</h2>
            <ol className="mt-3 list-decimal space-y-2 pl-5 text-caption text-gray2"><li>必须有“商品编码”或唯一商品名称</li><li>必须有“大于 0 的入库数量”</li><li>可选：批次号、生产日期、到期日期</li><li>未知商品、重名商品、错误数量会阻止整批提交</li></ol>
          </div>
          <label className="block cursor-pointer rounded-card border-2 border-dashed border-border bg-white p-6 text-center"><input type="file" accept=".xlsx,.xls,.csv" onChange={selectFile} className="hidden" /><b>选择 Excel 文件</b><p className="mt-1 text-micro text-gray3">{filename || '支持 .xlsx / .xls / .csv'}</p></label>
          <label className="block"><span className="mb-1 block text-micro text-gray3">整批入库说明</span><input value={reason} onChange={event => setReason(event.target.value)} maxLength={100} className="h-11 w-full rounded-cta border border-border bg-white px-3" /></label>
          <button onClick={submit} disabled={submitting || rows.length === 0 || invalid > 0} className="h-11 w-full rounded-cta bg-accent text-button text-white disabled:opacity-40">{submitting ? '入库中…' : `确认增量入库 ${rows.length} 行`}</button>
        </div>

        <div className="overflow-hidden rounded-card border border-border bg-white">
          <div className="flex items-center justify-between border-b border-border px-4 py-3"><h2 className="text-h2">导入预览</h2><div className="flex gap-2"><Chip tone="green">{rows.length - invalid} 正常</Chip>{invalid > 0 && <Chip tone="red">{invalid} 错误</Chip>}</div></div>
          <div className="max-h-[680px] overflow-auto"><table className="w-full text-left text-caption"><thead className="sticky top-0 bg-bg text-gray3"><tr><th className="px-3 py-2">行</th><th className="px-3 py-2">Excel 商品</th><th className="px-3 py-2">匹配商品</th><th className="px-3 py-2 text-right">增量</th><th className="px-3 py-2">批次 / 日期</th><th className="px-3 py-2">校验</th></tr></thead><tbody className="divide-y divide-border">{rows.map(row => <tr key={row.row} className={row.error ? 'bg-red-bg/30' : ''}><td className="px-3 py-3 font-num text-gray3">{row.row}</td><td className="px-3 py-3">{row.code || '—'} · {row.name || '—'}</td><td className="px-3 py-3"><b>{row.product?.name || '未匹配'}</b><div className="text-micro text-gray3">{row.product?.code}</div></td><td className="px-3 py-3 text-right font-num">{row.qty || '—'} {row.product?.inventoryUnit || row.product?.unit}</td><td className="px-3 py-3 text-micro text-gray2">{row.batchNo || '自动生成'}<br />{row.manufactureDate || '—'} → {row.expiryDate || '—'}</td><td className="px-3 py-3">{row.error ? <span className="text-red-fg">{row.error}</span> : <span className="text-green-fg">通过</span>}</td></tr>)}</tbody></table>{rows.length === 0 && <div className="py-16 text-center text-caption text-gray3">选择文件后在这里逐行核对</div>}</div>
        </div>
      </section>
    </div>
  )
}
