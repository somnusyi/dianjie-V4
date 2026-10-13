'use client'

/**
 * DJ-002 / REQ-FIN-001 / DEC-023：账务三类只读详情弹窗。
 * - 账期：到期/付款状态 + 来源入库单（单张）+ 商品下钻
 * - 对账单：期间/状态/总金额 + 全部组成来源单（各自对账金额与原单金额）+ 商品下钻
 * - 发票：票面资料 + 关联入库单 + 已授权签名附件
 * 全部只读：不提供付款、审核、银行操作；金额取服务器值，前端不重算。
 * 状态流：closed(父级卸载) → loading(type,id) → ready/error；sourceLoading(receiptId) → sourceReady/error。
 * 每次请求捕获当前 type/id（effect 闭包），关闭/换单/切tab由父级卸载或 key 重挂，迟到请求一律丢弃。
 */
import { useEffect, useState, type ReactNode } from 'react'
import { apiFetch } from '@/lib/v2-auth'
import type {
  BillingDetailType, InvoiceDetail, ReceiptSourceDetail,
  ReconciliationDetail, ScheduleDetail,
} from './detail-types'

type DetailError = { status?: number; message: string }

type DetailState =
  | { phase: 'loading' }
  | { phase: 'ready'; data: ScheduleDetail | ReconciliationDetail | InvoiceDetail }
  | { phase: 'error'; error: DetailError }

type SourceState =
  | { phase: 'loading'; receiptId: string; seq: number }
  | { phase: 'ready'; receiptId: string; seq: number; data: ReceiptSourceDetail }
  | { phase: 'error'; receiptId: string; seq: number; error: DetailError }

const TYPE_LABEL: Record<BillingDetailType, string> = {
  schedule: '账期详情',
  reconciliation: '对账单详情',
  invoice: '发票详情',
}

function money(value: number | string | null | undefined) {
  return `¥${Number(value || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`
}

function moneyOrDash(value: number | string | null | undefined) {
  return value === null || value === undefined || value === '' ? '—' : money(value)
}

function qty(value: number | string | null | undefined) {
  return value === null || value === undefined || value === ''
    ? '—'
    : Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 2 })
}

function dateOnly(value?: string | null) {
  return value?.slice(0, 10) || '—'
}

function taxRateText(value: number | string | null | undefined) {
  if (value === null || value === undefined || value === '') return '—'
  const rate = Number(value)
  return Number.isFinite(rate) ? `${(rate * 100).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}%` : '—'
}

function toError(reason: unknown): DetailError {
  const err = reason as { status?: number; message?: string } | undefined
  return { status: err?.status, message: String(err?.message || reason) }
}

function detailErrorText(error: DetailError) {
  if (error.status === 404) return '记录不存在或已被删除'
  if (error.status === 403) return '无权限查看该记录'
  return `详情加载失败：${error.message || '网络异常'}，可重试`
}

function sourceErrorText(error: DetailError) {
  if (error.status === 404) return '来源入库单不存在'
  if (error.status === 403) return '无权限查看该来源入库单'
  return `来源明细加载失败：${error.message || '网络异常'}，可重试`
}

