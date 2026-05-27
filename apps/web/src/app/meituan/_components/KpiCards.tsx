'use client'

import { useEffect, useState } from 'react'
import axios from 'axios'

interface TodayStats {
  date: string
  orderCount: number
  gmv: number
  avgPrice: number
  refundAmount: number
}

export function KpiCards() {
  const [data, setData] = useState<TodayStats | null>(null)

  useEffect(() => {
    axios.get<TodayStats>('/api/meituan/stats/today').then(r => setData(r.data)).catch(() => {})
  }, [])

  if (!data) return <div className="text-sm text-gray-400">加载中...</div>

  return (
    <>
      <Card label="今日订单" value={data.orderCount.toString()} />
      <Card label="今日营收" value={`¥${data.gmv.toLocaleString()}`} />
      <Card label="均单价" value={`¥${data.avgPrice.toLocaleString()}`} />
      <Card label="今日退款" value={`¥${data.refundAmount.toLocaleString()}`} />
    </>
  )
}

function Card({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border bg-white p-4 shadow-sm">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-2xl font-semibold mt-1">{value}</div>
    </div>
  )
}
