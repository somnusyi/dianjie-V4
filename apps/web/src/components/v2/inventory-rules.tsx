'use client'

import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch } from '@/lib/v2-auth'
import { ConfirmSheet, useConfirmSheet } from './confirm-sheet'
import { ManagementTabs } from './management-tabs'
import { SUPPLY_CHAIN_BEFORE_NAVIGATE_EVENT } from './supply-chain-shell'
import { managementPages, managementHref } from '@/lib/inventory-management'
import filters from './scm-filter-bar.module.css'
import styles from './inventory-rules.module.css'

type Warehouse = { id: string; code: string; name: string; isDefault: boolean }
type RuleRow = {
  productId: string; code: string; name: string; spec?: string | null; category?: string | null
  inventoryUnit: string; currentQty: number; minQty: number | null; maxQty: number | null
  stagnantDays: number; source: 'configured' | 'legacy-fallback' | 'unconfigured' | 'unit-pending' | 'disabled'
  alertStatus: string; active: boolean; rowVersion: number; unitChanged: boolean; hasPolicy: boolean
}
type Result = { warehouse: Warehouse; warehouses: Warehouse[]; items: RuleRow[]; total: number; page: number; pageSize: number }
type Draft = { minQty: string; maxQty: string; stagnantDays: string; active: boolean }

const sourceLabel: Record<RuleRow['source'], string> = {
  configured: '已配置', 'legacy-fallback': '旧安全库存兼容 · 待迁移', unconfigured: '未配置', 'unit-pending': '单位待确认', disabled: '已停用',
}
const requestId = () => globalThis.crypto?.randomUUID?.() || `inventory-rule-${Date.now()}-${Math.random().toString(36).slice(2)}`
const draftOf = (row: RuleRow): Draft => ({ minQty: row.minQty == null ? '' : String(row.minQty), maxQty: row.maxQty == null ? '' : String(row.maxQty), stagnantDays: String(row.stagnantDays || 30), active: row.active })
const alertStatus = (quantity: number, minQty: number | null, maxQty: number | null, active: boolean) => {
  if (quantity <= 0) return '缺货'
  if (!active || minQty == null && maxQty == null) return '阈值未配置'
  if (minQty != null && quantity < minQty) return '低于下限'
  if (maxQty != null && quantity > maxQty) return '高于上限'
  return '正常'
}

