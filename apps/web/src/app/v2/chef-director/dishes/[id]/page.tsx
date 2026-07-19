/** 总厨 · 菜品档案、BOM 版本、别名和上下架。 */
'use client'

import { useEffect, useMemo, useState } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { Chip } from '@/components/v2'
import { ErrorScreen } from '@/components/v2/use-dashboard'
import { apiFetch } from '@/lib/v2-auth'

type Product = {
  id: string
  name: string
  code?: string
  spec?: string | null
  unit: string
  price: string
  status?: string
  supplier?: { name: string } | null
}

type BomItem = {
  id?: string
  productId: string
  quantity: string | number
  unit: string
  lossRate: string | number
  isMain: boolean
  note?: string | null
  product: Product
}

type BomVersion = {
  id: string
  variantKey: string
  versionNo: number
  status: 'DRAFT' | 'PUBLISHED' | 'RETIRED'
  changeType: 'INITIAL' | 'BUSINESS_CHANGE' | 'HISTORICAL_CORRECTION'
  changeReason?: string | null
  effectiveFrom?: string | null
  effectiveTo?: string | null
  publishedAt?: string | null
  items: BomItem[]
}

type Dish = {
  id: string
  name: string
  code?: string | null
  category?: string | null
  unit: string
  salePrice: string
  status: 'ACTIVE' | 'DISABLED' | 'UPCOMING'
  imageUrl?: string | null
  description?: string | null
  inventoryPolicy: 'BOM' | 'EXCLUDE'
  inventoryPolicyNote?: string | null
  groupWide: boolean
  storeIds: string[]
  availableFrom?: string | null
  availableTo?: string | null
  aliases: Array<{ id: string; rawName: string; source: string }>
  bomVersions: BomVersion[]
  foodCost: number
  grossProfit: number
  grossMargin: number
}

