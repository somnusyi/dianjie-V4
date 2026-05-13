/**
 * 供应商 · 批量上传商品报价表
 *
 * 模板格式 (跟用户实际报价单对齐):
 *   行 1:  供应商：[填名字]
 *   行 2:  报价日期：[填日期]
 *   行 3:  序号 | 品项名称 | 规格型号 | 采购单位 | 金额
 *   行 4+: 数据
 *
 * 必填只有 2 个: 品项名称 + 金额
 *   编码 → 后端自动生成 (供应商前缀+时间戳)
 *   类目 → 缺省"其他"
 *   单位 → 缺省"件"
 */
'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import * as XLSX from 'xlsx'
import { Chip } from '@/components/v2'
import { ConfirmSheet, useConfirmSheet } from '@/components/v2/confirm-sheet'
import { apiFetch, getUser } from '@/lib/v2-auth'

type Row = {
  __row: number          // 原表 Excel 行号
  __error?: string       // 行级错误
  __ok?: boolean
  name: string
  spec?: string
  unit?: string
  price: number | string
  category?: string
  shelfDays?: number | string
  stock?: number | string
  minStock?: number | string
}

/** 表头 → 字段名 映射, 兼容多种写法 */
const HEADER_MAP: Record<string, keyof Row> = {
  '品项名称': 'name', '商品名称': 'name', '名称': 'name', '品名': 'name', '物品名称': 'name',
  '规格型号': 'spec', '规格': 'spec',
  '采购单位': 'unit', '单位': 'unit',
  '金额': 'price', '单价': 'price', '价格': 'price',
  '类目': 'category', '类别': 'category', '分类': 'category', '物品类别': 'category',
  '保质期': 'shelfDays', '保质期(天)': 'shelfDays', '保质天数': 'shelfDays',
  '初始库存': 'stock', '当前库存': 'stock', '库存': 'stock', '库存量': 'stock',
  '安全库存': 'minStock', '最低库存': 'minStock',
}

