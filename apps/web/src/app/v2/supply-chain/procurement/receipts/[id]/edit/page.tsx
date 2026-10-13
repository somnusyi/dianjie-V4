'use client'
import {useRouter} from 'next/navigation'
import {inventoryDocumentReturnHref} from '@/lib/inventory-document-navigation'
import {ProcurementDocumentEditor} from '@/components/v2/procurement-document-editor'
export default function ReceiptEditPage({params,searchParams}:{params:{id:string};searchParams?:{from?:string|string[]}}){const router=useRouter();return <ProcurementDocumentEditor kind="RECEIPT" sourceId={params.id} onClose={()=>router.push(inventoryDocumentReturnHref(searchParams?.from,'receipt'))}/>}