export function BillingDetailDialog({ type, id, titleHint, onClose }: {
  type: BillingDetailType
  id: string
  titleHint?: string
  onClose: () => void
}) {
  // loadSeq 仅作为只读重试/刷新签名触发器：递增后 effect 重跑并清空旧状态
  const [loadSeq, setLoadSeq] = useState(0)
  const [state, setState] = useState<DetailState>({ phase: 'loading' })
  const [source, setSource] = useState<SourceState | null>(null)

  useEffect(() => {
    // 每次打开/换单/重试都清空旧详情与旧来源明细，不沿用另一单数据
    setState({ phase: 'loading' })
    setSource(null)
    let alive = true
    const path = type === 'schedule'
      ? `/api/schedules/${id}`
      : type === 'reconciliation' ? `/api/reconciliations/${id}` : `/api/invoices/${id}`
    apiFetch<ScheduleDetail | ReconciliationDetail | InvoiceDetail>(path)
      .then(data => { if (alive) setState({ phase: 'ready', data }) })
      .catch(reason => { if (alive) setState({ phase: 'error', error: toError(reason) }) })
    return () => { alive = false }
  }, [type, id, loadSeq])

  useEffect(() => {
    if (!source || source.phase !== 'loading') return
    let alive = true
    const { receiptId } = source
    apiFetch<ReceiptSourceDetail>(`/api/receipts/${receiptId}`)
      .then(data => {
        if (!alive) return
        setSource(prev => (prev && prev.phase === 'loading' && prev.receiptId === receiptId
          ? { ...prev, phase: 'ready', data } : prev))
      })
      .catch(reason => {
        if (!alive) return
        setSource(prev => (prev && prev.phase === 'loading' && prev.receiptId === receiptId
          ? { ...prev, phase: 'error', error: toError(reason) } : prev))
      })
    return () => { alive = false }
  }, [source])

  const openSource = (receiptId: string) => {
    setSource(prev => ({ phase: 'loading', receiptId, seq: (prev?.seq ?? 0) + 1 }))
  }

  const retryDetail = () => setLoadSeq(seq => seq + 1)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/60 p-4" onClick={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-label="账务详情"
        onClick={event => event.stopPropagation()}
        className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-card bg-white shadow-xl"
      >
        <header className="flex items-center justify-between border-b border-border px-5 py-4">
          <div>
            <h2 className="text-h2">{TYPE_LABEL[type]}</h2>
            {titleHint && <p className="mt-0.5 text-micro text-gray3">{titleHint}</p>}
          </div>
          <button type="button" onClick={onClose} aria-label="关闭" className="text-2xl text-gray3">×</button>
        </header>
        <div className="overflow-y-auto p-5">
          {state.phase === 'loading' && (
            <div className="py-10 text-center text-caption text-gray3">正在加载详情…</div>
          )}
          {state.phase === 'error' && (
            <div className="rounded-card border border-red/30 bg-red-bg p-4">
              <p className="text-caption text-red-fg" data-testid="detail-error">{detailErrorText(state.error)}</p>
              <button
                type="button"
                onClick={retryDetail}
                className="mt-3 rounded-cta border border-ink px-4 py-1.5 text-button text-ink"
              >重试</button>
            </div>
          )}
          {state.phase === 'ready' && (source === null || source.phase === 'error') && type === 'schedule'
            && <ScheduleDetailBody detail={state.data as ScheduleDetail} onOpenSource={openSource} />}
          {state.phase === 'ready' && (source === null || source.phase === 'error') && type === 'reconciliation'
            && <ReconciliationDetailBody detail={state.data as ReconciliationDetail} onOpenSource={openSource} />}
          {state.phase === 'ready' && (source === null || source.phase === 'error') && type === 'invoice'
            && <InvoiceDetailBody
              detail={state.data as InvoiceDetail}
              onOpenSource={openSource}
              onRefreshSignature={retryDetail}
            />}
          {state.phase === 'ready' && source !== null && (
            <SourcePanel source={source} onBack={() => setSource(null)} onRetry={openSource} />
          )}
        </div>
      </section>
    </div>
  )
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  return <div className="rounded-lg bg-bg p-3"><dt className="text-micro text-gray3">{label}</dt><dd className="mt-1 break-words text-body text-ink">{value}</dd></div>
}

function SourceListEntry({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mt-4 rounded-card border border-border p-3">
      <div className="mb-2 text-button text-ink">{label}</div>
      {children}
    </div>
  )
}

function NoAttachment() {
  return <div className="mt-4 rounded-card border border-border p-3 text-caption text-gray2">附件：无可用附件</div>
}

function ScheduleDetailBody({ detail, onOpenSource }: {
  detail: ScheduleDetail
  onOpenSource: (receiptId: string) => void
}) {
  return (
    <div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
        <Field label="供应商" value={detail.supplier?.name || '—'} />
        <Field label="状态" value={detail.status} />
        <Field label="金额" value={moneyOrDash(detail.amount)} />
        <Field label="到期日" value={dateOnly(detail.dueAt)} />
        <Field label="付款日期" value={detail.paidAt ? dateOnly(detail.paidAt) : '未付款'} />
      </dl>
      {detail.receipt ? (
        <SourceListEntry label="来源入库单">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-caption text-gray2">
            <span className="font-num text-ink">{detail.receipt.no}</span>
            <span>到货日期 {dateOnly(detail.receipt.deliveryDate)}</span>
            <span>门店 {detail.receipt.store?.name || '—'}</span>
            <span>原单金额 <b className="font-num text-ink">{moneyOrDash(detail.receipt.totalAmount)}</b></span>
          </div>
          <button
            type="button"
            onClick={() => onOpenSource(detail.receipt!.id)}
            className="mt-3 rounded-cta border border-border px-3 py-1.5 text-button text-accent"
          >查看商品明细</button>
        </SourceListEntry>
      ) : (
        <div className="mt-4 rounded-card border border-border p-3 text-caption text-gray2">无来源入库单关联，不可下钻</div>
      )}
      <NoAttachment />
    </div>
  )
}

