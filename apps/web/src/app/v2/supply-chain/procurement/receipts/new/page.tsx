'use client'
import {Suspense} from 'react'
import {useRouter,useSearchParams} from 'next/navigation'
import {ProcurementDocumentEditor} from '@/components/v2/procurement-document-editor'
export default function NewReceiptPage(){return <Suspense fallback={<p>正在读取发货单…</p>}><NewReceiptContent/></Suspense>}
function NewReceiptContent(){
 const router=useRouter(),shipment=useSearchParams().get('shipment')||''
 if(!shipment)return <div className="p-6"><button onClick={()=>router.push('/v2/supply-chain/procurement?tab=orders')}>返回发货单</button><p>请从待收货的发货单进入新建入库单。</p></div>
 return <ProcurementDocumentEditor kind="RECEIPT" sourceId="new" shipmentId={shipment} onClose={()=>router.push('/v2/supply-chain/procurement?tab=orders')} onCreated={id=>router.replace(`/v2/supply-chain/procurement/receipts/${encodeURIComponent(id)}/edit`)}/>
}
