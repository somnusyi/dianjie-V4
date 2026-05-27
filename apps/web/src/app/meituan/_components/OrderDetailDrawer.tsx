'use client'

import { useEffect, useState } from 'react'
import axios from 'axios'

interface OrderDetail {
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
  items: any[]
  payments: any[]
  refundOrders: any[]
}

export function OrderDetailDrawer({ mtOrderId, onClose }: { mtOrderId: string; onClose: () => void }) {
  const [data, setData] = useState<OrderDetail | null>(null)

  useEffect(() => {
    axios.get<OrderDetail>(`/api/meituan/orders/${mtOrderId}`).then(r => setData(r.data)).catch(() => {})
  }, [mtOrderId])

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/30" onClick={onClose} />
      <div className="w-[480px] bg-white shadow-2xl overflow-y-auto">
        <div className="sticky top-0 bg-white border-b p-4 flex justify-between items-center">
          <h3 className="font-semibold">订单 {data?.orderNo}</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-900">✕</button>
        </div>
        {!data ? (
          <div className="p-4 text-gray-400">加载中...</div>
        ) : (
          <div className="p-4 space-y-4 text-sm">
            <div className="grid grid-cols-2 gap-2">
              <Info label="状态" value={data.statusName} />
              <Info label="渠道" value={data.channel} />
              <Info label="桌号" value={data.tableComment || '-'} />
              <Info label="人数" value={data.customerCount.toString()} />
              <Info label="收银员" value={data.cashierName || '-'} />
              <Info label="营业日" value={data.businessTime ? new Date(data.businessTime).toLocaleDateString('zh-CN') : '-'} />
            </div>

            <div>
              <h4 className="font-medium mb-2">菜品明细（{data.items.length}）</h4>
              <table className="w-full text-xs">
                <thead className="bg-gray-50"><tr><th className="px-2 py-1 text-left">菜品</th><th className="px-2 py-1 text-right">数量</th><th className="px-2 py-1 text-right">金额</th></tr></thead>
                <tbody>
                  {data.items.map(i => (
                    <tr key={i.id} className="border-t">
                      <td className="px-2 py-1">{i.name} {i.specs && <span className="text-gray-400">({i.specs})</span>}</td>
                      <td className="px-2 py-1 text-right">×{i.count}</td>
                      <td className="px-2 py-1 text-right">¥{(i.totalPrice / 100).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div>
              <h4 className="font-medium mb-2">支付方式（{data.payments.length}）</h4>
              {data.payments.map(p => (
                <div key={p.id} className="flex justify-between border-t py-1">
                  <span>{p.payTypeName} {p.dealTitle && <span className="text-gray-400 text-xs">{p.dealTitle}</span>}</span>
                  <span>¥{(p.payed / 100).toLocaleString()}</span>
                </div>
              ))}
            </div>

            {data.refundOrders.length > 0 && (
              <div>
                <h4 className="font-medium mb-2 text-red-600">退款（{data.refundOrders.length}）</h4>
                {data.refundOrders.map(r => (
                  <div key={r.id} className="flex justify-between border-t py-1">
                    <span>{r.statusName || `状态 ${r.status}`}</span>
                    <span>¥{(r.refundAmount / 100).toLocaleString()}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="border-t pt-3 space-y-1">
              <Info label="应收" value={`¥${(data.receivable / 100).toLocaleString()}`} />
              <Info label="优惠" value={`-¥${(data.discount / 100).toLocaleString()}`} />
              <Info label="实收" value={`¥${(data.payed / 100).toLocaleString()}`} bold />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function Info({ label, value, bold }: { label: string; value: string | null; bold?: boolean }) {
  return (
    <div className="flex justify-between">
      <span className="text-gray-500">{label}</span>
      <span className={bold ? 'font-semibold' : ''}>{value}</span>
    </div>
  )
}
