'use client'
import {Suspense} from 'react'
import {useSearchParams} from 'next/navigation'
import {InventoryRuleSelector} from '@/components/v2/inventory-rule-selector'
function Selector(){const warehouseId=useSearchParams().get('warehouseId')||'';return <InventoryRuleSelector key={warehouseId} initialWarehouseId={warehouseId}/>}
export default function Page(){return <Suspense fallback={<p>正在读取规则入口…</p>}><Selector/></Suspense>}
