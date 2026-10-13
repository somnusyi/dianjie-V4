'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import sheet from '@/components/v2/document-sheet.module.css'
import { useEffect, useRef, useState } from 'react'
import { apiFetch, getUser } from '@/lib/v2-auth'
import { ConfirmSheet, useConfirmSheet } from '@/components/v2/confirm-sheet'
import { SUPPLY_CHAIN_BEFORE_NAVIGATE_EVENT } from '@/components/v2/supply-chain-shell'

type Option = { id: string; name: string; code?: string }
type Product = Option & { code: string; spec?: string | null; category?: string | null; inventoryUnit: string | null; unit: string; unitConversionStatus?: string }
type Item = {
  id: string; unitPending?: boolean; productNameSnapshot: string; productCodeSnapshot: string; productSpecSnapshot: string | null
  inventoryUnit: string; bookQuantity: string; averageUnitCost: string; countedQuantity: string | null
  countedUnitCost: string | null; differenceQuantity: string | null; differenceValue: string | null; reason: string | null
}
type Section = { id: string; name: string; assignedToId: string; status: 'OPEN' | 'SUBMITTED'; rowVersion: number; submittedAt: string | null; items: Item[] }
type Count = {
  id: string; no: string; status: string; rowVersion: number; warehouse: Option; sections: Section[]
  adjustments: Array<{ id: string; no: string; type: 'PROFIT' | 'LOSS'; totalAmount: string }>
  countedCount: number; itemCount: number; totalDifferenceValue: string
}
type PendingCreate = { body: { requestKey: string; warehouseId: string; countDate: string; countScope?: 'ALL' | 'SELECTED'; sections: DraftSection[] }; countScope: 'ALL' | 'SELECTED' }

function pendingStorageKey() {
  const tenant = JSON.parse(localStorage.getItem('tenant') || 'null')
  const user = getUser()
  if (!tenant?.id || !user?.id) throw new Error('缺少当前账号或租户信息，请重新登录')
  return `dj:stocktake-create:${tenant.id}:${user.id}`
}

type DraftSection = { name: string; assignedToId: string; productIds: string[] }

// The route accepts at most ten integer and six fractional digits. Compare at
// this exact precision so a small difference at large quantities is not lost.
function quantityMicros(value: string, input = false): bigint | null {
  const match = value.match(input ? /^(\d{1,10})(?:\.(\d{1,6}))?$/ : /^(\d{1,12})(?:\.(\d{1,6}))?$/)
  return match ? BigInt(match[1]) * BigInt(1000000) + BigInt((match[2] || '').padEnd(6, '0')) : null
}

const labels: Record<string, string> = { DRAFT: '草稿', COUNTING: '盘点中', REVIEWING: '待审核', CONFIRMED: '已审核', CANCELLED: '已取消' }
const field = 'w-full rounded-lg border border-border bg-white p-2'

