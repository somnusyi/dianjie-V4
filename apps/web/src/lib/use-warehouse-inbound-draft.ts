'use client'
import { useEffect, useRef, useState } from 'react'
import { apiFetch, getUser } from './v2-auth'
type Draft={id:string;version:number;payload:Record<string,any>;status:string;docId?:string;reconfirmationReceipt?:{requestId:string;resultVersion:number;requiresReload:boolean;currentStatus:string};attachmentUrls?:Record<string,string>}
function owner(){try{return `${JSON.parse(localStorage.getItem('tenant')||'{}').id||''}:${getUser()?.id||''}`}catch{return ''}}
export function useWarehouseInboundDraft(mode:'SINGLE'|'BATCH'|'OUTBOUND',open:boolean,payload:Record<string,any>,restore:(value:any)=>void){
 const [status,setStatus]=useState(''),[failure,setFailure]=useState(''),[submittedDocId,setSubmittedDocId]=useState('')
 const model=useRef<{id:string;version:number;saved:string;ready:boolean;closed:boolean}>({id:'',version:0,saved:'',ready:false,closed:false})
 const snapshot=useRef<any>(null),manualLoad=useRef(0),reloadingRef=useRef(false)
 const [reloading,setReloading]=useState(false),[terminalStatus,setTerminalStatus]=useState('')
 const reconfirmation=useRef<{draftId:string;body:{baseVersion:number;payload:Record<string,any>;reconfirmSnapshot:true;reconfirmRequestId:string};displaySnapshot?:any}|null>(null)
 const latest=useRef(payload);latest.current=payload
 const restoring=useRef(restore);restoring.current=restore
 const queue=useRef(Promise.resolve<any>(null)),generation=useRef(0),disposed=useRef(false)
 const ownerRef=useRef(owner()),cacheKey=`warehouse-inbound-pending:${ownerRef.current}:${mode}`
 const reconfirmCacheKey=`${cacheKey}:reconfirmation`
 function clearReconfirmation(attempt:NonNullable<typeof reconfirmation.current>){
   try{const cached=JSON.parse(localStorage.getItem(reconfirmCacheKey)||'null');if(cached?.body?.reconfirmRequestId===attempt.body.reconfirmRequestId)localStorage.removeItem(reconfirmCacheKey)}catch{}
   if(reconfirmation.current===attempt)reconfirmation.current=null
 }
 function show(s:string,e=''){if(!disposed.current){setStatus(s);setFailure(e)}}
 function backup(){if(!model.current.ready || model.current.closed)return;if(ownerRef.current && ownerRef.current!==':')try{localStorage.setItem(cacheKey,JSON.stringify({id:model.current.id,version:model.current.version,payload:latest.current}))}catch{}}
 async function flush(reconfirmSnapshot=false){
  backup()
  const current=model.current,scope=generation.current
  const originalData=JSON.parse(JSON.stringify(latest.current))
  const run=async()=>{
   if(reloadingRef.current)throw Error('草稿正在恢复，请等读取完成')
   if(model.current!==current||generation.current!==scope)throw Error('草稿已重新打开，旧保存请求已停止')
   if(owner()!==ownerRef.current)throw Error('账号已切换，请重新打开草稿')
   if(current.closed)throw Error('草稿已提交或丢弃，请重新打开')
   if(!current.ready)throw Error('草稿尚未加载成功，输入已保留，请重试读取')
   if(reconfirmation.current&&!reconfirmSnapshot)throw Error('原单位核对结果待确认，请先核对原请求')
   let attempt:NonNullable<typeof reconfirmation.current>|null=null
   let body:any={baseVersion:current.version,payload:originalData}
   if(reconfirmSnapshot){
     if(!reconfirmation.current)reconfirmation.current={draftId:current.id,body:{baseVersion:current.version,payload:JSON.parse(JSON.stringify(latest.current)),reconfirmSnapshot:true,reconfirmRequestId:crypto.randomUUID()},displaySnapshot:snapshot.current}
     attempt=reconfirmation.current
     if(attempt.draftId!==current.id)throw Error('原核对请求属于另一草稿，请先恢复原草稿')
     localStorage.setItem(reconfirmCacheKey,JSON.stringify(attempt));body=attempt.body
   }
   const json=JSON.stringify(body.payload)
   if(!reconfirmSnapshot&&current.saved===json)return {id:current.id,version:current.version}
   show(reconfirmSnapshot?'正在核对原仓库与单位请求':'正在同步草稿')
   try{
     const result=await apiFetch<{draft:Draft}>(`/api/warehouse-inventory/inbound-drafts/${encodeURIComponent(current.id)}`,{method:'PUT',body:JSON.stringify(body)})
     if(attempt)clearReconfirmation(attempt)
     if(model.current!==current||generation.current!==scope||current.closed||disposed.current||owner()!==ownerRef.current)return {id:current.id,version:current.version}
     if(result.draft.reconfirmationReceipt?.requiresReload){
       current.ready=false;current.closed=result.draft.status!=='EDITING'
       if(current.closed){setTerminalStatus(result.draft.status);try{localStorage.removeItem(cacheKey)}catch{};if(result.draft.docId)setSubmittedDocId(result.draft.docId)}
       if(result.draft.status==='DISCARDED'){show('原核对已成功，原草稿已丢弃','请关闭后从新建入口另开单，不能把已丢弃来源恢复为新草稿');return {id:current.id,version:result.draft.version,requiresReload:true}}
       if(result.draft.status==='SUBMITTED'){show('原核对已成功，请查看已提交原单');return {id:current.id,version:result.draft.version,requiresReload:true}}
       show('原核对已成功，草稿已有后续版本','原请求不会重写当前草稿，请加载服务器版本；本页输入保留')
       return {id:current.id,version:result.draft.version,requiresReload:true}
     }
     current.version=result.draft.version;current.saved=json;snapshot.current=result.draft.payload.executionSnapshot||null
     if(JSON.stringify(latest.current)===json){try{localStorage.removeItem(cacheKey)}catch{};show('草稿已同步 · 换设备可恢复')}else show('有未同步修改')
     return {id:current.id,version:current.version}
   }catch(reason:any){
     if(attempt&&[400,403,404,409,422].includes(reason.status))clearReconfirmation(attempt)
     throw reason
   }
  }
  const pending=queue.current.catch(()=>null).then(run);queue.current=pending
  try{return await pending}catch(e:any){if(model.current===current&&generation.current===scope&&owner()===ownerRef.current)show(reconfirmation.current?'原单位核对结果待确认':'草稿未同步',String(e?.message||e));throw e}
 }

 useEffect(()=>{
  disposed.current=false
  return()=>{backup();if(model.current.ready&&!model.current.closed)void flush().catch(()=>{});disposed.current=true;generation.current++}
 },[])
 useEffect(()=>{
  manualLoad.current++;reloadingRef.current=false;setReloading(false)
  if(!open){generation.current++;if(model.current.ready&&!model.current.closed)void flush().catch(()=>{});return}
  const seq=++generation.current;model.current.ready=false;setSubmittedDocId('');show('正在恢复草稿')
  setTerminalStatus('')
  let cachedConfirmation:any=null;try{cachedConfirmation=JSON.parse(localStorage.getItem(reconfirmCacheKey)||'null')}catch{cachedConfirmation={invalid:true}}
  if(cachedConfirmation){
    if(typeof cachedConfirmation.draftId!=='string'||!/^[A-Za-z0-9_-]{8,80}$/.test(cachedConfirmation.draftId)||cachedConfirmation.body?.reconfirmSnapshot!==true||!Number.isInteger(cachedConfirmation.body?.baseVersion)||cachedConfirmation.body.baseVersion<0||cachedConfirmation.body?.payload?.mode!==mode||typeof cachedConfirmation.body?.reconfirmRequestId!=='string'||cachedConfirmation.body.reconfirmRequestId.length<8||cachedConfirmation.body.reconfirmRequestId.length>100){
      show('原核对请求待核对','原请求缓存格式不正确，已保留；不创建替代草稿');return
    }
    reconfirmation.current=cachedConfirmation;snapshot.current=null
    model.current={id:cachedConfirmation.draftId,version:cachedConfirmation.body.baseVersion,saved:'',ready:true,closed:false}
    restoring.current({...cachedConfirmation.body.payload,executionSnapshot:cachedConfirmation.displaySnapshot})
    show('原单位核对结果待确认','已恢复原请求，请先核对原请求，不重新接受其他配置');return
  }
  apiFetch<{draft:Draft|null}>(`/api/warehouse-inventory/inbound-drafts?mode=${mode}`).then(async result=>{
   if(seq!==generation.current||disposed.current||owner()!==ownerRef.current)return
   const server=result.draft
   reconfirmation.current=null
   let local:any=null;try{local=JSON.parse(localStorage.getItem(cacheKey)||'null')}catch{}
   if(local && (!server || local.id!==server.id)){
    const previous=await apiFetch<{draft:{status:string;docId?:string}|null}>(`/api/warehouse-inventory/inbound-drafts/${local.id}`)
    if(seq!==generation.current||disposed.current||owner()!==ownerRef.current)return
    if(previous.draft?.status==='SUBMITTED'){
     model.current={id:local.id,version:local.version,saved:'',ready:false,closed:true}
     localStorage.removeItem(cacheKey);setSubmittedDocId(previous.draft.docId||'')
     show('已核对：该草稿已经入库，请查看原单据；关闭后可录新单');return
    }
    if(previous.draft?.status==='DISCARDED'){localStorage.removeItem(cacheKey);local=null}
   }
   // Preserve a failed local write only when its version still matches the server.
   if(local && server && (local.id!==server.id || local.version!==server.version)){
    model.current={id:server.id,version:server.version,saved:JSON.stringify(server.payload),ready:false,closed:false}
    restoring.current(local.payload);show('草稿冲突：本页输入保留','服务器已有其他版本，请选择加载服务器版本，或确认保留本页输入后保存');return
   }
   snapshot.current=server?.payload.executionSnapshot||null
   const chosen=local?.payload||server?.payload
   model.current={id:server?.id||local?.id||crypto.randomUUID(),version:server?.version??local?.version??0,saved:server?JSON.stringify(server.payload):'',ready:true,closed:false}
   if(chosen)restoring.current({...chosen,executionSnapshot:snapshot.current,attachments:(chosen.attachments||[]).map((a:any)=>({...a,url:server?.attachmentUrls?.[a.key]||''}))})
   show(server?'已恢复服务器草稿':'草稿自动保存')
  }).catch(e=>{if(seq===generation.current)show('草稿读取失败',String(e?.message||e))})
 },[open])
 const serialized=JSON.stringify(payload)
 useEffect(()=>{if(!open||reloading||reconfirmation.current||!model.current.ready||model.current.closed)return;backup();const timer=setTimeout(()=>void flush().catch(()=>{}),500);return()=>clearTimeout(timer)},[open,serialized,reloading,status==='已恢复服务器草稿'||status==='草稿自动保存'])
 function completed(status='SUBMITTED'){setTerminalStatus(status);model.current.closed=true;model.current.ready=false;generation.current++;try{localStorage.removeItem(cacheKey)}catch{};show(mode==='OUTBOUND'?'已生成出库单，请查看原单据':'已提交审核并入库')}
 async function discard(){const saved=await flush();await apiFetch(`/api/warehouse-inventory/inbound-drafts/${saved.id}/discard`,{method:'POST',body:JSON.stringify({version:saved.version})});completed('DISCARDED')}
 async function reload(keep:boolean){
  if(model.current.closed)throw Error('该草稿已结束，请从独立新建入口另开单，不能恢复终态来源')
  if(reconfirmation.current||localStorage.getItem(reconfirmCacheKey))throw Error('请先核对原单位请求，不能用恢复草稿跳过未知结果')
  if(reloadingRef.current)throw Error('草稿正在恢复，请等读取完成')
  const seq=++manualLoad.current,current=model.current,scope=generation.current,actor=ownerRef.current,inputAtStart=JSON.stringify(latest.current)
  const valid=()=>!disposed.current&&manualLoad.current===seq&&generation.current===scope&&model.current===current&&owner()===actor
  reloadingRef.current=true;setReloading(true)
  try{
   await queue.current.catch(()=>null)
   if(!valid())return
   const result=await apiFetch<{draft:Draft|null}>(`/api/warehouse-inventory/inbound-drafts?mode=${mode}`)
   if(!valid())return
   if(!keep&&JSON.stringify(latest.current)!==inputAtStart)throw Error('读取期间有新输入，本页已保留，请重新选择恢复方式')
   const draft=result.draft
   if(reconfirmation.current)throw Error('请先核对原单位请求，不能用恢复草稿跳过未知结果')
   if(!draft && !keep)throw Error('服务器没有未提交草稿；本页输入保留')
   model.current={id:draft?.id||crypto.randomUUID(),version:draft?.version||0,saved:keep?'':JSON.stringify(draft!.payload),ready:true,closed:false}
   snapshot.current=draft?.payload.executionSnapshot||null
   reloadingRef.current=false
   if(keep)await flush()
   else {try{localStorage.removeItem(cacheKey)}catch{};restoring.current({...draft!.payload,attachments:(draft!.payload.attachments||[]).map((a:any)=>({...a,url:draft!.attachmentUrls?.[a.key]||''}))});show('已恢复服务器草稿')}
  }finally{if(manualLoad.current===seq){reloadingRef.current=false;setReloading(false)}}
 }

 return {terminalStatus,reconfirmPending:Boolean(reconfirmation.current),reloading,snapshot:snapshot.current,status,failure,submittedDocId,flush,completed,discard,reload,ready:model.current.ready,unsaved:model.current.ready&&!model.current.closed&&model.current.saved!==JSON.stringify(payload)}
}
