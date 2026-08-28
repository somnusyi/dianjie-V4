/**
 * 厨师长 · 发起新采购单
 *
 * 接 POST /api/orders → 自动 status=SUBMITTED 通知供应商
 * 食材采购单不走审批 (任何金额都直接发供应商)
 */
'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Chip } from '@/components/v2'
import { ConfirmSheet, useConfirmSheet } from '@/components/v2/confirm-sheet'
import { OrderProductImage } from '@/components/v2/order-product-image'
import {
  calculateOrderEntryLineAmount,
  resolveOrderEntryCostPricing,
  sumOrderEntryLineAmounts,
} from '@/lib/order-entry-cost-pricing'
import { deliveryScheduleText } from '@/lib/delivery-rule-cycle'
import { apiFetch, getUser } from '@/lib/v2-auth'

type Supplier = { id: string; name: string; category: string | null; bankAccount: string | null }
type Product  = { id: string; name: string; unit: string; price: string; supplierId: string | null
                  spec?: string | null; category?: string | null; code?: string
                  imageUrl?: string | null
                  purchaseUnit?: string | null; inventoryUnit?: string | null
                  orderUnit?: string | null; costUnit?: string | null
                  inventoryUnitsPerPurchaseUnit?: string | number | null
                  inventoryUnitsPerOrderUnit?: string | number | null
                  inventoryUnitsPerCostUnit?: string | number | null
                  unitConversionStatus?: string | null
                  minOrderQty?: string | number; stepQty?: string | number
                  stock?: string | number | null
                  physicalStock?: number; reservedStock?: number; availableStock?: number
                  status?: string  /* ENABLED / DISABLED / PENDING_APPROVAL / PENDING_DISABLE */ }
type LineItem = { productId: string; quantity: number; unitPrice: number }

// 模糊匹配: name + spec + code 任意子串包含; 多关键字 AND
// 不匹配 category — 避免同类目 SKU 全命中, category 已有 chips 筛选
function matchesQuery(p: Product, q: string) {
  if (!q.trim()) return true
  const hay = `${p.name} ${p.spec || ''} ${p.code || ''}`.toLowerCase()
  return q.toLowerCase().split(/\s+/).filter(Boolean).every(t => hay.includes(t))
}

// ── 草稿暂存 (客户反馈: 选品后未提交退出, 返回时已选商品丢失) ──
// localStorage 单端持久化, 未跨设备同步; 7 天过期防陈旧
const DRAFT_KEY = 'dj:po-new:draft:v1'
const DRAFT_TTL_MS = 7 * 86400_000

