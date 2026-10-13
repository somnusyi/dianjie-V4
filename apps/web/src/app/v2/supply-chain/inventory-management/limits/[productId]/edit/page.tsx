'use client'
import Link from 'next/link'
import {Suspense} from 'react'
import {useSearchParams} from 'next/navigation'
import {InventoryRules} from '@/components/v2/inventory-rules'
function Editor({productId}:{productId:string}){
 const warehouseId=useSearchParams().get('warehouseId')||''
 if(!warehouseId)return <div><p role="alert">请从库存上下限列表选择明确仓库和商品，不会改用默认仓。</p><Link href="/v2/supply-chain/inventory-management/limits">返回库存上下限</Link></div>
 return <InventoryRules key={`${warehouseId}:${productId}`} editor={{productId,warehouseId}}/>
}
export default function InventoryRuleEditPage({params}:{params:{productId:string}}){return <Suspense fallback={<p>正在读取规则入口…</p>}><Editor productId={params.productId}/></Suspense>}
