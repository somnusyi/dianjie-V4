/**
 * 财务 · 凭证详情
 * - 借贷分录可看
 * - 草稿可改/作废, 已审可反审 (未导出)
 */
'use client'
import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import dayjs from 'dayjs'
import { Chip } from '@/components/v2'
import { ErrorScreen } from '@/components/v2/use-dashboard'
import { apiFetch } from '@/lib/v2-auth'

type Entry = {
  id: string; lineNo: number; summary: string
  accountCode: string; accountName: string
  debit: string; credit: string
}
type Voucher = {
  id: string; no: string; date: string; word: string; summary: string
  sourceType?: string | null
  sourceId?: string | null
  totalDebit: string; totalCredit: string
  status: 'DRAFT' | 'POSTED' | 'VOIDED'
  postedAt?: string | null
  postedById?: string | null
  exportedAt?: string | null
  createdAt: string
  entries: Entry[]
}

const STATUS_LABEL: Record<string, string> = {
  DRAFT: '草稿', POSTED: '已审', VOIDED: '已作废',
}
const SOURCE_LABEL: Record<string, string> = {
  Receipt: '收货入库', Payment: '付款给供应商', LossClaim: '报损损耗', Revenue: '营业额', Manual: '手工录入',
}

export default function VoucherDetailPage() {
  const router = useRouter()
  const params = useParams() as any
  const id = String(params.id)
  const [v, setV] = useState<Voucher | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function reload() {
    setError(null)
    try {
      const d = await apiFetch<Voucher>(`/api/vouchers/${id}`)
      setV(d)
    } catch (e: any) {
      setError(e.message || String(e))
    }
  }
  useEffect(() => { reload() }, [id])

  async function action(path: string, confirmMsg?: string) {
    if (confirmMsg && !confirm(confirmMsg)) return
    setBusy(true)
    try {
      await apiFetch(`/api/vouchers/${id}/${path}`, { method: 'PATCH' })
      await reload()
    } catch (e: any) {
      alert(e.message)
    } finally { setBusy(false) }
  }

  if (error) return <ErrorScreen message={error} />
  if (!v) return <div className="min-h-screen bg-bg flex items-center justify-center text-gray3">加载中…</div>

  const tone = v.status === 'POSTED' ? 'green' : v.status === 'VOIDED' ? 'gray' : 'red'

  return (
    <div className="min-h-screen bg-bg pb-32">
      <header className="px-4 pt-4 pb-2 flex items-center gap-2">
        <button onClick={() => router.back()} className="text-gray2 text-h2">‹</button>
        <h1 className="text-h1">凭证详情</h1>
      </header>

      {/* 凭证头 */}
      <div className="mx-4 mt-2 bg-white rounded-card border border-border p-3">
        <div className="flex items-center gap-2 mb-2 flex-wrap">
          <Chip tone={tone as any}>{STATUS_LABEL[v.status]}</Chip>
          {v.sourceType && <Chip tone="amber">{SOURCE_LABEL[v.sourceType] || v.sourceType}</Chip>}
          {v.exportedAt && <Chip tone="gray">已导出</Chip>}
          <span className="text-micro text-gray3 ml-auto">{dayjs(v.date).format('YYYY-MM-DD')}</span>
        </div>
        <div className="text-h2 font-num">{v.no}</div>
        <p className="text-caption text-gray2 mt-1">{v.summary}</p>
        <div className="grid grid-cols-2 mt-2 gap-2 text-caption">
          <div>
            <span className="text-gray3">借方合计</span>
            <span className="ml-2 font-num">¥{Number(v.totalDebit).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
          </div>
          <div>
            <span className="text-gray3">贷方合计</span>
            <span className="ml-2 font-num">¥{Number(v.totalCredit).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
          </div>
        </div>
        {v.exportedAt && (
          <p className="text-micro text-gray3 mt-2">导出时间: {dayjs(v.exportedAt).format('YYYY-MM-DD HH:mm')}</p>
        )}
      </div>

      {/* 分录列表 */}
      <div className="mx-4 mt-3 bg-white rounded-card border border-border overflow-hidden">
        <div className="px-3 py-2 bg-bg-warm border-b border-border text-caption text-gray2 grid grid-cols-12 gap-2">
          <span className="col-span-1">行</span>
          <span className="col-span-3">科目编码</span>
          <span className="col-span-4">科目名称</span>
          <span className="col-span-2 text-right">借</span>
          <span className="col-span-2 text-right">贷</span>
        </div>
        {v.entries.map(e => (
          <div key={e.id} className="px-3 py-2 border-b border-border last:border-b-0 grid grid-cols-12 gap-2 text-caption">
            <span className="col-span-1 text-gray3">{e.lineNo}</span>
            <span className="col-span-3 font-num">{e.accountCode}</span>
            <div className="col-span-4">
              <div>{e.accountName}</div>
              {e.summary !== v.summary && (
                <div className="text-micro text-gray3 truncate">{e.summary}</div>
              )}
            </div>
            <span className="col-span-2 text-right font-num">{Number(e.debit) > 0 ? '¥' + Number(e.debit).toFixed(2) : ''}</span>
            <span className="col-span-2 text-right font-num">{Number(e.credit) > 0 ? '¥' + Number(e.credit).toFixed(2) : ''}</span>
          </div>
        ))}
      </div>

      {/* 操作按钮 */}
      <div className="mx-4 mt-4 flex gap-2">
        {v.status === 'DRAFT' && (
          <>
            <button onClick={() => action('post', '确定审核通过此凭证?')} disabled={busy}
                    className="flex-1 py-3 bg-ink text-white rounded-cta text-button disabled:opacity-40">
              {busy ? '处理中…' : '审核通过'}
            </button>
            <button onClick={() => action('void', '确定作废此凭证?')} disabled={busy}
                    className="px-4 py-3 border border-red text-red rounded-cta text-button disabled:opacity-40">
              作废
            </button>
          </>
        )}
        {v.status === 'POSTED' && !v.exportedAt && (
          <button onClick={() => action('unpost', '反审后凭证回到草稿状态,可再修改')} disabled={busy}
                  className="flex-1 py-3 bg-white border border-border text-gray2 rounded-cta text-button disabled:opacity-40">
            反审 (回到草稿)
          </button>
        )}
        {v.status === 'POSTED' && v.exportedAt && (
          <div className="flex-1 py-3 text-center text-caption text-gray3 bg-bg-warm rounded-cta">
            ⚠ 已导出至好会计 · 不可反审
          </div>
        )}
      </div>

      {/* 来源链接 (业务路由) */}
      {v.sourceType && v.sourceId && (
        <div className="mx-4 mt-3 bg-amber/10 border border-amber/30 rounded-card p-3">
          <p className="text-caption text-amber-fg">来源业务: <b>{SOURCE_LABEL[v.sourceType] || v.sourceType}</b></p>
          <p className="text-micro text-gray3 mt-1 break-all">{v.sourceId}</p>
        </div>
      )}
    </div>
  )
}