function timeAgoCn(ts: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (sec < 60)    return `${sec} 秒前`
  if (sec < 3600)  return `${Math.floor(sec / 60)} 分钟前`
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小时前`
  return `${Math.floor(sec / 86400)} 天前`
}

export default function ChefPONewPage() {
  const router = useRouter()
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [products, setProducts]   = useState<Product[]>([])
  const [supplierId, setSupplierId] = useState<string>('')
  const [expectedDate, setExpectedDate] = useState<string>(() => new Date(Date.now() + 86400_000).toISOString().slice(0, 10))
  const [note, setNote] = useState('')
  const [items, setItems] = useState<LineItem[]>([])
  const [submitting, setSubmitting] = useState(false)
  // 防重 idempotencyKey: 进页面时生成, 提交一次 / 失败可重试 (重置 key)
  const [idempotencyKey, setIdempotencyKey] = useState(() => `po-${Date.now()}-${Math.random().toString(36).slice(2,10)}`)
  const [error, setError] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [confirm, openConfirm] = useConfirmSheet()
  const [searchQ, setSearchQ] = useState('')
  const [catFilter, setCatFilter] = useState<string>('全部')
  // 草稿恢复 banner: 显示"已恢复 N 项草稿"提示, 用户可一键清空
  const [restoredFromDraft, setRestoredFromDraft] = useState(false)
  const [draftSavedAt, setDraftSavedAt] = useState<number | null>(null)
  // 配送班表：选中供应商后拉取本店适用班表，预填最快到货日并展示送货节奏
  const [ruleHint, setRuleHint] = useState<{
    name: string; deliveryScheduleMode: 'WEEKLY' | 'INTERVAL'; weekdays: number[]; leadDays: number; enforce: boolean
    deliveryIntervalDays: number | null; deliveryIntervalStart: string | null
    orderWindowStart: string | null; orderWindowEnd: string | null; withinOrderWindow: boolean
    earliestArrival: string | null; nextDeliveryDates: string[]
  } | null>(null)

  useEffect(() => {
    apiFetch<Supplier[]>('/api/suppliers').then(setSuppliers).catch(e => setError(String(e?.message || e)))
    apiFetch<{items: Product[]}>('/api/products').then(d => setProducts(Array.isArray(d) ? d : (d?.items || []))).catch(() => {})
  }, [])

  // 供应商变化 → 拉本店配送班表；软引导：到货日早于最快到货日时自动顺延；
  // 强制班表：当前日期不是送货日时直接吸附到最快到货日（后端还会再拦一道）。
  useEffect(() => {
    if (!supplierId) { setRuleHint(null); return }
    apiFetch<{ rule: any }>(`/api/delivery-rules/for-store?supplierId=${encodeURIComponent(supplierId)}`)
      .then(d => {
        const rule = d?.rule || null
        setRuleHint(rule)
        if (!rule?.earliestArrival) return
        setExpectedDate(current => {
          if (rule.enforce && !rule.nextDeliveryDates.includes(current)) return rule.earliestArrival
          return current < rule.earliestArrival ? rule.earliestArrival : current
        })
      })
      .catch(() => setRuleHint(null))
  }, [supplierId])

  // mount 时检查 localStorage 是否有上次未提交的草稿, 有就自动恢复
  // 客户原需求是"返回页面自动保留", 不再弹确认; 通过顶部 banner 提示并提供"清空"出口
  useEffect(() => {
    try {
      const raw = localStorage.getItem(DRAFT_KEY)
      if (!raw) return
      const d = JSON.parse(raw)
      if (!d || typeof d !== 'object') return
      if (!d.savedAt || Date.now() - d.savedAt > DRAFT_TTL_MS) {
        localStorage.removeItem(DRAFT_KEY)
        return
      }
      if (!Array.isArray(d.items) || d.items.length === 0) return
      if (d.supplierId)   setSupplierId(d.supplierId)
      if (d.expectedDate) setExpectedDate(d.expectedDate)
      if (d.note)         setNote(d.note)
      setItems(d.items)
      setRestoredFromDraft(true)
      setDraftSavedAt(d.savedAt)
    } catch { /* 草稿坏了直接当没有, 不阻塞页面 */ }
  }, [])

  // state 变化时 debounced 400ms 写 localStorage. 空状态时主动清, 避免下次空 banner
  useEffect(() => {
    if (items.length === 0 && !supplierId && !note) {
      localStorage.removeItem(DRAFT_KEY)
      return
    }
    const t = setTimeout(() => {
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify({
          supplierId, expectedDate, note, items, savedAt: Date.now(),
        }))
      } catch { /* quota / 序列化失败忽略 */ }
    }, 400)
    return () => clearTimeout(t)
  }, [supplierId, expectedDate, note, items])

  // 商品数据到达后，把旧草稿里的兼容价格字段同步为当前订货单位价。
  // 待核验商品保留在草稿中供用户识别和移除，但绝不改写或用于预览/提交。
  useEffect(() => {
    if (products.length === 0) return
    setItems(current => {
      let changed = false
      const next = current.map(item => {
        const product = products.find(product => product.id === item.productId)
        if (!product) return item
        const pricing = resolveOrderEntryCostPricing(product)
        if (pricing.status === 'PENDING') return item
        const unitPrice = Number(pricing.orderUnitPrice)
        if (item.unitPrice === unitPrice) return item
        changed = true
        return { ...item, unitPrice }
      })
      return changed ? next : current
    })
  }, [products])

  const supplierProducts = supplierId
    ? products.filter(p => p.supplierId === supplierId)
    : products
  // 类别 chips (只显示当前供应商的有商品类别)
  const allCategories = ['全部', ...Array.from(new Set(supplierProducts.map(p => p.category || '其他'))).sort()]
  // 已选 chip 类别 + 模糊匹配过滤
  const filteredProducts = supplierProducts.filter(p => {
    if (catFilter !== '全部' && (p.category || '其他') !== catFilter) return false
    return matchesQuery(p, searchQ)
  })
  const itemPricing = items.map(item => {
    const product = products.find(product => product.id === item.productId)
    return product ? resolveOrderEntryCostPricing(product) : null
  })
  const lineAmounts = items.map((item, index) => {
    const pricing = itemPricing[index]
    if (!pricing || pricing.status === 'PENDING') return null
    return calculateOrderEntryLineAmount(item.quantity, pricing.orderUnitPrice)
  })
  const total = itemPricing.every(pricing => pricing?.status === 'READY')
    ? sumOrderEntryLineAmounts(lineAmounts)
    : null

  // 起订量/步长 helper
  function moq(p: Product) { return Math.max(0.01, Number(p.minOrderQty || 1)) }
  function step(p: Product) { return Math.max(0.01, Number(p.stepQty || 1)) }
  // 把任意数 round 到合法整倍数 (>= moq, 偏移 step)
  function snap(p: Product, q: number) {
    const m = moq(p), s = step(p)
    if (q < m) return m
    const k = Math.round((q - m) / s)
    return +(m + k * s).toFixed(2)
  }
  function addItem(p: Product) {
    if (items.some(i => i.productId === p.id)) return
    const pricing = resolveOrderEntryCostPricing(p)
    if (pricing.status === 'PENDING') {
      setError(`${pricing.message}，请联系采购核验单位换算后再加入`)
      return
    }
    setError(null)
    setItems(prev => [...prev, {
      productId: p.id,
      quantity: moq(p),
      unitPrice: Number(pricing.orderUnitPrice),
    }])
  }
  function updateItem(idx: number, patch: Partial<LineItem>) {
    setItems(items.map((it, i) => i === idx ? { ...it, ...patch } : it))
  }
  function removeItem(idx: number) {
    setItems(items.filter((_, i) => i !== idx))
  }
  // 抽屉内统一调数量 (按 productId)
  function setQtyByProduct(p: Product, qty: number) {
    if (qty <= 0) {
      setItems(prev => prev.filter(i => i.productId !== p.id))
      return
    }
    const pricing = resolveOrderEntryCostPricing(p)
    if (pricing.status === 'PENDING') {
      setError(`${pricing.message}，请联系采购核验单位换算后再加入`)
      return
    }
    setError(null)
    setItems(prev => {
      const existing = prev.find(i => i.productId === p.id)
      const snapped = snap(p, qty)
      const unitPrice = Number(pricing.orderUnitPrice)
      if (existing) return prev.map(i => i.productId === p.id ? { ...i, quantity: snapped, unitPrice } : i)
      return [...prev, { productId: p.id, quantity: snapped, unitPrice }]
    })
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!supplierId) { setError('请选择供应商'); return }
    if (items.length === 0) { setError('请至少添加一个商品'); return }
    // 前端兜底拦下已停售/待审批 SKU (草稿可能残留, server 端 orders.ts:298 也会兜底)
    const blocked = items
      .map(it => products.find(p => p.id === it.productId))
      .filter((p): p is Product => !!p && p.status != null && p.status !== 'ENABLED')
    if (blocked.length > 0) {
      setError(`以下商品已停售/待审, 请先移除: ${blocked.map(p => p.name).join('、')}`)
      return
    }
    const submitItems: LineItem[] = []
    const pricingProblems: string[] = []
    for (const item of items) {
      const product = products.find(product => product.id === item.productId)
      if (!product) {
        pricingProblems.push(`${item.productId}（商品信息已失效）`)
        continue
      }
      const pricing = resolveOrderEntryCostPricing(product)
      if (pricing.status === 'PENDING') {
        pricingProblems.push(product.name)
        continue
      }
      submitItems.push({
        ...item,
        // API 会权威重算；兼容字段也必须来自同一成本价折算 helper。
        unitPrice: Number(pricing.orderUnitPrice),
      })
    }
    if (pricingProblems.length > 0) {
      setError(`以下草稿商品无法计算订货价，请先移除或联系采购核验单位换算：${pricingProblems.join('、')}`)
      return
    }
    setError(null); setSubmitting(true)
    try {
      // 兜底: 显式传 storeId (后端旧版只对 MANAGER 用 token storeId, KITCHEN_LEAD 漏接)
      const u = getUser()
      const myStoreId = u?.storeId || u?.store?.id
      const order = await apiFetch<{ id: string; no: string }>('/api/orders', {
        method: 'POST',
        body: JSON.stringify({ supplierId, expectedDate, note, items: submitItems, storeId: myStoreId, idempotencyKey }),
      })
      // 提交成功 → 草稿清掉, 下次进页面是空白态
      localStorage.removeItem(DRAFT_KEY)
      router.push(`/v2/chef/purchase/po-success/${order.id}`)
    } catch (e: any) {
      setError(e.message || '提交失败')
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen bg-bg pb-32">
      <header className="px-4 pt-4 pb-2 flex items-center gap-2">
        <button onClick={() => router.back()} className="text-gray2 text-h2">‹</button>
        <h1 className="text-h1">发起采购单</h1>
      </header>

      <div className="mx-4 mt-2 bg-bg-warm rounded-card border border-border p-4">
        <div className="flex items-center gap-3">
          <span className="w-10 h-10 rounded-md bg-amber-bg text-amber-fg flex items-center justify-center text-h2">🍲</span>
          <div className="flex-1">
            <div className="text-h2">食材采购单</div>
            <p className="text-caption text-gray2 mt-0.5">提交后直发供应商 · 无金额审批限制</p>
          </div>
        </div>
      </div>

      {/* 恢复草稿提示 banner — 客户反馈 "返回页面要保留已选商品" */}
      {restoredFromDraft && items.length > 0 && (
        <div className="mx-4 mt-3 bg-amber/10 border border-amber/30 rounded-card p-3 flex items-start gap-2">
          <span className="text-amber-fg text-h2 leading-none mt-0.5">📋</span>
          <div className="flex-1 min-w-0">
            <div className="text-caption text-amber-fg">
              已恢复上次未提交的草稿 ({items.length} 项{draftSavedAt ? `, 保存于 ${timeAgoCn(draftSavedAt)}` : ''})
            </div>
            <p className="text-micro text-gray3 mt-0.5">继续编辑即可, 或点右侧"清空"重新开始</p>
          </div>
          <button
            type="button"
            onClick={() => {
              setSupplierId('')
              setItems([])
              setNote('')
              setRestoredFromDraft(false)
              setDraftSavedAt(null)
              localStorage.removeItem(DRAFT_KEY)
            }}
            className="text-caption px-3 py-1.5 bg-white border border-amber/40 text-amber-fg rounded-chip whitespace-nowrap"
          >清空</button>
        </div>
      )}

      <form onSubmit={submit} className="space-y-3 mt-4 px-4">
        {/* 供应商选择 */}
        <div className="bg-white rounded-card border border-border p-3">
          <label className="text-micro text-gray3 block mb-1">供应商</label>
          <select
            value={supplierId}
            onChange={(e) => { setSupplierId(e.target.value); setItems([]) }}
            required
            className="w-full text-body bg-transparent outline-none py-1"
          >
            <option value="">— 选择供应商 —</option>
            {suppliers.map(s => (
              <option key={s.id} value={s.id}>{s.name}{s.category ? ` · ${s.category}` : ''}</option>
            ))}
          </select>
        </div>

        {/* 期望到货日期 */}
        <div className="bg-white rounded-card border border-border p-3">
          <label className="text-micro text-gray3 block mb-1">期望到货日期</label>
          <input
            type="date"
            value={expectedDate}
            onChange={(e) => setExpectedDate(e.target.value)}
            required
            min={new Date().toISOString().slice(0, 10)}
            className="w-full text-body bg-transparent outline-none"
          />
          {ruleHint && (
            <div className="mt-2 rounded-cta bg-bg px-2 py-1.5 text-micro text-gray2">
              班表「{ruleHint.name}」：{deliveryScheduleText(ruleHint)}送货
              {ruleHint.earliestArrival && <>，今天下单最快 <b>{ruleHint.earliestArrival}</b> 到货</>}
              {ruleHint.orderWindowStart && <>，订货时段 {ruleHint.orderWindowStart}~{ruleHint.orderWindowEnd}</>}
              {ruleHint.enforce && <span className="ml-1 text-red-fg">（强制班表）</span>}
              {!ruleHint.withinOrderWindow && <span className="ml-1 text-red-fg">当前不在订货时段</span>}
            </div>
          )}
        </div>

        {/* 商品列表 */}
        <div className="bg-white rounded-card border border-border p-3">
          <div className="flex items-center justify-between mb-2">
            <label className="text-micro text-gray3">采购商品 ({items.length})</label>
            {supplierId && supplierProducts.length > 0 && (
              <button
                type="button"
                onClick={() => setPickerOpen(true)}
                className="text-button text-accent"
              >+ 添加商品</button>
            )}
          </div>
          {!supplierId && <p className="text-micro text-gray3">请先选供应商</p>}
          {supplierId && supplierProducts.length === 0 && (
            <div className="bg-amber/10 border border-amber/30 rounded-cta p-3 text-caption text-amber-fg">
              ⚠ 该供应商暂未上架商品 · 请联系采购或换一家供应商
            </div>
          )}
          {supplierId && supplierProducts.length > 0 && items.length === 0 && (
            <p className="text-micro text-gray3">点击右上角「+ 添加商品」</p>
          )}
          <ul className="space-y-2 mt-2">
            {items.map((it, i) => {
              const p = products.find(pr => pr.id === it.productId)
              const pricing = itemPricing[i]
              return (
                <li key={it.productId} className="flex items-center gap-2 py-1.5 border-b border-border last:border-b-0">
                  <OrderProductImage src={p?.imageUrl} name={p?.name || it.productId} code={p?.code} size="compact" />
                  <div className="flex-1 min-w-0">
                    <div className="text-body truncate">
                      {p?.name || it.productId}
                      {p?.spec && <span className="text-micro text-gray3 ml-1">· {p.spec}</span>}
                    </div>
                    <div className="text-micro text-gray3">
                      {p?.code && <span className="mr-1">#{p.code}</span>}
                      {pricing?.status === 'READY' ? (
                        <>¥{pricing.orderUnitPrice} · {pricing.unitLabel}{p && Number(p.minOrderQty || 1) > 1 && <span className="text-amber-fg ml-1">· 起订 {moq(p)}</span>}</>
                      ) : (
                        <span className="text-red-fg">{pricing?.message || '商品信息已失效，请移除后重新选择'}</span>
                      )}
                    </div>
                    {pricing?.status === 'READY' && (
                      <div className="text-micro text-gray3">{pricing.costPriceSource}</div>
                    )}
                  </div>
                  <input
                    type="number"
                    min={p ? moq(p) : 0.01}
                    step={p ? step(p) : 0.01}
                    value={it.quantity}
                    onChange={(e) => updateItem(i, { quantity: Number(e.target.value) })}
                    onBlur={(e) => p && updateItem(i, { quantity: snap(p, Number(e.target.value) || moq(p)) })}
                    className="w-16 text-right font-num bg-bg rounded-chip px-2 py-1"
                  />
                  <span className="font-num text-body w-20 text-right">{lineAmounts[i] === null ? '—' : `¥${lineAmounts[i]}`}</span>
                  <button type="button" onClick={() => removeItem(i)} className="text-gray3 px-1">×</button>
                </li>
              )
            })}
          </ul>
          {items.length > 0 && (
            <div className="mt-2 pt-2 border-t border-border flex items-center justify-between">
              <span className="text-h2">合计</span>
              <span className={`text-right ${total === null ? 'text-caption text-red-fg' : 'font-num text-h2'}`}>
                {total === null ? '存在价格待核验商品，暂不计算' : `¥${total}`}
              </span>
            </div>
          )}
        </div>

        {/* 提交后直发供应商, 不再阈值审批 */}
        {total !== null && Number(total) > 0 && (
          <div className="flex items-center gap-2">
            <Chip tone="green">提交后直发供应商</Chip>
          </div>
        )}

        {/* 备注 */}
        <div className="bg-white rounded-card border border-border p-3">
          <label className="text-micro text-gray3 block mb-1">备注（可选）</label>
          <textarea
            value={note} onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="特殊要求 · 配送时段 · 验收标准..."
            className="w-full text-body bg-transparent outline-none resize-none"
          />
        </div>

        {error && (
          <div className="bg-red-bg text-red-fg rounded-card p-3 text-caption">{error}</div>
        )}
      </form>

      {/* 商品选择 底部抽屉 */}
      {pickerOpen && (
        <div className="fixed inset-0 z-50" onClick={() => setPickerOpen(false)}>
          <div className="absolute inset-0 bg-ink/60" />
          <div
            className="absolute bottom-0 left-0 right-0 bg-white rounded-t-card shadow-drawer max-h-[75vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="w-12 h-1 bg-gray5 rounded-full mx-auto mt-2" />
            <div className="flex items-baseline justify-between px-4 pt-3 pb-2">
              <h3 className="text-h2">选择商品</h3>
              <span className="text-caption text-gray3">{filteredProducts.length}/{supplierProducts.length} SKU · 已选 {items.length}</span>
            </div>
            {/* 搜索框 */}
            <div className="px-4 pb-2">
              <div className="relative">
                <input
                  type="search"
                  value={searchQ}
                  onChange={e => setSearchQ(e.target.value)}
                  placeholder="搜索 名称 / 规格 / 类别 / 编码（空格分隔多关键字）"
                  className="w-full bg-bg rounded-chip pl-9 pr-9 py-2 text-body outline-none"
                />
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray3 text-caption">🔍</span>
                {searchQ && (
                  <button
                    type="button"
                    onClick={() => setSearchQ('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-gray5 text-gray2 text-caption flex items-center justify-center"
                    aria-label="清除"
                  >×</button>
                )}
              </div>
            </div>
            {/* 类别 chips */}
            {allCategories.length > 2 && (
              <div className="px-4 pb-2 overflow-x-auto">
                <div className="flex gap-2 whitespace-nowrap">
                  {allCategories.map(c => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setCatFilter(c)}
                      className={`px-3 py-1 rounded-chip text-caption ${catFilter === c ? 'bg-ink text-white' : 'bg-bg text-gray2'}`}
                    >{c}</button>
                  ))}
                </div>
              </div>
            )}
            <ul className="overflow-auto flex-1 divide-y divide-border">
              {filteredProducts.length === 0 && (
                <li className="px-4 py-8 text-center text-caption text-gray3">无匹配商品 · 试试清空搜索条件</li>
              )}
              {filteredProducts.map(p => {
                const picked = items.find(i => i.productId === p.id)
                const qty = picked?.quantity || 0
                const pricing = resolveOrderEntryCostPricing(p)
                const pricePending = pricing.status === 'PENDING'
                const stockNum = Number(p.availableStock ?? p.stock ?? 0)
                const outOfStock = stockNum <= 0
                // 商品状态: 供应商下架 / 待审批的 SKU 不可加入采购单 (server 端 orders.ts:298 兜底拦)
                const notOrderable = p.status != null && p.status !== 'ENABLED'
                const statusChip = p.status === 'DISABLED'         ? { label: '已停售', cls: 'bg-gray5 text-gray2' }
                                 : p.status === 'PENDING_DISABLE'  ? { label: '停售待审', cls: 'bg-orange-50 text-orange-fg' }
                                 : p.status === 'PENDING_APPROVAL' ? { label: '待上架', cls: 'bg-orange-50 text-orange-fg' }
                                 : null
                return (
                  <li key={p.id} className={`flex items-center px-4 py-3 ${notOrderable || pricePending ? 'opacity-60' : picked ? 'bg-amber/5' : ''}`}>
                    <OrderProductImage src={p.imageUrl} name={p.name} code={p.code} size="picker" />
                    <div className="flex-1 min-w-0 ml-3">
                      <div className="text-body truncate flex items-center gap-1 flex-wrap">
                        <span>{p.name}</span>
                        {p.code && <span className="text-micro text-gray3">#{p.code}</span>}
                        {p.spec && <span className="text-micro text-gray3">· {p.spec}</span>}
                        {statusChip && (
                          <span className={`text-micro px-1.5 py-0.5 rounded-chip whitespace-nowrap ${statusChip.cls}`}>{statusChip.label}</span>
                        )}
                        {!notOrderable && Number(p.minOrderQty || 1) > 1 && (
                          <span className="text-micro px-1.5 py-0.5 bg-amber/10 text-amber-fg rounded-chip whitespace-nowrap">起订 {moq(p)}{step(p) > 1 ? `·步 ${step(p)}` : ''}</span>
                        )}
                        {!notOrderable && outOfStock && (
                          <span className="text-micro px-1.5 py-0.5 bg-red-50 text-red-600 rounded-chip whitespace-nowrap">⚠ 供应商断货</span>
                        )}
                      </div>
                      {pricing.status === 'READY' ? (
                        <>
                          <div className="text-micro text-gray3 font-num">
                            ¥{pricing.orderUnitPrice} · {pricing.unitLabel} · 可用 {stockNum}
                            {(p.reservedStock || 0) > 0 && <span className="text-amber-fg">（已占 {p.reservedStock}）</span>}
                            {qty > 0 && <span className="text-amber-fg ml-2">小计 ¥{calculateOrderEntryLineAmount(qty, pricing.orderUnitPrice) || '0.00'}</span>}
                          </div>
                          <div className="text-micro text-gray3">{pricing.costPriceSource}</div>
                        </>
                      ) : (
                        <div className="text-micro text-red-fg">{pricing.message} · 请联系采购核验单位换算</div>
                      )}
                    </div>
                    {notOrderable ? (
                      qty > 0 ? (
                        /* 草稿里有已停售残留, 给一个"移除"按钮让用户清掉 (setQtyByProduct(p, 0) 触发 filter 移除) */
                        <button
                          type="button"
                          onClick={() => setQtyByProduct(p, 0)}
                          className="px-3 py-1.5 rounded-cta text-button bg-red-50 text-red-600"
                          aria-label="移除已停售商品"
                        >移除</button>
                      ) : (
                        <button
                          type="button"
                          disabled
                          className="px-3 py-1.5 rounded-cta text-button bg-gray5 text-gray3 cursor-not-allowed"
                          aria-label="该商品已停售"
                        >不可加入</button>
                      )
                    ) : pricePending ? (
                      qty > 0 ? (
                        <button
                          type="button"
                          onClick={() => setQtyByProduct(p, 0)}
                          className="px-3 py-1.5 rounded-cta text-button bg-red-50 text-red-600"
                          aria-label="移除价格待核验商品"
                        >移除</button>
                      ) : (
                        <button
                          type="button"
                          disabled
                          className="px-3 py-1.5 rounded-cta text-button bg-gray5 text-gray3 cursor-not-allowed"
                          aria-label="该商品价格待核验"
                        >不可加入</button>
                      )
                    ) : qty === 0 ? (
                      <button
                        type="button"
                        onClick={() => {
                          if (outOfStock) {
                            openConfirm({
                              title: '供应商断货提醒',
                              body: <span>「<b>{p.name}</b>」供应商当前库存为 <b className="text-red-600">0</b>,可能无法按时发货。仍要加入采购单吗?</span>,
                              confirmLabel: '仍然加入',
                              cancelLabel: '取消',
                              tone: 'danger',
                              onConfirm: () => addItem(p),
                            })
                          } else {
                            addItem(p)
                          }
                        }}
                        className={`px-3 py-1.5 rounded-cta text-button ${outOfStock ? 'bg-red-50 text-red-600' : 'bg-amber/10 text-amber-fg'}`}
                      >+ 加入</button>
                    ) : (
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setQtyByProduct(p, +(qty - step(p)).toFixed(2))}
                          className="w-8 h-8 rounded-full bg-bg text-h2 leading-none flex items-center justify-center"
                          aria-label="减少"
                        >−</button>
                        <input
                          type="number" inputMode="decimal" min={moq(p)} step={step(p)}
                          value={qty}
                          onChange={e => setQtyByProduct(p, Number(e.target.value))}
                          onBlur={e => setQtyByProduct(p, snap(p, Number(e.target.value) || moq(p)))}
                          className="w-14 text-center font-num text-body bg-bg rounded-chip py-1 outline-none"
                        />
                        <button
                          type="button"
                          onClick={() => setQtyByProduct(p, +(qty + step(p)).toFixed(2))}
                          className="w-8 h-8 rounded-full bg-amber text-white text-h2 leading-none flex items-center justify-center"
                          aria-label="增加"
                        >+</button>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
            <div className="border-t border-border p-3 flex items-center gap-3">
              <div className="flex-1">
                <div className="text-micro text-gray3">已选 {items.length} 项</div>
                <div className={total === null ? 'text-caption text-red-fg' : 'font-num text-h2'}>
                  {total === null ? '价格待核验' : `¥${total}`}
                </div>
              </div>
              <button
                onClick={() => setPickerOpen(false)}
                className="px-6 py-3 bg-ink text-white rounded-cta text-button"
              >完成</button>
            </div>
          </div>
        </div>
      )}

      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-border p-3 flex gap-3">
        <button type="button" onClick={() => router.back()} className="px-4 py-3 bg-white border border-border rounded-cta text-button text-gray2">取消</button>
        <button
          onClick={submit}
          disabled={submitting || !supplierId || items.length === 0 || total === null}
          className="flex-1 py-3 bg-ink text-white rounded-cta text-button disabled:opacity-40"
        >
          {submitting ? '提交中…' : `提交采购单${total !== null && Number(total) > 0 ? ` · ¥${total}` : ''}`}
        </button>
      </div>
      <ConfirmSheet {...confirm} />
    </div>
  )
}
