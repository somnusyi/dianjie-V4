'use client'

import Link from 'next/link'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ConfirmSheet, useConfirmSheet } from '@/components/v2/confirm-sheet'
import { SUPPLY_CHAIN_BEFORE_NAVIGATE_EVENT } from '@/components/v2/supply-chain-shell'
import { WarehouseToolTabs } from '@/components/v2/warehouse-tool-tabs'
import { apiFetch } from '@/lib/v2-auth'

type Product = {
  id: string
  code: string
  name: string
  spec?: string | null
  inventoryUnit: string
  physicalQty: number
  availableQty: number
}
type LossLine = { productId: string; quantity: string; note: string }
type Evidence = { key: string; name: string; mime: string; size: number; url: string }

const REASONS = ['盘亏损毁', '过期变质', '搬运损坏', '保管不当', '其他自损'] as const
const MAX_EVIDENCE = 9

function localDateTime() {
  const now = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000)
  return now.toISOString().slice(0, 16)
}

function requestKey() {
  return globalThis.crypto?.randomUUID?.() || `warehouse-loss-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export default function WarehouseSelfLossPage() {
  const initialEffectiveAtRef = useRef(localDateTime())
  const [products, setProducts] = useState<Product[]>([])
  const [lines, setLines] = useState<LossLine[]>([])
  const [reason, setReason] = useState<'' | (typeof REASONS)[number]>('')
  const [responsibility, setResponsibility] = useState('')
  const [effectiveAt, setEffectiveAt] = useState(initialEffectiveAtRef.current)
  const [evidence, setEvidence] = useState<Evidence[]>([])
  const [keyword, setKeyword] = useState('')
  const [loading, setLoading] = useState(true)
  const [searching, setSearching] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState('')
  const [completedDoc, setCompletedDoc] = useState<{ id: string; docNo: string } | null>(null)
  const [error, setError] = useState('')
  const [idempotencyKey, setIdempotencyKey] = useState(requestKey)
  const [confirmState, openConfirm] = useConfirmSheet()
  const dirty = Boolean(reason || responsibility.trim() || effectiveAt !== initialEffectiveAtRef.current || lines.length || evidence.length)
  const dirtyRef = useRef(dirty)
  const busyRef = useRef(uploading || submitting)
  useEffect(() => { dirtyRef.current = dirty }, [dirty])
  useEffect(() => { busyRef.current = uploading || submitting }, [uploading, submitting])

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current && !busyRef.current) return
      event.preventDefault()
      event.returnValue = ''
    }
    const warnInternalNavigation = (event: Event) => {
      if (!dirtyRef.current && !busyRef.current) return
      event.preventDefault()
      if (busyRef.current) {
        setError(uploading ? '现场证据正在上传，请等待完成后再离开' : '自损单正在提交入账，请等待结果后再离开')
        return
      }
      const proceed = (event as CustomEvent<{ proceed?: () => void }>).detail?.proceed
      openConfirm({
        title: '放弃未提交的总仓自损单？',
        body: '当前填写的原因、责任、商品或现场证据尚未提交，离开后将不会保留。',
        confirmLabel: '放弃并离开',
        tone: 'danger',
        onConfirm: () => {
          dirtyRef.current = false
          setReason('')
          setResponsibility('')
          setLines([])
          setEvidence([])
          initialEffectiveAtRef.current = effectiveAt
          proceed?.()
        },
      })
    }
    window.addEventListener('beforeunload', warn)
    window.addEventListener(SUPPLY_CHAIN_BEFORE_NAVIGATE_EVENT, warnInternalNavigation)
    return () => {
      window.removeEventListener('beforeunload', warn)
      window.removeEventListener(SUPPLY_CHAIN_BEFORE_NAVIGATE_EVENT, warnInternalNavigation)
    }
  }, [effectiveAt, openConfirm, uploading])

  useEffect(() => {
    apiFetch<{ items: Product[] }>('/api/warehouse-inventory?scope=stock&pageSize=100')
      .then(result => setProducts((result.items || []).filter(item => item.availableQty > 0)))
      .catch(cause => setError(String(cause?.message || cause)))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    const term = keyword.trim()
    if (!term) return
    const timer = window.setTimeout(() => {
      setSearching(true)
      apiFetch<{ items: Product[] }>(`/api/warehouse-inventory?scope=stock&pageSize=50&q=${encodeURIComponent(term)}`)
        .then(result => setProducts(current => {
          const merged = new Map(current.map(item => [item.id, item]))
          for (const item of result.items || []) if (item.availableQty > 0) merged.set(item.id, item)
          return [...merged.values()]
        }))
        .catch(cause => setError(String(cause?.message || cause)))
        .finally(() => setSearching(false))
    }, 250)
    return () => window.clearTimeout(timer)
  }, [keyword])

  const candidates = useMemo(() => {
    const term = keyword.trim().toLowerCase()
    return products.filter(product => !lines.some(line => line.productId === product.id)
      && (!term || [product.code, product.name, product.spec].some(value => String(value || '').toLowerCase().includes(term))))
  }, [keyword, lines, products])

  function addProduct(product: Product) {
    setLines(current => [...current, { productId: product.id, quantity: '', note: '' }])
    setKeyword('')
  }

  function updateLine(productId: string, patch: Partial<LossLine>) {
    setLines(current => current.map(line => line.productId === productId ? { ...line, ...patch } : line))
  }

  async function upload(files: File[]) {
    const selected = files.slice(0, Math.max(0, MAX_EVIDENCE - evidence.length))
    if (!selected.length) return setError('现场证据最多上传9份')
    setUploading(true); setError('')
    try {
      for (const file of selected) {
        const form = new FormData(); form.append('file', file, file.name)
        const uploaded = await apiFetch<Evidence>('/api/upload?category=warehouse-docs', { method: 'POST', body: form as any })
        setEvidence(current => current.some(item => item.key === uploaded.key) ? current : [...current, uploaded].slice(0, MAX_EVIDENCE))
      }
    } catch (cause: any) {
      setError(String(cause?.message || cause))
    } finally { setUploading(false) }
  }

  function validate() {
    if (!reason) return '请选择自损原因'
    if (!responsibility.trim()) return '请填写责任归属'
    if (!lines.length) return '请至少添加一项自损商品'
    for (const line of lines) {
      const product = products.find(item => item.id === line.productId)
      const quantity = Number(line.quantity)
      if (!Number.isFinite(quantity) || quantity <= 0) return `请填写「${product?.name || '商品'}」的正确自损数量`
      if (product && quantity > product.availableQty) return `「${product.name}」自损数量不能超过可用库存 ${product.availableQty}${product.inventoryUnit}`
    }
    if (!evidence.length) return '请上传现场照片或PDF证据'
    return ''
  }

  async function submit() {
    setSubmitting(true); setError(''); setMessage('')
    try {
      const result = await apiFetch<{ replayed: boolean; count: number; totalAmount: number; doc: { id: string; docNo: string } }>('/api/warehouse-inventory/batch-self-loss', {
        method: 'POST',
        body: JSON.stringify({
          items: lines.map(line => ({ productId: line.productId, inventoryQuantity: Number(line.quantity), note: line.note.trim() || null })),
          effectiveAt: new Date(effectiveAt).toISOString(),
          idempotencyKey,
          reason,
          responsibility: responsibility.trim(),
          attachments: evidence.map(({ key, name, mime, size }) => ({ key, name, mime, size })),
        }),
      })
      setMessage(result.replayed ? `自损单 ${result.doc.docNo} 已处理，本次未重复扣库` : `自损单 ${result.doc.docNo} 已入账：${result.count}项，库存成本 ¥${result.totalAmount.toFixed(2)}`)
      setCompletedDoc(result.doc)
      initialEffectiveAtRef.current = effectiveAt
      dirtyRef.current = false
      setLines([]); setEvidence([]); setResponsibility(''); setReason(''); setIdempotencyKey(requestKey())
    } catch (cause: any) {
      setError(String(cause?.message || cause))
    } finally { setSubmitting(false) }
  }

  function requestSubmit() {
    const invalid = validate()
    if (invalid) { setError(invalid); return }
    openConfirm({
      title: '确认提交总仓自损？',
      body: `将按库存单位扣减 ${lines.length} 项实物库存，并冻结当前移动平均成本。\n原因：${reason}\n责任归属：${responsibility.trim()}\n提交后如需更正，必须通过冲销/盘点流程，不能直接改写历史。`,
      confirmLabel: '确认扣库并生成自损单',
      tone: 'danger',
      onConfirm: submit,
    })
  }

  return <div className="min-h-screen bg-bg px-4 py-5 lg:px-8 lg:py-7">
    <div className="mx-auto max-w-[1440px]">
      <WarehouseToolTabs />
      <header className="flex flex-wrap items-end justify-between gap-3 border-b border-border pb-5">
        <div><h1 className="text-h1">总仓自损单</h1><p className="mt-1 text-caption text-gray2">只登记总仓内部盘亏、过期、破损等损耗；门店验收短量和门店报损不在这里处理。</p></div>
        <Link href="/v2/supply-chain/inventory-management/other-out" className="rounded-cta border border-border bg-white px-4 py-2.5 text-button text-gray2">查询 / 导出其他出库单</Link>
      </header>

      {error && <div role="alert" className="mt-4 rounded-card border border-red-fg/20 bg-red-bg px-4 py-3 text-caption text-red-fg">{error}</div>}
      {message && <div role="status" className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-card border border-green/20 bg-green/5 px-4 py-3 text-caption text-green-fg"><span>{message}</span>{completedDoc && <Link href={`/v2/supply-chain/docs?doc=${encodeURIComponent(completedDoc.id)}`} className="font-semibold underline">查看单据明细与现场证据</Link>}</div>}

      <section className="mt-4 grid gap-4 rounded-card border border-border bg-white p-5 md:grid-cols-3">
        <label><span className="mb-1 block text-micro text-gray3">自损原因 *</span><select value={reason} onChange={event => setReason(event.target.value as typeof reason)} className="h-11 w-full rounded-cta border border-border px-3"><option value="">请选择</option>{REASONS.map(item => <option key={item}>{item}</option>)}</select></label>
        <label><span className="mb-1 block text-micro text-gray3">责任归属 *</span><input value={responsibility} maxLength={120} onChange={event => setResponsibility(event.target.value)} placeholder="例：仓储环节 / 搬运环节 / 待调查" className="h-11 w-full rounded-cta border border-border px-3" /></label>
        <label><span className="mb-1 block text-micro text-gray3">实际发生时间 *</span><input type="datetime-local" value={effectiveAt} onChange={event => setEffectiveAt(event.target.value)} className="h-11 w-full rounded-cta border border-border px-3" /></label>
      </section>

      <section className="mt-4 rounded-card border border-border bg-white p-5">
        <h2 className="text-h2">自损商品</h2>
        <div className="relative mt-3"><input value={keyword} onChange={event => setKeyword(event.target.value)} placeholder={loading ? '库存加载中…' : '输入物品编码、名称或规格'} className="h-11 w-full rounded-cta border border-border px-3" />
          {keyword && <div className="absolute z-10 mt-1 max-h-64 w-full overflow-auto rounded-card border border-border bg-white shadow-lg">{candidates.slice(0, 50).map(product => <button type="button" key={product.id} onClick={() => addProduct(product)} className="flex w-full items-center justify-between border-b border-border px-3 py-2 text-left hover:bg-bg"><span><b>{product.code} · {product.name}</b><small className="ml-2 text-gray3">{product.spec || '无规格'}</small></span><span className="text-caption text-gray2">可用 {product.availableQty}{product.inventoryUnit}</span></button>)}{searching && <p className="px-3 py-2 text-caption text-gray3">正在从全部商品中搜索…</p>}{!searching && candidates.length === 0 && <p className="px-3 py-2 text-caption text-gray3">没有可用库存商品</p>}</div>}
        </div>
        <div className="mt-3 space-y-2">{lines.map(line => { const product = products.find(item => item.id === line.productId)!; return <div key={line.productId} className="grid items-end gap-2 rounded-card bg-bg p-3 md:grid-cols-[minmax(0,1fr)_180px_minmax(0,1fr)_40px]">
          <div><b>{product.code} · {product.name}</b><p className="text-micro text-gray3">物理 {product.physicalQty}{product.inventoryUnit} · 已预占 {product.physicalQty - product.availableQty}{product.inventoryUnit} · 可用 {product.availableQty}{product.inventoryUnit}</p></div>
          <label><span className="mb-1 block text-micro text-gray3">自损数量（{product.inventoryUnit}）*</span><input aria-label={`${product.name}自损数量`} type="number" min="0.000001" max={product.availableQty} step="0.001" value={line.quantity} onChange={event => updateLine(line.productId, { quantity: event.target.value })} className="h-10 w-full rounded-cta border border-border px-2" /></label>
          <label><span className="mb-1 block text-micro text-gray3">单项说明</span><input value={line.note} maxLength={240} onChange={event => updateLine(line.productId, { note: event.target.value })} placeholder="现场情况，选填" className="h-10 w-full rounded-cta border border-border px-2" /></label>
          <button type="button" aria-label={`移除${product.name}`} onClick={() => setLines(current => current.filter(item => item.productId !== line.productId))} className="h-10 text-red-fg">×</button>
        </div> })}</div>
        {!lines.length && <p className="py-8 text-center text-caption text-gray3">搜索并添加本次实际自损的商品</p>}
      </section>

      <section className="mt-4 rounded-card border border-border bg-white p-5">
        <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-h2">现场证据 *</h2><p className="mt-1 text-micro text-gray3">上传现场照片或PDF，最多9份；证据随自损单保存，不会被后续上传覆盖。</p></div><label className={`cursor-pointer rounded-cta border border-dashed border-accent px-4 py-2 text-button text-accent ${uploading ? 'pointer-events-none opacity-40' : ''}`}>{uploading ? '上传中…' : '+ 上传证据'}<input type="file" accept="image/jpeg,image/png,image/webp,image/gif,application/pdf" multiple className="hidden" onChange={event => { const files = Array.from(event.target.files || []); event.target.value = ''; void upload(files) }} /></label></div>
        <div className="mt-3 flex flex-wrap gap-2">{evidence.map(item => <span key={item.key} className="inline-flex items-center gap-2 rounded-cta border border-border bg-bg px-3 py-2 text-caption"><a href={item.url} target="_blank" rel="noreferrer" className="max-w-64 truncate text-accent">{item.name}</a><button type="button" aria-label={`移除${item.name}`} onClick={() => setEvidence(current => current.filter(row => row.key !== item.key))} className="text-red-fg">×</button></span>)}</div>
      </section>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-card border border-amber/20 bg-amber/5 p-4"><p className="max-w-3xl text-caption text-gray2">提交后会立即扣减总仓实物库存，按冻结移动平均成本记录损耗金额，并生成可查询、导出的其他出库单。</p><button type="button" onClick={requestSubmit} disabled={submitting || uploading} className="h-11 rounded-cta bg-red-fg px-6 text-button text-white disabled:opacity-40">{submitting ? '正在扣库…' : '审核后提交自损'}</button></div>
    </div>
    <ConfirmSheet {...confirmState} />
  </div>
}
