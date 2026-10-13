'use client'
import { useRouter } from 'next/navigation'
import { useCallback, useState } from 'react'
import { WarehouseDocumentEditor } from './warehouse-document-editor'
import {inventoryDocumentHref,inventoryDocumentReturnHref} from '@/lib/inventory-document-navigation'
import { getUser } from '@/lib/v2-auth'
export function NewWarehouseDocumentPage({newType='MANUAL_INBOUND',from}:{newType?:'MANUAL_INBOUND'|'MANUAL_OUTBOUND';from?:unknown}) {
  const router = useRouter(), user = getUser()
  const [notice,setNotice] = useState('')
  const created = useCallback((id: string, message?: string) => {
    if (message) try {
      const tenant = JSON.parse(localStorage.getItem('tenant') || 'null')
      const actor = getUser()
      if (tenant?.id && actor?.id) sessionStorage.setItem(`dj:warehouse-created:${tenant.id}:${actor.id}`, JSON.stringify({ id, message }))
    } catch {}
    router.replace(inventoryDocumentHref(`/v2/supply-chain/docs/${encodeURIComponent(id)}/edit`,from))
  }, [router,from])
  return <>{notice && <p role="status">{notice}</p>}<WarehouseDocumentEditor newType={newType} fullPage canAudit={user?.role === 'SUPPLY_CHAIN'} canReview={user?.role === 'SUPPLY_CHAIN'} canEdit={['SUPPLY_CHAIN','SUPER_ADMIN','ADMIN','PURCHASER'].includes(user?.role || '')} onClose={() => router.push(inventoryDocumentReturnHref(from))} onChanged={setNotice} onCreated={created} /></>
}
