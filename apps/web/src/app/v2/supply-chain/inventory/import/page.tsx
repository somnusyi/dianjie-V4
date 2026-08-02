'use client'

import { useEffect, useMemo, useState } from 'react'
import { Chip } from '@/components/v2'
import { apiFetch } from '@/lib/v2-auth'

type Issue = { code: string; message: string; detail?: string }
type Product = {
  id: string
  code: string
  name: string
  spec?: string | null
  status: string
  supplierId?: string | null
  supplier?: { id: string; name: string } | null
  stock?: number
  purchaseUnit?: string | null
  inventoryUnit?: string | null
  unit: string
}
type ImportItem = {
  id: string
  rowNumber: number
  externalCode: string
  externalName: string
  sourceSpec?: string | null
  sourceCategory?: string | null
  purchaseUnit: string
  conversionText?: string | null
  sourceQuantity: number
  inventoryAmount: number
  inventoryUnit?: string | null
  conversionFactor?: number | null
  normalizedQuantity?: number | null
  matchSource?: string | null
  issues: Issue[]
  warnings: Issue[]
  product?: Product | null
  oldQuantity?: number | null
  delta?: number | null
}
type InventoryImport = {
  id: string
  no: string
  source: 'MEITUAN'
  sourceFilename: string
  sourceWarehouseName: string
  snapshotDate: string
  status: 'STAGED' | 'CONFIRMED' | 'REVERSED'
  itemCount: number
  ignoredRowCount: number
  matchedCount: number
  blockingCount: number
  warningCount: number
  detailTotalAmount: number
  sourceTotalAmount?: number | null
  rowVersion: number
  metadata?: { fileWarnings?: Issue[]; ignoredWarehouses?: string[] }
  warehouse?: { id: string; name: string; code: string }
  items?: ImportItem[]
  confirmedAt?: string | null
  reversedAt?: string | null
  reversalReason?: string | null
}

const STATUS: Record<InventoryImport['status'], { label: string; tone: 'amber' | 'green' | 'gray' }> = {
  STAGED: { label: '待确认', tone: 'amber' },
  CONFIRMED: { label: '已生效', tone: 'green' },
  REVERSED: { label: '已撤销', tone: 'gray' },
}

function yesterdayInShanghai() {
  const today = new Date(Date.now() + 8 * 60 * 60 * 1000)
  today.setUTCDate(today.getUTCDate() - 1)
  return today.toISOString().slice(0, 10)
}

