'use client'
import sheet from './document-sheet.module.css'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch, getUser } from '@/lib/v2-auth'
import {inventoryRuleOwner as ruleOwner} from '@/lib/inventory-rule-scope'
import { confirmDialog } from '@/lib/ui-dialogs'
import { ConfirmSheet, useConfirmSheet } from './confirm-sheet'
import { ManagementTabs } from './management-tabs'
import { SUPPLY_CHAIN_BEFORE_NAVIGATE_EVENT } from './supply-chain-shell'
import { managementPages, managementHref } from '@/lib/inventory-management'
import filters from './scm-filter-bar.module.css'
import styles from './inventory-rules.module.css'

type Warehouse = { id: string; code: string; name: string; isDefault: boolean }
type Revision = { id:string; status:'DRAFT'|'PENDING'|'AUDITED'|'REVIEWED'; rowVersion:number; cycleNumber?:number; payload:{inventoryUnitSnapshot?:string;minQty:number|null;maxQty:number|null;active:boolean;stagnantDays:number} }
type RuleRow = {
  revision?: Revision | null
  effectiveMin?:number|null; effectiveMax?:number|null; effectiveUnit?:string; storedUnit?:string; draftUnit?:string
  productId: string; code: string; name: string; spec?: string | null; category?: string | null
  inventoryUnit: string; currentQty: number; minQty: number | null; maxQty: number | null
  stagnantDays: number; source: 'configured' | 'legacy-fallback' | 'unconfigured' | 'unit-pending' | 'disabled'
  alertStatus: string; active: boolean; rowVersion: number; unitChanged: boolean; hasPolicy: boolean
}
type Result = { organizationName?:string; warehouse: Warehouse; warehouses: Warehouse[]; items: RuleRow[]; total: number; page: number; pageSize: number }
type ApprovalAction = 'submit'|'audit'|'unconfirm'|'review'|'revise'
type ApprovalAttempt = {row:RuleRow;action:ApprovalAction;endpoint:string;body:string;key:string;scope:string;epoch:number}
type Draft = { inventoryUnitSnapshot?:string; minQty: string; maxQty: string; stagnantDays: string; active: boolean }

const sourceLabel: Record<RuleRow['source'], string> = {
  configured: '已配置', 'legacy-fallback': '旧安全库存兼容 · 待迁移', unconfigured: '未配置', 'unit-pending': '单位待确认', disabled: '已停用',
}
const requestId = () => globalThis.crypto?.randomUUID?.() || `inventory-rule-${Date.now()}-${Math.random().toString(36).slice(2)}`
const draftOf = (row:RuleRow):Draft => { const value=row.revision?.payload || row; return {inventoryUnitSnapshot:row.revision?.payload.inventoryUnitSnapshot || row.storedUnit || row.draftUnit || row.inventoryUnit,minQty:value.minQty==null?'':String(value.minQty),maxQty:value.maxQty==null?'':String(value.maxQty),stagnantDays:'30',active:value.active} }
const editUnit=(row:RuleRow)=>row.revision?.payload.inventoryUnitSnapshot || row.draftUnit || row.storedUnit || row.inventoryUnit
const effectiveMin=(row:RuleRow)=>row.effectiveMin===undefined?row.minQty:row.effectiveMin
const effectiveMax=(row:RuleRow)=>row.effectiveMax===undefined?row.maxQty:row.effectiveMax
const approvalLabel={DRAFT:'草稿',PENDING:'待审核',AUDITED:'已审核 · 待复审',REVIEWED:'已复审 · 已生效'}

