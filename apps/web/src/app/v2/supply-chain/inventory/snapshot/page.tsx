'use client'

import { useEffect, useState } from 'react'
import { Chip } from '@/components/v2'
import { apiFetch } from '@/lib/v2-auth'
import {
  assertRealWarehouseResponse,
  withSupplierWarehouseParams,
} from '@/lib/supplier-default-warehouse'

type Supplier = { id: string; no: string; name: string }

type ParsedRow = {
  row: number
  name: string
  spec?: string
  category?: string
  unit?: string
  qty: number
  rawQty: unknown
  error?: string
}

type SnapshotItem = {
  name: string
  spec?: string
  category?: string
  unit?: string
  qty: number
}

type FailedDetail = { row: number; name: string; error: string }

type SnapshotResult = {
  ok: boolean
  summary: {
    total: number
    adjusted: number
    skipped: number
    failed: number
  }
  details?: {
    adjusted?: Array<{ row: number; name: string; oldStock: number; newStock: number }>
    skipped?: Array<{ row: number; name: string; stock: number }>
    failed?: FailedDetail[]
  }
  warehouseId: string
  warehouse: { id: string; name: string }
}

function assertSnapshotSummary(result: SnapshotResult, submittedRows: number) {
  const summary = result?.summary
  const counts = summary && [
    summary.total,
    summary.adjusted,
    summary.skipped,
    summary.failed,
  ]
  if (
    result?.ok !== true
    || !counts
    || counts.some(value => !Number.isInteger(value) || value < 0)
    || summary.total !== submittedRows
    || summary.adjusted + summary.skipped + summary.failed !== summary.total
  ) {
    throw new Error('盘点响应汇总无效，预览已保留，请勿直接重试')
  }
}

const HEADER_MAP: Record<string, keyof Omit<ParsedRow, 'row' | 'rawQty' | 'error'>> = {
  品项名称: 'name',
  商品名称: 'name',
  名称: 'name',
  品名: 'name',
  物品名称: 'name',
  规格型号: 'spec',
  规格: 'spec',
  采购单位: 'unit',
  单位: 'unit',
  库存单位: 'unit',
  类目: 'category',
  类别: 'category',
  分类: 'category',
  物品类别: 'category',
  初始库存: 'qty',
  当前库存: 'qty',
  库存: 'qty',
  库存量: 'qty',
  数量: 'qty',
  盘点数量: 'qty',
  目标数量: 'qty',
  qty: 'qty',
}

function normalizeCell(value: unknown): string {
  if (value == null) return ''
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  return String(value).trim()
}

function parseQty(value: unknown): { qty: number; error?: string } {
  if (value === '' || value == null) return { qty: NaN, error: '目标数量不能为空' }
  const num = Number(value)
  if (!Number.isFinite(num)) return { qty: NaN, error: '目标数量必须是数字' }
  if (num < 0) return { qty: num, error: '目标数量不能为负数' }
  if (Math.abs(num * 100 - Math.round(num * 100)) > 1e-9) {
    return { qty: num, error: '目标数量最多保留 2 位小数' }
  }
  return { qty: num }
}

async function parseWorkbook(file: File): Promise<ParsedRow[]> {
  const XLSX = await import('xlsx')
  const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' })
  const aoa: unknown[][] = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], {
    header: 1,
    defval: '',
  })

  let headerIndex = -1
  for (let i = 0; i < Math.min(aoa.length, 10); i++) {
    const row = aoa[i]
    if (!Array.isArray(row)) continue
    const cells = row.map(cell => normalizeCell(cell))
    const hasName = cells.some(cell => HEADER_MAP[cell] === 'name')
    const hasQty = cells.some(cell => HEADER_MAP[cell] === 'qty')
    if (hasName && hasQty) {
      headerIndex = i
      break
    }
  }
  if (headerIndex < 0) {
    throw new Error('找不到表头，请至少包含「商品名称/品项名称/品名」和「目标数量/数量/库存量」两列')
  }

  const header = aoa[headerIndex].map(cell => normalizeCell(cell))
  const keys = header.map(cell => HEADER_MAP[cell] || null)

  const rows: ParsedRow[] = []
  const seenNames = new Set<string>()

  for (let index = headerIndex + 1; index < aoa.length; index++) {
    const source = aoa[index] || []
    const raw: Record<string, unknown> = {}
    keys.forEach((key, column) => {
      if (key) raw[key] = source[column]
    })

    const hasAnyValue = Object.values(raw).some(value => normalizeCell(value) !== '')
    if (!hasAnyValue) continue
    const name = normalizeCell(raw.name)

    const spec = normalizeCell(raw.spec) || undefined
    const category = normalizeCell(raw.category) || undefined
    const unit = normalizeCell(raw.unit) || undefined
    const { qty, error: qtyError } = parseQty(raw.qty)

    let error = qtyError
    if (!name) {
      error = '商品名称不能为空'
    } else if (seenNames.has(name.toLowerCase())) {
      error = '品名重复，同一商品只能保留一行'
    }

    if (name) seenNames.add(name.toLowerCase())

    rows.push({
      row: index + 1,
      name,
      spec,
      category,
      unit,
      qty,
      rawQty: raw.qty,
      error,
    })
  }

  return rows
}