/** 下载模板 — 兼容 webview 的 Blob+a 下载, 自动预填供应商名 */
function downloadTemplate() {
  const u = getUser()
  const supplierName = u?.supplier?.name || ''
  const today = new Date().toISOString().slice(0, 10)
  const aoa: any[][] = [
    [`供应商：${supplierName}`, '', '', '', '', '', '', ''],
    [`报价日期：${today}`,      '', '', '', '', '', '', ''],
    ['序号', '品项名称', '规格型号', '采购单位', '金额', '保质期(天)', '初始库存', '安全库存'],
    ['1', '见手青啤酒', '24瓶*330ml/件', '件', 248, 90, 0, 0],
    ['2', '乌苏罐装',   '6罐*1L/件',     '件', 85,  90, 0, 0],
    ['3', '红乌苏瓶装', '620ml*12瓶/件', '件', 80,  '', '', ''],
  ]
  // 后面留 30 行空, 像用户提供的模板那样
  for (let i = 4; i <= 33; i++) aoa.push([String(i), '', '', '', '', '', '', ''])

  const ws = XLSX.utils.aoa_to_sheet(aoa)
  ws['!cols'] = [
    { wch: 6 }, { wch: 22 }, { wch: 22 }, { wch: 10 },
    { wch: 10 }, { wch: 12 }, { wch: 10 }, { wch: 10 },
  ]
  // 合并 A1:H1, A2:H2 让"供应商：" / "报价日期：" 横跨整张表
  ws['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 7 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: 7 } },
  ]
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '报价表')

  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${supplierName || '滇界'}-报价模板-${today}.xlsx`
  document.body.appendChild(a)
  a.click()
  setTimeout(() => {
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }, 200)
}

function parseFile(file: File): Promise<Row[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error)
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(e.target!.result, { type: 'array' })
        const sheet = wb.Sheets[wb.SheetNames[0]]
        const aoa: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' })
        if (aoa.length < 2) return resolve([])

        // 自动找表头行: 必须有名称列 (price/stock 至少一个)
        // 兼容两种场景:
        //   A. 报价单: 品项名称 + 金额 + 规格...
        //   B. 仓库库存表: 物品名称 + 库存量 + 物品类别... (无价格)
        let headerRowIdx = -1
        for (let i = 0; i < Math.min(aoa.length, 10); i++) {
          const row = aoa[i].map(v => String(v || '').trim())
          const hasName  = row.some(c => HEADER_MAP[c] === 'name')
          const hasPrice = row.some(c => HEADER_MAP[c] === 'price')
          const hasStock = row.some(c => HEADER_MAP[c] === 'stock')
          if (hasName && (hasPrice || hasStock)) {
            headerRowIdx = i
            break
          }
        }
        if (headerRowIdx === -1) return reject(new Error('找不到表头. 至少要 「品项名称/物品名称」 + 「金额」或「库存量」其中一列'))

        const headerRow = aoa[headerRowIdx].map(v => String(v || '').trim())
        const headerKeys: (keyof Row | null)[] = headerRow.map(h => HEADER_MAP[h] ?? null)

        const rows: Row[] = []
        for (let i = headerRowIdx + 1; i < aoa.length; i++) {
          const arr = aoa[i]
          if (!arr) continue
          // 全部空 / 只有"序号"列填 → 跳过
          const r: any = { __row: i + 1 }
          let hasContent = false
          headerKeys.forEach((k, idx) => {
            if (k && arr[idx] !== '' && arr[idx] != null) {
              r[k] = arr[idx]
              if (k === 'name' || k === 'price') hasContent = true
            }
          })
          if (!hasContent) continue   // 必填全空 → 跳过
          rows.push(r as Row)
        }
        resolve(rows)
      } catch (err) { reject(err) }
    }
    reader.readAsArrayBuffer(file)
  })
}

function validate(rows: Row[]): Row[] {
  // 价格不再强制. 缺失 → 后端默认 0 (仓库库存初始化场景常无价).
  return rows.map(r => {
    if (!r.name || String(r.name).trim() === '') return { ...r, __error: '品项名称必填' }
    if (r.price != null && String(r.price).trim() !== '') {
      if (Number.isNaN(Number(r.price))) return { ...r, __error: '金额必须是数字' }
      if (Number(r.price) < 0) return { ...r, __error: '金额不能为负' }
    }
    return r
  })
}

export default function BatchUploadPage() {
  const router = useRouter()
  const [rows, setRows] = useState<Row[] | null>(null)
  const [filename, setFilename] = useState<string>('')
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<any | null>(null)
  const [confirmState, openConfirm] = useConfirmSheet()

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (!f) return
    setFilename(f.name)
    setResult(null)
    try {
      const parsed = await parseFile(f)
      setRows(validate(parsed))
    } catch (err: any) {
      alert('解析失败: ' + (err.message || err))
      setRows(null)
    }
    e.target.value = ''
  }

  const total = rows?.length || 0
  const valid = rows?.filter(r => !r.__error).length || 0
  const invalid = total - valid

  function submit() {
    if (!rows || valid === 0 || submitting) return
    openConfirm({
      title: `上传 ${valid} 个商品?`,
      body: invalid > 0
        ? `${invalid} 行有错会跳过, 上架剩余 ${valid} 行\n编码会自动生成, 类目默认"其他"`
        : `全部 ${total} 行将上架\n编码会自动生成, 类目默认"其他"`,
      confirmLabel: '确认上传',
      tone: 'primary',
      onConfirm: async () => {
        setSubmitting(true)
        try {
          // 数字字段防御性转换: 用户表格里非数字 (如 "—" / "无" / 空格) → 走默认值,
          // 不能把 NaN 传给后端 (JSON 会序列化成 null, zod 验证失败)
          const numOr = (v: any, def: number) => {
            if (v == null || v === '') return def
            const n = Number(v)
            return Number.isFinite(n) ? n : def
          }
          const items = rows.filter(r => !r.__error).map(r => ({
            // code 不传, 后端自动生成
            name: String(r.name).trim(),
            spec: r.spec ? String(r.spec).trim() : undefined,
            category: r.category ? String(r.category).trim() : undefined,
            unit: r.unit ? String(r.unit).trim() : '件',
            price: numOr(r.price, 0),
            stock: numOr(r.stock, 0),
            minStock: numOr(r.minStock, 0),
            shelfDays: numOr(r.shelfDays, 7),
          }))
          const res = await apiFetch<any>('/api/products/batch', {
            method: 'POST',
            body: JSON.stringify({ items, filename }),
          })
          setResult(res)
          // 后端 row 是 items[] 1-based, 我们映射回 Excel 行号
          // items[] 顺序 = rows.filter(!error) 顺序, 所以可对齐
          const validRows = rows.filter(r => !r.__error)
          const failedSet = new Set<number>()
          const errMap: Record<number, string> = {}
          ;(res.failed || []).forEach((f: any) => {
            const orig = validRows[f.row - 1]
            if (orig) {
              failedSet.add(orig.__row)
              errMap[orig.__row] = f.error
            }
          })
          setRows(rows.map(r => {
            if (r.__error) return r
            if (failedSet.has(r.__row)) return { ...r, __error: errMap[r.__row] }
            return { ...r, __ok: true }
          }))
        } catch (e: any) {
          alert(e.message || '上传失败')
          throw e
        } finally {
          setSubmitting(false)
        }
      },
    })
  }

  return (
    <div className="min-h-screen bg-bg pb-32">
      <header className="px-4 pt-4 pb-2 flex items-center gap-2">
        <button onClick={() => router.back()} className="text-gray2 text-h2">‹</button>
        <h1 className="text-h1">批量上传商品</h1>
      </header>

      <div className="mx-4 mt-2 bg-bg-card rounded-card border border-border p-3">
        <ol className="text-caption text-gray2 space-y-1.5 pl-4 list-decimal">
          <li>下载 Excel 模板 → 填好你的报价表</li>
          <li>上传文件 → 自动解析 (跳过表头说明, 仅留有效行)</li>
          <li>看错误行修一下 → 提交</li>
        </ol>
        <p className="text-micro text-gray3 mt-2">必填字段：<strong>品项名称</strong> + <strong>金额</strong>。其他列留空也可，编码后端自动生成。</p>
        <button
          onClick={downloadTemplate}
          className="mt-3 px-3 py-2 bg-accent-bg border border-accent/30 rounded-cta text-button text-accent-fg w-full"
        >⤓ 下载 Excel 模板</button>
      </div>

      <div className="mx-4 mt-3">
        <label className="block bg-bg-card rounded-card border-2 border-dashed border-border p-6 text-center cursor-pointer active:bg-accent-bg/50 transition">
          <input type="file" accept=".xlsx,.xls,.csv" onChange={onFile} className="hidden" />
          <div className="text-h2">📄 选择文件</div>
          <p className="text-caption text-gray3 mt-1">{filename || '支持 .xlsx / .xls / .csv'}</p>
        </label>
      </div>

      {rows && (
        <div className="mx-4 mt-3 bg-bg-card rounded-card border border-border p-3">
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            <span className="text-h2">解析结果</span>
            <Chip tone="green">{valid} 行可上传</Chip>
            {invalid > 0 && <Chip tone="red">{invalid} 行有错</Chip>}
            {result && <Chip tone="default">已提交</Chip>}
          </div>
          {rows.length === 0 && <p className="text-caption text-gray3 py-4 text-center">没有有效数据行（必填全空都被跳过了）</p>}
          <ul className="space-y-1 max-h-[400px] overflow-y-auto">
            {rows.map(r => (
              <li
                key={r.__row}
                className={`flex items-center gap-2 px-2 py-1.5 rounded-chip text-caption ${
                  r.__error ? 'bg-red-bg' : r.__ok ? 'bg-green-bg' : 'bg-bg'
                }`}
              >
                <span className="font-num text-micro text-gray3 w-8">#{r.__row}</span>
                <span className="truncate flex-1">
                  {r.name || '—'}
                  {r.spec ? <span className="text-micro text-gray3 ml-1">({r.spec})</span> : null}
                </span>
                <span className="font-num">¥{r.price ?? '—'}</span>
                {r.unit ? <span className="text-micro text-gray3">/{r.unit}</span> : null}
                {r.__error && <span className="text-red-fg text-micro flex-shrink-0">{r.__error}</span>}
                {r.__ok && <span className="text-green-fg text-micro">✓</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {result && (
        <div className="mx-4 mt-3 bg-green-bg border border-green/30 rounded-card p-3">
          <div className="text-h2 text-green-fg">上传完成</div>
          <p className="text-caption text-gray2 mt-1">
            ✓ {result.createdCount} 行成功 · ✗ {result.failedCount} 行失败
          </p>
          <a href="/v2/supplier/products" className="text-caption text-accent inline-block mt-2">
            ‹ 回到商品报价表
          </a>
        </div>
      )}

      {rows && rows.length > 0 && !result && (
        <div className="fixed bottom-0 left-0 right-0 bg-bg-card border-t border-border p-4 flex gap-2"
             style={{ paddingBottom: 'calc(16px + env(safe-area-inset-bottom))' }}>
          <button onClick={() => router.back()}
                  className="px-4 py-3 bg-white border border-border rounded-cta text-button text-gray2">取消</button>
          <button
            onClick={submit}
            disabled={submitting || valid === 0}
            className="flex-1 py-3 bg-ink text-white rounded-cta text-button disabled:opacity-40"
          >
            {submitting ? '上传中…' : `上架 ${valid} 个商品`}
          </button>
        </div>
      )}

      <ConfirmSheet {...confirmState} />
    </div>
  )
}