const shortDate = (value?: string | null) => value ? value.slice(0, 10) : ''
const today = () => new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
const tomorrow = () => {
  const value = new Date(`${today()}T00:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() + 1)
  return value.toISOString().slice(0, 10)
}
const fmt = (n: number, d = 2) => n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })

function versionEffective(version: BomVersion, date: string) {
  const from = shortDate(version.effectiveFrom)
  const to = shortDate(version.effectiveTo)
  return version.status === 'PUBLISHED' && Boolean(from) && from <= date && (!to || date <= to)
}

export default function DishDetailPage() {
  const router = useRouter()
  const params = useParams() as any
  const searchParams = useSearchParams()
  const id = String(params.id)
  const requestedVariant = searchParams.get('variant') || ''
  const targetSpec = searchParams.get('spec') || ''
  const taskId = searchParams.get('task') || ''
  const hasSuggestedEffectiveFrom = Boolean(searchParams.get('effectiveFrom'))
  const suggestedDate = searchParams.get('effectiveFrom') || tomorrow()
  const suggestedType = searchParams.get('changeType') === 'HISTORICAL_CORRECTION' ? 'HISTORICAL_CORRECTION' : 'BUSINESS_CHANGE'

  const [dish, setDish] = useState<Dish | null>(null)
  const [products, setProducts] = useState<Product[]>([])
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [publishedResult, setPublishedResult] = useState<BomVersion | null>(null)
  const [busy, setBusy] = useState(false)
  const [draftItems, setDraftItems] = useState<BomItem[]>([])
  const [reason, setReason] = useState(taskId ? '补齐历史日报缺失 BOM' : '配方调整')
  const [effectiveFrom, setEffectiveFrom] = useState(suggestedDate)
  const [changeType, setChangeType] = useState<'BUSINESS_CHANGE' | 'HISTORICAL_CORRECTION'>(suggestedType)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [productQ, setProductQ] = useState('')
  const [aliasName, setAliasName] = useState('')
  const [lifecycleDate, setLifecycleDate] = useState(today())
  const [lifecycleReason, setLifecycleReason] = useState('')

  const variantKeys = useMemo(() => {
    const keys = new Set((dish?.bomVersions || []).map(version => version.variantKey))
    if (requestedVariant) keys.add(requestedVariant)
    return [...keys].sort((left, right) => left === '' ? -1 : right === '' ? 1 : left.localeCompare(right, 'zh-CN'))
  }, [dish, requestedVariant])
  const targetVariant = requestedVariant || (!variantKeys.includes('') && variantKeys.length > 0 ? variantKeys[0] : '')

  async function reload() {
    try {
      const [nextDish, catalog] = await Promise.all([
        apiFetch<Dish>(`/api/dishes/${id}`),
        apiFetch<any>('/api/products?all=1'),
      ])
      setDish(nextDish)
      setProducts(Array.isArray(catalog) ? catalog : catalog?.items || [])
      const draft = nextDish.bomVersions.find(version => version.variantKey === targetVariant && version.status === 'DRAFT')
      setDraftItems(draft?.items || [])
      setError(null)
    } catch (reason: any) {
      setError(reason.message || '菜品加载失败')
    }
  }

  useEffect(() => { reload() }, [id, targetVariant])

  const versions = useMemo(
    () => (dish?.bomVersions || []).filter(version => version.variantKey === targetVariant),
    [dish, targetVariant],
  )
  const draft = versions.find(version => version.status === 'DRAFT') || null
  const current = versions.find(version => versionEffective(version, today())) || null
  const scheduled = versions
    .filter(version => version.status === 'PUBLISHED' && shortDate(version.effectiveFrom) > today())
    .sort((left, right) => shortDate(left.effectiveFrom).localeCompare(shortDate(right.effectiveFrom)))[0] || null
  const latest = versions.find(version => version.status === 'PUBLISHED') || null
  const displayVersion = current || scheduled || latest

  useEffect(() => {
    if (dish && !hasSuggestedEffectiveFrom && versions.length === 0) setEffectiveFrom(today())
  }, [dish?.id, targetVariant, versions.length, hasSuggestedEffectiveFrom])
  const used = new Set(draftItems.map(item => item.productId))
  const filteredProducts = products.filter(product => {
    if (used.has(product.id) || product.status === 'DISABLED') return false
    const q = productQ.trim().toLowerCase()
    return !q || `${product.name} ${product.code || ''} ${product.spec || ''}`.toLowerCase().includes(q)
  }).slice(0, 80)

  if (error) return <ErrorScreen message={error} />
  if (!dish) return <div className="min-h-screen bg-bg flex items-center justify-center text-gray3">加载中…</div>

  async function createDraft() {
    if (!reason.trim()) { setError('请填写配方变更原因'); return }
    setBusy(true); setError(null)
    try {
      await apiFetch(`/api/dishes/${id}/bom-versions/draft`, {
        method: 'POST',
        body: JSON.stringify({ variantKey: targetVariant, effectiveFrom, changeType, changeReason: reason }),
      })
      setNotice('配方草稿已建立。编辑完成后需明确发布才会生效。')
      await reload()
    } catch (reason: any) { setError(reason.message) }
    finally { setBusy(false) }
  }

  async function saveDraft() {
    if (!draft) return false
    if (draftItems.length === 0) { setError('BOM 至少需要一项原材料'); return false }
    setBusy(true); setError(null)
    try {
      await apiFetch(`/api/dishes/bom-versions/${draft.id}/items`, {
        method: 'PUT',
        body: JSON.stringify({
          items: draftItems.map(item => ({
            productId: item.productId,
            quantity: Number(item.quantity),
            unit: item.unit,
            lossRate: Number(item.lossRate),
            isMain: item.isMain,
            note: item.note || undefined,
          })),
        }),
      })
      setNotice('草稿已保存，尚未影响库存扣减。')
      await reload()
      return true
    } catch (reason: any) { setError(reason.message); return false }
    finally { setBusy(false) }
  }

  async function publishDraft() {
    if (!draft) return
    if (!(await saveDraft())) return
    setBusy(true); setError(null)
    try {
      let published: BomVersion
      try {
        published = await apiFetch<BomVersion>(`/api/dishes/bom-versions/${draft.id}/publish`, { method: 'POST', body: JSON.stringify({}) })
      } catch (reason: any) {
        if (reason.data?.code !== 'HISTORICAL_CONFIRMATION_REQUIRED') throw reason
        if (!window.confirm(`${reason.message}\n\n确认发布这次历史纠错吗？发布后请回到 BOM 待办执行历史回补。`)) return
        published = await apiFetch<BomVersion>(`/api/dishes/bom-versions/${draft.id}/publish`, {
          method: 'POST', body: JSON.stringify({ confirmHistoricalCorrection: true }),
        })
      }
      const liveDate = shortDate(published.effectiveFrom)
      setPublishedResult(published)
      setNotice(`BOM v${published.versionNo} 已发布，${liveDate}起生效。`)
      await reload()
    } catch (reason: any) { setError(reason.message) }
    finally { setBusy(false) }
  }

  function addProduct(product: Product) {
    setDraftItems(items => [...items, {
      productId: product.id, quantity: 1, unit: product.unit, lossRate: 0,
      isMain: items.length === 0, product,
    }])
    setPickerOpen(false); setProductQ('')
  }

  function patchItem(productId: string, patch: Partial<BomItem>) {
    setDraftItems(items => items.map(item => item.productId === productId ? { ...item, ...patch } : item))
  }

  async function addAlias() {
    if (!aliasName.trim()) return
    setBusy(true); setError(null)
    try {
      await apiFetch(`/api/dishes/${id}/aliases`, { method: 'POST', body: JSON.stringify({ rawName: aliasName }) })
      setAliasName(''); setNotice('收银菜名已关联，后续日报会自动识别。'); await reload()
    } catch (reason: any) { setError(reason.message) }
    finally { setBusy(false) }
  }

  async function removeAlias(aliasId: string) {
    setBusy(true); setError(null)
    try { await apiFetch(`/api/dishes/aliases/${aliasId}`, { method: 'DELETE' }); await reload() }
    catch (reason: any) { setError(reason.message) }
    finally { setBusy(false) }
  }

  async function lifecycle(action: 'PUBLISH' | 'DELIST' | 'RELIST') {
    if (!dish) return
    if (!lifecycleReason.trim()) { setError('请填写上新/下架原因'); return }
    setBusy(true); setError(null)
    try {
      await apiFetch(`/api/dishes/${id}/lifecycle`, {
        method: 'POST',
        body: JSON.stringify({ action, effectiveDate: lifecycleDate, reason: lifecycleReason, groupWide: dish.groupWide, storeIds: dish.storeIds }),
      })
      setNotice(action === 'DELIST' ? '下架安排已保存，历史销量和 BOM 不会删除。' : '上架安排已保存。')
      setLifecycleReason(''); await reload()
    } catch (reason: any) { setError(reason.message) }
    finally { setBusy(false) }
  }

  async function recalculateHistory(version: BomVersion) {
    setBusy(true); setError(null)
    try {
      const impact = await apiFetch<{
        importCount: number; saleDays: number; saleQuantity: number; saleRevenue: number; from: string; to: string
      }>(`/api/daily-business-imports/bom-recalculation-impact?versionId=${encodeURIComponent(version.id)}`)
      const confirmed = window.confirm(
        `历史重算影响预览\n\n营业日期：${shortDate(impact.from)} ～ ${shortDate(impact.to)}\n日报：${impact.importCount} 天\n该菜品销量：${impact.saleQuantity} 份\n销售收入：¥${fmt(impact.saleRevenue)}\n\n系统会按各营业日有效 BOM 原子重建库存消耗。确认继续吗？`,
      )
      if (!confirmed) return
      const result = await apiFetch<{ recalculatedImportCount: number }>('/api/daily-business-imports/bom-recalculation', {
        method: 'POST', body: JSON.stringify({ versionId: version.id, confirm: true }),
      })
      setNotice(`历史重算完成：已重新核算 ${result.recalculatedImportCount} 个营业日。`)
      await reload()
    } catch (reason: any) { setError(reason.message) }
    finally { setBusy(false) }
  }

  const displayItems = draft ? draftItems : (displayVersion?.items || [])
  const cost = displayItems.reduce((sum, item) => sum + Number(item.product.price || 0) * Number(item.quantity) * (1 + Number(item.lossRate)), 0)
  const margin = Number(dish.salePrice) > 0 ? (Number(dish.salePrice) - cost) / Number(dish.salePrice) : 0
  const costLabel = draft ? '草稿成本' : current ? '当前成本' : scheduled ? '待生效成本' : latest ? '最近版本成本' : '当前成本'
  const copyButtonLabel = current
    ? '复制当前版本并发起变更'
    : scheduled
      ? '复制待生效版本并发起变更'
      : latest
        ? '复制最近版本并发起变更'
        : '建立首版 BOM 草稿'

  function variantHref(variantKey: string) {
    const query = new URLSearchParams(searchParams.toString())
    if (variantKey) query.set('variant', variantKey)
    else query.delete('variant')
    const suffix = query.toString()
    return `/v2/chef-director/dishes/${id}${suffix ? `?${suffix}` : ''}`
  }

  return (
    <div className="min-h-screen bg-bg pb-24">
      <header className="px-4 pt-4 pb-2 flex items-center gap-2">
        <button onClick={() => router.back()} className="text-gray2 text-h2">‹</button>
        <div className="flex-1 min-w-0">
          <h1 className="text-h1 truncate">{dish.name}</h1>
          <p className="text-micro text-gray3">菜品档案 · BOM 版本中心</p>
        </div>
        <Chip tone={dish.status === 'ACTIVE' ? 'green' : dish.status === 'UPCOMING' ? 'amber' : 'gray'}>
          {dish.status === 'ACTIVE' ? '在售' : dish.status === 'UPCOMING' ? '研发/待上架' : '已下架'}
        </Chip>
      </header>

      {notice && <div className="mx-4 mt-2 bg-green-bg text-green-fg rounded-card p-3 text-caption">{notice}</div>}
      {error && <div className="mx-4 mt-2 bg-red-bg text-red-fg rounded-card p-3 text-caption">{error}</div>}
      {taskId && <a href="/v2/chef-director/bom" className="block mx-4 mt-2 bg-amber/10 text-amber-fg rounded-card p-3 text-caption">完成配方发布后，返回 BOM 待办执行历史回补 ›</a>}

      <section className="mx-4 mt-3 bg-bg-warm rounded-card border border-border p-4">
        <div className="grid grid-cols-3 gap-2 text-caption">
          <div><div className="text-gray3">售价</div><div className="font-num text-h2">¥{fmt(Number(dish.salePrice))}</div></div>
          <div><div className="text-gray3">{costLabel}</div><div className="font-num text-h2 text-red-fg">¥{fmt(cost)}</div></div>
          <div><div className="text-gray3">预计毛利率</div><div className="font-num text-h2 text-green-fg">{(margin * 100).toFixed(1)}%</div></div>
        </div>
        <div className="text-micro text-gray3 mt-3">当前规格：{targetSpec || targetVariant || '默认规格'} · 库存策略：{dish.inventoryPolicy === 'BOM' ? '按配方扣减' : '明确不扣库存'}</div>
      </section>

      {(variantKeys.length > 0 || targetVariant) && (
        <nav className="px-4 mt-3 flex gap-2 overflow-x-auto" aria-label="BOM 规格">
          {variantKeys.map(variantKey => (
            <a key={variantKey || '__default'} href={variantHref(variantKey)} className={`shrink-0 px-3 py-1.5 rounded-chip text-caption ${variantKey === targetVariant ? 'bg-ink text-white' : 'bg-white border border-border text-gray2'}`}>
              {variantKey || '默认规格'}
            </a>
          ))}
          {!variantKeys.includes('') && <a href={variantHref('')} className="shrink-0 px-3 py-1.5 rounded-chip text-caption border border-dashed border-amber text-amber-fg">+ 默认兜底 BOM</a>}
        </nav>
      )}

      <section className="mx-4 mt-3 bg-white rounded-card border border-border p-3">
        <div className="flex items-center justify-between gap-2">
          <div><h2 className="text-h2">BOM 配方</h2><p className="text-micro text-gray3">已发布版本不可直接改写，变更先进入草稿</p></div>
          {draft && <Chip tone="amber">草稿 v{draft.versionNo}</Chip>}
          {!draft && current && <Chip tone="green">生效 v{current.versionNo}</Chip>}
          {!draft && !current && scheduled && <Chip tone="amber">待生效 v{scheduled.versionNo}</Chip>}
          {!draft && !current && !scheduled && latest && <Chip tone="gray">最近 v{latest.versionNo}</Chip>}
        </div>

        {!draft && (
          <div className="mt-3 bg-bg rounded-card p-3 space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <label className="text-micro text-gray3">生效日期<input type="date" value={effectiveFrom} onChange={e => setEffectiveFrom(e.target.value)} className="mt-1 w-full bg-white rounded-cta px-2 py-2 text-body" /></label>
              <label className="text-micro text-gray3">变更性质<select value={changeType} onChange={e => setChangeType(e.target.value as any)} className="mt-1 w-full bg-white rounded-cta px-2 py-2 text-body"><option value="BUSINESS_CHANGE">正常业务变更</option><option value="HISTORICAL_CORRECTION">历史配方纠错</option></select></label>
            </div>
            <input value={reason} onChange={e => setReason(e.target.value)} placeholder="变更原因" className="w-full bg-white rounded-cta px-3 py-2 text-body" />
            <button onClick={createDraft} disabled={busy} className="w-full py-2.5 bg-ink text-white rounded-cta text-button disabled:opacity-40">{copyButtonLabel}</button>
          </div>
        )}

        <ul className="mt-3 space-y-2">
          {displayItems.length === 0 && <li className="py-6 text-center text-caption text-gray3">当前规格还没有配方</li>}
          {displayItems.map(item => (
            <li key={item.productId} className="border-b border-border pb-2 last:border-0">
              <div className="flex items-center gap-2"><span className="flex-1 text-body">{item.isMain && <Chip tone="amber">主料</Chip>} {item.product.name}</span><span className="text-micro text-gray3">{item.product.spec}</span></div>
              <div className="flex items-center gap-2 mt-1 text-caption">
                <span className="text-gray3">用量</span>
                <input disabled={!draft} type="number" min="0.000001" step="0.01" value={String(item.quantity)} onChange={e => patchItem(item.productId, { quantity: e.target.value })} className="w-20 bg-bg rounded-chip px-2 py-1 text-right font-num disabled:opacity-70" />
                <span>{item.unit}</span><span className="text-gray3 ml-2">损耗</span>
                <input disabled={!draft} type="number" min="0" max="1" step="0.01" value={String(item.lossRate)} onChange={e => patchItem(item.productId, { lossRate: e.target.value })} className="w-16 bg-bg rounded-chip px-2 py-1 text-right font-num disabled:opacity-70" />
                {draft && <button onClick={() => setDraftItems(items => items.filter(row => row.productId !== item.productId))} className="ml-auto text-red-fg px-2">移除</button>}
              </div>
            </li>
          ))}
        </ul>
        {draft && (
          <div className="mt-3 grid grid-cols-3 gap-2">
            <button onClick={() => setPickerOpen(true)} className="py-2 border border-border rounded-cta text-button">+ 原材料</button>
            <button onClick={saveDraft} disabled={busy} className="py-2 border border-amber text-amber-fg rounded-cta text-button disabled:opacity-40">保存草稿</button>
            <button onClick={publishDraft} disabled={busy || draftItems.length === 0} className="py-2 bg-amber text-white rounded-cta text-button disabled:opacity-40">发布生效</button>
          </div>
        )}
      </section>

      <section className="mx-4 mt-3 bg-white rounded-card border border-border p-3">
        <h2 className="text-h2">收银菜名映射</h2><p className="text-micro text-gray3 mt-0.5">改名、简称或旧名称关联一次后，日报会持续自动识别</p>
        <div className="flex gap-2 mt-2"><input value={aliasName} onChange={e => setAliasName(e.target.value)} placeholder="输入收银系统菜名" className="min-w-0 flex-1 bg-bg rounded-cta px-3 py-2 text-body" /><button onClick={addAlias} disabled={busy || !aliasName.trim()} className="px-3 bg-ink text-white rounded-cta text-button disabled:opacity-40">关联</button></div>
        <div className="flex flex-wrap gap-2 mt-2">{dish.aliases.length === 0 && <span className="text-caption text-gray3">暂无别名，标准菜名仍可直接匹配</span>}{dish.aliases.map(alias => <span key={alias.id} className="bg-bg rounded-chip px-2 py-1 text-caption">{alias.rawName}<button onClick={() => removeAlias(alias.id)} className="ml-2 text-gray3">×</button></span>)}</div>
      </section>

      <section className="mx-4 mt-3 bg-white rounded-card border border-border p-3">
        <h2 className="text-h2">上新与下架</h2><p className="text-micro text-gray3 mt-0.5">只改变未来可售状态，历史销量和 BOM 永久保留</p>
        <div className="grid grid-cols-2 gap-2 mt-2"><input type="date" value={lifecycleDate} onChange={e => setLifecycleDate(e.target.value)} className="bg-bg rounded-cta px-3 py-2 text-body" /><input value={lifecycleReason} onChange={e => setLifecycleReason(e.target.value)} placeholder="原因" className="bg-bg rounded-cta px-3 py-2 text-body" /></div>
        <div className="grid grid-cols-2 gap-2 mt-2">{dish.status === 'ACTIVE' ? <button onClick={() => lifecycle('DELIST')} disabled={busy} className="py-2 border border-red text-red-fg rounded-cta text-button">安排下架</button> : <button onClick={() => lifecycle(dish.status === 'DISABLED' ? 'RELIST' : 'PUBLISH')} disabled={busy} className="py-2 bg-ink text-white rounded-cta text-button">{dish.status === 'DISABLED' ? '重新上架' : '发布上新'}</button>}<div className="py-2 text-center text-caption text-gray3">{dish.availableFrom ? `${shortDate(dish.availableFrom)}起` : '未设置上架日'}{dish.availableTo ? ` · ${shortDate(dish.availableTo)}下架` : ''}</div></div>
      </section>

      <section className="mx-4 mt-3 bg-white rounded-card border border-border p-3">
        <h2 className="text-h2">配方版本记录</h2>
        <div className="mt-2 space-y-2">{versions.length === 0 && <p className="text-caption text-gray3">暂无版本记录</p>}{versions.map(version => <div key={version.id} className="bg-bg rounded-card p-2 text-caption"><div className="flex justify-between"><span>v{version.versionNo} · {version.status === 'DRAFT' ? '草稿' : version.status === 'PUBLISHED' ? '已发布' : '已退役'}</span><span className="font-num text-gray3">{shortDate(version.effectiveFrom)}{version.effectiveTo ? ` ～ ${shortDate(version.effectiveTo)}` : ' 起'}</span></div><div className="text-micro text-gray3 mt-1">{version.changeType === 'HISTORICAL_CORRECTION' ? '历史纠错' : version.changeType === 'INITIAL' ? '初始版本' : '业务变更'} · {version.changeReason || '未填写原因'} · {version.items.length} 项原材料</div>{version.status === 'PUBLISHED' && version.changeType === 'HISTORICAL_CORRECTION' && <button onClick={() => recalculateHistory(version)} disabled={busy} className="mt-2 w-full py-2 border border-amber text-amber-fg rounded-cta text-button disabled:opacity-40">预览并重算历史营业日</button>}</div>)}</div>
      </section>

      {pickerOpen && <div className="fixed inset-0 z-50 bg-ink/60" onClick={() => setPickerOpen(false)}><div className="absolute bottom-0 left-0 right-0 bg-white rounded-t-card max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}><div className="px-4 pt-4 pb-2"><div className="flex justify-between"><h3 className="text-h2">选择原材料</h3><button onClick={() => setPickerOpen(false)}>×</button></div><input value={productQ} onChange={e => setProductQ(e.target.value)} placeholder="搜索名称 / 编码 / 规格" className="w-full bg-bg rounded-cta px-3 py-2 text-body mt-2" /></div><ul className="overflow-y-auto divide-y divide-border">{filteredProducts.map(product => <li key={product.id} className="px-4 py-3 flex items-center gap-2"><div className="flex-1 min-w-0"><div className="text-body truncate">{product.name}</div><div className="text-micro text-gray3">{product.spec} · ¥{fmt(Number(product.price))}/{product.unit}</div></div><button onClick={() => addProduct(product)} className="px-3 py-1.5 bg-amber/10 text-amber-fg rounded-cta text-button">添加</button></li>)}</ul></div></div>}
      {publishedResult && (
        <div className="fixed inset-0 z-[60] bg-ink/60 flex items-end" role="dialog" aria-modal="true" aria-label="BOM 发布成功">
          <div className="w-full bg-white rounded-t-card p-5 pb-8">
            <div className="w-12 h-12 rounded-full bg-green-bg text-green-fg flex items-center justify-center text-h1 mx-auto">✓</div>
            <h3 className="text-h1 text-center mt-3">发布成功</h3>
            <p className="text-body text-center mt-2">
              BOM v{publishedResult.versionNo} 已发布 · <span className="font-num">{shortDate(publishedResult.effectiveFrom)}</span>起生效
            </p>
            <p className="text-caption text-gray3 text-center mt-1">如设置未来生效日，生效前继续使用当前版本，不会中断库存扣减。</p>
            <div className="grid grid-cols-2 gap-2 mt-5">
              <button onClick={() => setPublishedResult(null)} className="py-3 border border-border rounded-cta text-button">继续查看</button>
              <button onClick={() => { location.href = '/v2/chef-director/dishes' }} className="py-3 bg-ink text-white rounded-cta text-button">返回菜品列表</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