export default function InternalInventorySnapshotPage() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [supplierId, setSupplierId] = useState('')
  const [rows, setRows] = useState<ParsedRow[]>([])
  const [filename, setFilename] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState('')
  const [done, setDone] = useState('')
  const [partial, setPartial] = useState<{ summary: string; failures: FailedDetail[] } | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    apiFetch<Supplier[]>('/api/suppliers?status=ENABLED')
      .then(list => {
        const items = Array.isArray(list) ? list : []
        setSuppliers(items)
        const requested = new URLSearchParams(window.location.search).get('supplierId') || ''
        setSupplierId(items.some(item => item.id === requested) ? requested : items[0]?.id || '')
      })
      .catch(reasonValue => setError(String(reasonValue?.message || reasonValue)))
  }, [])

  function resetResults() {
    setError('')
    setDone('')
    setPartial(null)
  }

  async function selectFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setFilename(file.name)
    resetResults()
    try {
      setRows(await parseWorkbook(file))
    } catch (reasonValue: any) {
      setRows([])
      setError(String(reasonValue?.message || reasonValue))
    }
  }

  function buildPayload(): { reason: string; items: SnapshotItem[] } {
    return {
      reason: reason.trim() || `全量盘点导入 ${filename || '库存清单'}`,
      items: rows.map(row => ({
        name: row.name,
        ...(row.spec ? { spec: row.spec } : {}),
        ...(row.category ? { category: row.category } : {}),
        ...(row.unit ? { unit: row.unit } : {}),
        qty: row.qty,
      })),
    }
  }

  async function submit() {
    if (!supplierId) {
      setError('请先选择供应商')
      return
    }
    if (rows.length === 0) {
      setError('请先上传 Excel 并确认预览数据')
      return
    }
    const invalid = rows.filter(row => row.error)
    if (invalid.length > 0) {
      setError(`存在 ${invalid.length} 行校验错误，请修正后再提交`)
      return
    }

    setSubmitting(true)
    resetResults()
    try {
      const res = await apiFetch<SnapshotResult>(
        withSupplierWarehouseParams('/api/supplier/stock/import-snapshot', supplierId),
        {
          method: 'POST',
          body: JSON.stringify(buildPayload()),
        },
      )
      assertSnapshotSummary(res, rows.length)
      const { warehouseName } = assertRealWarehouseResponse(res)

      if (res.summary.failed > 0) {
        const failures = (res.details?.failed || []).map(failure => ({
          ...failure,
          row: rows[failure.row - 1]?.row ?? failure.row,
        }))
        if (failures.length !== res.summary.failed) {
          throw new Error('盘点响应的失败明细与汇总不一致，预览已保留，请勿直接重试')
        }
        setPartial({
          summary: `共 ${res.summary.total} 行：已调整 ${res.summary.adjusted}，已跳过 ${res.summary.skipped}，失败 ${res.summary.failed}（${warehouseName}）`,
          failures,
        })
        return
      }

      setDone(
        `全量盘点导入成功（${warehouseName}）：已调整 ${res.summary.adjusted} 个 SKU，跳过 ${res.summary.skipped} 个已是目标值的 SKU`,
      )
      setRows([])
      setFilename('')
    } catch (reasonValue: any) {
      const status = reasonValue?.status
      const message = String(reasonValue?.message || reasonValue)
      if (status === 409 || /尚未建档|未建档|UNMATCHED_STOCK_SKU|不存在|未匹配/i.test(message)) {
        setError(`未建档或商品数据冲突：${message}`)
      } else {
        setError(message)
      }
    } finally {
      setSubmitting(false)
    }
  }

  const invalidCount = rows.filter(row => row.error).length

  return (
    <div className="min-h-screen bg-bg px-4 py-5 lg:px-8 lg:py-7">
      <header className="flex flex-col gap-4 border-b border-border pb-5 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <a href="/v2/supply-chain/inventory" className="text-caption text-gray2">‹ 返回仓库库存</a>
          <div className="mt-2 flex items-center gap-2">
            <Chip tone="amber">全量盘点</Chip>
            <span className="text-caption text-gray3">设置目标库存，会替换当前物理余额</span>
          </div>
          <h1 className="mt-2 text-h1">全量库存盘点导入</h1>
        </div>
        <select
          value={supplierId}
          onChange={event => setSupplierId(event.target.value)}
          className="h-10 min-w-72 rounded-cta border border-border bg-white px-3 text-body"
        >
          {suppliers.map(supplier => (
            <option key={supplier.id} value={supplier.id}>
              {supplier.no} · {supplier.name}
            </option>
          ))}
        </select>
      </header>

      {error && (
        <div className="mt-4 rounded-card border border-red/30 bg-red-bg p-3 text-caption text-red-fg">{error}</div>
      )}
      {done && (
        <div className="mt-4 rounded-card border border-green/30 bg-green/10 p-3 text-caption text-green-fg">{done}</div>
      )}
      {partial && (
        <div className="mt-4 rounded-card border border-amber/30 bg-amber/10 p-3 text-caption text-amber-fg">
          <p className="font-medium">部分导入失败，预览已保留；成功行可能已经落账，重试时会按当前余额跳过</p>
          <p className="mt-1">{partial.summary}</p>
          <ul className="mt-2 max-h-48 list-disc space-y-1 overflow-auto pl-5">
            {partial.failures.map((failure, index) => (
              <li key={index}>
                行 {failure.row} · {failure.name}：{failure.error}
              </li>
            ))}
          </ul>
        </div>
      )}

      <section className="mt-5 grid gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
        <div className="space-y-4">
          <div className="rounded-card border border-border bg-white p-4">
            <h2 className="text-h2">文件规则</h2>
            <ol className="mt-3 list-decimal space-y-2 pl-5 text-caption text-gray2">
              <li>必填：商品名称 / 品项名称 / 品名 + 目标数量 / 数量 / 库存量</li>
              <li>目标数量 ≥ 0，最多 2 位小数</li>
              <li>可选：规格、分类、库存单位</li>
              <li>空名、重复品名、非法数量会阻止整批提交</li>
              <li>本操作会按目标数量替换当前物理余额，与「Excel 批量入库」增量加库存不同</li>
            </ol>
          </div>

          <label className="block cursor-pointer rounded-card border-2 border-dashed border-border bg-white p-6 text-center">
            <input type="file" accept=".xlsx,.xls" onChange={selectFile} className="hidden" />
            <b>选择 Excel 文件</b>
            <p className="mt-1 text-micro text-gray3">{filename || '支持 .xlsx / .xls'}</p>
          </label>

          <label className="block">
            <span className="mb-1 block text-micro text-gray3">本次盘点说明</span>
            <input
              value={reason}
              onChange={event => setReason(event.target.value)}
              maxLength={120}
              placeholder="如：2026-07 月末盘点 / 第三方系统迁移"
              className="h-11 w-full rounded-cta border border-border bg-white px-3"
            />
          </label>

          <button
            onClick={submit}
            disabled={submitting || !supplierId || rows.length === 0 || invalidCount > 0}
            className="h-11 w-full rounded-cta bg-accent text-button text-white disabled:opacity-40"
          >
            {submitting ? '导入中…' : `确认全量盘点导入 ${rows.length - invalidCount} 行`}
          </button>
        </div>

        <div className="overflow-hidden rounded-card border border-border bg-white">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <h2 className="text-h2">导入预览</h2>
            <div className="flex gap-2">
              <Chip tone="green">{rows.length - invalidCount} 正常</Chip>
              {invalidCount > 0 && <Chip tone="red">{invalidCount} 错误</Chip>}
            </div>
          </div>
          <div className="max-h-[680px] overflow-auto">
            <table className="w-full text-left text-caption">
              <thead className="sticky top-0 bg-bg text-gray3">
                <tr>
                  <th className="px-3 py-2">行</th>
                  <th className="px-3 py-2">商品名称</th>
                  <th className="px-3 py-2">规格</th>
                  <th className="px-3 py-2">分类</th>
                  <th className="px-3 py-2">单位</th>
                  <th className="px-3 py-2 text-right">目标数量</th>
                  <th className="px-3 py-2">校验</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map(row => (
                  <tr key={row.row} className={row.error ? 'bg-red-bg/30' : ''}>
                    <td className="px-3 py-3 font-num text-gray3">{row.row}</td>
                    <td className="px-3 py-3">{row.name || '—'}</td>
                    <td className="px-3 py-3 text-gray2">{row.spec || '—'}</td>
                    <td className="px-3 py-3 text-gray2">{row.category || '—'}</td>
                    <td className="px-3 py-3 text-gray2">{row.unit || '—'}</td>
                    <td className="px-3 py-3 text-right font-num">
                      {Number.isFinite(row.qty) ? row.qty : String(row.rawQty || '—')}
                    </td>
                    <td className="px-3 py-3">
                      {row.error ? (
                        <span className="text-red-fg">{row.error}</span>
                      ) : (
                        <span className="text-green-fg">通过</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length === 0 && (
              <div className="py-16 text-center text-caption text-gray3">选择文件后在这里逐行核对</div>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}
