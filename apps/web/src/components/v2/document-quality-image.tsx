'use client'
import {useEffect,useRef,useState} from 'react'
import {createPortal} from 'react-dom'
import {apiFetch} from '@/lib/v2-auth'
import {clientRequestId} from '@/lib/client-id'
type Kind='WAREHOUSE'|'RECEIPT'|'RETURN'|'BATCH'|'SHIPMENT'|'ORDER'
type Image={id?:string;name:string;mime:string;size:number;url:string|null;version:number;createdAt:string;actorName:string}
type Uploaded={key:string;name:string;mime:string;size:number;url?:string|null}
type View={version:number;image:Image|null;images?:Image[];history:(Image|{version:number;actorName:string;images:Image[]})[];canWrite:boolean;batch?:{productName:string;productCode?:string|null;batchNo?:string|null;sourceNo:string;orderNo?:string|null}}
export function qualityImageEndpoint(kind:Kind,id:string){if(kind==='BATCH')return `/api/upstream/quality-batches/${encodeURIComponent(id)}`;return `${kind==='WAREHOUSE'?'/api/warehouse-docs':kind==='RECEIPT'?'/api/upstream/receipts':'/api/upstream/purchase-returns'}/${encodeURIComponent(id)}/quality-image`}
export function DocumentQualityImageButton({kind,sourceId,initialOpen=false,label='质检'}:{kind:Kind;sourceId:string;initialOpen?:boolean;label?:string}){
  const [open,setOpen]=useState(initialOpen)
  useEffect(()=>{setOpen(initialOpen)},[kind,sourceId,initialOpen])
  return <><button type="button" className="text-accent" onClick={()=>setOpen(true)}>{label}</button>{open&&(kind==='BATCH'?<DocumentQualityImageDialog kind={kind} sourceId={sourceId} onClose={()=>setOpen(false)}/>:<GoodsQualityPicker kind={kind} sourceId={sourceId} onClose={()=>setOpen(false)}/>)}</>
}
export function DocumentQualityImageDialog({kind,sourceId,onClose,readOnly=false,title='质检图片'}:{kind:Kind;sourceId:string;onClose:()=>void;readOnly?:boolean;title?:string}){
  const [view,setView]=useState<View|null>(null),[pending,setPending]=useState<Uploaded[]>([]),[removed,setRemoved]=useState<string[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[conflict,setConflict]=useState(false)
  const [refreshRequired,setRefreshRequired]=useState(false),[retryRequired,setRetryRequired]=useState(false)
  const [mounted,setMounted]=useState(false)
  const fileInput=useRef<HTMLInputElement>(null)
  useEffect(()=>{setMounted(true)},[])
  const busyRef=useRef(false),requestId=useRef(clientRequestId()),owner=useRef(0)
  const endpoint=qualityImageEndpoint(kind,sourceId)
  useEffect(()=>{
    const current=++owner.current
    setView(null);setPending([]);setRemoved([]);setError('');setConflict(false);setRefreshRequired(false);setRetryRequired(false);setBusy(false);busyRef.current=false;requestId.current=clientRequestId()
    void apiFetch<View>(endpoint).then(result=>{if(owner.current===current)setView(result)}).catch(reason=>{if(owner.current===current)setError(reason.message||'图片加载失败')})
    return ()=>{owner.current++}
  },[endpoint])
  const savedImages=view?.images??(view?.image?[view.image]:[])
  const retained=savedImages.filter(image=>!removed.includes(image.id||''))
  const changed=pending.length>0||removed.length>0
  const canWrite=Boolean(view?.canWrite&&!readOnly)
  const uploadEndpoint=kind==='BATCH'?`${endpoint}/images`:'/api/upload?category=warehouse-docs'
  async function upload(files:File[]){
    if(!files.length||busyRef.current||!canWrite||refreshRequired||conflict||retryRequired)return
    if(retained.length+pending.length+files.length>50){setError(kind==='BATCH'?'这个商品的本批图片最多50张':'每张单据最多保存50张质检图片');return}
    busyRef.current=true;setBusy(true);setError('');const current=owner.current
    const successes:Uploaded[]=[],failures:string[]=[]
    for(const file of files){
      if(!['image/jpeg','image/png','image/webp','image/gif'].includes(file.type)||file.size<=0||file.size>10*1024*1024){failures.push(`${file.name}：只支持图片，单张最大10MB`);continue}
      try{
        const form=new FormData();form.append('file',file,file.name)
        const result=await apiFetch<Uploaded>(uploadEndpoint,{method:'POST',body:form as any})
        if(owner.current!==current)return
        successes.push(result)
      }catch(reason:any){if(owner.current!==current)return;failures.push(`${file.name}：${reason.message||'上传失败'}`)}
    }
    if(owner.current===current){
      if(successes.length){setPending(items=>[...items,...successes]);requestId.current=clientRequestId()}
      setError(failures.join('；'));busyRef.current=false;setBusy(false)
    }
  }
  function remove(id:string,pendingImage=false){
    if(busyRef.current||conflict||refreshRequired||retryRequired)return
    if(pendingImage)setPending(items=>items.filter(item=>item.key!==id))
    else setRemoved(items=>[...items,id])
    requestId.current=clientRequestId()
  }
  async function save(){
    if(busyRef.current||!view||!changed||conflict||refreshRequired)return
    if(retained.length+pending.length>50){setError('最多保存50张质检图片，请先移除多余图片');return}
    busyRef.current=true;setBusy(true);setError('');const current=owner.current;let saved=false
    try{
      await apiFetch<{version:number;image:Image}>(endpoint,{method:'POST',body:JSON.stringify({version:view.version,requestId:requestId.current,images:[...retained.map(image=>({id:image.id})),...pending.map(({key,name,mime,size})=>({key,name,mime,size}))]})})
      saved=true
      if(owner.current!==current)return
      setPending([]);setRemoved([]);setRetryRequired(false);setRefreshRequired(true)
      const latest=await apiFetch<View>(endpoint)
      if(owner.current===current){setView(latest);setRefreshRequired(false)}
    }catch(reason:any){if(owner.current===current){setError(saved?`图片已保存，最新图片加载失败：${reason.message||'请重新加载'}`:reason.message||'保存失败，已上传图片保留，可重试');if(!saved){setRetryRequired(!reason.status||reason.status>=500);if(reason.status===409)setConflict(true)}}}
    finally{if(owner.current===current){busyRef.current=false;setBusy(false)}}
  }
  async function reload(){
    if(busyRef.current)return
    busyRef.current=true;setBusy(true);setError('');const current=owner.current
    try{const result=await apiFetch<View>(endpoint);if(owner.current===current){setView(result);setConflict(false);setRefreshRequired(false);setRetryRequired(false);requestId.current=clientRequestId()}}
    catch(reason:any){if(owner.current===current)setError(reason.message||'最新图片加载失败')}
    finally{if(owner.current===current){busyRef.current=false;setBusy(false)}}
  }
  return mounted ? createPortal(<div role="dialog" aria-modal="true" aria-label="单据质检图片" className="fixed inset-0 z-[110] flex items-center justify-center bg-black/40 p-4" onClick={event=>{event.stopPropagation();if(!busyRef.current)onClose()}}>
    <section className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl bg-white" onClick={event=>event.stopPropagation()}>
      <div className="flex items-center justify-between border-b p-5"><h2 className="text-xl font-bold">{title}</h2><button type="button" disabled={busy} onClick={onClose}>关闭</button></div>
      <div className="min-h-0 overflow-y-auto p-5">
      {error&&<p role="alert" className="mb-3 text-red-600">{error}</p>}
      {!view&&!error&&<p>正在加载图片…</p>}
      {view&&<>{kind==='BATCH'&&view.batch&&<p className="mb-3 text-sm">商品：{view.batch.productName} · 商品编号：{view.batch.productCode||'未填写'} · 批次号：{view.batch.batchNo||'未填写'} · 进货记录 {view.batch.sourceNo}{view.batch.orderNo?` · 采购单 ${view.batch.orderNo}`:''}</p>}<p className="mb-3 text-sm text-gray2">{readOnly?'原整单图片尚未分配到商品，作为历史记录只读保留。':kind==='BATCH'?'仅属于这个商品的这次进货，可多选和追加，最多50张、单张10MB；不影响库存和审批。':'支持多选和继续追加，每单最多50张，单张最大10MB。图片不影响数量、金额、库存和审核状态。'}</p>
        {refreshRequired?<p>图片已保存，请刷新查看最新图片。</p>:<>
          <p className="mb-3 text-sm">共 {retained.length+pending.length} 张{pending.length>0?`（待保存 ${pending.length} 张）`:''}</p>
          {!retained.length&&!pending.length&&<p>暂无质检图片</p>}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {retained.map(image=><figure key={image.id||image.url} className="min-w-0 rounded-lg border p-2">
              {image.url&&<a href={image.url} target="_blank" rel="noreferrer" aria-label={`查看 ${image.name}`}><img className="h-32 w-full object-contain" src={image.url} alt={image.name}/></a>}
              <figcaption className="mt-2 break-all text-sm">{image.name} · {image.actorName}</figcaption>
              {canWrite&&image.id&&<button type="button" className="mt-2 text-sm text-red-600" disabled={busy||conflict||retryRequired} onClick={()=>remove(image.id!)} aria-label={`移除 ${image.name}`}>移除</button>}
            </figure>)}
            {pending.map(image=><figure key={image.key} className="min-w-0 rounded-lg border border-accent p-2">
              {image.url&&<a href={image.url} target="_blank" rel="noreferrer" aria-label={`查看待保存 ${image.name}`}><img className="h-32 w-full object-contain" src={image.url} alt={`待保存 ${image.name}`}/></a>}
              <figcaption className="mt-2 break-all text-sm">待保存：{image.name}</figcaption>
              <button type="button" className="mt-2 text-sm text-red-600" disabled={busy||conflict||retryRequired} aria-label={`移除待保存 ${image.name}`} onClick={()=>remove(image.key,true)}>移除</button>
            </figure>)}
          </div>
          {removed.length>0&&<p className="mt-3 text-sm">待移除 {removed.length} 张，历史记录仍保留。<button type="button" className="ml-2 text-accent" disabled={busy||conflict||retryRequired} onClick={()=>{setRemoved([]);requestId.current=clientRequestId()}}>撤销移除</button></p>}
        </>}
        {!refreshRequired&&view.history.length>1&&<details className="mt-5"><summary>历史图片</summary>{view.history.map(entry=><div key={entry.version} className="my-3"><p>第{entry.version}版 · {entry.actorName}</p><div className="flex flex-wrap gap-3">{('images' in entry?entry.images:[entry]).map((image,index)=><span key={image.id||index}>{image.url?<a className="text-accent" href={image.url} target="_blank" rel="noreferrer">{image.name}</a>:image.name}</span>)}</div></div>)}</details>}
      </>}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-t bg-white p-4">
      {canWrite&&<><button type="button" className="rounded-lg border border-accent px-3 py-2 text-accent" style={{display:'inline-flex',alignItems:'center',justifyContent:'center',minWidth:100,minHeight:40,flexShrink:0,whiteSpace:'nowrap'}} disabled={busy||refreshRequired||conflict||retryRequired||retained.length+pending.length>=50} onClick={()=>fileInput.current?.click()}>添加图片</button><input ref={fileInput} hidden multiple aria-label="添加质检图片" type="file" accept="image/jpeg,image/png,image/webp,image/gif" disabled={busy||refreshRequired||conflict||retryRequired} onChange={event=>{const files=Array.from(event.target.files||[]);event.target.value='';void upload(files)}}/>
        {changed&&!refreshRequired&&<button type="button" disabled={busy||conflict} className="rounded-lg bg-accent px-3 py-2 text-white" onClick={()=>void save()}>{busy?'处理中…':'保存图片'}</button>}
      </>}
      {(conflict||refreshRequired)&&<button type="button" disabled={busy} onClick={()=>void reload()}>{refreshRequired?'重新加载最新图片':'查看最新图片后重新保存'}</button>}
      {!view&&error&&<button type="button" disabled={busy} onClick={()=>void reload()}>重新加载</button>}
      {retryRequired&&<p className="text-sm">保存结果尚未确认，请先重试保存；已选图片会保留。</p>}
      {busy&&<span role="status">正在处理图片…</span>}
      </div>
    </section>
  </div>,document.body) : null
}

type BatchGroup={key:string;purchaseOrderLineId?:string;productName:string;productCode?:string|null;batchNo?:string|null;quantity:string;unit:string;sourceNo:string;orderNo?:string|null;imageCount:number}
function qualityGroupsEndpoint(kind:Exclude<Kind,'BATCH'>,id:string){
 const prefix=kind==='WAREHOUSE'?'/api/warehouse-docs':`/api/upstream/${kind==='RECEIPT'?'receipts':kind==='RETURN'?'purchase-returns':kind==='ORDER'?'purchase-orders':'shipments'}`
 return `${prefix}/${encodeURIComponent(id)}/quality-batches`
}
function GoodsQualityPicker({kind,sourceId,onClose}:{kind:Exclude<Kind,'BATCH'>;sourceId:string;onClose:()=>void}){
 const [groups,setGroups]=useState<BatchGroup[]>([]),[selected,setSelected]=useState<BatchGroup|null>(null),[legacy,setLegacy]=useState(false),[legacyOnly,setLegacyOnly]=useState(false),[showLegacy,setShowLegacy]=useState(false),[error,setError]=useState(''),[loading,setLoading]=useState(true),[refresh,setRefresh]=useState(0)
 const endpoint=qualityGroupsEndpoint(kind,sourceId)
 useEffect(()=>{
  let active=true;setLoading(true);setError('');setSelected(null);setShowLegacy(false)
  void apiFetch<{groups:BatchGroup[];legacyAvailable:boolean;legacyOnly:boolean}>(endpoint).then(result=>{if(active){setGroups(result.groups);setLegacy(result.legacyAvailable);setLegacyOnly(result.legacyOnly)}}).catch(reason=>{if(active)setError(reason.message||'进货商品加载失败')}).finally(()=>{if(active)setLoading(false)})
  return ()=>{active=false}
 },[endpoint,refresh])
 if(selected)return <DocumentQualityImageDialog key={selected.key} kind="BATCH" sourceId={selected.key} title="质检图片" onClose={()=>{setSelected(null);setRefresh(value=>value+1)}}/>
 if(legacyOnly)return <DocumentQualityImageDialog kind={kind} sourceId={sourceId} onClose={onClose}/>
 if(showLegacy)return <DocumentQualityImageDialog kind={kind} sourceId={sourceId} readOnly title="历史整单图片（未分配）" onClose={()=>setShowLegacy(false)}/>
 return createPortal(<div role="dialog" aria-modal="true" aria-label="选择质检商品" className="fixed inset-0 z-[110] flex items-center justify-center bg-black/40 p-4" onClick={event=>{event.stopPropagation();onClose()}}><section className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl bg-white" onClick={event=>event.stopPropagation()}>
  <header className="flex items-center justify-between border-b p-4"><h2 className="text-xl font-bold">质检</h2><button type="button" onClick={onClose}>关闭</button></header>
  <div className="min-h-0 overflow-auto p-4"><p className="mb-3 text-sm text-gray2">按商品和进货批次分别保存图片。</p>
  {loading?<p>正在加载进货商品…</p>:error?<p role="alert">{error}</p>:!groups.length?<p>暂无本次进货记录。请先建立本批发货草稿，再为各商品添加图片。</p>:<div className="space-y-3">{groups.map((group,index)=><article key={group.key} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"><div className="min-w-0"><b>{index+1}. {group.productName}</b><p className="text-sm text-gray2">商品编号：{group.productCode||'未填写'} · {group.quantity} {group.unit} · 批次号：{group.batchNo||'未填写'}</p><p className="text-sm text-gray2">批次记录 {group.sourceNo}{group.orderNo?` · 采购单 ${group.orderNo}`:''}</p></div><button type="button" className="shrink-0 rounded-lg border border-accent px-3 py-2 text-accent" aria-label={`${group.productName} 质检图片 ${index+1}`} onClick={()=>setSelected(group)}>质检图片 · {group.imageCount}张</button></article>)}</div>}
  </div><footer className="flex shrink-0 flex-wrap gap-3 border-t p-4">{legacy&&<button type="button" className="text-sm text-gray2" onClick={()=>setShowLegacy(true)}>查看历史整单图片（未分配）</button>}{error&&<button type="button" onClick={()=>setRefresh(value=>value+1)}>重新加载</button>}</footer>
 </section></div>,document.body)
}

// Order rows may have several actual arrivals. Show each batch in the row, never guess one.
export function OrderLineQuality({orderId,lineId}:{orderId:string;lineId:string}){
 const [groups,setGroups]=useState<BatchGroup[]>([]),[status,setStatus]=useState('加载中'),[retry,setRetry]=useState(0)
 useEffect(()=>{let active=true;setGroups([]);setStatus('加载中');void apiFetch<{groups:BatchGroup[]}>(qualityGroupsEndpoint('ORDER',orderId)).then(result=>{if(active){setGroups(result.groups.filter(group=>group.purchaseOrderLineId===lineId));setStatus('')}}).catch(()=>{if(active)setStatus('加载失败')});return()=>{active=false}},[orderId,lineId,retry])
 if(status==='加载失败')return <button type="button" className="text-accent" onClick={()=>setRetry(value=>value+1)}>重新加载质检</button>
 return <div className="flex flex-col gap-2">{groups.map(group=><DocumentQualityImageButton key={group.key} kind="BATCH" sourceId={group.key} label={groups.length>1?`质检 · ${group.batchNo||group.sourceNo}`:'质检'}/>)}{!groups.length&&<button type="button" disabled className="text-gray3" title={status||'尚无进货批次，请先保存发货草稿'}>质检</button>}</div>
}
export function LegacyQualityImagesButton({kind,sourceId}:{kind:'WAREHOUSE'|'RECEIPT'|'RETURN';sourceId:string}){
 const [open,setOpen]=useState(false)
 return <><button type="button" className="text-sm text-gray2" onClick={()=>setOpen(true)}>历史整单图片（未分配）</button>{open&&<DocumentQualityImageDialog kind={kind} sourceId={sourceId} readOnly title="历史整单图片（未分配）" onClose={()=>setOpen(false)}/>}</>
}
