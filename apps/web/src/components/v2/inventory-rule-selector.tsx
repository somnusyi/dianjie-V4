'use client'
import Link from 'next/link'
import {useEffect,useRef,useState} from 'react'
import {apiFetch} from '@/lib/v2-auth'
import {inventoryRuleOwner} from '@/lib/inventory-rule-scope'
type Result={warehouse:{id:string;name:string};warehouses:Array<{id:string;name:string}>;items:Array<{productId:string;code:string;name:string}>;total:number;page:number;pageSize:number}
/** Read-only selection; opening this page never creates a rule or product. */
export function InventoryRuleSelector({initialWarehouseId=''}:{initialWarehouseId?:string}){
 const [warehouseId,setWarehouseId]=useState(initialWarehouseId),[query,setQuery]=useState(''),[applied,setApplied]=useState(''),[page,setPage]=useState(1)
 const [result,setResult]=useState<Result|null>(null),[selected,setSelected]=useState(''),[error,setError]=useState(''),[loading,setLoading]=useState(true)
 const sequence=useRef(0),owner=useRef(inventoryRuleOwner())
 useEffect(()=>{const changed=()=>{if(owner.current!==inventoryRuleOwner()){setSelected('');setError('账号或租户已变化，请重新打开新增页面')}};window.addEventListener('storage',changed);return()=>window.removeEventListener('storage',changed)},[])
 useEffect(()=>{
  const current=++sequence.current,actor=inventoryRuleOwner()
  setLoading(true);setError('');setSelected('')
  const params=new URLSearchParams({q:applied,page:String(page),pageSize:'50'});if(warehouseId)params.set('warehouseId',warehouseId)
  void apiFetch<Result>(`/api/inventory-reports/policies?${params}`).then(data=>{if(current===sequence.current&&actor===inventoryRuleOwner()&&owner.current===inventoryRuleOwner()){setResult(data);setWarehouseId(data.warehouse.id)}}).catch(reason=>{if(current===sequence.current&&actor===inventoryRuleOwner()&&owner.current===inventoryRuleOwner())setError(reason.message||'商品读取失败')}).finally(()=>{if(current===sequence.current)setLoading(false)})
  return()=>{sequence.current++}
 },[warehouseId,applied,page])
 const row=result?.items.find(row=>row.productId===selected)
 return <main className="min-h-screen bg-white p-6"><h1 className="text-2xl font-bold">新增库存规则</h1><p>先选择仓库和已有商品；已有草稿会恢复当前轮次，不会重复创建规则。</p>
  {error&&<p role="alert">{error}</p>}
  <label className="mt-5 block max-w-3xl">仓库<select className="ml-3 h-11 rounded border border-border px-3" aria-label="规则仓库" value={warehouseId} disabled={loading} onChange={event=>{setWarehouseId(event.target.value);setPage(1)}}>{result?.warehouses.map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
  <form className="mt-4 flex max-w-3xl gap-3" onSubmit={event=>{event.preventDefault();setApplied(query.trim());setPage(1)}}><input className="h-11 flex-1 rounded border border-border px-3" aria-label="查找规则商品" placeholder="名称 / 编码 / 类别" value={query} onChange={event=>setQuery(event.target.value)}/><button className="rounded border border-border px-4" disabled={loading}>查询</button></form>
  <label className="mt-4 block max-w-3xl">商品<select className="ml-3 h-11 max-w-full rounded border border-border px-3" aria-label="规则商品" disabled={loading||Boolean(error)} value={selected} onChange={event=>setSelected(event.target.value)}><option value="">选择商品</option>{result?.items.map(row=><option key={row.productId} value={row.productId}>{row.code} · {row.name}</option>)}</select></label>
  {loading&&<p role="status">正在读取商品…</p>}
  <div><button disabled={loading||Boolean(error)||page<=1} onClick={()=>setPage(page-1)}>上一页</button><span>{page} / {Math.max(1,Math.ceil((result?.total||0)/50))}</span><button disabled={loading||Boolean(error)||page*50>=(result?.total||0)} onClick={()=>setPage(page+1)}>下一页</button></div>
  <footer className="mt-6 flex gap-4"><Link href="/v2/supply-chain/inventory-management/limits">取消</Link>{row&&!loading&&!error&&warehouseId&&owner.current===inventoryRuleOwner()?<Link href={`/v2/supply-chain/inventory-management/limits/${encodeURIComponent(row.productId)}/edit?warehouseId=${encodeURIComponent(warehouseId)}`}>进入新增／编辑</Link>:<button disabled>进入新增／编辑</button>}</footer>
 </main>
}