function ReconciliationDetailBody({ detail, onOpenSource }: {
  detail: ReconciliationDetail
  onOpenSource: (receiptId: string) => void
}) {
  const visibleSum = detail.items.reduce((sum, item) => sum + Number(item.amount || 0), 0)
  const total = Number(detail.totalAmount || 0)
  const compositionMismatch = Math.abs(visibleSum - total) > 0.005
  return (
    <div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
        <Field label="对账单号" value={detail.no} />
        <Field label="供应商" value={detail.supplier?.name || '—'} />
        <Field label="供应商编号" value={detail.supplier?.no || '—'} />
        <Field label="对账期间" value={`${dateOnly(detail.periodStart)} 至 ${dateOnly(detail.periodEnd)}`} />
        <Field label="状态" value={detail.status} />
        <Field label="对账总金额" value={moneyOrDash(detail.totalAmount)} />
      </dl>
      <SourceListEntry label={`组成单据（${detail.items.length} 张）`}>
        {compositionMismatch && (
          <p className="mb-2 rounded-lg bg-red-bg p-2 text-micro text-red-fg">
            组成金额合计 {money(visibleSum)}，与对账总金额 {moneyOrDash(detail.totalAmount)} 不一致；可能存在缺失或不可见的组成单据，以下仅呈现当前可见部分。
          </p>
        )}
        {detail.items.length === 0 && <p className="text-caption text-gray3">暂无可见的组成单据</p>}
        <ul className="divide-y divide-border">
          {detail.items.map(item => (
            <li key={item.receiptId} className="flex flex-wrap items-center gap-x-6 gap-y-2 py-2 text-caption text-gray2">
              {item.receipt ? (
                <>
                  <span className="font-num text-ink">{item.receipt.no}</span>
                  <span>到货日期 {dateOnly(item.receipt.deliveryDate)}</span>
                  <span>对账金额 <b className="font-num text-ink">{moneyOrDash(item.amount)}</b></span>
                  <span>原单金额 <span className="font-num">{moneyOrDash(item.receipt.totalAmount)}</span></span>
                  <button
                    type="button"
                    onClick={() => onOpenSource(item.receipt!.id)}
                    className="ml-auto rounded-cta border border-border px-3 py-1 text-button text-accent"
                  >查看商品明细</button>
                </>
              ) : (
                <span className="text-red-fg">来源单不可见或已损坏，对账金额 {moneyOrDash(item.amount)}，不可下钻</span>
              )}
            </li>
          ))}
        </ul>
      </SourceListEntry>
      <NoAttachment />
    </div>
  )
}

function InvoiceDetailBody({ detail, onOpenSource, onRefreshSignature }: {
  detail: InvoiceDetail
  onOpenSource: (receiptId: string) => void
  onRefreshSignature: () => void
}) {
  return (
    <div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
        <Field label="发票号码" value={detail.invoiceNo} />
        <Field label="发票代码" value={detail.invoiceCode || '—'} />
        <Field label="状态" value={detail.status} />
        <Field label="价税合计" value={moneyOrDash(detail.amount)} />
        <Field label="不含税金额" value={moneyOrDash(detail.amountWithoutTax)} />
        <Field label="税率" value={taxRateText(detail.taxRate)} />
        <Field label="税额" value={moneyOrDash(detail.taxAmount)} />
        <Field label="开票日期" value={dateOnly(detail.issueDate)} />
        <Field label="备注" value={detail.note || '—'} />
      </dl>
      <div className="mt-4 flex flex-wrap items-center gap-3 rounded-card border border-border p-3">
        <span className="text-caption text-gray2">附件：</span>
        {detail.fileUrl ? (
          <>
            <a
              href={detail.fileUrl}
              target="_blank"
              rel="noreferrer"
              className="text-button text-accent underline"
            >查看附件（{detail.fileType === 'pdf' ? 'PDF' : '图片'}）</a>
            <button
              type="button"
              onClick={onRefreshSignature}
              className="rounded-cta border border-border px-3 py-1 text-micro text-gray2"
            >刷新签名</button>
          </>
        ) : (
          <span className="text-caption text-gray2">无可用附件</span>
        )}
      </div>
      <SourceListEntry label={`关联入库单（${detail.receipts?.length || 0} 张）`}>
        {(detail.receipts?.length || 0) === 0 && <p className="text-caption text-gray3">暂无关联入库单</p>}
        <ul className="divide-y divide-border">
          {(detail.receipts || []).map(receipt => (
            <li key={receipt.id} className="flex flex-wrap items-center gap-x-6 gap-y-2 py-2 text-caption text-gray2">
              <span className="font-num text-ink">{receipt.no}</span>
              <span>到货日期 {dateOnly(receipt.deliveryDate)}</span>
              <span>门店 {receipt.store?.name || '—'}</span>
              <span>金额 <span className="font-num">{moneyOrDash(receipt.totalAmount)}</span></span>
              <button
                type="button"
                onClick={() => onOpenSource(receipt.id)}
                className="ml-auto rounded-cta border border-border px-3 py-1 text-button text-accent"
              >查看商品明细</button>
            </li>
          ))}
        </ul>
      </SourceListEntry>
    </div>
  )
}

