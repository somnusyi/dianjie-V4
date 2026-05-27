'use client'

import { useEffect, useState } from 'react'
import axios from 'axios'
import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from 'recharts'

interface Row { payTypeName: string; totalAmount: number; orderCount: number; percentage: number }

const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#14b8a6', '#f97316']

export function PaymentBreakdown() {
  const [rows, setRows] = useState<Row[]>([])

  useEffect(() => {
    axios.get<Row[]>('/api/meituan/stats/payment-breakdown').then(r => setRows(r.data)).catch(() => {})
  }, [])

  return (
    <div className="rounded border bg-white p-4">
      <h3 className="text-base font-medium mb-3">支付方式分布</h3>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={rows} dataKey="totalAmount" nameKey="payTypeName" cx="50%" cy="50%" outerRadius={80} label={(e: any) => `${e.payTypeName} ${(e.percentage * 100).toFixed(0)}%`}>
              {rows.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
            </Pie>
            <Tooltip formatter={(v: number) => `¥${v.toLocaleString()}`} />
            <Legend />
          </PieChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
