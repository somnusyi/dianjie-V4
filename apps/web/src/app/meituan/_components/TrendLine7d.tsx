'use client'

import { useEffect, useState } from 'react'
import axios from 'axios'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts'

interface Row { date: string; gmv: number; orderCount: number }

export function TrendLine7d() {
  const [rows, setRows] = useState<Row[]>([])

  useEffect(() => {
    axios.get<Row[]>('/api/meituan/stats/trend?days=7').then(r => setRows(r.data)).catch(() => {})
  }, [])

  return (
    <div className="rounded border bg-white p-4">
      <h3 className="text-base font-medium mb-3">近 7 日营收趋势</h3>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows}>
            <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
            <XAxis dataKey="date" />
            <YAxis tickFormatter={(v) => `¥${v}`} />
            <Tooltip formatter={(v: number) => `¥${v.toLocaleString()}`} />
            <Line type="monotone" dataKey="gmv" stroke="#3b82f6" strokeWidth={2} dot />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
