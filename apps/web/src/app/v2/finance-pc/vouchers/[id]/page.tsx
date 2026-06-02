/**
 * 财务 PC Web · 凭证详情
 *
 * Phase 3 P0
 * 接 /api/vouchers/:id + /api/vouchers/:id/{post,unpost,void}
 *
 * PC 端 UX:
 *   - 两栏布局: 左 凭证头+来源+操作 / 右 分录详细表格
 *   - 借/贷不平时整页红底告警
 *   - 已导出不可反审 (灰显说明)
 *   - 顶部面包屑: ← 凭证列表
 */
'use client'
import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import dayjs from 'dayjs'
import { Chip } from '@/components/v2'
import { apiFetch } from '@/lib/v2-auth'
import FinanceTopNav from '../../_topnav'

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

const STATUS_LABEL: Record<string, string> = { DRAFT: '草稿', POSTED: '已审', VOIDED: '已作废' }
const SOURCE_LABEL: Record<string, string> = {
  Receipt: '收货入库', Payment: '付款给供应商', LossClaim: '报损损耗', Revenue: '营业额',
  CapitalExpense: '资本支出付款', InvoicePayment: '发票付款', CmbInternalTransfer: '内部转账',
  PaymentSchedule: '账期自动付款', Manual: '手工录入',
}

