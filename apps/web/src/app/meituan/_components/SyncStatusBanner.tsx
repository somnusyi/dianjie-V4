'use client'

import { useEffect, useState } from 'react'
import axios from 'axios'

interface HealthData {
  enabled: boolean
  mode: string
  lastSync?: { createdAt: string } | null
  stats24h: { errorRate: number; totalCalls: number; failedCalls: number }
}

export function SyncStatusBanner() {
  const [data, setData] = useState<HealthData | null>(null)

  useEffect(() => {
    const load = async () => {
      try {
        const resp = await axios.get<HealthData>('/api/admin/meituan/health')
        setData(resp.data)
      } catch {
        setData(null)
      }
    }
    load()
    const t = setInterval(load, 60_000)
    return () => clearInterval(t)
  }, [])

  if (!data) {
    return <div className="rounded bg-gray-100 px-4 py-2 text-sm text-gray-600">加载状态中...</div>
  }

  const lastSyncTime = data.lastSync?.createdAt ? new Date(data.lastSync.createdAt) : null
  const minsSince = lastSyncTime ? Math.floor((Date.now() - lastSyncTime.getTime()) / 60_000) : null
  const errorRate = data.stats24h.errorRate

  const isError = errorRate > 0.3 || (minsSince != null && minsSince > 180)
  const isWarn = !isError && (errorRate > 0.05 || (minsSince != null && minsSince > 90))

  const tone = isError ? 'bg-red-50 border-red-200 text-red-800'
             : isWarn  ? 'bg-yellow-50 border-yellow-200 text-yellow-800'
             :           'bg-green-50 border-green-200 text-green-800'
  const icon = isError ? '🔴' : isWarn ? '🟡' : '🟢'
  const label = isError ? '同步失败' : isWarn ? '数据可能延迟' : '同步正常'

  return (
    <div className={`rounded border px-4 py-2 text-sm ${tone}`}>
      {icon} <strong>{label}</strong>　·
      {lastSyncTime
        ? `上次成功同步 ${minsSince} 分钟前`
        : '尚无成功同步记录'}　·
      24h 错误率 {(errorRate * 100).toFixed(1)}%（{data.stats24h.failedCalls}/{data.stats24h.totalCalls}）　·
      模式：{data.mode}
    </div>
  )
}