function SourcePanel({ source, onBack, onRetry }: {
  source: SourceState
  onBack: () => void
  onRetry: (receiptId: string) => void
}) {
  return (
    <div data-testid="source-panel">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-button text-ink">来源入库商品明细</h3>
        <button
          type="button"
          onClick={onBack}
          className="rounded-cta border border-border px-3 py-1.5 text-button text-gray2"
        >返回来源列表</button>
      </div>
      {source.phase === 'loading' && <div className="py-8 text-center text-caption text-gray3">正在加载商品明细…</div>}
      {source.phase === 'error' && (
        <div className="rounded-card border border-red/30 bg-red-bg p-4">
          <p className="text-caption text-red-fg" data-testid="source-error">{sourceErrorText(source.error)}</p>
          <button
            type="button"
            onClick={() => onRetry(source.receiptId)}
            className="mt-3 rounded-cta border border-ink px-4 py-1.5 text-button text-ink"
          >重试</button>
        </div>
      )}
      {source.phase === 'ready' && (
        <div>
          <div className="mb-2 flex flex-wrap gap-x-6 text-caption text-gray2">
            <span className="font-num text-ink">{source.data.no}</span>
            <span>到货日期 {dateOnly(source.data.deliveryDate)}</span>
            <span>门店 {source.data.store?.name || '—'}</span>
            <span>入库单总金额 <b className="font-num text-ink">{moneyOrDash(source.data.totalAmount)}</b></span>
          </div>
          {(source.data.items || []).some(item =>
            !item.productCodeSnapshot || !item.productNameSnapshot || !item.productUnitSnapshot
          ) && <p className="mb-3 text-caption text-gray2" role="status">历史商品快照缺失，相关字段待核；金额沿用原单据。</p>}
          <div className="overflow-hidden rounded-card border border-border">
            <table className="w-full text-left text-caption">
              <thead className="bg-bg text-gray3">
                <tr>
                  <th className="px-3 py-2">编码</th>
                  <th className="px-3 py-2">名称</th>
                  <th className="px-3 py-2">规格</th>
                  <th className="px-3 py-2">单位</th>
                  <th className="px-3 py-2 text-right">数量</th>
                  <th className="px-3 py-2 text-right">单价</th>
                  <th className="px-3 py-2 text-right">金额</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {(source.data.items || []).map(item => (
                  <tr key={item.id}>
                    <td className="px-3 py-2 font-num">{item.productCodeSnapshot || '—'}</td>
                    <td className="px-3 py-2">{item.productNameSnapshot || '—'}</td>
                    <td className="px-3 py-2 text-gray2">{item.productSpecSnapshot || '—'}</td>
                    <td className="px-3 py-2 text-gray2">{item.productUnitSnapshot || '—'}</td>
                    <td className="px-3 py-2 text-right font-num">{qty(item.quantity)}</td>
                    <td className="px-3 py-2 text-right font-num">{moneyOrDash(item.unitPrice)}</td>
                    <td className="px-3 py-2 text-right font-num">{moneyOrDash(item.amount)}</td>
                  </tr>
                ))}
                {(source.data.items?.length || 0) === 0 && (
                  <tr><td colSpan={7} className="px-3 py-6 text-center text-gray3">该入库单无商品明细</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
