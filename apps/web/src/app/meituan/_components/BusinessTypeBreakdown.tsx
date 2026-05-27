'use client'

import { useEffect, useState } from 'react'
import axios from 'axios'

interface Row { channel: string; orderCount: number; gmv: number; percentage: number }

const CHANNEL_LABEL: Record<string, string> = {
  INSTORE: '堂食',
  WAIMAI_MT: '美团外卖',
  WAIMAI_ELE: '饿了么',
  SELF: '自营外卖',
  UNKNOWN: '其他',
}

export function BusinessTypeBreakdown() {
  const [rows, setRows] = useState<Row[]>([])

  useEffect(() => {
    axios.get<Row[]>('/api/meituan/stats/business-type-breakdown').then(r => setRows(r.data)).catch(() => {})
  }, [])

  return (
    <div className="rounded border bg-white p-4">
      <h3 className="text-base font-medium mb-3">业务类型分布</h3>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-gray-500 border-b">
            <th className="py-2">渠道</th>
            <th className="py-2 text-right">订单数</th>
            <th className="py-2 text-right">营收</th>
            <th className="py-2 text-right">占比</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.channel} className="border-b last:border-0">
              <td className="py-2">{CHANNEL_LABEL[r.channel] ?? r.channel}</td>
              <td className="py-2 text-right">{r.orderCount}</td>
              <td className="py-2 text-right">¥{r.gmv.toLocaleString()}</td>
              <td className="py-2 text-right">{(r.percentage * 100).toFixed(1)}%</td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={4} className="py-4 text-center text-gray-400">无数据</td></tr>}
        </tbody>
      </table>
    </div>
  )
}
