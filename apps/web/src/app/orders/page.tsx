'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { legacyOrdersDestination } from './legacy-orders-redirect'

/**
 * The original `/orders` screen predates the split shipment/delivery workflow.
 * It called the shipment endpoint while presenting the action as "delivered",
 * bypassing the current quantity review and actual-person capture. Keep the URL
 * only as a role-aware compatibility redirect; all writes happen in the v2
 * role pages.
 */
export default function LegacyOrdersRedirectPage() {
  const router = useRouter()

  useEffect(() => {
    let role: string | undefined
    try {
      const raw = localStorage.getItem('dj_user')
      role = raw ? JSON.parse(raw)?.role : undefined
    } catch {
      role = undefined
    }
    router.replace(legacyOrdersDestination(role))
  }, [router])

  return (
    <main className="flex min-h-screen items-center justify-center bg-bg px-6 text-center">
      <div>
        <p className="text-h2 text-ink">正在进入新版订单流程…</p>
        <p className="mt-2 text-caption text-gray2">发货与送达已分开记录，并分别保存实际分拣人和配送人。</p>
      </div>
    </main>
  )
}
