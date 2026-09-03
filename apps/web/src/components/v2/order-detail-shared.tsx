import type { ReactNode } from 'react'
import { Chip, ProgressDots } from '@/components/v2'

export type OrderDetailTableRow = {
  key: string
  name: string
  spec: string | null
  unit: string
  quantity: number
  unitPrice: number
  originalQuantity: number
  sourceLabel?: string
}

export function OrderDetailHeader(props: {
  title?: string
  statusLabel: string
  statusTone: 'gray' | 'green' | 'red' | 'orange' | 'blue'
  onBack: () => void
  onDeliveryNote: () => void
}) {
  return <header className="flex items-center gap-2 px-4 pb-2 pt-4">
    <button type="button" onClick={props.onBack} className="flex h-9 w-9 items-center justify-center rounded-full border border-border bg-white">‹</button>
    <h1 className="flex-1 truncate text-h1">{props.title || '订单详情'}</h1>
    <button type="button" onClick={props.onDeliveryNote} title="打开打印 / 导出 PDF 页面"
      className="whitespace-nowrap rounded-cta border border-border bg-white px-3 py-1.5 text-button text-gray2">🖨 送货单</button>
    <Chip tone={props.statusTone}>{props.statusLabel}</Chip>
  </header>
}

export function OrderAmountCard(props: {
  eyebrow: ReactNode
  name: ReactNode
  amountLabel: string
  amount: string
  orderedAmount?: string | null
  children?: ReactNode
}) {
  return <section className="mx-4 mt-2 rounded-card border border-border bg-white p-4">
    <div className="text-micro font-num text-gray3">{props.eyebrow}</div>
    <div className="mt-1 flex items-baseline justify-between gap-3">
      <span className="text-h2">{props.name}</span>
      <span className="text-right">
        <span className="block text-micro text-gray3">{props.amountLabel}</span>
        <span className="font-num text-h1">¥{props.amount}</span>
        {props.orderedAmount && <span className="mt-0.5 block text-micro text-gray3">订货 ¥{props.orderedAmount}</span>}
      </span>
    </div>
    {props.children}
  </section>
}

export function OrderDeliverySummary({ lines }: { lines: string[] }) {
  if (lines.length === 0) return null
  return <section className="mx-4 mt-3 rounded-card border border-border bg-white p-3">
    <h2 className="text-h2">关联配送单 ({lines.length})</h2>
    <p className="mt-2 overflow-x-auto whitespace-nowrap text-caption text-gray2">{lines.map((line, index) => `${index + 1}${line}`).join('、')}</p>
  </section>
}

export function OrderProgressCard({ currentIndex }: { currentIndex: number }) {
  return <section className="mx-4 mt-3 rounded-card border border-border bg-white p-4">
    <ProgressDots steps={['已发起', '已接单', '在途', '送达', '门店已收'].map(label => ({ label }))} currentIndex={currentIndex} />
  </section>
}

export function OrderProductTable(props: {
  rows: OrderDetailTableRow[]
  editable: boolean
  total: string
  saving?: boolean
  dirty?: boolean
  onAdd?: () => void
  onSave?: () => void
  renderQuantity?: (row: OrderDetailTableRow) => ReactNode
  onRemove?: (row: OrderDetailTableRow) => void
  notice?: ReactNode
}) {
  return <section className="mx-4 mt-3 rounded-card border border-border bg-white">
    <div className="flex items-center gap-2 px-3 pb-2 pt-3">
      <h2 className="text-h2">商品明细 ({props.rows.length})</h2>
      {props.editable && props.onAdd && <button type="button" onClick={props.onAdd} className="rounded-cta border border-amber px-2 py-1 text-caption text-amber-fg">＋ 增加商品</button>}
      <span className="ml-auto font-num text-caption text-gray3">合计 ¥{props.total}</span>
      {props.editable && props.onSave && <button type="button" onClick={props.onSave} disabled={!props.dirty || props.saving}
        className="whitespace-nowrap rounded-cta bg-ink px-4 py-1.5 text-button text-white disabled:opacity-40">{props.saving ? '保存中…' : '保存'}</button>}
    </div>
    {props.notice}
    <div className="overflow-x-auto border-t border-border">
      <table className="w-full min-w-[760px] text-left text-caption">
        <thead className="bg-bg text-micro text-gray3"><tr>
          <th className="w-16 px-3 py-2">序号</th><th className="px-3 py-2">名称</th><th className="px-3 py-2">规格</th>
          <th className="px-3 py-2 text-right">数量</th><th className="px-3 py-2 text-right">单价</th><th className="px-3 py-2 text-right">总价</th>
          {props.editable && <th className="w-20 px-3 py-2 text-right">操作</th>}
        </tr></thead>
        <tbody className="divide-y divide-border">
          {props.rows.map((row, index) => {
            const rowDirty = Math.abs(row.quantity - row.originalQuantity) >= 0.0001
            return <tr key={row.key} className={rowDirty ? 'bg-red-bg/50 text-red-fg' : ''}>
              <td className="px-3 py-3 font-num text-gray3">{index + 1}</td>
              <td className="px-3 py-3">{row.name}{row.sourceLabel && <span className="mt-0.5 block text-micro text-gray3">{row.sourceLabel}</span>}</td>
              <td className="px-3 py-3 text-gray2">{row.spec || '-'}</td>
              <td className="px-3 py-3 text-right font-num">{props.renderQuantity ? props.renderQuantity(row) : <>{row.quantity}{row.unit}</>}</td>
              <td className="px-3 py-3 text-right font-num">¥{row.unitPrice.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
              <td className="px-3 py-3 text-right font-num">¥{(row.quantity * row.unitPrice).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
              {props.editable && <td className="px-3 py-3 text-right">{props.onRemove && <button type="button" onClick={() => props.onRemove?.(row)}
                className="rounded-cta border border-red-fg/40 px-2 py-1 text-micro text-red-fg">移除</button>}</td>}
            </tr>
          })}
          {props.rows.length === 0 && <tr><td colSpan={props.editable ? 7 : 6} className="px-4 py-10 text-center text-caption text-gray3">暂无可展示商品</td></tr>}
        </tbody>
      </table>
    </div>
  </section>
}
