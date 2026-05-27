'use client'

import { useEffect, useState } from 'react'
import axios from 'axios'
import { OrderDetailDrawer } from './OrderDetailDrawer'

interface OrderRow {
  mtOrderId: string
  orderNo: string
  channel: string
  businessTime: string
  checkoutTime: string | null
  status: number
  statusName: string | null
  payed: number
  receivable: number
  discount: number
  customerCount: number
  tableComment: string | null
  cashierName: string | null
  isPartRefund: boolean
}

export function OrderTable() {
  const [rows, setRows] = useState<OrderRow[]>([])
  const [total, setTotal] = useState(0)
  const [pageNo, setPageNo] = useState(1)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  useEffect(() => {
    axios.get(`/api/meituan/orders?pageNo=${pageNo}&pageSize=20`)
      .then(r => { setRows(r.data.items); setTotal(r.data.total) })
      .catch(() => {})
  }, [pageNo])

  return (
    <div className="rounded border bg-white">
      <div className="p-4 border-b flex items-center justify-between">
        <h3 className="text-base font-medium">订单流水</h3>
        <div className="text-sm text-gray-500">共 {total} 单</div>
      </div>
      <table className="w-full text-sm">
        <thead className="bg-gray-50">
          <tr className="text-left text-gray-600">
            <th className="px-4 py-2">结账时间</th>
            <th className="px-4 py-2">订单号</th>
            <th className="px-4 py-2">渠道</th>
            <th className="px-4 py-2">桌号</th>
            <th className="px-4 py-2">收银员</th>
            <th className="px-4 py-2 text-right">应收</th>
            <th className="px-4 py-2 text-right">实收</th>
            <th className="px-4 py-2">状态</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(o => (
            <tr key={o.mtOrderId} className="border-t hover:bg-gray-50 cursor-pointer" onClick={() => setSelectedId(o.mtOrderId)}>
              <td className="px-4 py-2">{o.checkoutTime ? new Date(o.checkoutTime).toLocaleString('zh-CN') : '-'}</td>
              <td className="px-4 py-2 font-mono text-xs">{o.orderNo}</td>
              <td className="px-4 py-2">{o.channel}</td>
              <td className="px-4 py-2">{o.tableComment || '-'}</td>
              <td className="px-4 py-2">{o.cashierName || '-'}</td>
              <td className="px-4 py-2 text-right">¥{o.receivable.toLocaleString()}</td>
              <td className="px-4 py-2 text-right">¥{o.payed.toLocaleString()}</td>
              <td className="px-4 py-2">
                {o.statusName}
                {o.isPartRefund && <span className="ml-1 text-xs text-orange-600">(部分退款)</span>}
              </td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={8} className="py-8 text-center text-gray-400">无订单</td></tr>}
        </tbody>
      </table>
      <div className="p-3 flex justify-between items-center text-sm">
        <div>第 {pageNo} 页</div>
        <div className="space-x-2">
          <button className="px-3 py-1 border rounded disabled:opacity-40" disabled={pageNo === 1} onClick={() => setPageNo(p => p - 1)}>上一页</button>
          <button className="px-3 py-1 border rounded disabled:opacity-40" disabled={rows.length < 20} onClick={() => setPageNo(p => p + 1)}>下一页</button>
        </div>
      </div>

      {selectedId && <OrderDetailDrawer mtOrderId={selectedId} onClose={() => setSelectedId(null)} />}
    </div>
  )
}