export function InventoryRules({editor}:{editor?:{productId:string;warehouseId:string}}={}) {
  const router = useRouter()
  const fixedOwner=useRef(ruleOwner()),liveScope=useRef(true)
  const [ownerExpired,setOwnerExpired]=useState(false)
  const [viewVerified,setViewVerified]=useState(false),viewVerifiedRef=useRef(false)
  const activeView=useRef<{warehouseId:string;products:Set<string>}|null>(null)
  const ownsScope=()=>liveScope.current&&fixedOwner.current===ruleOwner()
  const [unknownApproval,setUnknownApproval]=useState<ApprovalAttempt|null>(null),unknownApprovalRef=useRef<ApprovalAttempt|null>(null)
  const verificationTarget=useRef<{productId:string;warehouseId:string}|null>(null)
  const canManage=viewVerified&&!unknownApproval&&!ownerExpired&&ownsScope()&&['SUPPLY_CHAIN','ADMIN','SUPER_ADMIN'].includes(getUser()?.role || '')
  useEffect(()=>{liveScope.current=true;const changed=()=>{if(!ownsScope())setOwnerExpired(true)};window.addEventListener('storage',changed);return()=>{liveScope.current=false;window.removeEventListener('storage',changed)}},[])
  const [result, setResult] = useState<Result | null>(null)
  const [historyPage,setHistoryPage]=useState(1),[history,setHistory]=useState<{items:Array<{id:string;action:string;actorName:string;actorRole:string;createdAt:string;sourceType?:string;effectiveEvent?:unknown;revision:{cycleNumber:number}|null}>;total:number}|null>(null),[historyError,setHistoryError]=useState(''),[historyLoading,setHistoryLoading]=useState(false)
  const historySequence=useRef(0)

  const [warehouseId, setWarehouseId] = useState(editor?.warehouseId||'')
  const scopeKey=`${editor?.productId||'list'}:${editor?.warehouseId||warehouseId}`
  const scopeRef=useRef({key:scopeKey,epoch:0})
  if(scopeRef.current.key!==scopeKey)scopeRef.current={key:scopeKey,epoch:scopeRef.current.epoch+1}
  const attemptOwned=(attempt:ApprovalAttempt)=>ownsScope()&&scopeRef.current.key===attempt.scope&&scopeRef.current.epoch===attempt.epoch
  useEffect(()=>{unknownApprovalRef.current=null;setUnknownApproval(null);verificationTarget.current=null;busyRef.current=false;setSaving(null)},[scopeKey])
  const [query, setQuery] = useState('')
  const [appliedQuery, setAppliedQuery] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [dirtyIds, setDirtyIds] = useState<Set<string>>(() => new Set())
  const [saving, setSaving] = useState<string | null>(null)
  const busyRef=useRef(false)
  const loadSequence=useRef(0)
  const [conflictedIds,setConflictedIds]=useState<Set<string>>(()=>new Set())
  const [unverifiedConflictIds,setUnverifiedConflictIds]=useState<Set<string>>(()=>new Set())
  const requests=useRef(new Map<string,{fingerprint:string;id:string}>())
  function stableRequest(key:string,payload:unknown){const fingerprint=JSON.stringify(payload),old=requests.current.get(key);if(old?.fingerprint===fingerprint)return old.id;const id=requestId();requests.current.set(key,{fingerprint,id});return id}
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [leaveConfirm, openLeaveConfirm] = useConfirmSheet()
  const draftRowLabels=useRef(new Map<string,{name:string;unit:string}>())
  const draftsRef = useRef(drafts)
  const dirtyRef = useRef(dirtyIds)
  useEffect(() => { draftsRef.current = drafts }, [drafts])
  useEffect(() => { dirtyRef.current = dirtyIds }, [dirtyIds])
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current.size && !busyRef.current && !unknownApprovalRef.current) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [])
  useEffect(() => {
    const guard = (event: Event) => {
      if (!dirtyRef.current.size && !busyRef.current && !unknownApprovalRef.current) return
      event.preventDefault()
      if(busyRef.current){setError('保存或审批进行中，请等待结果后再离开');return}
      const proceed = (event as CustomEvent<{ proceed?: () => void }>).detail?.proceed
      openLeaveConfirm({
        title: unknownApprovalRef.current?'审批结果未确认，仍要离开？':'放弃未保存的库存规则？',
        body: `${unknownApprovalRef.current?'原审批结果尚未确认，离开不会撤销后台操作；返回后须重新读取真实状态。':''}当前有 ${dirtyRef.current.size} 条规则尚未保存，离开后将不会保留。`,
        confirmLabel: '放弃并离开',
        tone: 'danger',
        onConfirm: () => {
          unknownApprovalRef.current=null;setUnknownApproval(null)
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
    if(!ownsScope()){setOwnerExpired(true);return false}
    const sequence=++loadSequence.current
    viewVerifiedRef.current=false;setViewVerified(false)
    setLoading(true); setError('')
    const params = new URLSearchParams({ q: appliedQuery, page: String(page), pageSize: String(pageSize) })
    if (warehouseId) params.set('warehouseId', warehouseId)
    try {
      const data = await apiFetch<Result>(editor?`/api/inventory-reports/policies/${encodeURIComponent(editor.productId)}?warehouseId=${encodeURIComponent(editor.warehouseId)}`:`/api/inventory-reports/policies?${params}`)
      if(sequence!==loadSequence.current)return false
      if(!ownsScope()){if(liveScope.current)setOwnerExpired(true);return false}
      if((warehouseId&&data.warehouse.id!==warehouseId)||(editor&&(data.warehouse.id!==editor.warehouseId||data.items.length!==1||data.items[0].productId!==editor.productId)))throw Error('规则来源与当前商品或仓库不一致，原输入保留')
      const returned=new Set(data.items.map(row=>row.productId))
      const target=verificationTarget.current
      if(target&&(data.warehouse.id!==target.warehouseId||!returned.has(target.productId)))throw Error('本次审批商品尚未返回，不能确认最新规则状态')
      verificationTarget.current=null
      activeView.current={warehouseId:data.warehouse.id,products:returned}
      const missingDirty=[...dirtyRef.current].filter(id=>id!==options?.refreshProductId&&!returned.has(id))
      data.items.forEach(row=>draftRowLabels.current.set(row.productId,{name:row.name,unit:editUnit(row)}))
      setResult(data)
      viewVerifiedRef.current=true;setViewVerified(true)
      setUnverifiedConflictIds(current=>new Set([...current].filter(id=>!returned.has(id)).concat(missingDirty)))
      if(missingDirty.length)setConflictedIds(current=>new Set([...current,...missingDirty]))
      setWarehouseId(data.warehouse.id)
      const next=Object.fromEntries(data.items.map(row => {
        const preserve = dirtyRef.current.has(row.productId) && row.productId !== options?.refreshProductId
        return [row.productId, preserve ? draftsRef.current[row.productId] : draftOf(row)]
      }))
      missingDirty.forEach(id=>{if(draftsRef.current[id])next[id]=draftsRef.current[id]})
      setDrafts(next)
      setDirtyIds(current => new Set([...current].filter(id=>id!==options?.refreshProductId)))
      return true
    } catch (reason:any) {
      if(sequence!==loadSequence.current||!ownsScope())return false
      setError(`${reason?.message || '库存规则加载失败'}；已保留当前输入。`)
      return false
    } finally {if(sequence===loadSequence.current)setLoading(false)}

  }, [appliedQuery, page, pageSize, warehouseId,editor?.productId,editor?.warehouseId])

  useEffect(() => { void load();return()=>{loadSequence.current++} }, [load])

  useEffect(()=>{
    if(!editor)return
    const current=++historySequence.current,actor=getUser()?.id
    setHistoryLoading(true);setHistoryError('')
    void apiFetch<any>(`/api/inventory-reports/policies/${encodeURIComponent(editor.productId)}/history?warehouseId=${encodeURIComponent(editor.warehouseId)}&page=${historyPage}&pageSize=20`).then(data=>{if(current===historySequence.current&&actor===getUser()?.id&&ownsScope())setHistory(data)}).catch(reason=>{if(current===historySequence.current&&actor===getUser()?.id&&ownsScope())setHistoryError(reason.message||'操作记录读取失败')}).finally(()=>{if(current===historySequence.current)setHistoryLoading(false)})
    return()=>{historySequence.current++}
  },[editor?.productId,editor?.warehouseId,historyPage,result?.items[0]?.revision?.rowVersion])

  function change(productId: string, patch: Partial<Draft>) {
    const next={...draftsRef.current,[productId]:{...draftsRef.current[productId],...patch}}
    draftsRef.current=next;setDrafts(next)
    const dirty=new Set(dirtyRef.current).add(productId);dirtyRef.current=dirty;setDirtyIds(dirty)
  }

  async function confirmLeave() {
    if(busyRef.current){setError('保存或审批进行中，请等待结果后再切换页面');return false}
    if(unknownApprovalRef.current)return await confirmDialog('原审批结果尚未确认，离开不会撤销后台操作。返回后须重新读取真实状态；未保存输入不会保留。是否继续离开？')
    return !dirtyRef.current.size || await confirmDialog(`当前有 ${dirtyRef.current.size} 条规则尚未保存，继续会丢失这些修改。是否继续？`)
  }

  async function leaveDirty(action: () => void, navigation=false) {
    if(unknownApprovalRef.current&&!navigation){setError('审批结果尚未确认，请先核对原审批后再切换筛选或分页');return}
    if (!(await confirmLeave()) || busyRef.current) return
    unknownApprovalRef.current=null;setUnknownApproval(null)
    dirtyRef.current=new Set();setDirtyIds(new Set());setConflictedIds(new Set());setUnverifiedConflictIds(new Set())
    action()
  }

  async function save(row: RuleRow, resolving=false) {
    if(!ownsScope()){setOwnerExpired(true);return}
    if(!canManage||!viewVerifiedRef.current||busyRef.current||unknownApprovalRef.current)return
    if(unverifiedConflictIds.has(row.productId)){setError('服务器版本尚未核对，请先重新加载；本页输入保留');return}
    if(conflictedIds.has(row.productId)&&!resolving){setError('请先选择如何处理本行冲突，本页输入仍保留');return}
    const draft = drafts[row.productId]
    const minQty = draft.minQty.trim() === '' ? null : Number(draft.minQty)
    const maxQty = draft.maxQty.trim() === '' ? null : Number(draft.maxQty)
    const stagnantDays = 30
    if (minQty != null && (!Number.isFinite(minQty) || minQty < 0) || maxQty != null && (!Number.isFinite(maxQty) || maxQty < 0)) {
      setError(`${row.name}：库存上下限必须是大于等于0的数字`); return
    }
    if (minQty != null && maxQty != null && minQty > maxQty) { setError(`${row.name}：库存上限不能低于库存下限`); return }
    const targetUnit=row.draftUnit || row.inventoryUnit
    if(draft.inventoryUnitSnapshot && draft.inventoryUnitSnapshot!==targetUnit){setError(`「${row.name}」旧拟值单位为${draft.inventoryUnitSnapshot}，当前商品单位为${targetUnit}，请先重新核对单位并填写上下限`);return}
    let confirmUnitChange = false
    if (row.unitChanged) {
      confirmUnitChange = await confirmDialog(`「${row.name}」的库存与规则单位需要核对，当前拟规则单位为 ${draft.inventoryUnitSnapshot || targetUnit}。\n请确认已用新单位重新核对上下限，继续保存？`)
      if (!confirmUnitChange) return
    }
    if (row.source === 'legacy-fallback' && !(await confirmDialog(`「${row.name}」当前使用旧安全库存兼容值。复审通过后将迁移为该仓库的独立库存规则，是否继续？`))) return
    if (row.active && !draft.active && !(await confirmDialog(`停用「${row.name}」后，该仓库商品将按“阈值未配置”处理，且不会恢复旧安全库存。是否确认停用？`))) return
    if(!ownsScope()){setOwnerExpired(true);return}
    if(!viewVerifiedRef.current||!activeView.current||activeView.current.warehouseId!==result?.warehouse.id||!activeView.current.products.has(row.productId)){setError('规则来源或版本尚未重新读取，请先加载后继续');return}
    busyRef.current=true; setSaving(row.productId); setError(''); setNotice('')
    try {
      const body={warehouseId:result?.warehouse.id,minQty,maxQty,stagnantDays,active:draft.active,rowVersion:row.rowVersion,draftVersion:row.revision?.rowVersion ?? 0,revisionId:row.revision?.id,confirmUnitChange,inventoryUnitSnapshot:draft.inventoryUnitSnapshot || targetUnit}
      const saved=await apiFetch<{revision:Revision}>(`/api/inventory-reports/policies/${row.productId}`,{method:'PATCH',body:JSON.stringify({...body,requestId:stableRequest(`${row.productId}:save`,body)})})
      if(!ownsScope()){if(liveScope.current)setOwnerExpired(true);return}
      requests.current.delete(`${row.productId}:save`)
      setConflictedIds(current=>{const next=new Set(current);next.delete(row.productId);return next})
      setResult(current=>current?{...current,items:current.items.map(item=>item.productId===row.productId?{...item,revision:saved.revision}:item)}:current)
      setDirtyIds(current=>{const next=new Set(current);next.delete(row.productId);return next})
      setNotice(`「${row.name}」草稿已保存；提交、审核不会生效，复审通过后才生效。`)
    } catch (reason: any) {
      if(!ownsScope()){if(liveScope.current)setOwnerExpired(true);return}
      const message = reason?.message || '库存规则保存失败'
      if (reason.status===409 || message.includes('刷新')) {
        setConflictedIds(current=>new Set(current).add(row.productId))
        setUnverifiedConflictIds(current=>new Set(current).add(row.productId))
        const refreshed=await load({preserveDirty:true})
        if(!refreshed){setError(`${message}；尚未核对服务器版本，本页输入保留，请重新加载后再保存。`);return}
        setError(`${message}；服务器版本已核对，本行及其他未保存修改已保留，请选择冲突处理方式。`)
      } else setError(message)
    } finally { busyRef.current=false; setSaving(null) }
  }

  async function transition(row:RuleRow,action:ApprovalAction,retry?:ApprovalAttempt){
    if(!ownsScope()){setOwnerExpired(true);return}
    if(busyRef.current)return
    if(retry){
      if(unknownApprovalRef.current!==retry||!attemptOwned(retry)||!['SUPPLY_CHAIN','ADMIN','SUPER_ADMIN'].includes(getUser()?.role||''))return
    }else{
      if(unknownApprovalRef.current||!canManage||!viewVerifiedRef.current)return
      if(conflictedIds.has(row.productId)||unverifiedConflictIds.has(row.productId)){setError('请先处理本行冲突，再继续审批');return}
      if(!row.revision)return
      if(dirtyRef.current.has(row.productId)){setError('请先保存本行修改，再处理审批');return}
    }
    const names={submit:'提交',audit:'审核',unconfirm:'反审核',review:'复审',revise:'开始新修订'}
    const effect=action==='review'?'复审通过后新上下限才生效。':action==='revise'?'保留当前已生效规则，新草稿须复审后才替换它。':'本操作只改变审批进度，当前生效规则保持不变。'
    const scope={...scopeRef.current}
    if(!(await confirmDialog(`${retry?'核对原审批：':''}${names[action]}「${row.name}」？${effect}`)))return
    if(!ownsScope()||scope.key!==scopeRef.current.key||scope.epoch!==scopeRef.current.epoch)return
    if(busyRef.current)return
    if(retry){if(unknownApprovalRef.current!==retry||!attemptOwned(retry))return}
    else if(unknownApprovalRef.current||dirtyRef.current.has(row.productId)||!viewVerifiedRef.current||!activeView.current||activeView.current.warehouseId!==result?.warehouse.id||!activeView.current.products.has(row.productId)){setError('规则输入、来源或版本已变化，请先核对后继续');return}
    const payload={warehouseId:result!.warehouse.id,rowVersion:row.revision!.rowVersion,revisionId:row.revision!.id}
    const key=`${row.productId}:${action}`
    const attempt=retry||{row,action,key,scope:scope.key,epoch:scope.epoch,endpoint:`/api/inventory-reports/policies/${row.productId}/${action}`,body:JSON.stringify({...payload,requestId:stableRequest(key,payload)})}
    busyRef.current=true;setSaving(row.productId);setError('');setNotice('')
    try{
      await apiFetch(attempt.endpoint,{method:'POST',body:attempt.body})
      if(!attemptOwned(attempt))return
      unknownApprovalRef.current=null;setUnknownApproval(null)
      requests.current.delete(attempt.key)
      verificationTarget.current={productId:row.productId,warehouseId:JSON.parse(attempt.body).warehouseId}
      if(!(await load({preserveDirty:true,refreshProductId:row.productId}))){if(attemptOwned(attempt))setError('审批已成功，但最新规则读取失败；请重新加载后继续');return}
      if(!attemptOwned(attempt))return
      setNotice(`「${row.name}」已${names[action]}。${effect}`)
    }catch(reason:any){
      if(!attemptOwned(attempt))return
      const status=Number(reason?.status),message=reason?.message||'审批失败'
      if(status===409){
        unknownApprovalRef.current=null;setUnknownApproval(null)
        verificationTarget.current={productId:row.productId,warehouseId:JSON.parse(attempt.body).warehouseId}
        viewVerifiedRef.current=false;setViewVerified(false)
        setError(`${message}；最新规则尚未核对，请重新加载，本页输入保留。`)
      }else if([400,401,403,404,405,422,429].includes(status)){
        unknownApprovalRef.current=null;setUnknownApproval(null);setError(message)
      }else{
        unknownApprovalRef.current=attempt;setUnknownApproval(attempt)
        setError(`${message}；审批结果尚未确认，请核对原审批；新保存及其他审批暂不可操作，本页输入保留。`)
      }
    }finally{if(attemptOwned(attempt)){busyRef.current=false;setSaving(null)}}
  }
  const rows = result?.items || []
  const editorRow=editor?rows.find(row=>row.productId===editor.productId):undefined
  const ruleEditorHref=(row:RuleRow)=>`/v2/supply-chain/inventory-management/limits/${encodeURIComponent(row.productId)}/edit?warehouseId=${encodeURIComponent(result!.warehouse.id)}`
  const missingDirtyIds=[...dirtyIds].filter(id=>!rows.some(row=>row.productId===id)&&drafts[id])
  return <div className={editor ? `${styles.page} ${sheet.page}` : styles.page} style={editor?{paddingBottom:100,background:"white"}:undefined}>
    <header className={styles.breadcrumb}><span>货品与仓库 <span>/</span> <strong>库存管理</strong></span><span>库存基准单位规则</span></header>
    <div className={filters.mobileMenu}><details><summary>库存管理菜单</summary><nav aria-label="库存管理功能菜单">{managementPages.filter(item => item.group === 'inventory').map(item => <Link key={item.id} href={managementHref(item)} aria-current={item.id === 'limits' ? 'page' : undefined} onClick={event => { if (item.id !== 'limits' && (dirtyRef.current.size || busyRef.current || unknownApprovalRef.current)) { event.preventDefault(); void leaveDirty(() => router.push(managementHref(item)),true) } }}>{item.title}</Link>)}</nav></details></div>
    <ManagementTabs activeId="limits" beforeNavigate={confirmLeave} />
    <main className={editor ? sheet.ruleContent : styles.content}>
      <div className={editor ? sheet.header : styles.heading}><div><p>库存管理</p><h1>{editor?(editorRow?.revision?'编辑库存规则':'新增库存规则'):'库存上下限与呆滞规则'}</h1><small>保存草稿 → 提交 → 审核 → 复审生效；复审后本轮流程结束。只提醒，不自动移库。</small></div><div className={styles.links}><Link href="/v2/supply-chain/reports?report=alerts" onClick={event => { if (dirtyRef.current.size || busyRef.current || unknownApprovalRef.current) { event.preventDefault(); void leaveDirty(() => router.push('/v2/supply-chain/reports?report=alerts'),true) } }}>查看库存预警 ↗</Link><Link href="/v2/supply-chain/reports?report=stagnant" onClick={event => { if (dirtyRef.current.size || busyRef.current || unknownApprovalRef.current) { event.preventDefault(); void leaveDirty(() => router.push('/v2/supply-chain/reports?report=stagnant'),true) } }}>查看呆滞品 ↗</Link></div></div>
      {!editor&&<form className={styles.toolbar} onSubmit={event => { event.preventDefault(); void leaveDirty(() => { setAppliedQuery(query.trim()); setPage(1) }) }}>
        <label><span>仓库</span><select aria-label="仓库" value={warehouseId} onChange={event => { const value = event.target.value; void leaveDirty(() => { setWarehouseId(value); setPage(1) }) }} disabled={loading || saving!==null || !!unknownApproval}>{result?.warehouses.map(item => <option key={item.id} value={item.id}>{item.name}{item.isDefault ? '（默认）' : ''}</option>)}</select></label>
        <label><span>商品</span><input disabled={!!unknownApproval} value={query} onChange={event => setQuery(event.target.value)} placeholder="名称 / 编码 / 类别" /></label>
        <button disabled={!!unknownApproval} className={styles.primary}>查询</button><button disabled={!!unknownApproval} type="button" onClick={() => void leaveDirty(() => { setQuery(''); setAppliedQuery(''); setPage(1) })}>重置</button>
      </form>}
      {!editor&&canManage&&<Link href={`/v2/supply-chain/inventory-management/limits/new${warehouseId?`?warehouseId=${encodeURIComponent(warehouseId)}`:''}`}>新增库存规则</Link>}
      {editor&&<div className={sheet.meta}><div>机构：{result?.organizationName||'—'}</div><div title={result?.warehouse.name}>仓库：{result?.warehouse.name||'正在读取'}</div><div title={editorRow?.name}>商品：{editorRow?.name||'正在读取'}</div><div>审批：{editorRow?.revision ? approvalLabel[editorRow.revision.status] : '未保存'}</div></div>}
      {ownerExpired&&<p role="alert">账号或租户已变化，本页输入保留；请重新打开规则页面，不能用新账号保存原页面。</p>}
      {error && <div className={styles.error} role="alert">{error}<button onClick={() => void load({preserveDirty:true})}>重新加载</button></div>}
      {unknownApproval&&<p role="status">审批结果尚未确认：{unknownApproval.row.name}<button type="button" disabled={saving!==null||ownerExpired||!attemptOwned(unknownApproval)} onClick={()=>void transition(unknownApproval.row,unknownApproval.action,unknownApproval)}>核对原审批</button></p>}
      {notice && <div className={styles.notice} role="status">{notice}</div>}
      {missingDirtyIds.length>0&&<section className={styles.error} aria-label="未返回的规则草稿"><p>以下未保存规则本次未返回，原输入仍保留，尚不能保存；请重新加载核对。</p><ul>{missingDirtyIds.map(id=><li key={id}>{draftRowLabels.current.get(id)?.name||'原商品'}：{drafts[id].minQty||'不设'}／{drafts[id].maxQty||'不设'}（{drafts[id].inventoryUnitSnapshot||draftRowLabels.current.get(id)?.unit}），{drafts[id].active?'拟启用':'拟停用'}</li>)}</ul><button disabled={loading||saving!==null} onClick={()=>void load({preserveDirty:true})}>重新读取未返回草稿</button></section>}
      <p className={styles.help}><strong>停用说明：</strong>停用后该仓库商品按“阈值未配置”处理，不会恢复使用旧安全库存。所有商品呆滞提醒统一30天，与上下限启停无关。</p>
      <section className={editor ? `${styles.tableCard} ${sheet.ruleCard}` : styles.tableCard} aria-busy={loading}>
        <div className={editor ? `${sheet.tableWrap} ${sheet.ruleTable}` : styles.scroll}><table><thead><tr><th>商品</th><th>当前库存</th><th>库存下限</th><th>库存上限</th><th>呆滞天数</th><th>启用</th><th>状态</th><th>操作</th></tr></thead><tbody>
          {loading ? <tr><td colSpan={8} className={styles.empty}>正在加载库存规则…</td></tr> : rows.length === 0 ? <tr><td colSpan={8} className={styles.empty}>没有符合条件的商品。</td></tr> : rows.map(row => {
            const draft = drafts[row.productId] || draftOf(row)
            return <tr key={row.productId}>
              <td data-label="商品"><b>{row.name}</b><small>{row.code} · {row.spec || '无规格'} · {row.category || '未分类'}</small>{row.unitChanged && <em>库存与规则单位需核对，保存前需二次确认</em>}{draft.inventoryUnitSnapshot && draft.inventoryUnitSnapshot!==(row.draftUnit || row.inventoryUnit) && <button type="button" disabled={!canManage || saving!==null || ['AUDITED','REVIEWED'].includes(row.revision?.status || '')} onClick={async()=>{if(await confirmDialog(`旧拟值单位${draft.inventoryUnitSnapshot}已变为${row.draftUnit || row.inventoryUnit}。将清空拟上下限，请按新单位重新填写；当前有效规则保持不变。是否继续？`))change(row.productId,{inventoryUnitSnapshot:row.draftUnit || row.inventoryUnit,minQty:'',maxQty:''})}}>重新核对单位</button>}</td>
              <td data-label="当前库存"><b>{row.currentQty.toLocaleString('zh-CN', { maximumFractionDigits: 6 })}</b><small>{row.inventoryUnit}</small></td>
              <td data-label="库存下限"><small>拟值单位：{draft.inventoryUnitSnapshot || editUnit(row)}</small><input aria-label={`${row.name}库存下限`} type="number" min="0" step="0.000001" disabled={!canManage || saving!==null || ['AUDITED','REVIEWED'].includes(row.revision?.status || '')} value={draft.minQty} onChange={event => change(row.productId, { minQty: event.target.value })} placeholder="不设下限" /></td>
              <td data-label="库存上限"><small>拟值单位：{draft.inventoryUnitSnapshot || editUnit(row)}</small><input aria-label={`${row.name}库存上限`} type="number" min="0" step="0.000001" disabled={!canManage || saving!==null || ['AUDITED','REVIEWED'].includes(row.revision?.status || '')} value={draft.maxQty} onChange={event => change(row.productId, { maxQty: event.target.value })} placeholder="不设上限" /></td>
              <td data-label="呆滞天数"><span>统一30天</span></td>
              <td data-label="启用"><label className={styles.switch}><input aria-label={`${row.name}启用库存规则`} type="checkbox" disabled={!canManage || saving!==null || ['AUDITED','REVIEWED'].includes(row.revision?.status || '')} checked={draft.active} onChange={event => change(row.productId, { active: event.target.checked })} /><span>{row.revision ? draft.active ? '拟启用' : '拟停用' : row.source === 'legacy-fallback' ? '兼容生效' : draft.active ? '已启用' : '已停用'}</span></label></td>
              <td data-label="状态"><b>{row.alertStatus}</b><small>{sourceLabel[row.source]} · 当前生效下限 {effectiveMin(row) ?? '不设'}／上限 {effectiveMax(row) ?? '不设'}（{row.effectiveUnit || row.inventoryUnit}）</small><small>{row.revision ? approvalLabel[row.revision.status] : '尚无审批草稿'}{row.revision?.cycleNumber ? ` · 第${row.revision.cycleNumber}轮` : ''}</small></td>
              <td data-label="操作">
                {!editor&&<div className={styles.rowEditActions}><Link href={ruleEditorHref(row)} onClick={event=>{if(dirtyRef.current.size||busyRef.current||unknownApprovalRef.current){event.preventDefault();void leaveDirty(()=>router.push(ruleEditorHref(row)),true)}}}>{canManage?'编辑':'查看'}</Link>
                <button type="button" className={styles.primary} title={['AUDITED','REVIEWED'].includes(row.revision?.status || '')?'待复审可反审核；已复审请开始新修订':undefined} disabled={!canManage || saving!==null || !dirtyIds.has(row.productId) || conflictedIds.has(row.productId) || ['AUDITED','REVIEWED'].includes(row.revision?.status || '')} onClick={()=>void save(row)}>{saving===row.productId?'保存中…':dirtyIds.has(row.productId)&&row.source==='legacy-fallback'?'迁移并保存':'保存'}</button>
                <button type="button" disabled={!canManage||saving!==null||!dirtyIds.has(row.productId)} onClick={async()=>{const scope=scopeRef.current,sequence=loadSequence.current;if(!await confirmDialog(`取消「${row.name}」本行未保存的修改？其他行保持不变。`))return;if(!ownsScope()||scopeRef.current!==scope||loadSequence.current!==sequence||busyRef.current||unknownApprovalRef.current)return;const next={...draftsRef.current,[row.productId]:draftOf(row)};draftsRef.current=next;setDrafts(next);const dirty=new Set(dirtyRef.current);dirty.delete(row.productId);dirtyRef.current=dirty;setDirtyIds(dirty)}}>取消</button></div>}
                {!editor&&row.revision?.status==='DRAFT' && <button type="button" disabled={!canManage || saving!==null || dirtyIds.has(row.productId)} onClick={()=>void transition(row,'submit')}>提交</button>}
                {!editor&&row.revision?.status==='PENDING' && <button type="button" disabled={!canManage || saving!==null || dirtyIds.has(row.productId)} onClick={()=>void transition(row,'audit')}>审核</button>}
                {row.revision?.status==='AUDITED' && <><button type="button" disabled={!canManage || saving!==null} onClick={()=>void transition(row,'unconfirm')}>反审核</button><button type="button" disabled={!canManage || saving!==null} onClick={()=>void transition(row,'review')}>复审</button></>}
                {row.revision?.status==='REVIEWED' && <button type="button" disabled={!canManage || saving!==null} onClick={()=>void transition(row,'revise')}>开始新修订</button>}
                {conflictedIds.has(row.productId) && <div role="alert">{unverifiedConflictIds.has(row.productId)?<small>服务器版本尚未核对，本页输入保留；请重新加载。</small>:<><small>服务器拟值：{(row.revision?row.revision.payload.minQty:row.minQty) ?? '不设'}／{(row.revision?row.revision.payload.maxQty:row.maxQty) ?? '不设'}；单位：{draftOf(row).inventoryUnitSnapshot}；{draftOf(row).active?'启用':'停用'}；本页输入保留</small><button type="button" disabled={saving!==null} onClick={async()=>{if(!(await confirmDialog('加载本行服务器值将放弃本行未保存输入，其他行保留。是否继续？')))return;const next={...draftsRef.current,[row.productId]:draftOf(row)};draftsRef.current=next;setDrafts(next);const dirty=new Set(dirtyRef.current);dirty.delete(row.productId);dirtyRef.current=dirty;setDirtyIds(dirty);setConflictedIds(current=>{const n=new Set(current);n.delete(row.productId);return n})}}>加载本行服务器值</button><button type="button" disabled={!canManage || saving!==null || ['AUDITED','REVIEWED'].includes(row.revision?.status || '')} onClick={async()=>{if(await confirmDialog('是否基于已核对的最新服务器版本，用本页输入重新保存草稿？'))await save(row,true)}}>用本页输入重新保存</button></>}</div>}
              </td>
            </tr>
          })}
        </tbody></table></div>
        {editor&&<details aria-label="规则操作记录" className={sheet.records}><summary>操作记录</summary>{historyLoading&&<p role="status">正在读取操作记录…</p>}{historyError&&<p role="alert">{historyError}</p>}<ul>{history?.items.map(event=><li key={event.id}>{new Date(event.createdAt).toLocaleString('zh-CN',{hour12:false})} · {event.revision?`第${event.revision.cycleNumber}轮`:'生效规则记录（未关联审批轮次）'} · {({save:'保存',submit:'提交',audit:'审核',unconfirm:'反审核',review:'复审',unreview:'取消复审（历史）',revise:'开始新修订',policy_update:'生效规则变更'} as Record<string,string>)[event.action]||event.action} · {event.actorName} {event.effectiveEvent?' · 已关联本次生效记录':''}（{({SUPPLY_CHAIN:'供应链',ADMIN:'管理员',SUPER_ADMIN:'超级管理员',FINANCE:'财务'} as Record<string,string>)[event.actorRole]||event.actorRole}）</li>)}</ul>{!historyLoading&&!historyError&&!history?.items.length&&<p>暂无记录</p>}<button disabled={historyLoading||historyPage<=1} onClick={()=>setHistoryPage(historyPage-1)}>上一页记录</button><button disabled={historyLoading||historyPage*20>=(history?.total||0)} onClick={()=>setHistoryPage(historyPage+1)}>下一页记录</button></details>}
        {editor&&<footer aria-label="库存规则编辑操作" className={sheet.footer}>
          <button disabled={saving!==null} onClick={()=>void leaveDirty(()=>router.push('/v2/supply-chain/inventory-management/limits'),true)}>取消</button>
          <button disabled={!editorRow||!canManage||loading||saving!==null||!dirtyIds.has(editorRow.productId)||conflictedIds.has(editorRow.productId)||['AUDITED','REVIEWED'].includes(editorRow.revision?.status||'')} onClick={()=>editorRow&&void save(editorRow)}>保存</button>
          <button disabled={!editorRow||!canManage||loading||saving!==null||dirtyIds.has(editorRow.productId)||conflictedIds.has(editorRow.productId)||editorRow.revision?.status!=='DRAFT'} onClick={()=>editorRow&&void transition(editorRow,'submit')}>提交</button>
          <button disabled={!editorRow||!canManage||loading||saving!==null||dirtyIds.has(editorRow.productId)||conflictedIds.has(editorRow.productId)||editorRow.revision?.status!=='PENDING'} onClick={()=>editorRow&&void transition(editorRow,'audit')}>审核</button>
        </footer>}
        {!editor&&<footer className={styles.pagination}><span>共 {result?.total ?? 0} 项{dirtyIds.size ? ` · ${dirtyIds.size} 条未保存` : ''}</span><div><select aria-label="每页条数" disabled={loading || saving!==null || !!unknownApproval} value={pageSize} onChange={event => { const value = Number(event.target.value); void leaveDirty(() => { setPageSize(value); setPage(1) }) }}><option value="20">20条</option><option value="50">50条</option><option value="100">100条</option></select><button disabled={loading || saving!==null || !!unknownApproval || page <= 1} onClick={() => void leaveDirty(() => setPage(value => value - 1))}>上一页</button><span>{page} / {Math.max(1, Math.ceil((result?.total || 0) / pageSize))}</span><button disabled={loading || saving!==null || !!unknownApproval || page * pageSize >= (result?.total || 0)} onClick={() => void leaveDirty(() => setPage(value => value + 1))}>下一页</button></div></footer>}
      </section>
    </main>
    <ConfirmSheet {...leaveConfirm} />
  </div>
}
