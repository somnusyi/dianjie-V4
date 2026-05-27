'use client'

import { SyncStatusBanner } from './_components/SyncStatusBanner'
import { KpiCards } from './_components/KpiCards'
import { PaymentBreakdown } from './_components/PaymentBreakdown'
import { BusinessTypeBreakdown } from './_components/BusinessTypeBreakdown'
import { TrendLine7d } from './_components/TrendLine7d'
import { OrderTable } from './_components/OrderTable'

export default function MeituanPage() {
  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">美团 POS 数据</h1>
        <div className="text-sm text-gray-500">瑶海店</div>
      </div>

      <SyncStatusBanner />

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <KpiCards />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <PaymentBreakdown />
        <BusinessTypeBreakdown />
      </div>

      <div>
        <TrendLine7d />
      </div>

      <div>
        <OrderTable />
      </div>
    </div>
  )
}
