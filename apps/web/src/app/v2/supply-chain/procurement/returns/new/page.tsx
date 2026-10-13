'use client'
import {useEffect,useState} from 'react'
import {useRouter} from 'next/navigation'
import {apiFetch} from '@/lib/v2-auth'
import {ProcurementDocumentEditor} from '@/components/v2/procurement-document-editor'
type Option={id:string;no?:string;code?:string;name:string}
export default function NewReturnPage(){
 const router=useRouter(),[setup,setSetup]=useState<{suppliers:Option[];warehouses:Option[]}|null>(null),[error,setError]=useState(''),[supplier,setSupplier]=useState(''),[warehouse,setWarehouse]=useState(''),[selected,setSelected]=useState(false),[retry,setRetry]=useState(0)
 useEffect(()=>{let active=true;setError('');void apiFetch<{suppliers:Option[];warehouses:Option[]}>('/api/upstream/setup-options').then(result=>{if(active)setSetup(result)}).catch(reason=>{if(active)setError(reason.message||'选择项加载失败')});return()=>{active=false}},[retry])
 const close=()=>router.push('/v2/supply-chain/procurement?tab=returns')
 if(selected)return <ProcurementDocumentEditor kind="RETURN" sourceId="new" supplierId={supplier} warehouseId={warehouse} onClose={close} onCreated={id=>router.replace(`/v2/supply-chain/procurement/returns/${encodeURIComponent(id)}/edit`)}/>
 return <div className="p-6"><button onClick={close}>← 返回采购退货</button><h1 className="my-4 text-2xl font-bold">新建采购退货单</h1><p>先选择供应商和退货仓库，再按原收货单填写本次退货数量。</p>{error&&<p role="alert">{error}<button onClick={()=>setRetry(value=>value+1)}>重新加载</button></p>}
 <div className="my-4 grid max-w-3xl gap-4 md:grid-cols-2"><label>上游供应商<select aria-label="上游供应商" className="input" value={supplier} onChange={event=>setSupplier(event.target.value)}><option value="">请选择</option>{setup?.suppliers.map(item=><option key={item.id} value={item.id}>{item.no} · {item.name}</option>)}</select></label><label>退货仓库<select aria-label="退货仓库" className="input" value={warehouse} onChange={event=>setWarehouse(event.target.value)}><option value="">请选择</option>{setup?.warehouses.map(item=><option key={item.id} value={item.id}>{item.code} · {item.name}</option>)}</select></label></div>
 <button className="rounded border px-4 py-2" disabled={!supplier||!warehouse||Boolean(error)} onClick={()=>setSelected(true)}>选择可退商品</button></div>
}