export function InventoryRules() {
  const [result, setResult] = useState<Result | null>(null)
  const [warehouseId, setWarehouseId] = useState('')
  const [query, setQuery] = useState('')
  const [appliedQuery, setAppliedQuery] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [dirtyIds, setDirtyIds] = useState<Set<string>>(() => new Set())
  const [saving, setSaving] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [leaveConfirm, openLeaveConfirm] = useConfirmSheet()
  const draftsRef = useRef(drafts)
  const dirtyRef = useRef(dirtyIds)
  useEffect(() => { draftsRef.current = drafts }, [drafts])
  useEffect(() => { dirtyRef.current = dirtyIds }, [dirtyIds])
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current.size) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [])
  useEffect(() => {
    const guard = (event: Event) => {
      if (!dirtyRef.current.size) return
      event.preventDefault()
      const proceed = (event as CustomEvent<{ proceed?: () => void }>).detail?.proceed
      openLeaveConfirm({
        title: '放弃未保存的库存规则？',
        body: `当前有 ${dirtyRef.current.size} 条规则尚未保存，离开后将不会保留。`,
        confirmLabel: '放弃并离开',
        tone: 'danger',
        onConfirm: () => {
          dirtyRef.current = new Set()
          setDirtyIds(new Set())
          proceed?.()
        },
      })
    }
    window.addEventListener(SUPPLY_CHAIN_BEFORE_NAVIGATE_EVENT, guard)
    return () => window.removeEventListener(SUPPLY_CHAIN_BEFORE_NAVIGATE_EVENT, guard)
  }, [openLeaveConfirm])

  const load = useCallback(async (options?: { preserveDirty?: boolean; refreshProductId?: string }) => {
    setLoading(true); setError('')
    const params = new URLSearchParams({ q: appliedQuery, page: String(page), pageSize: String(pageSize) })
    if (warehouseId) params.set('warehouseId', warehouseId)
    try {
      const data = await apiFetch<Result>(`/api/inventory-reports/policies?${params}`)
      setResult(data)
      setWarehouseId(data.warehouse.id)
      setDrafts(Object.fromEntries(data.items.map(row => {
        const preserve = options?.preserveDirty && dirtyRef.current.has(row.productId) && row.productId !== options.refreshProductId
        return [row.productId, preserve ? draftsRef.current[row.productId] : draftOf(row)]
      })))
      setDirtyIds(current => options?.preserveDirty
        ? new Set([...current].filter(id => id !== options.refreshProductId && data.items.some(row => row.productId === id)))
        : new Set())
    } catch (reason: any) {
      setError(reason?.message || '库存规则加载失败')
      setResult(null)
    } finally { setLoading(false) }
  }, [appliedQuery, page, pageSize, warehouseId])

  useEffect(() => { void load() }, [load])

  function change(productId: string, patch: Partial<Draft>) {
    setDrafts(current => ({ ...current, [productId]: { ...current[productId], ...patch } }))
    setDirtyIds(current => new Set(current).add(productId))
  }

  function confirmLeave() {
    return !dirtyRef.current.size || window.confirm(`当前有 ${dirtyRef.current.size} 条规则尚未保存，继续会丢失这些修改。是否继续？`)
  }

  function leaveDirty(action: () => void) {
    if (!confirmLeave()) return
    setDirtyIds(new Set())
    action()
  }

  async function save(row: RuleRow) {
    const draft = drafts[row.productId]
    const minQty = draft.minQty.trim() === '' ? null : Number(draft.minQty)
    const maxQty = draft.maxQty.trim() === '' ? null : Number(draft.maxQty)
    const stagnantDays = Number(draft.stagnantDays)
    if (minQty != null && (!Number.isFinite(minQty) || minQty < 0) || maxQty != null && (!Number.isFinite(maxQty) || maxQty < 0)) {
      setError(`${row.name}：库存上下限必须是大于等于0的数字`); return
    }
    if (minQty != null && maxQty != null && minQty > maxQty) { setError(`${row.name}：库存上限不能低于库存下限`); return }
    if (!Number.isInteger(stagnantDays) || stagnantDays < 1 || stagnantDays > 36500) { setError(`${row.name}：呆滞天数必须是1–36500的整数`); return }
    let confirmUnitChange = false
    if (row.unitChanged) {
      confirmUnitChange = window.confirm(`「${row.name}」的库存基准单位已变为 ${row.inventoryUnit}。\n请确认已用新单位重新核对上下限，继续保存？`)
      if (!confirmUnitChange) return
    }
    if (row.source === 'legacy-fallback' && !window.confirm(`「${row.name}」当前使用旧安全库存兼容值。保存后将迁移为该仓库的独立库存规则，是否继续？`)) return
    if (row.active && !draft.active && !window.confirm(`停用「${row.name}」后，该仓库商品将按“阈值未配置”处理，且不会恢复旧安全库存。是否确认停用？`)) return
    setSaving(row.productId); setError(''); setNotice('')
    try {
      const saved = await apiFetch<{ policy: { minQty: number | null; maxQty: number | null; stagnantDays: number; active: boolean; rowVersion: number }; replayed: boolean }>(`/api/inventory-reports/policies/${row.productId}`, { method: 'PATCH', body: JSON.stringify({
        warehouseId: result?.warehouse.id, minQty, maxQty, stagnantDays, active: draft.active,
        rowVersion: row.rowVersion, requestId: requestId(), confirmUnitChange,
      }) })
      setResult(current => current ? { ...current, items: current.items.map(item => item.productId === row.productId ? {
        ...item, minQty: saved.policy.minQty, maxQty: saved.policy.maxQty, stagnantDays: saved.policy.stagnantDays,
        active: saved.policy.active, rowVersion: saved.policy.rowVersion, hasPolicy: true, unitChanged: false,
        source: saved.policy.active ? 'configured' : 'disabled',
        alertStatus: alertStatus(item.currentQty, saved.policy.minQty, saved.policy.maxQty, saved.policy.active),
      } : item) } : current)
      setDrafts(current => ({ ...current, [row.productId]: {
        minQty: saved.policy.minQty == null ? '' : String(saved.policy.minQty),
        maxQty: saved.policy.maxQty == null ? '' : String(saved.policy.maxQty),
        stagnantDays: String(saved.policy.stagnantDays), active: saved.policy.active,
      } }))
      setDirtyIds(current => { const next = new Set(current); next.delete(row.productId); return next })
      setNotice(`「${row.name}」规则已保存，库存预警和呆滞查询已同步生效。`)
    } catch (reason: any) {
      const message = reason?.message || '库存规则保存失败'
      if (message.includes('刷新')) {
        await load({ preserveDirty: true, refreshProductId: row.productId })
        setError(`${message}；已为你刷新该商品的最新规则，其他未保存修改已保留。`)
      } else setError(message)
    } finally { setSaving(null) }
  }

  const rows = result?.items || []
  return <div className={styles.page}>
    <header className={styles.breadcrumb}><span>货品与仓库 <span>/</span> <strong>库存管理</strong></span><span>库存基准单位规则</span></header>
    <div className={filters.mobileMenu}><details><summary>库存管理菜单</summary><nav aria-label="库存管理功能菜单">{managementPages.filter(item => item.group === 'inventory').map(item => <Link key={item.id} href={managementHref(item)} aria-current={item.id === 'limits' ? 'page' : undefined} onClick={event => { if (item.id !== 'limits' && !confirmLeave()) event.preventDefault() }}>{item.title}</Link>)}</nav></details></div>
    <ManagementTabs activeId="limits" beforeNavigate={confirmLeave} />
    <main className={styles.content}>
      <div className={styles.heading}><div><p>库存管理</p><h1>库存上下限与呆滞规则</h1><small>数量统一使用库存基准单位；配置只提醒，不自动移库。</small></div><div className={styles.links}><Link href="/v2/supply-chain/reports?report=alerts" onClick={event => { if (!confirmLeave()) event.preventDefault() }}>查看库存预警 ↗</Link><Link href="/v2/supply-chain/reports?report=stagnant" onClick={event => { if (!confirmLeave()) event.preventDefault() }}>查看呆滞品 ↗</Link></div></div>
      <form className={styles.toolbar} onSubmit={event => { event.preventDefault(); leaveDirty(() => { setAppliedQuery(query.trim()); setPage(1) }) }}>
        <label><span>仓库</span><select aria-label="仓库" value={warehouseId} onChange={event => { const value = event.target.value; leaveDirty(() => { setWarehouseId(value); setPage(1) }) }} disabled={loading}>{result?.warehouses.map(item => <option key={item.id} value={item.id}>{item.name}{item.isDefault ? '（默认）' : ''}</option>)}</select></label>
        <label><span>商品</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="名称 / 编码 / 类别" /></label>
        <button className={styles.primary}>查询</button><button type="button" onClick={() => leaveDirty(() => { setQuery(''); setAppliedQuery(''); setPage(1) })}>重置</button>
      </form>
      {error && <div className={styles.error} role="alert">{error}<button onClick={() => void load()}>重新加载</button></div>}
      {notice && <div className={styles.notice} role="status">{notice}</div>}
      <p className={styles.help}><strong>停用说明：</strong>停用后该仓库商品按“阈值未配置”处理，不会恢复使用旧安全库存。呆滞规则未启用时默认30天。</p>
      <section className={styles.tableCard} aria-busy={loading}>
        <div className={styles.scroll}><table><thead><tr><th>商品</th><th>当前库存</th><th>库存下限</th><th>库存上限</th><th>呆滞天数</th><th>启用</th><th>状态</th><th>操作</th></tr></thead><tbody>
          {loading ? <tr><td colSpan={8} className={styles.empty}>正在加载库存规则…</td></tr> : rows.length === 0 ? <tr><td colSpan={8} className={styles.empty}>没有符合条件的商品。</td></tr> : rows.map(row => {
            const draft = drafts[row.productId] || draftOf(row)
            return <tr key={row.productId}>
              <td data-label="商品"><b>{row.name}</b><small>{row.code} · {row.spec || '无规格'} · {row.category || '未分类'}</small>{row.unitChanged && <em>库存单位已变更，保存前需二次确认</em>}</td>
              <td data-label="当前库存"><b>{row.currentQty.toLocaleString('zh-CN', { maximumFractionDigits: 6 })}</b><small>{row.inventoryUnit}</small></td>
              <td data-label="库存下限"><input aria-label={`${row.name}库存下限`} type="number" min="0" step="0.000001" value={draft.minQty} onChange={event => change(row.productId, { minQty: event.target.value })} placeholder="不设下限" /></td>
              <td data-label="库存上限"><input aria-label={`${row.name}库存上限`} type="number" min="0" step="0.000001" value={draft.maxQty} onChange={event => change(row.productId, { maxQty: event.target.value })} placeholder="不设上限" /></td>
              <td data-label="呆滞天数"><input aria-label={`${row.name}呆滞天数`} type="number" min="1" max="36500" step="1" value={draft.stagnantDays} onChange={event => change(row.productId, { stagnantDays: event.target.value })} /></td>
              <td data-label="启用"><label className={styles.switch}><input aria-label={`${row.name}启用库存规则`} type="checkbox" checked={draft.active} onChange={event => change(row.productId, { active: event.target.checked })} /><span>{row.source === 'legacy-fallback' ? '兼容生效' : draft.active ? '已启用' : '已停用'}</span></label></td>
              <td data-label="状态"><b>{row.alertStatus}</b><small>{sourceLabel[row.source]}</small></td>
              <td data-label="操作"><button type="button" className={styles.primary} disabled={saving === row.productId || !dirtyIds.has(row.productId)} onClick={() => void save(row)}>{saving === row.productId ? '保存中…' : dirtyIds.has(row.productId) ? row.source === 'legacy-fallback' ? '迁移并保存' : '保存' : '已保存'}</button></td>
            </tr>
          })}
        </tbody></table></div>
        <footer className={styles.pagination}><span>共 {result?.total ?? 0} 项{dirtyIds.size ? ` · ${dirtyIds.size} 条未保存` : ''}</span><div><select aria-label="每页条数" value={pageSize} onChange={event => { const value = Number(event.target.value); leaveDirty(() => { setPageSize(value); setPage(1) }) }}><option value="20">20条</option><option value="50">50条</option><option value="100">100条</option></select><button disabled={loading || page <= 1} onClick={() => leaveDirty(() => setPage(value => value - 1))}>上一页</button><span>{page} / {Math.max(1, Math.ceil((result?.total || 0) / pageSize))}</span><button disabled={loading || page * pageSize >= (result?.total || 0)} onClick={() => leaveDirty(() => setPage(value => value + 1))}>下一页</button></div></footer>
      </section>
    </main>
    <ConfirmSheet {...leaveConfirm} />
  </div>
}
