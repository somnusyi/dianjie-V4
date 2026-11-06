'use client'
import { SearchableSelect } from '@/components/v2/searchable-select'
import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { apiFetch } from '@/lib/v2-auth'

type Choice = { productId: string; warehouseId: string; name: string; code: string }
type Movement = { id: string; sourceType: string; sourceId: string; effectiveAt: string; quantity: string; amount: string; quantityAfter: string; amountAfter: string; unit: string; confirmation: { version: number } | null }
type Context = { movement: { id: string; physicalDelta: string; valueDelta: string; physicalAfter: string; valueAfter: string; inventoryUnit: string }; balance: { physicalQty: string; inventoryValue: string } | null; latestMovementId: string | null; currentVersion: number; expectedPostingSequence: number }
type Basis = 'NET_DOCUMENT' | 'ALREADY_NET' | 'POOL_DOCUMENT'
const sources: Record<string,string> = { WarehouseManualInbound:'手工入库',WarehouseBatchManualInbound:'批量入库',WarehousePhysicalCount:'实盘校准',WarehouseStocktake:'盘点调整',WarehouseDocValueAdjust:'成本补价',UpstreamReceipt:'采购入库',DeliveryOrder:'配送出库',UpstreamPurchaseReturn:'采购退货',PurchaseOrder:'订单预占' }