const fmtMoney2 = (n: number) => `¥${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export default function FinancePCVoucherDetailPage() {
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

  if (error) return (
    <div className="min-h-screen bg-bg">
      <FinanceTopNav />
      <div className="max-w-[1440px] mx-auto px-6 py-6">
        <div className="bg-red-bg text-red-fg rounded-card p-4">{error}</div>
        <a href="/v2/finance-pc/vouchers" className="inline-block mt-3 px-4 py-2 bg-ink text-white rounded-cta text-button">← 返回列表</a>
      </div>
    </div>
  )

  if (!v) return (
    <div className="min-h-screen bg-bg">
      <FinanceTopNav />
      <div className="max-w-[1440px] mx-auto px-6 py-12 text-center text-caption text-gray3">加载中…</div>
    </div>
  )

  const tone = v.status === 'POSTED' ? 'green' : v.status === 'VOIDED' ? 'gray' : 'red'
  const balanced = Math.abs(Number(v.totalDebit) - Number(v.totalCredit)) < 0.01
  const totalAmount = Number(v.totalDebit)

  return (
    <div className="min-h-screen bg-bg">
      <FinanceTopNav />
      <main className="max-w-[1440px] mx-auto px-6 py-6">
        {/* 面包屑 */}
        <div className="flex items-center gap-2 mb-4">
          <a href="/v2/finance-pc/vouchers" className="text-gray2 hover:text-ink text-caption">← 凭证列表</a>
          <span className="text-gray3">/</span>
          <span className="text-caption text-gray2 font-num">{v.no}</span>
        </div>

        {/* 不平警告 (硬告警) */}
        {!balanced && (
          <div className="bg-red-bg border border-red/30 rounded-card p-3 mb-4 text-caption text-red-fg">
            ⚠ 凭证不平! 借 {fmtMoney2(Number(v.totalDebit))} ≠ 贷 {fmtMoney2(Number(v.totalCredit))}, 差额 {fmtMoney2(Number(v.totalDebit) - Number(v.totalCredit))}, 需手工补救
          </div>
        )}

        <div className="grid grid-cols-[1fr_2fr] gap-4">
          {/* 左侧 凭证头 + 来源 + 操作 */}
          <div className="space-y-4">
            {/* 凭证头 */}
            <section className="bg-white rounded-card border border-border p-4">
              <div className="flex items-center gap-2 mb-3 flex-wrap">
                <Chip tone={tone as any}>{STATUS_LABEL[v.status]}</Chip>
                {v.sourceType && <Chip tone="amber">{SOURCE_LABEL[v.sourceType] || v.sourceType}</Chip>}
                {v.exportedAt && <Chip tone="gray">已导出</Chip>}
                {!balanced && <Chip tone="red">不平</Chip>}
              </div>
              <div className="text-h1 font-num">{v.no}</div>
              <p className="text-caption text-gray2 mt-1 mb-3">{v.summary}</p>
              <div className="grid grid-cols-2 gap-y-2 text-caption">
                <div><span className="text-gray3">凭证日期</span></div>
                <div className="font-num text-right">{dayjs(v.date).format('YYYY-MM-DD')}</div>
                <div><span className="text-gray3">字</span></div>
                <div className="text-right">{v.word}</div>
                <div><span className="text-gray3">借方合计</span></div>
                <div className="font-num text-right">{fmtMoney2(Number(v.totalDebit))}</div>
                <div><span className="text-gray3">贷方合计</span></div>
                <div className="font-num text-right">{fmtMoney2(Number(v.totalCredit))}</div>
                <div><span className="text-gray3">总金额</span></div>
                <div className="font-num text-right text-h2">{fmtMoney2(totalAmount)}</div>
              </div>
              <div className="border-t border-border mt-3 pt-3 text-micro text-gray3 space-y-1">
                <div>创建于: {dayjs(v.createdAt).format('YYYY-MM-DD HH:mm')}</div>
                {v.postedAt && <div>审核于: {dayjs(v.postedAt).format('YYYY-MM-DD HH:mm')}</div>}
                {v.exportedAt && <div>导出于: {dayjs(v.exportedAt).format('YYYY-MM-DD HH:mm')}</div>}
              </div>
            </section>

            {/* 来源 (业务事件追溯) */}
            {v.sourceType && v.sourceId && (
              <section className="bg-amber/10 border border-amber/30 rounded-card p-4">
                <div className="text-h2 text-amber-fg mb-1">来源业务</div>
                <p className="text-caption text-gray2">{SOURCE_LABEL[v.sourceType] || v.sourceType}</p>
                <p className="text-micro text-gray3 mt-2 font-num break-all">{v.sourceId}</p>
              </section>
            )}

            {/* 操作 */}
            <section className="bg-white rounded-card border border-border p-4">
              <div className="text-h2 mb-3">操作</div>
              {v.status === 'DRAFT' && (
                <div className="space-y-2">
                  <button onClick={() => action('post', '确定审核通过此凭证?')} disabled={busy}
                          className="w-full py-3 bg-ink text-white rounded-cta text-button disabled:opacity-40">
                    {busy ? '处理中…' : '✓ 审核通过'}
                  </button>
                  <button onClick={() => action('void', '确定作废此凭证? 作废后不可恢复.')} disabled={busy}
                          className="w-full py-2 border border-red text-red-fg rounded-cta text-button disabled:opacity-40">
                    作废
                  </button>
                </div>
              )}
              {v.status === 'POSTED' && !v.exportedAt && (
                <button onClick={() => action('unpost', '反审后凭证回到草稿状态, 可再修改')} disabled={busy}
                        className="w-full py-3 bg-white border border-border text-gray2 rounded-cta text-button disabled:opacity-40">
                  反审 (回到草稿)
                </button>
              )}
              {v.status === 'POSTED' && v.exportedAt && (
                <div className="bg-bg-warm rounded-cta p-3 text-caption text-gray3 text-center">
                  ⚠ 已导出至好会计 · 不可反审
                </div>
              )}
              {v.status === 'VOIDED' && (
                <div className="text-caption text-gray3 text-center py-3">凭证已作废, 不可再操作</div>
              )}
            </section>
          </div>

          {/* 右侧 分录表格 */}
          <section className="bg-white rounded-card border border-border overflow-hidden">
            <header className="px-4 py-3 border-b border-border flex items-center justify-between">
              <h2 className="text-h2">分录明细 ({v.entries.length} 行)</h2>
              {balanced && <Chip tone="green">借贷平账 ✓</Chip>}
            </header>
            <table className="w-full">
              <thead className="bg-bg/40">
                <tr className="text-micro text-gray3 text-left">
                  <th className="px-3 py-2 font-normal w-12">行</th>
                  <th className="px-3 py-2 font-normal w-28">科目编码</th>
                  <th className="px-3 py-2 font-normal">科目名称 / 摘要</th>
                  <th className="px-3 py-2 font-normal text-right w-28">借方</th>
                  <th className="px-3 py-2 font-normal text-right w-28">贷方</th>
                </tr>
              </thead>
              <tbody>
                {v.entries.map(e => (
                  <tr key={e.id} className="border-t border-border">
                    <td className="px-3 py-2.5 text-gray3 text-caption">{e.lineNo}</td>
                    <td className="px-3 py-2.5 font-num text-body">{e.accountCode}</td>
                    <td className="px-3 py-2.5">
                      <div className="text-body">{e.accountName}</div>
                      {e.summary && e.summary !== v.summary && (
                        <div className="text-micro text-gray3 mt-0.5">{e.summary}</div>
                      )}
                    </td>
                    <td className="px-3 py-2.5 font-num text-right">
                      {Number(e.debit) > 0 ? fmtMoney2(Number(e.debit)) : ''}
                    </td>
                    <td className="px-3 py-2.5 font-num text-right">
                      {Number(e.credit) > 0 ? fmtMoney2(Number(e.credit)) : ''}
                    </td>
                  </tr>
                ))}
                {/* 合计行 */}
                <tr className="border-t border-border bg-bg/40">
                  <td colSpan={3} className="px-3 py-2.5 text-right text-caption text-gray2">合计</td>
                  <td className="px-3 py-2.5 font-num text-right text-h2">{fmtMoney2(Number(v.totalDebit))}</td>
                  <td className="px-3 py-2.5 font-num text-right text-h2">{fmtMoney2(Number(v.totalCredit))}</td>
                </tr>
              </tbody>
            </table>
          </section>
        </div>
      </main>
    </div>
  )
}
