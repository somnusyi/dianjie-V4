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
  pendingRemoval?: boolean
}

const pendingRemovalStrike = {
  backgroundImage: 'linear-gradient(to bottom, transparent 48%, rgba(95, 94, 90, 0.72) 48%, rgba(95, 94, 90, 0.72) 52%, transparent 52%)',
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
  originalOrderAmount?: string | null
  children?: ReactNode
}) {
  return <section className="mx-4 mt-2 rounded-card border border-border bg-white p-4">
    <div className="text-micro font-num text-gray3">{props.eyebrow}</div>
    <div className="mt-1 flex items-baseline justify-between gap-3">
      <span>
        <span className="block text-h2">{props.name}</span>
        {props.originalOrderAmount && <span className="mt-1 block text-micro text-gray3">原始订单金额 ¥{props.originalOrderAmount}</span>}
      </span>
      <span className="text-right">
        <span className="block text-micro text-gray3">{props.amountLabel}</span>
        <span className="font-num text-h1">¥{props.amount}</span>
      </span>
    </div>
    {props.children}
  </section>
}

export function OrderDeliverySummary({ lines }: { lines: string[] }) {
  if (lines.length === 0) return null
  return <section className="mx-4 mt-3 rounded-card border border-border bg-white p-3">
    <h2 className="text-h2">关联配送单 ({lines.length})</h2>
    <p className="mt-3 break-words text-caption leading-7 text-gray2">
      {lines.map((line, index) => `${index + 1}.${line}`).join('、')}
    </p>
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
  onRestore?: (row: OrderDetailTableRow) => void
  canRemove?: (row: OrderDetailTableRow) => boolean
  notice?: ReactNode
}) {
  return <section className="mx-4 mt-3 rounded-card border border-border bg-white">
    <div className="flex items-center gap-2 px-3 pb-2 pt-3">
      <h2 className="text-h2">商品明细 ({props.rows.length})</h2>
      {props.editable && props.onAdd && <button type="button" onClick={props.onAdd}
        className="rounded-cta border border-amber bg-amber px-3 py-1.5 text-button text-white shadow-sm transition-colors hover:bg-amber/90">＋ 增加商品</button>}
      <span className="ml-auto font-num text-caption text-gray3">合计 ¥{props.total}</span>
      {props.editable && props.onSave && <button type="button" onClick={props.onSave} disabled={!props.dirty || props.saving}
        className="whitespace-nowrap rounded-cta bg-ink px-4 py-1.5 text-button text-white disabled:opacity-40">{props.saving ? '保存中…' : '保存'}</button>}
    </div>
    {props.notice}
    <div className="border-t border-border">
      <table className="w-full table-auto text-left text-micro sm:text-caption">
        <thead className="bg-bg text-micro text-gray3"><tr>
          <th className="w-16 px-3 py-2">序号</th><th className="px-3 py-2">名称</th><th className="px-3 py-2">规格</th>
          <th className="px-3 py-2 text-right">数量</th><th className="px-3 py-2 text-right">单价</th><th className="px-3 py-2 text-right">总价</th>
          {props.editable && <th className="w-20 px-3 py-2 text-right">操作</th>}
        </tr></thead>
        <tbody className="divide-y divide-border">
          {props.rows.map((row, index) => {
            const pendingRemoval = row.pendingRemoval === true
            const rowDirty = Math.abs(row.quantity - row.originalQuantity) >= 0.0001
            const strikeClass = pendingRemoval ? 'line-through decoration-2 decoration-gray3/80' : ''
            const canChangeRemoval = props.canRemove?.(row) ?? true
            return <tr key={row.key} data-state={pendingRemoval ? 'pending-removal' : undefined}
              aria-label={pendingRemoval ? `${row.name}待移除` : undefined}
              className={pendingRemoval ? 'bg-gray5/30 text-gray3' : rowDirty ? 'bg-red-bg/50 text-red-fg' : ''}
              style={pendingRemoval ? pendingRemovalStrike : undefined}>
              <td className={`px-3 py-3 font-num text-gray3 ${strikeClass}`}>{index + 1}</td>
              <td className={`px-3 py-3 ${strikeClass}`}>{row.name}{row.sourceLabel && <span className="mt-0.5 block text-micro text-gray3">{row.sourceLabel}</span>}</td>
              <td className={`px-3 py-3 text-gray2 ${strikeClass}`}>{row.spec || '-'}</td>
              <td className={`px-3 py-3 text-right font-num ${strikeClass}`}>{props.renderQuantity ? props.renderQuantity(row) : <>{row.quantity}{row.unit}</>}</td>
              <td className={`px-3 py-3 text-right font-num ${strikeClass}`}>¥{row.unitPrice.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
              <td className={`px-3 py-3 text-right font-num ${strikeClass}`}>¥{(row.quantity * row.unitPrice).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
              {props.editable && <td className="px-3 py-3 text-right">
                {pendingRemoval
                  ? props.onRestore && canChangeRemoval && <button type="button" onClick={() => props.onRestore?.(row)}
                    className="rounded-cta border border-amber bg-white px-2 py-1 text-micro text-amber-fg">恢复</button>
                  : props.onRemove && canChangeRemoval && <button type="button" onClick={() => props.onRemove?.(row)}
                    className="rounded-cta border border-red-fg/40 px-2 py-1 text-micro text-red-fg">移除</button>}
              </td>}
            </tr>
          })}
          {props.rows.length === 0 && <tr><td colSpan={props.editable ? 7 : 6} className="px-4 py-10 text-center text-caption text-gray3">暂无可展示商品</td></tr>}
        </tbody>
      </table>
    </div>
  </section>
}
