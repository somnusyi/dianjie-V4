'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { OrderProductImage } from '@/components/v2/order-product-image'
import { apiFetch } from '@/lib/v2-auth'

type Supplier = { id: string; name: string; category?: string | null; inventoryMode: string }
type Product = {
  id: string
  supplierId: string | null
  code: string
  name: string
  category?: string | null
  spec?: string | null
  unit: string
  orderUnit?: string | null
  imageUrl?: string | null
  orderUnitPrice?: number | string | null
  minOrderQty?: number | string | null
  stepQty?: number | string | null
  availableStock?: number
  reservedStock?: number
  unitConversionStatus?: string | null
}
type Catalog = {
  mode: 'SIMULATION'
  store: { id: string; no: string; name: string; status: string }
  suppliers: Supplier[]
  products: Product[]
}
type PreflightIssue = { code: string; productId?: string; productName?: string; message: string; stage: 'ORDER_ENTRY' | 'SUPPLIER_ACCEPT' }
type PreflightResult = {
  mode: 'SIMULATION'
  persisted: false
  canSubmit: boolean
  canCompleteFlow: boolean
  totalAmount: string | null
  itemCount: number
  issues: PreflightIssue[]
  message: string
}

function minimum(product: Product) { return Math.max(0.01, Number(product.minOrderQty || 1)) }
function increment(product: Product) { return Math.max(0.01, Number(product.stepQty || 1)) }
function roundQuantity(value: number) { return Number(value.toFixed(4)) }