export default function WarehouseStocktakeWorkPage() {
  const router = useRouter()
  const user = getUser()
  const canWrite = ['SUPPLY_CHAIN', 'SUPER_ADMIN', 'ADMIN', 'PURCHASER'].includes(user?.role || '')
  const canAudit = ['SUPPLY_CHAIN', 'SUPER_ADMIN', 'ADMIN'].includes(user?.role || '')
  const canReadInventoryReports = ['SUPPLY_CHAIN', 'SUPER_ADMIN', 'ADMIN', 'FINANCE'].includes(user?.role || '')
  const [options, setOptions] = useState<{ warehouses: Option[]; users: Option[]; products: Product[] }>({ warehouses: [], users: [], products: [] })
  const [rows, setRows] = useState<Array<{ id: string; no: string; status: string; warehouse: Option }>>([])
  const [count, setCount] = useState<Count | null>(null)
  const [creating, setCreating] = useState(false)
  const [returnPage,setReturnPage]=useState<'count'|'multi-count'>('count')
  const [warehouseId, setWarehouseId] = useState('')
  const [date, setDate] = useState(new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }))
  const [countScope, setCountScope] = useState<'ALL' | 'SELECTED'>('ALL')
  const [sections, setSections] = useState<DraftSection[]>([])
  const [entries, setEntries] = useState<Record<string, { countedQuantity: string; countedUnitCost: string; reason: string }>>({})
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const submitting = useRef(false)
  const pendingCreate = useRef<PendingCreate | null>(null)
  const [resultUnknown, setResultUnknown] = useState(false)
  const [confirm, openConfirm] = useConfirmSheet()
  const [optionsLoading, setOptionsLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const loadSequence = useRef(0)
  const baselineEntries = useRef('')
  const hasUnsavedEntries = baselineEntries.current !== '' && JSON.stringify(entries) !== baselineEntries.current

  function protectChange(proceed: () => void) {
    if (busy || resultUnknown) { setError('操作结果尚未确认，请等待或重试原请求后再离开'); return }
    if (!creating && !hasUnsavedEntries) { proceed(); return }
    openConfirm({ title: '放弃未保存的盘点填写？', body: '尚未保存的分区分配或实盘录入将丢失。已保存到服务器的草稿保留。', confirmLabel: '放弃并继续', tone: 'danger', onConfirm: proceed })
  }

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!creating && !hasUnsavedEntries && !busy && !resultUnknown) return
      event.preventDefault(); event.returnValue = ''
    }
    const navigate = (event: Event) => {
      if (!creating && !hasUnsavedEntries && !busy && !resultUnknown) return
      event.preventDefault()
      const proceed = (event as CustomEvent<{ proceed?: () => void }>).detail?.proceed
      protectChange(() => proceed?.())
    }
    window.addEventListener('beforeunload', warn)
    window.addEventListener(SUPPLY_CHAIN_BEFORE_NAVIGATE_EVENT, navigate)
    return () => { window.removeEventListener('beforeunload', warn); window.removeEventListener(SUPPLY_CHAIN_BEFORE_NAVIGATE_EVENT, navigate) }
  }, [creating, hasUnsavedEntries, busy, resultUnknown, openConfirm])

  async function load(id?: string, savedSectionId?: string) {
    const sequence = ++loadSequence.current
    setDetailLoading(true)
    try {
    const list = await apiFetch<{ rows: typeof rows }>('/api/warehouse-stocktakes?page=1&pageSize=200')
    if (sequence !== loadSequence.current) return
    setRows(list.rows)
    if (!id) return
    const detail = await apiFetch<Count>(`/api/warehouse-stocktakes/${id}`)
    if (sequence !== loadSequence.current) return
    setCount(detail)
    const nextEntries = Object.fromEntries(detail.sections.flatMap(section => section.items.map(item => [item.id, {
      countedQuantity: item.countedQuantity ?? '',
      countedUnitCost: item.unitPending ? '' : item.countedUnitCost ?? item.averageUnitCost,
      reason: item.reason || '',
    }])))
    const previousBaseline = JSON.parse(baselineEntries.current || '{}') as typeof entries
    baselineEntries.current = JSON.stringify(nextEntries)
    setEntries(current => savedSectionId ? Object.fromEntries(detail.sections.flatMap(section => section.items.map(item => [item.id, section.id !== savedSectionId && current[item.id] && JSON.stringify(current[item.id]) !== JSON.stringify(previousBaseline[item.id]) ? current[item.id] : nextEntries[item.id]]))) : nextEntries)
    } finally { if (sequence === loadSequence.current) setDetailLoading(false) }
  }

  useEffect(() => {
    let recovering=false
    try {
      const raw = sessionStorage.getItem(pendingStorageKey())
      if (raw) {
        recovering=true
        const saved: PendingCreate = JSON.parse(raw)
        if (typeof saved.body?.requestKey !== 'string' || !saved.body.requestKey || typeof saved.body.warehouseId !== 'string' || !saved.body.warehouseId || typeof saved.body.countDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(saved.body.countDate) || !Array.isArray(saved.body.sections) || !saved.body.sections.length || saved.body.sections.some(section => !section || typeof section.name !== 'string' || typeof section.assignedToId !== 'string' || !Array.isArray(section.productIds) || !section.productIds.length || section.productIds.some(id => typeof id !== 'string' || !id)) || !['ALL', 'SELECTED'].includes(saved.countScope)) throw new Error('恢复记录不完整，请核实已创建盘点后处理')
        pendingCreate.current = saved
        setWarehouseId(saved.body.warehouseId); setDate(saved.body.countDate); setSections(saved.body.sections); setCountScope(saved.countScope)
        setCreating(true); setResultUnknown(true)
        setError('已恢复上次结果未确认的创建请求，请重试原请求核实结果')
      }
    } catch (reason: any) { setCreating(true); setResultUnknown(true); setError(reason.message || '恢复记录读取失败，请核实创建结果') }
    const incoming=new URLSearchParams(window.location.search)
    setReturnPage(incoming.get('from')==='multi-count'?'multi-count':'count')
    if(incoming.get('create')==='1'&&!incoming.get('doc')&&!recovering)setCreating(true)
    apiFetch<typeof options>('/api/warehouse-stocktakes/options').then(result => {
      setOptions(result)
      if (recovering) return
      const requested=incoming.get('warehouseId')
      const valid=requested&&result.warehouses.some(warehouse=>warehouse.id===requested)
      if(requested&&!valid)setError('所选仓库已停用或不可用，请重新选择')
      setWarehouseId(requested?(valid?requested:''):result.warehouses[0]?.id || '')
      setSections([{ name: '分区 1', assignedToId: user?.id || result.users[0]?.id || '', productIds: [] }])
    }).catch(reason => setError(reason.message)).finally(() => setOptionsLoading(false))
    void load(recovering?undefined:incoming.get('doc') || undefined).catch(reason => setError(reason.message))
  }, [])

  async function run(task: () => Promise<unknown>, message: string, id = count?.id, savedSectionId?: string) {
    if (busy) return false
    setBusy(true); setError(''); setNotice('')
    let writeConfirmed = false
    try { await task(); writeConfirmed = true; await load(id, savedSectionId); setNotice(message); return true }
    catch (reason: any) { setError(writeConfirmed ? `${message}，但最新状态读取失败，请重新打开单据核对；当前填写已保留。${reason.message || ''}` : reason.message || '操作失败'); return false }
    finally { setBusy(false) }
  }

  async function createDraft() {
    if (submitting.current) return
    submitting.current = true
    setBusy(true); setError(''); setNotice('')
    const wasUnknown = resultUnknown
    let confirmed = false
    try {
      if (resultUnknown && !pendingCreate.current) throw new Error('创建恢复记录不可用，请先核实盘点结果，不能创建新请求')
      if (!pendingCreate.current) {
        const effectiveSections = countScope === 'ALL' && sections.length === 1 && sections[0].productIds.length === 0
          ? [{ ...sections[0], productIds: options.products.map(product => product.id) }]
          : sections
        if (countScope === 'ALL' && (new Set(effectiveSections.flatMap(section => section.productIds)).size !== options.products.length || options.products.some(product => !effectiveSections.some(section => section.productIds.includes(product.id))))) throw new Error('全部盘点必须将全部商品分配到分区，不能遗漏')
        if (effectiveSections.some(section => section.productIds.length === 0)) throw new Error('每个分区至少分配一个商品；不用的分区请移除')
        if (effectiveSections.every(section => section.productIds.length === 0)) throw new Error('至少选择一个盘点商品')
        const saved: PendingCreate = { countScope, body: { requestKey: crypto.randomUUID(), warehouseId, countDate: date, countScope, sections: effectiveSections } }
        sessionStorage.setItem(pendingStorageKey(), JSON.stringify(saved))
        pendingCreate.current = saved
      }
      sessionStorage.setItem(pendingStorageKey(), JSON.stringify(pendingCreate.current))
      const result = await apiFetch<{ stocktake: Count }>('/api/warehouse-stocktakes', {
        method: 'POST', body: JSON.stringify(pendingCreate.current.body),
      })
      confirmed = true
      sessionStorage.removeItem(pendingStorageKey())
      pendingCreate.current = null
      setResultUnknown(false); setCreating(false)
      await load(result.stocktake.id)
      setNotice('盘点已创建，请各负责人录入')
    } catch (reason: any) {
      if (confirmed) {
        setError('盘点已创建，但列表加载失败，请刷新页面查看，勿重复创建')
      } else if (pendingCreate.current) {
        if (!wasUnknown && reason.status >= 400 && reason.status < 500) {
          sessionStorage.removeItem(pendingStorageKey()); pendingCreate.current = null; setResultUnknown(false)
          setError(reason.message || '创建请求被拒绝，请修正后再试')
        } else {
          setResultUnknown(true)
          setError(`${reason.message || '请求失败'}；创建结果未确认，请重试原请求`)
        }
      } else setError(reason.message || '创建盘点失败')
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }

  async function saveSection(section: Section, submit: boolean) {
    const clearedRecordedItem = section.items.find(item => !item.unitPending && item.countedQuantity !== null && entries[item.id]?.countedQuantity === '')
    if (clearedRecordedItem) {
      setError(`「${clearedRecordedItem.productNameSnapshot}」已有保存的实盘数量，不能清空后保存。请填写实际数量；实盘为零请明确填写0。当前输入已保留，未发送保存或提交。`)
      return
    }
    if (submit && section.items.some(item => item.unitPending)) {
      setError('分区存在待核验换算，请先补齐并刷新换算后提交')
      return
    }
    const invalidQuantity = section.items.find(item => !item.unitPending && entries[item.id]?.countedQuantity !== '' && quantityMicros(entries[item.id]?.countedQuantity || '', true) === null)
    if (invalidQuantity) { setError(`「${invalidQuantity.productNameSnapshot}」实盘数量格式不正确，请填写非负数，最多10位整数及6位小数`); return }
    if (submit) {
      const missingReason = section.items.find(item => !item.unitPending && entries[item.id]?.countedQuantity !== '' && quantityMicros(entries[item.id]?.countedQuantity || '', true) !== quantityMicros(item.bookQuantity) && !entries[item.id]?.reason.trim())
      if (missingReason) { setError(`「${missingReason.productNameSnapshot}」存在差异，请填写盘盈/盘亏原因后再提交分区`); return }
    }
    const items = section.items.filter(item => !item.unitPending && entries[item.id]?.countedQuantity !== '').map(item => ({ itemId: item.id, ...entries[item.id] }))
    if (!items.length) { setError('请先录入实盘数量，待核验商品需先补齐换算'); return }
    await run(() => apiFetch(`/api/warehouse-stocktakes/${count!.id}/sections/${section.id}`, { method: 'PUT', body: JSON.stringify({ rowVersion: section.rowVersion, submit, items }) }), `${section.name}${submit ? '已提交' : '已保存'}`, count!.id, section.id)
  }

  function confirmTransition(action: 'submit' | 'approve' | 'reject' | 'cancel') {
    if (!count) return
    if (hasUnsavedEntries && action !== 'cancel') { setError('请先保存各分区未保存的实盘录入，再执行单据操作'); return }
    const title = { submit: '汇总提交审核', approve: '审核并生成盘盈盘亏', reject: '退回继续录入', cancel: '取消盘点单' }[action]
    openConfirm({
      title,
      body: action === 'approve' ? '将按差额调整总仓库存并生成盘盈/盘亏单。已审核不支持反审核。' : '请确认已核对单据和各分区进度。',
      tone: action === 'cancel' ? 'danger' : 'primary',
      withInput: ['reject', 'cancel'].includes(action),
      inputRequired: ['reject', 'cancel'].includes(action),
      inputPlaceholder: action === 'reject' ? '请填写退回原因' : action === 'cancel' ? '请填写取消原因' : undefined,
      onConfirm: async inputReason => {
        const reason = inputReason?.trim() || ''
        if (['reject', 'cancel'].includes(action) && (!reason || reason.length < 2)) throw new Error('请填写至少2个字的原因')
        const body = action === 'submit' ? { rowVersion: count.rowVersion } : action === 'cancel' ? { reason, rowVersion: count.rowVersion } : action === 'reject' ? { reason } : undefined
        if (!await run(() => apiFetch(`/api/warehouse-stocktakes/${count.id}/${action}`, { method: 'POST', ...(body ? { body: JSON.stringify(body) } : {}) }), `${title}成功`)) throw new Error('操作未完成')
      },
    })
  }

  return <main className={`${sheet.page} ${sheet.workPage}`}>
    <header className={sheet.header}>{canReadInventoryReports && <Link href={`/v2/supply-chain/stocktake/${returnPage}`} onClick={event=>{if(event.defaultPrevented)return;event.preventDefault();protectChange(()=>router.push(`/v2/supply-chain/stocktake/${returnPage}`))}} className="text-caption underline">{returnPage==='multi-count'?'返回多人盘点查询':'返回盘点查询'}</Link>}<h1>总仓盘点作业</h1></header><p className="text-caption text-gray2">分区填写 → 分区提交 → 汇总提交 → 审核。审核会核对盘点时的库存快照；库存已变化时，需要取消旧单并重新盘点。</p>
    {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-red-700">{error}</p>}{count && error.includes('库存已变动') && <aside className="border border-amber-200 bg-amber-50 p-3"><strong>这张单的库存快照已过期</strong><p>只退回重填不会更新旧账面。请先退回录入，再取消旧单，最后在同一仓库新建盘点。旧单和操作记录会保留。</p></aside>}{notice && <p role="status" className="rounded-xl bg-green-50 p-3">{notice}</p>}
    {canWrite && <button className="w-fit rounded border border-border px-3 py-1.5" disabled={busy || resultUnknown || optionsLoading} onClick={() => { if (creating) protectChange(() => { setCreating(false); setSections([{ name: '分区 1', assignedToId: user?.id || options.users[0]?.id || '', productIds: [] }]); setQuery('') }); else protectChange(()=>{setWarehouseId(count?.warehouse.id || warehouseId);setCreating(true)}) }}>新建总仓盘点</button>}
    {creating && <section className="space-y-3 border border-border p-3"><h2 className="text-h2">创建盘点</h2><fieldset disabled={busy || resultUnknown} className="space-y-3"><div className="grid gap-3 sm:grid-cols-2"><label>仓库<select className={field} value={warehouseId} onChange={event => setWarehouseId(event.target.value)}><option value="">请选择仓库</option>{options.warehouses.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}</select></label><label>盘点日期<input className={field} type="date" value={date} onChange={event => setDate(event.target.value)} /></label></div>
      <fieldset className="rounded-lg border border-border p-3"><legend className="px-1 text-caption text-gray2">盘点范围</legend><div className="flex flex-wrap gap-4"><label className="flex items-center gap-2"><input type="radio" name="countScope" checked={countScope === 'ALL'} onChange={() => setCountScope('ALL')} />全部盘点</label><label className="flex items-center gap-2"><input type="radio" name="countScope" checked={countScope === 'SELECTED'} onChange={() => setCountScope('SELECTED')} />指定盘点</label></div><p className="mt-2 text-caption text-gray3">{countScope === 'ALL' ? `盘点该仓库当前全部 ${options.products.length} 个商品。多人盘点请逐分区分配全部商品；单人未勾选时自动分配全部。` : '按分类全选或逐个选择本次要盘点的商品。'}</p></fieldset>
      {<label className="block">筛选商品<input className={field} value={query} onChange={event => setQuery(event.target.value)} placeholder="商品名称 / 编码" /></label>}
      {sections.map((section, index) => <div key={index} className="rounded-lg border p-3"><div className="grid gap-2 sm:grid-cols-2"><label>分区名<input className={field} value={section.name} onChange={event => setSections(rows => rows.map((row, i) => i === index ? { ...row, name: event.target.value } : row))} /></label><label>负责人<select className={field} value={section.assignedToId} onChange={event => setSections(rows => rows.map((row, i) => i === index ? { ...row, assignedToId: event.target.value } : row))}>{options.users.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}</select></label></div>{<><p className="mt-2 text-caption">已分配 {section.productIds.length} 项；同一商品只能进入一个分区。</p><div className="mt-2 max-h-72 space-y-3 overflow-auto">{Array.from(new Set(options.products.map(product => product.category || '未分类'))).map(category => { const allCategoryProducts = options.products.filter(product => (product.category || '未分类') === category); const categoryProducts = allCategoryProducts.filter(product => `${product.code} ${product.name}`.toLowerCase().includes(query.toLowerCase())); if (!categoryProducts.length) return null; const availableIds = allCategoryProducts.filter(product => !sections.some((row, i) => i !== index && row.productIds.includes(product.id))).map(product => product.id); const allSelected = availableIds.length > 0 && availableIds.every(id => section.productIds.includes(id)); return <div key={category} className="rounded-lg bg-bg p-2"><label className="flex items-center gap-2 font-medium"><input type="checkbox" checked={allSelected} onChange={event => setSections(rows => rows.map((row, i) => i === index ? { ...row, productIds: event.target.checked ? Array.from(new Set([...row.productIds, ...availableIds])) : row.productIds.filter(id => !availableIds.includes(id)) } : row))} />全选分类：{category}（{allCategoryProducts.length}）</label><div className="mt-2 grid gap-2 sm:grid-cols-2">{categoryProducts.map(product => <label key={product.id} className="text-caption"><input type="checkbox" checked={section.productIds.includes(product.id)} disabled={sections.some((row, i) => i !== index && row.productIds.includes(product.id))} onChange={event => setSections(rows => rows.map((row, i) => i === index ? { ...row, productIds: event.target.checked ? [...row.productIds, product.id] : row.productIds.filter(id => id !== product.id) } : row))} /> {product.code} {product.name}{product.unitConversionStatus && product.unitConversionStatus !== 'VERIFIED' && <span className="ml-2 text-orange-fg">换算待核验，可保存草稿</span>}</label>)}</div></div> })}</div></>}{sections.length > 1 && <button className="mt-2 underline" onClick={() => setSections(rows => rows.filter((_, i) => i !== index))}>移除此分区</button>}</div>)}
      <div className="flex flex-wrap gap-3">{<button className="underline" onClick={() => setSections(rows => [...rows, { name: `分区 ${rows.length + 1}`, assignedToId: user?.id || options.users[0]?.id || '', productIds: [] }])}>添加分区 / 负责人</button>}</div></fieldset><button disabled={busy} className="rounded-lg bg-ink px-4 py-2 text-white" onClick={() => void createDraft()}>{resultUnknown ? '重试原创建请求' : '保存盘点草稿'}</button>
    </section>}
    <label className="block">选择盘点单<select className={field} value={count?.id || ''} disabled={busy || resultUnknown} onChange={event => { const id = event.target.value; protectChange(() => { setCreating(false); if (id) void load(id).catch(reason => setError(reason.message)); else { ++loadSequence.current; setCount(null); setEntries({}); baselineEntries.current = '' } }) }}><option value="">请选择</option>{rows.map(row => <option key={row.id} value={row.id}>{row.no} · {row.warehouse.name} · {labels[row.status]}</option>)}</select></label>
    {count && <section className="space-y-4">{count.sections.some(section => section.items.some(item => item.unitPending)) && <div className="rounded-xl border border-orange-200 bg-orange-50 p-4"><p>有商品换算待核验，分区草稿已保存；补齐并核验后才能录入和提交。</p><Link className="mr-4 underline" href="/v2/supply-chain/products" onClick={event=>{if(event.defaultPrevented)return;event.preventDefault();protectChange(()=>router.push('/v2/supply-chain/products'))}}>前往商品管理补齐换算</Link>{canWrite && ['DRAFT', 'COUNTING'].includes(count.status) && <button disabled={busy} className="underline" onClick={() => openConfirm({ title: '刷新已核验换算', body: '请先保存已录入的分区。刷新会重新加载服务器草稿，未保存的录入不会保留。', onConfirm: async () => { if (!await run(() => apiFetch(`/api/warehouse-stocktakes/${count.id}/refresh-units`, { method: 'POST', body: JSON.stringify({ rowVersion: count.rowVersion }) }), '换算已核验，盘点草稿已更新')) throw new Error('换算刷新未完成') } })}>补齐后刷新换算</button>}</div>}<div className={sheet.meta}><h2 className="text-body font-semibold">{count.no} · {labels[count.status]}</h2><p>{count.warehouse.name} · 已盘 {count.countedCount}/{count.itemCount} 项 · 汇总差异金额 ¥{Number(count.totalDifferenceValue).toFixed(2)}</p><Link className="text-caption underline" href={`/v2/supply-chain/stocktake/count/${count.id}?source=warehouse`} onClick={event=>{if(event.defaultPrevented)return;event.preventDefault();protectChange(()=>router.push(`/v2/supply-chain/stocktake/count/${count.id}?source=warehouse`))}}>查看差异 / 打印 / 保存 PDF</Link><div className={sheet.toolbar}>{canWrite && ['DRAFT', 'COUNTING'].includes(count.status) && <button disabled={busy} onClick={() => confirmTransition('submit')}>汇总提交审核</button>}{canAudit && count.status === 'REVIEWING' && <><button disabled={busy} onClick={() => confirmTransition('approve')}>审核并生成盘盈盘亏</button><button disabled={busy} onClick={() => confirmTransition('reject')}>退回录入</button></>}{canWrite && ['DRAFT', 'COUNTING'].includes(count.status) && <button disabled={busy} onClick={() => confirmTransition('cancel')}>取消盘点</button>}</div></div>
      {count.sections.map(section => {
        const editable = canWrite && section.assignedToId === user?.id && ['DRAFT', 'COUNTING'].includes(count.status) && section.status === 'OPEN'
        return <section key={section.id} className={sheet.workSection} aria-label={`${section.name}盘点明细`}>
          <div className={sheet.toolbar}><h3 className="font-semibold">{section.name} · {options.users.find(option => option.id === section.assignedToId)?.name || '负责人'} · {section.status === 'SUBMITTED' ? '已提交' : '录入中'}</h3><span>共 {section.items.length} 项</span></div>
          <div className={sheet.tableWrap}><table aria-label={`${section.name}商品表格`}><thead><tr>{['序号','物品编码','物品名称','规格型号','单位','账面数量','实盘数量','成本单价','差异数量','差异金额','差异说明'].map(label=><th key={label}>{label}</th>)}</tr></thead><tbody>
            {section.items.map((item,index)=><tr key={item.id}>
              <td>{index+1}</td><td>{item.productCodeSnapshot}</td><td>{item.productNameSnapshot}{item.unitPending&&<small className="block text-orange-700">换算待核验，账面和成本待确认</small>}</td><td>{item.productSpecSnapshot||'—'}</td><td>{item.inventoryUnit}</td>
              <td>{item.unitPending?'待核验':item.bookQuantity}</td>
              <td><input aria-label={`${item.productNameSnapshot}实盘数量`} className={field} type="number" min="0" step="0.000001" disabled={!editable || busy || detailLoading || item.unitPending} value={entries[item.id]?.countedQuantity ?? ''} onChange={event => setEntries(rows => ({ ...rows, [item.id]: { ...rows[item.id], countedQuantity: event.target.value } }))} /></td>
              <td><input aria-label={`${item.productNameSnapshot}成本单价`} className={field} type="number" min="0" step="0.000001" disabled={!editable || busy || detailLoading || item.unitPending || Number(item.averageUnitCost) > 0} value={entries[item.id]?.countedUnitCost ?? ''} onChange={event => setEntries(rows => ({ ...rows, [item.id]: { ...rows[item.id], countedUnitCost: event.target.value } }))} /></td>
              <td>{item.unitPending?'待核验':item.differenceQuantity ?? '未盘'}</td><td>{item.unitPending?'待核验':item.differenceValue ?? '—'}</td>
              <td><input aria-label={`${item.productNameSnapshot}差异说明`} className={field} disabled={!editable || busy || detailLoading || item.unitPending} value={entries[item.id]?.reason ?? ''} onChange={event => setEntries(rows => ({ ...rows, [item.id]: { ...rows[item.id], reason: event.target.value } }))} /></td>
            </tr>)}
          </tbody></table></div>
          {editable && <div className={sheet.toolbar}><button disabled={busy || detailLoading} className="rounded border px-3 py-1.5" onClick={() => void saveSection(section, false)}>保存我的分区</button><button disabled={busy || detailLoading} className="rounded bg-ink px-3 py-1.5 text-white" onClick={() => void saveSection(section, true)}>提交我的分区</button></div>}
        </section>
      })}
      {count.adjustments.length > 0 && <div className="rounded-xl bg-green-50 p-4"><h3>已生成并过账</h3>{count.adjustments.map(row => <p key={row.id}>{canReadInventoryReports ? <Link className="underline" href={`/v2/supply-chain/stocktake/${row.type === 'PROFIT' ? 'profit' : 'loss'}`}>{row.no} · {row.type === 'PROFIT' ? '盘盈' : '盘亏'} ¥{Number(row.totalAmount).toFixed(2)}</Link> : <>{row.no} · {row.type === 'PROFIT' ? '盘盈' : '盘亏'} ¥{Number(row.totalAmount).toFixed(2)}</>}</p>)}</div>}
    </section>}
    <ConfirmSheet {...confirm} />
  </main>
}
