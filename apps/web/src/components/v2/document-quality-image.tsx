'use client'
import {useEffect,useRef,useState} from 'react'
import {createPortal} from 'react-dom'
import {apiFetch} from '@/lib/v2-auth'
import {clientRequestId} from '@/lib/client-id'
type Kind='WAREHOUSE'|'RECEIPT'|'RETURN'
type Image={name:string;mime:string;size:number;url:string|null;version:number;createdAt:string;actorName:string}
type Uploaded={key:string;name:string;mime:string;size:number;url?:string|null}
type View={version:number;image:Image|null;history:Image[];canWrite:boolean}
export function qualityImageEndpoint(kind:Kind,id:string){return `${kind==='WAREHOUSE'?'/api/warehouse-docs':kind==='RECEIPT'?'/api/upstream/receipts':'/api/upstream/purchase-returns'}/${encodeURIComponent(id)}/quality-image`}
export function DocumentQualityImageButton({kind,sourceId,initialOpen=false}:{kind:Kind;sourceId:string;initialOpen?:boolean}){
  const [open,setOpen]=useState(initialOpen)
  useEffect(()=>{setOpen(initialOpen)},[kind,sourceId,initialOpen])
  return <><button type="button" className="text-accent" onClick={()=>setOpen(true)}>质检</button>{open&&<DocumentQualityImageDialog kind={kind} sourceId={sourceId} onClose={()=>setOpen(false)}/>}</>
}
export function DocumentQualityImageDialog({kind,sourceId,onClose}:{kind:Kind;sourceId:string;onClose:()=>void}){
  const [view,setView]=useState<View|null>(null),[pending,setPending]=useState<Uploaded|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[conflict,setConflict]=useState(false)
  const [refreshRequired,setRefreshRequired]=useState(false)
  const [mounted,setMounted]=useState(false)
  const fileInput=useRef<HTMLInputElement>(null)
  useEffect(()=>{setMounted(true)},[])
  const busyRef=useRef(false),requestId=useRef(clientRequestId()),owner=useRef(0)
  const endpoint=qualityImageEndpoint(kind,sourceId)
  useEffect(()=>{
    const current=++owner.current
    setView(null);setPending(null);setError('');setConflict(false);setRefreshRequired(false);setBusy(false);busyRef.current=false;requestId.current=clientRequestId()
    void apiFetch<View>(endpoint).then(result=>{if(owner.current===current)setView(result)}).catch(reason=>{if(owner.current===current)setError(reason.message||'图片加载失败')})
    return ()=>{owner.current++}
  },[endpoint])
  async function upload(file?:File){
    if(!file||busyRef.current||!view?.canWrite||refreshRequired)return
    if(!['image/jpeg','image/png','image/webp','image/gif'].includes(file.type)||file.size<=0||file.size>10*1024*1024){setError('只支持图片，单张最大10MB');return}
    busyRef.current=true;setBusy(true);setError('');const current=owner.current
    try{const form=new FormData();form.append('file',file,file.name);const result=await apiFetch<Uploaded>('/api/upload?category=warehouse-docs',{method:'POST',body:form as any});if(owner.current===current){setPending(result);requestId.current=clientRequestId()}}
    catch(reason:any){if(owner.current===current)setError(reason.message||'图片上传失败')}
    finally{if(owner.current===current){busyRef.current=false;setBusy(false)}}
  }
  async function save(){
    if(busyRef.current||!view||!pending||conflict)return
    busyRef.current=true;setBusy(true);setError('');const current=owner.current;let saved=false
    try{
      const {key,name,mime,size}=pending
      await apiFetch<{version:number;image:Image}>(endpoint,{method:'POST',body:JSON.stringify({version:view.version,requestId:requestId.current,image:{key,name,mime,size}})})
      saved=true
      if(owner.current!==current)return
      setPending(null);setRefreshRequired(true)
      const latest=await apiFetch<View>(endpoint)
      if(owner.current===current){setView(latest);setRefreshRequired(false)}
    }catch(reason:any){if(owner.current===current){setError(saved?`图片已保存，最新图片加载失败：${reason.message||'请重新加载'}`:reason.message||'保存失败，已上传图片保留，可重试');if(!saved&&reason.status===409)setConflict(true)}}
    finally{if(owner.current===current){busyRef.current=false;setBusy(false)}}
  }
  async function reload(){
    if(busyRef.current)return
    busyRef.current=true;setBusy(true);setError('');const current=owner.current
    try{const result=await apiFetch<View>(endpoint);if(owner.current===current){setView(result);setConflict(false);setRefreshRequired(false);requestId.current=clientRequestId()}}
    catch(reason:any){if(owner.current===current)setError(reason.message||'最新图片加载失败')}
    finally{if(owner.current===current){busyRef.current=false;setBusy(false)}}
  }
  return mounted ? createPortal(<div role="dialog" aria-modal="true" aria-label="单据质检图片" className="fixed inset-0 z-[110] flex items-center justify-center bg-black/40 p-4" onClick={event=>{event.stopPropagation();if(!busyRef.current)onClose()}}>
    <section className="max-h-[85vh] w-full max-w-2xl overflow-auto rounded-xl bg-white p-5" onClick={event=>event.stopPropagation()}>
      <div className="flex items-center justify-between"><h2 className="text-xl font-bold">质检图片</h2><button type="button" disabled={busy} onClick={onClose}>关闭</button></div>
      {error&&<p role="alert" className="my-3 text-red-600">{error}</p>}
      {!view&&!error&&<p>正在加载图片…</p>}
      {view&&<><p className="my-3 text-gray2">添加图片不改变单据数量、金额、库存或审核状态。</p>
        {refreshRequired?<p>图片已保存，请刷新查看最新图片。</p>:view.image?.url?<a href={view.image.url} target="_blank" rel="noreferrer"><img className="max-h-80 max-w-full object-contain" src={view.image.url} alt={view.image.name}/></a>:<p>暂无质检图片</p>}
        {!refreshRequired&&view.image&&<p className="my-2 text-sm">{view.image.name} · {view.image.actorName}</p>}
        {view.canWrite&&<div className="my-4 space-y-3"><button type="button" className="rounded-lg border border-accent px-3 py-2 text-accent" style={{display:'inline-flex',alignItems:'center',justifyContent:'center',minWidth:100,minHeight:40,flexShrink:0,whiteSpace:'nowrap'}} disabled={busy||refreshRequired} onClick={()=>fileInput.current?.click()}>添加图片</button><input ref={fileInput} hidden aria-label="添加质检图片" type="file" accept="image/jpeg,image/png,image/webp,image/gif" disabled={busy||refreshRequired} onChange={event=>{const file=event.target.files?.[0];event.target.value='';void upload(file)}}/>
          {pending&&<><p>待保存：{pending.name}</p>{pending.url&&<img className="max-h-48 max-w-full object-contain" src={pending.url} alt={`待保存 ${pending.name}`}/>}<button type="button" disabled={busy||conflict} className="rounded-lg bg-accent px-3 py-2 text-white" onClick={()=>void save()}>{busy?'处理中…':'保存图片'}</button></>}
          {(conflict||refreshRequired)&&<button type="button" disabled={busy} onClick={()=>void reload()}>{refreshRequired?'重新加载最新图片':'查看最新图片后重新保存'}</button>}
        </div>}
        {!refreshRequired&&view.history.length>1&&<details><summary>历史图片</summary>{view.history.map(image=><p key={image.version} className="my-2">第{image.version}版 · {image.actorName} · {image.url?<a className="text-accent" href={image.url} target="_blank" rel="noreferrer">{image.name}</a>:image.name}</p>)}</details>}
      </>}
      {!view&&error&&<button type="button" disabled={busy} onClick={()=>void reload()}>重新加载</button>}
    </section>
  </div>,document.body) : null
}