function money(value: number | null | undefined) {
  return `¥${Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function quantity(value: number | null | undefined, maxDigits = 6) {
  if (value == null) return '—'
  return Number(value).toLocaleString('zh-CN', { maximumFractionDigits: maxDigits })
}

function Metric({ label, value, tone = '' }: { label: string; value: string; tone?: string }) {
  return <div className="rounded-card border border-border bg-white p-4"><div className={`font-num text-h1 ${tone}`}>{value}</div><div className="mt-1 text-micro text-gray3">{label}</div></div>
}

function InventoryBalance({ item }: { item: ImportItem }) {
  const currentQuantity = item.oldQuantity ?? item.product?.stock
  const delta = item.delta ?? (item.normalizedQuantity != null && item.product?.stock != null
    ? item.normalizedQuantity - item.product.stock
    : null)
  return <>
    <b className="font-num">{quantity(item.normalizedQuantity, 3)} {item.inventoryUnit || '—'}</b>
    {currentQuantity != null && <div className="text-micro text-gray3">当前 {quantity(currentQuantity, 3)} {item.inventoryUnit || '—'}</div>}
    {delta != null && <div className={`text-micro ${delta === 0 ? 'text-gray3' : delta > 0 ? 'text-green-fg' : 'text-red-fg'}`}>调整 {delta > 0 ? '+' : ''}{quantity(delta, 3)}</div>}
  </>
}

export default function WarehouseSnapshotImportPage() {
  const [imports, setImports] = useState<InventoryImport[]>([])
  const [current, setCurrent] = useState<InventoryImport | null>(null)
  const [products, setProducts] = useState<Product[]>([])
  const [file, setFile] = useState<File | null>(null)
  const [snapshotDate, setSnapshotDate] = useState(yesterdayInShanghai)
  const [view, setView] = useState<'all' | 'blocking' | 'warning'>('all')
  const [mappingItemId, setMappingItemId] = useState('')
  const [mappingProductId, setMappingProductId] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  async function loadHistory(selectId?: string) {
    const result = await apiFetch<{ items: InventoryImport[] }>('/api/warehouse-inventory-imports')
    setImports(result.items || [])
    const id = selectId || current?.id || result.items?.[0]?.id
    if (id) await loadImport(id)
  }

  async function loadImport(id: string) {
    const record = await apiFetch<InventoryImport>(`/api/warehouse-inventory-imports/${id}`)
    setCurrent(record)
    setView(record.blockingCount > 0 ? 'blocking' : 'all')
    setMappingItemId('')
    setMappingProductId('')
  }

  useEffect(() => {
    Promise.all([
      loadHistory(),
      apiFetch<Product[]>('/api/products').then(rows => setProducts(Array.isArray(rows) ? rows : [])),
    ]).catch(reason => setError(String(reason?.message || reason)))
  }, [])

  const visibleItems = useMemo(() => {
    const items = current?.items || []
    if (view === 'blocking') return items.filter(item => item.issues.length > 0)
    if (view === 'warning') return items.filter(item => item.warnings.length > 0)
    return items
  }, [current, view])
  const nameSuggestionCount = current?.items?.filter(item => item.matchSource === 'NAME_SUGGESTION').length || 0

  async function preview() {
    if (!file) return setError('请选择美团导出的 .xlsx 库存文件')
    setBusy('preview')
    setError('')
    setNotice('')
    try {
      const body = new FormData()
      body.append('file', file)
      body.append('snapshotDate', snapshotDate)
      body.append('sourceWarehouseName', '供应链总仓')
      const record = await apiFetch<InventoryImport>('/api/warehouse-inventory-imports/preview', { method: 'POST', body })
      setCurrent(record)
      setView(record.blockingCount > 0 ? 'blocking' : 'all')
      setNotice('预检完成：当前没有改动库存。本轮只保留历史文件核对，不允许写入库存。')
      await loadHistory(record.id)
    } catch (reason: any) {
      setError(String(reason?.message || reason))
    } finally {
      setBusy('')
    }
  }

  async function refresh() {
    if (!current) return
    setBusy('refresh')
    setError('')
    try {
      const record = await apiFetch<InventoryImport>(`/api/warehouse-inventory-imports/${current.id}/refresh`, { method: 'POST' })
      setCurrent(record)
      setView(record.blockingCount > 0 ? 'blocking' : 'all')
      await loadHistory(record.id)
    } catch (reason: any) {
      setError(String(reason?.message || reason))
    } finally {
      setBusy('')
    }
  }

  async function resolveItem(item: ImportItem, productId = mappingProductId) {
    if (!current || !productId) return setError('请选择要绑定的系统商品')
    setBusy(`map:${item.id}`)
    setError('')
    try {
      const record = await apiFetch<InventoryImport>(`/api/warehouse-inventory-imports/${current.id}/items/${item.id}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ productId }),
      })
      setCurrent(record)
      setMappingItemId('')
      setMappingProductId('')
      setNotice(`已确认美团编码 ${item.externalCode} 的商品映射；后续同编码会自动识别。`)
      await loadHistory(record.id)
    } catch (reason: any) {
      setError(String(reason?.message || reason))
    } finally {
      setBusy('')
    }
  }

  async function confirmImport() {
    if (!current || current.status !== 'STAGED') return
    if (!window.confirm(`确认把 ${current.snapshotDate}「供应链总仓」${current.itemCount} 条明细设为期末库存余额？系统会记录每个商品的调整差额和审计流水。`)) return
    setBusy('confirm')
    setError('')
    try {
      const record = await apiFetch<InventoryImport>(`/api/warehouse-inventory-imports/${current.id}/confirm`, {
        method: 'POST', body: JSON.stringify({ rowVersion: current.rowVersion }),
      })
      setCurrent(record)
      setNotice('库存快照已生效；商品余额、批次和调整流水已同步记录。')
      await loadHistory(record.id)
    } catch (reason: any) {
      setError(String(reason?.message || reason))
    } finally {
      setBusy('')
    }
  }

  async function confirmNameSuggestions() {
    if (!current || nameSuggestionCount === 0) return
    if (!window.confirm(`确认 ${nameSuggestionCount} 个“美团名称与系统名称完全相同且唯一”的商品候选吗？确认后会保存美团编码映射；单位问题仍会继续阻断库存确认。`)) return
    setBusy('bulk-map')
    setError('')
    try {
      const record = await apiFetch<InventoryImport>(`/api/warehouse-inventory-imports/${current.id}/resolve-name-suggestions`, {
        method: 'POST', body: JSON.stringify({ rowVersion: current.rowVersion }),
      })
      setCurrent(record)
      setView(record.blockingCount > 0 ? 'blocking' : 'all')
      setNotice(`已人工确认 ${nameSuggestionCount} 个唯一同名候选，并保存美团编码映射。`)
      await loadHistory(record.id)
    } catch (reason: any) {
      setError(String(reason?.message || reason))
    } finally {
      setBusy('')
    }
  }

  async function reverseImport() {
    if (!current || current.status !== 'CONFIRMED') return
    const reason = window.prompt('请输入撤销原因（至少 2 个字）。撤销会追加反向流水，不会删除原记录。')?.trim()
    if (!reason) return
    setBusy('reverse')
    setError('')
    try {
      const record = await apiFetch<InventoryImport>(`/api/warehouse-inventory-imports/${current.id}/reverse`, {
        method: 'POST', body: JSON.stringify({ rowVersion: current.rowVersion, reason }),
      })
      setCurrent(record)
      setNotice('库存快照已撤销，原导入单与反向流水均已保留。')
      await loadHistory(record.id)
    } catch (reasonValue: any) {
      setError(String(reasonValue?.message || reasonValue))
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="min-h-screen bg-bg px-4 py-5 lg:px-8 lg:py-7">
      <header className="flex flex-col gap-4 border-b border-border pb-5 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <a href="/v2/supply-chain/inventory" className="text-caption text-gray2">‹ 返回仓库库存</a>
          <div className="mt-2 flex items-center gap-2"><Chip tone="blue">美团库存快照</Chip><span className="text-caption text-gray3">供应链总仓 · 先预检，后整单确认</span></div>
          <h1 className="mt-2 text-h1">历史库存文件预检</h1>
          <p className="mt-1 text-caption text-gray2">7月31日后缺少连续流水，本页只做解析、映射和单位核对，不允许确认写库存。</p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1"><span className="text-micro text-gray3">结算完成日</span><input type="date" value={snapshotDate} onChange={event => setSnapshotDate(event.target.value)} className="h-10 rounded-cta border border-border bg-white px-3" /></label>
          <label className="flex h-10 cursor-pointer items-center rounded-cta border border-border bg-white px-4 text-button"><input type="file" accept=".xlsx" onChange={event => setFile(event.target.files?.[0] || null)} className="hidden" />{file?.name || '选择美团 .xlsx'}</label>
          <button onClick={preview} disabled={!file || busy !== ''} className="h-10 rounded-cta bg-accent px-4 text-button text-white disabled:opacity-40">{busy === 'preview' ? '预检中…' : '上传并预检'}</button>
        </div>
      </header>

      {error && <div className="mt-4 rounded-card border border-red/30 bg-red-bg p-3 text-caption text-red-fg">{error}</div>}
      {notice && <div className="mt-4 rounded-card border border-green/30 bg-green/10 p-3 text-caption text-green-fg">{notice}</div>}

      <section className="mt-5 rounded-card border border-blue/20 bg-white p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div><h2 className="text-h2">“入库单位”是什么意思？</h2><p className="mt-1 max-w-3xl text-caption text-gray2">美团表里的“单位”是供应商送货、采购收货时录入的单位，也就是采购/入库单位；系统真正记账使用库存单位。两者必须通过已验证换算率连接，不能把“箱”直接当成“袋”。</p></div>
          <div className="shrink-0 rounded-cta bg-bg px-4 py-3 text-caption"><b className="font-num">54.875 箱 × 8 袋/箱 = 439 袋</b><div className="mt-1 text-micro text-gray3">源数量原样保留；库存按 439 袋记账</div></div>
        </div>
      </section>

      <section className="mt-4 grid gap-4 2xl:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="overflow-hidden rounded-card border border-border bg-white">
          <div className="border-b border-border px-4 py-3"><h2 className="text-h2">导入单历史</h2><p className="text-micro text-gray3">借鉴美团单据层：有状态、可追溯、可撤销</p></div>
          <div className="max-h-[720px] overflow-auto divide-y divide-border">
            {imports.map(record => <button key={record.id} onClick={() => loadImport(record.id).catch(reason => setError(String(reason?.message || reason)))} className={`w-full px-4 py-3 text-left ${current?.id === record.id ? 'bg-amber/10' : 'hover:bg-bg'}`}><div className="flex items-center justify-between gap-2"><b className="font-num text-caption">{record.snapshotDate}</b><Chip tone={STATUS[record.status].tone}>{STATUS[record.status].label}</Chip></div><div className="mt-1 truncate text-micro text-gray3">{record.no}</div><div className="mt-1 text-micro text-gray2">{record.itemCount} SKU · 阻断 {record.blockingCount}</div></button>)}
            {imports.length === 0 && <div className="px-4 py-10 text-center text-caption text-gray3">还没有导入单</div>}
          </div>
        </aside>

        <main className="min-w-0 space-y-4">
          {!current && <div className="rounded-card border border-dashed border-border bg-white py-20 text-center text-caption text-gray3">上传 7·31 文件后，这里会显示逐行预检结果；预检不会改库存。</div>}
          {current && <>
            <div className="flex flex-col gap-3 rounded-card border border-border bg-white p-4 xl:flex-row xl:items-center xl:justify-between">
              <div><div className="flex flex-wrap items-center gap-2"><Chip tone={STATUS[current.status].tone}>{STATUS[current.status].label}</Chip><b className="font-num">{current.no}</b><span className="text-micro text-gray3">{current.sourceFilename}</span></div><p className="mt-1 text-caption text-gray2">{current.snapshotDate} 结算完成 · {current.sourceWarehouseName} · 系统仓库 {current.warehouse?.name || '默认仓'}</p></div>
              <div className="flex flex-wrap gap-2">
                {current.status === 'STAGED' && <button onClick={refresh} disabled={busy !== ''} className="h-9 rounded-cta border border-border px-3 text-button disabled:opacity-40">{busy === 'refresh' ? '匹配中…' : '重新匹配'}</button>}
                {current.status === 'STAGED' && nameSuggestionCount > 0 && <button onClick={confirmNameSuggestions} disabled={busy !== ''} className="h-9 rounded-cta border border-amber/40 bg-amber/10 px-3 text-button text-amber-fg disabled:opacity-40">{busy === 'bulk-map' ? '确认中…' : `批量确认同名候选 ${nameSuggestionCount}`}</button>}
                <span className="flex h-9 items-center rounded-cta border border-amber/30 bg-amber/10 px-3 text-micro text-amber-fg">仅预检 · 正式确认已关闭</span>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
              <Metric label="目标仓明细" value={String(current.itemCount)} />
              <Metric label="已确认映射" value={String(current.matchedCount)} />
              <Metric label="阻断商品" value={String(current.blockingCount)} tone={current.blockingCount ? 'text-red-fg' : 'text-green-fg'} />
              <Metric label="提醒项" value={String(current.warningCount)} tone={current.warningCount ? 'text-orange-fg' : ''} />
              <Metric label="目标仓明细金额" value={money(current.detailTotalAmount)} />
            </div>

            {current.sourceTotalAmount != null && Math.abs(current.sourceTotalAmount - current.detailTotalAmount) > 0.01 && <div className="rounded-card border border-amber/30 bg-amber/10 p-3 text-caption text-gray2">美团合计行 {money(current.sourceTotalAmount)} 包含其他筛选范围；本次只采用“供应链总仓”明细重算的 {money(current.detailTotalAmount)}，不会把合计行写入库存。</div>}

            <div className="overflow-hidden rounded-card border border-border bg-white">
              <div className="flex flex-col gap-3 border-b border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="text-h2">逐行核对</h2><p className="text-micro text-gray3">先看异常，再看全部；不静默跳过、不自动模糊匹配</p></div><div className="flex gap-1 rounded-cta bg-bg p-1">{([['blocking', `阻断 ${current.blockingCount}`], ['warning', `提醒 ${current.warningCount}`], ['all', `全部 ${current.itemCount}`]] as const).map(([key, label]) => <button key={key} onClick={() => setView(key)} className={`rounded-cta px-3 py-1.5 text-button ${view === key ? 'bg-white shadow-sm' : 'text-gray2'}`}>{label}</button>)}</div></div>
              <div className="max-h-[720px] overflow-auto">
                <table className="w-full min-w-[1120px] text-left text-caption">
                  <thead className="sticky top-0 z-10 bg-bg text-gray3"><tr><th className="px-3 py-2">行 / 美团编码</th><th className="px-3 py-2">美团物品</th><th className="px-3 py-2 text-right">期末数量（入库单位）</th><th className="px-3 py-2">换算</th><th className="px-3 py-2">系统商品 / 供应商</th><th className="px-3 py-2 text-right">记账库存数量</th><th className="px-3 py-2">校验</th></tr></thead>
                  <tbody className="divide-y divide-border">
                    {visibleItems.map(item => <tr key={item.id} className={item.issues.length ? 'bg-red-bg/20' : ''}>
                      <td className="px-3 py-3"><span className="font-num text-gray3">{item.rowNumber}</span><div className="font-num text-micro">{item.externalCode}</div></td>
                      <td className="px-3 py-3"><b>{item.externalName}</b><div className="text-micro text-gray3">{item.sourceCategory || '未分类'} · {item.sourceSpec || '无规格'}</div></td>
                      <td className="px-3 py-3 text-right"><b className="font-num">{quantity(item.sourceQuantity)} {item.purchaseUnit}</b><div className="text-micro text-gray3">{money(item.inventoryAmount)}</div></td>
                      <td className="px-3 py-3"><div className="font-num">{item.conversionText || '未提供'}</div><div className="text-micro text-gray3">系统因子 {quantity(item.conversionFactor)} 库存单位/入库单位</div></td>
                      <td className="px-3 py-3">
                        <b>{item.product?.name || '未匹配'}</b><div className="text-micro text-gray3">{item.product ? `${item.product.code} · ${item.product.supplier?.name || '未绑定供应商'}` : '需要人工选择系统商品'}</div>
                        {current.status === 'STAGED' && item.matchSource === 'NAME_SUGGESTION' && item.product && <button onClick={() => resolveItem(item, item.product!.id)} disabled={busy !== ''} className="mt-2 rounded-cta border border-amber/40 px-2 py-1 text-micro text-amber-fg">确认名称候选</button>}
                        {current.status === 'STAGED' && (!item.product || item.issues.some(issue => issue.code === 'EXTERNAL_CODE_REVIEW_REQUIRED')) && mappingItemId !== item.id && <button onClick={() => { setMappingItemId(item.id); setMappingProductId(item.product?.id || '') }} className="mt-2 ml-1 rounded-cta border border-border px-2 py-1 text-micro">选择其他商品</button>}
                        {mappingItemId === item.id && <div className="mt-2 flex gap-1"><select value={mappingProductId} onChange={event => setMappingProductId(event.target.value)} className="h-8 min-w-52 rounded-cta border border-border bg-white px-2 text-micro"><option value="">请选择…</option>{products.filter(product => product.status === 'ENABLED').map(product => <option key={product.id} value={product.id}>{product.code} · {product.name} · {product.supplier?.name || '无供应商'}</option>)}</select><button onClick={() => resolveItem(item)} disabled={!mappingProductId || busy !== ''} className="rounded-cta bg-accent px-2 text-micro text-white disabled:opacity-40">绑定</button></div>}
                      </td>
                      <td className="px-3 py-3 text-right"><InventoryBalance item={item} /></td>
                      <td className="px-3 py-3"><div className="space-y-1">{item.issues.map(issue => <div key={issue.code} className="text-red-fg"><b>{issue.message}</b>{issue.detail && <div className="text-micro">{issue.detail}</div>}</div>)}{item.warnings.map(issue => <div key={issue.code} className="text-orange-fg">{issue.message}{issue.detail && <div className="text-micro">{issue.detail}</div>}</div>)}{item.issues.length === 0 && item.warnings.length === 0 && <span className="text-green-fg">通过</span>}</div></td>
                    </tr>)}
                  </tbody>
                </table>
                {visibleItems.length === 0 && <div className="py-16 text-center text-caption text-gray3">这个视图没有明细</div>}
              </div>
            </div>
          </>}
        </main>
      </section>
    </div>
  )
}
