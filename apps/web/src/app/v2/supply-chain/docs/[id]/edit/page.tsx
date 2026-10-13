'use client'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { WarehouseDocumentEditor, type WarehouseDocumentAction } from '../../warehouse-document-editor'
import {inventoryDocumentReturnHref} from '@/lib/inventory-document-navigation'
import { getUser } from '@/lib/v2-auth'

export default function WarehouseDocumentEditPage({ params,searchParams }: { params: { id: string };searchParams?:{from?:string|string[]} }) {
  const router = useRouter()
  const user = getUser()
  const [notice, setNotice] = useState('')
  const noticeDocId = useRef('')
  const [action, setAction] = useState<WarehouseDocumentAction>()
  useEffect(() => {
    setAction(undefined)
    if (noticeDocId.current !== params.id) { noticeDocId.current = params.id; setNotice('') }
    try {
      const tenant = JSON.parse(localStorage.getItem('tenant') || 'null')
      const actor = getUser()
      if (tenant?.id && actor?.id) {
        const key = `dj:warehouse-created:${tenant.id}:${actor.id}`
        const saved = JSON.parse(sessionStorage.getItem(key) || 'null')
        if (saved?.id === params.id && typeof saved.message === 'string') { setNotice(saved.message); sessionStorage.removeItem(key) }
      }
    } catch {}
    const value = new URLSearchParams(window.location.search).get('action')
    if (['audit','unconfirm','review','print','quality'].includes(value || '')) setAction(value as WarehouseDocumentAction)
  }, [params.id])
  return <>
    {notice && <p role="status" className="border-b border-border bg-emerald-50 px-6 py-2 text-emerald-700">{notice}</p>}
    <WarehouseDocumentEditor docId={params.id} fullPage initialAction={action}
      canAudit={user?.role === 'SUPPLY_CHAIN'} canReview={user?.role === 'SUPPLY_CHAIN'}
      canEdit={['SUPER_ADMIN','ADMIN','PURCHASER','SUPPLY_CHAIN'].includes(user?.role || '')}
      onClose={() => router.push(inventoryDocumentReturnHref(searchParams?.from))} onChanged={setNotice} />
  </>
}