export function StoreOrderSimulation({ storeId, storeName }: { storeId: string; storeName: string }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [supplierId, setSupplierId] = useState('')
  const [category, setCategory] = useState('全部')
  const [query, setQuery] = useState('')
  const [quantities, setQuantities] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<PreflightResult | null>(null)
  const sequence = useRef(0)

  useEffect(() => {
    if (!storeId) return
    const current = ++sequence.current
    setLoading(true)
    setError('')
    setResult(null)
    setQuantities({})
    apiFetch<Catalog>(`/api/stores/${encodeURIComponent(storeId)}/order-simulation/catalog`)
      .then(data => {
        if (current !== sequence.current) return
        setCatalog(data)
        setSupplierId(data.suppliers[0]?.id || '')
        setCategory('全部')
      })
      .catch(reason => {
        if (current === sequence.current) setError(String(reason?.message || reason))
      })
      .finally(() => {
        if (current === sequence.current) setLoading(false)
      })
  }, [storeId])

  const supplierProducts = useMemo(
    () => (catalog?.products || []).filter(product => product.supplierId === supplierId),
    [catalog, supplierId],
  )
  const categories = useMemo(
    () => ['全部', ...Array.from(new Set(supplierProducts.map(product => product.category || '其他'))).sort()],
    [supplierProducts],
  )
  const visibleProducts = useMemo(() => {
    const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    return supplierProducts.filter(product => {
      if (category !== '全部' && (product.category || '其他') !== category) return false
      const haystack = `${product.name} ${product.code} ${product.spec || ''}`.toLowerCase()
      return tokens.every(token => haystack.includes(token))
    })
  }, [supplierProducts, category, query])
  const selectedProducts = supplierProducts.filter(product => Number(quantities[product.id] || 0) > 0)
  const estimatedTotal = selectedProducts.reduce(
    (sum, product) => sum + Number(quantities[product.id] || 0) * Number(product.orderUnitPrice || 0),
    0,
  )

  function setQuantity(product: Product, next: number) {
    setResult(null)
    setQuantities(current => {
      if (next <= 0) {
        const copy = { ...current }
        delete copy[product.id]
        return copy
      }
      const min = minimum(product)
      const step = increment(product)
      const snapped = next < min ? min : min + Math.round((next - min) / step) * step
      return { ...current, [product.id]: roundQuantity(snapped) }
    })
  }

  async function runPreflight() {
    if (!supplierId || selectedProducts.length === 0) return
    setChecking(true)
    setError('')
    setResult(null)
    try {
      const checked = await apiFetch<PreflightResult>(
        `/api/stores/${encodeURIComponent(storeId)}/order-simulation/preflight`,
        {
          method: 'POST',
          body: JSON.stringify({
            supplierId,
            items: selectedProducts.map(product => ({ productId: product.id, quantity: quantities[product.id] })),
          }),
        },
      )
      setResult(checked)
    } catch (reason: any) {
      setError(String(reason?.message || reason))
    } finally {
      setChecking(false)
    }
  }

  if (loading) return <div className="rounded-card border border-border bg-white px-4 py-12 text-center text-caption text-gray3">正在载入门店真实订货目录…</div>
  if (error && !catalog) return <div className="rounded-card border border-red/30 bg-red-bg px-4 py-8 text-center text-caption text-red-fg">模拟目录加载失败：{error}</div>
  if (!catalog || catalog.suppliers.length === 0) return <div className="rounded-card border border-orange/30 bg-orange/5 px-4 py-8 text-center text-caption text-orange">没有启用中的供应商，门店当前无法订货。</div>

  return (
    <section aria-label="模拟门店下单" className="space-y-4">
      <div className="rounded-card border-2 border-amber/50 bg-amber/10 px-4 py-3">
        <div className="flex items-start gap-3">
          <span className="rounded-chip bg-ink px-2.5 py-1 text-button text-white">模拟模式</span>
          <div>
            <h2 className="text-h2">以 {storeName} 的视角测试订货</h2>
            <p className="mt-1 text-caption text-gray2">商品、价格和订货约束来自真实业务规则；不会创建采购单，不会占用或扣减库存，也不会产生财务和审计单据。</p>
          </div>
        </div>
      </div>

      <div className="grid gap-3 rounded-card border border-border bg-white p-4 lg:grid-cols-[minmax(220px,0.35fr)_minmax(280px,0.65fr)]">
        <label className="text-caption text-gray2">
          模拟选择供应商
          <select
            aria-label="模拟选择供应商"
            value={supplierId}
            onChange={event => {
              setSupplierId(event.target.value)
              setQuantities({})
              setCategory('全部')
              setResult(null)
            }}
            className="mt-1 h-11 w-full rounded-cta border border-border bg-white px-3 text-body"
          >
            {catalog.suppliers.map(supplier => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}
          </select>
        </label>
        <label className="text-caption text-gray2">
          搜索商品
          <input
            type="search"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="商品名称 / 规格 / 编码，支持空格分词"
            className="mt-1 h-11 w-full rounded-cta border border-border bg-bg px-3 text-body outline-none focus:border-accent"
          />
        </label>
      </div>

      <div className="grid min-h-[520px] overflow-hidden rounded-card border border-border bg-white md:grid-cols-[190px_minmax(0,1fr)]">
        <aside className="overflow-x-auto border-b border-border bg-bg p-3 md:border-b-0 md:border-r" aria-label="商品分类">
          <div className="flex gap-2 md:flex-col">
            {categories.map(item => (
              <button
                key={item}
                type="button"
                aria-pressed={category === item}
                onClick={() => setCategory(item)}
                className={`shrink-0 rounded-cta px-3 py-2 text-left text-caption ${category === item ? 'bg-ink text-white' : 'bg-white text-gray2 hover:text-ink'}`}
              >{item}</button>
            ))}
          </div>
        </aside>
        <div>
          <header className="flex items-center justify-between border-b border-border px-4 py-3">
            <div><b>{category}</b><span className="ml-2 text-micro text-gray3">{visibleProducts.length} 个可售商品</span></div>
            <span className="text-micro text-gray3">与门店真实目录同步</span>
          </header>
          <ul className="divide-y divide-border">
            {visibleProducts.map(product => {
              const quantity = quantities[product.id] || 0
              const priceReady = product.orderUnitPrice !== null && product.orderUnitPrice !== undefined
              const available = Number(product.availableStock || 0)
              return (
                <li key={product.id} className={`flex gap-3 px-4 py-4 ${quantity > 0 ? 'bg-amber/5' : ''}`}>
                  <OrderProductImage src={product.imageUrl} name={product.name} code={product.code} size="picker" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <b className="text-body">{product.name}</b>
                      {available <= 0 && <span className="rounded-chip bg-red-bg px-2 py-0.5 text-micro text-red-fg">供应商无可用库存</span>}
                    </div>
                    <div className="mt-1 text-micro text-gray3">{product.spec || '无规格'} · 编码 {product.code}</div>
                    <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <span className="font-num text-h2 text-orange">{priceReady ? `¥${Number(product.orderUnitPrice).toFixed(2)}` : '价格待核验'}</span>
                      <span className="text-caption text-gray2">/{product.orderUnit || product.unit}</span>
                      <span className="text-micro text-gray3">起订 {minimum(product)} · 步长 {increment(product)} · 可用 {available}</span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center self-center rounded-cta border border-border bg-white">
                    <button type="button" aria-label={`减少${product.name}`} onClick={() => setQuantity(product, quantity - increment(product))} className="h-10 w-10 text-h2 text-gray2">−</button>
                    <span className="min-w-12 text-center font-num text-body">{quantity}</span>
                    <button type="button" aria-label={`增加${product.name}`} disabled={!priceReady} onClick={() => setQuantity(product, quantity ? quantity + increment(product) : minimum(product))} className="h-10 w-10 text-h2 text-amber-fg disabled:text-gray4">＋</button>
                  </div>
                </li>
              )
            })}
            {visibleProducts.length === 0 && <li className="px-4 py-14 text-center text-caption text-gray3">当前筛选下没有可订商品</li>}
          </ul>
        </div>
      </div>

      <div className="sticky bottom-3 z-10 rounded-card border border-border bg-ink p-4 text-white shadow-drawer">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-caption text-gray4">模拟购物车 · {selectedProducts.length} 种商品</div>
            <div className="mt-1 font-num text-h1">预计 ¥{estimatedTotal.toFixed(2)}</div>
          </div>
          <button
            type="button"
            disabled={checking || selectedProducts.length === 0}
            onClick={runPreflight}
            className="h-12 rounded-cta bg-accent px-7 text-button text-white disabled:bg-gray3"
          >{checking ? '正在模拟校验…' : '模拟校验完整下单链路'}</button>
        </div>
      </div>

      {error && <div className="rounded-card border border-red/30 bg-red-bg p-4 text-caption text-red-fg">{error}</div>}
      {result && (
        <div className={`rounded-card border p-4 ${result.canCompleteFlow ? 'border-green/30 bg-green-bg text-green-fg' : 'border-red/30 bg-red-bg text-red-fg'}`} role="status">
          <h3 className="text-h2">{result.canCompleteFlow ? '✓ 模拟通过' : '✕ 模拟发现阻塞'}</h3>
          <p className="mt-1 text-caption">{result.message} · 全程未生成真实订单</p>
          {result.issues.length > 0 && (
            <ul className="mt-3 list-disc space-y-1 pl-5 text-caption">
              {result.issues.map((issue, index) => <li key={`${issue.code}-${issue.productId || index}`}>{issue.stage === 'SUPPLIER_ACCEPT' ? '供应商接单：' : '门店提交：'}{issue.message}</li>)}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}