export function InventoryCostBasisSheet({ choices: initialChoices, onClose, onSaved }: { choices: Choice[]; onClose: () => void; onSaved: () => void }) {
  const [choices] = useState(initialChoices)
  const [choiceIndex,setChoiceIndex]=useState(0), [rows,setRows]=useState<Movement[]>([]), [page,setPage]=useState(1), [total,setTotal]=useState(0)
  const [selected,setSelected]=useState(''), [context,setContext]=useState<Context|null>(null), [basis,setBasis]=useState<Basis>('NET_DOCUMENT')
  const [value,setValue]=useState(''), [references,setReferences]=useState(''), [materialType,setMaterialType]=useState('archive'), [note,setNote]=useState('')
  const [error,setError]=useState(''), [message,setMessage]=useState(''), [busy,setBusy]=useState(false), [loading,setLoading]=useState(false), [savedForm,setSavedForm]=useState('')
  const request=useRef<{body:string;key:string}|null>(null), lock=useRef(false), choice=choices[choiceIndex]
  useEffect(()=>{
    let active=true;setLoading(true);setError('');setRows([]);setSelected('');setContext(null);setReferences('');setNote('')
    apiFetch<{rows:Movement[];total:number}>(`/api/inventory-reports/cost-basis/movements?warehouseId=${encodeURIComponent(choice.warehouseId)}&productId=${encodeURIComponent(choice.productId)}&page=${page}`)
      .then(r=>{if(active){setRows(r.rows);setTotal(r.total);setSelected(r.rows[0]?.id||'')}})
      .catch(e=>{if(active)setError(e.message)}).finally(()=>{if(active)setLoading(false)})
    return()=>{active=false}
  },[choice.productId,choice.warehouseId,page])
  useEffect(()=>{
    let active=true;setContext(null);setValue('');setMessage('')
    if(selected)apiFetch<Context>(`/api/inventory-reports/cost-basis/${encodeURIComponent(selected)}`).then(r=>{if(active)setContext(r)}).catch(e=>{if(active)setError(e.message)})
    return()=>{active=false}
  },[selected])
  const pool=basis==='POOL_DOCUMENT'
  const currentAnchor=!!context&&context.latestMovementId===selected
  const formFingerprint=JSON.stringify({selected,basis,value,references,materialType,note})
  const save=async()=>{
    if(lock.current||!context||savedForm===formFingerprint)return
    setError('');setMessage('')
    const evidenceRefs=references.split(/[,，\n]/).map(s=>s.trim()).filter(Boolean).map(s=>`${materialType}:${s}`)
    const body={basisType:basis,expectedVersion:context.currentVersion,evidenceRefs,note,
      ...(pool?{poolNetValueAfter:value,expectedPostingSequence:context.expectedPostingSequence}:{netValueDelta:value})}
    const serialized=JSON.stringify(body)
    if(request.current?.body!==selected+serialized)request.current={body:selected+serialized,key:crypto.randomUUID()}
    lock.current=true;setBusy(true)
    try {
      await apiFetch(`/api/inventory-reports/cost-basis/${encodeURIComponent(selected)}`,{method:'POST',body:JSON.stringify({...body,requestKey:request.current.key})})
      setSavedForm(formFingerprint);setMessage('材料核定已保存，库存数量和原账面金额保持不变。');onSaved()
      try {
        const fresh=await apiFetch<Context>(`/api/inventory-reports/cost-basis/${encodeURIComponent(selected)}`);setContext(fresh);request.current=null
      } catch {
        setContext(null);setError('核定已保存，但最新记录暂未读取成功。请关闭后重新打开查看，无需重复提交。')
      }
    } catch(e:any){setError(e.message||'核定未保存，请核对后重试')} finally{lock.current=false;setBusy(false)}
  }
  return <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/40 p-4">
    <section role="dialog" aria-modal="true" aria-label="库存成本材料核定" className="flex max-h-[86vh] w-full max-w-3xl flex-col rounded-2xl bg-white shadow-xl">
      <header className="flex items-center justify-between border-b p-4"><h2 className="text-lg font-semibold">库存成本材料核定</h2><button disabled={busy} onClick={onClose} aria-label="关闭成本材料核定">关闭</button></header>
      <div className="space-y-4 overflow-y-auto p-4">
        <p className="text-sm text-gray-600">按已有票据或导入材料核定成本，保留每次核定记录。缺少原账面成本时，先补齐账面金额，再核定成本。</p>
        <Link className="text-sm text-orange-600 underline" href="/v2/supply-chain/inventory/import">前往库存导入与期初材料</Link>
        <label className="block text-sm">商品<SearchableSelect searchLabel="搜索成本商品" className="mt-1 w-full rounded border p-2" value={choiceIndex} disabled={busy} onChange={e=>{setChoiceIndex(Number(e.target.value));setPage(1)}}>{choices.map((c,i)=><option key={`${c.warehouseId}/${c.productId}`} value={i}>{c.code} · {c.name}</option>)}</SearchableSelect></label>
        {loading?<p>正在读取原始流水…</p>:<label className="block text-sm">原始流水<SearchableSelect searchWhenLong searchLabel="搜索原始流水" className="mt-1 w-full rounded border p-2" value={selected} disabled={busy} onChange={e=>setSelected(e.target.value)}>{!rows.some(r=>r.id===selected)&&selected&&<option value={selected}>当前最新库存记录</option>}{rows.map(m=><option key={m.id} value={m.id}>{new Date(m.effectiveAt).toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai'})} · {sources[m.sourceType]||'历史库存'} · {m.quantity} {m.unit} · 账面金额 {m.amount}</option>)}</SearchableSelect></label>}
        <div className="flex items-center gap-3 text-sm"><button disabled={busy||page<=1} onClick={()=>setPage(n=>n-1)}>上一页</button><span>{page} / {Math.max(1,Math.ceil(total/30))}</span><button disabled={busy||page*30>=total} onClick={()=>setPage(n=>n+1)}>下一页</button></div>
        <label className="block text-sm">材料覆盖范围<select className="mt-1 w-full rounded border p-2" value={basis} disabled={busy} onChange={e=>{setBasis(e.target.value as Basis);setValue(e.target.value==='ALREADY_NET'&&context?context.movement.valueDelta:'')}}><option value="NET_DOCUMENT">单笔票据载明成本金额</option><option value="ALREADY_NET">单笔原金额已是成本</option><option value="POOL_DOCUMENT">核定当前库存池总成本</option></select></label>
        {context&&<div className="rounded bg-stone-50 p-3 text-sm">原流水：{context.movement.physicalDelta} {context.movement.inventoryUnit}，账面金额 {context.movement.valueDelta}；当前库存：{context.balance?.physicalQty??'—'} {context.movement.inventoryUnit}，账面金额 {context.balance?.inventoryValue??'—'}。</div>}
        {pool&&<p className="text-sm text-gray-600">材料应覆盖当前剩余全部库存。核定后从当前时点建立可靠成本，不会把以前未知的采购金额填成零。{!currentAnchor&&context?.latestMovementId&&<button className="ml-2 text-orange-600 underline" onClick={()=>setSelected(context.latestMovementId!)}>选择当前最新记录</button>}</p>}
        {<label className="block text-sm">{pool?'当前库存成本总额':'本笔成本金额（与原流水同正负方向）'}<input className="mt-1 w-full rounded border p-2" inputMode="decimal" value={value} disabled={busy} onChange={e=>setValue(e.target.value)} /></label>}
        <label className="block text-sm">材料类型<select className="mt-1 w-full rounded border p-2" value={materialType} disabled={busy} onChange={e=>setMaterialType(e.target.value)}><option value="archive">纸质或归档票据</option><option value="document">系统单据</option><option value="receipt">收货记录</option><option value="import">导入记录</option><option value="attachment">已上传附件</option></select></label><label className="block text-sm">材料编号<textarea className="mt-1 w-full rounded border p-2" rows={2} placeholder="例如 FP202610001；多份材料每行一条" value={references} disabled={busy} onChange={e=>setReferences(e.target.value)} /><span className="text-xs text-gray-500">填写可追溯的票据、导入记录或附件编号；不要填写密码或密钥。</span></label>
        <label className="block text-sm">核定说明<textarea className="mt-1 w-full rounded border p-2" rows={2} maxLength={500} value={note} disabled={busy} onChange={e=>setNote(e.target.value)} /></label>
        {error&&<p role="alert" className="text-sm text-red-700">{error}</p>}{message&&<p role="status" className="text-sm text-green-700">{message}</p>}
      </div>
      <footer className="flex shrink-0 justify-end gap-3 border-t p-4"><button className="rounded border px-4 py-2" disabled={busy} onClick={onClose}>取消</button><button className="rounded bg-stone-900 px-4 py-2 text-white" disabled={busy||loading||savedForm===formFingerprint||!context||!value||!references.trim()||(pool&&!currentAnchor)} onClick={save}>{busy?'正在保存…':'确认核定'}</button></footer>
    </section>
  </div>
}
