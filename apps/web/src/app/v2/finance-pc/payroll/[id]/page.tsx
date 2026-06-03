/**
 * 财务 PC · 工资单详情 (P2-1)
 */
'use client'
import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import dayjs from 'dayjs'
import { Chip } from '@/components/v2'
import { apiFetch } from '@/lib/v2-auth'
import FinanceTopNav from '../../_topnav'

type Item = {
  id: string; employeeName: string; position?: string | null
  baseSalary?: string | number | null
  bonus?: string | number | null
  overtime?: string | number | null
  deductSocialSec?: string | number | null
  deductTax?: string | number | null
  deductOther?: string | number | null
  netAmount: string | number
  note?: string | null
}
type Payroll = {
  id: string; month: string; status: string
  totalGross?: string | number | null
  totalNet: string | number
  totalSocialSec?: string | number | null
  totalTax?: string | number | null
  payDate?: string | null
  payMethod?: string | null
  bankTxNo?: string | null
  voucherId?: string | null
  note?: string | null
  store: { id: string; name: string }
  items: Item[]
}

const fmtMoney = (n: number) => `¥${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const STATUS_LABEL: Record<string, string> = { DRAFT: '草稿', APPROVED: '已批待发', PAID: '已发放', VOIDED: '已作废' }

export default function PayrollDetailPage() {
  const params = useParams() as any
  const id = String(params.id)
  const [p, setP] = useState<Payroll | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    apiFetch<Payroll>(`/api/payroll/${id}`).then(setP).catch(e => setError(e?.message || String(e)))
  }, [id])

  if (error) return (
    <div className="min-h-screen bg-bg">
      <FinanceTopNav />
      <div className="max-w-[1200px] mx-auto px-6 py-6">
        <div className="bg-red-bg text-red-fg rounded-card p-4">{error}</div>
      </div>
    </div>
  )
  if (!p) return (
    <div className="min-h-screen bg-bg">
      <FinanceTopNav />
      <div className="text-center text-caption text-gray3 py-12">加载中…</div>
    </div>
  )

  return (
    <div className="min-h-screen bg-bg">
      <FinanceTopNav />
      <main className="max-w-[1200px] mx-auto px-6 py-6">
        <div className="flex items-center gap-2 mb-4">
          <a href="/v2/finance-pc/payroll" className="text-gray2 hover:text-ink text-caption">← 工资管理</a>
          <span className="text-gray3">/</span>
          <span className="text-caption text-gray2 font-num">{p.month} · {p.store.name}</span>
        </div>

        <section className="bg-white rounded-card border border-border p-4 mb-4">
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <Chip tone={p.status === 'PAID' ? 'green' : p.status === 'VOIDED' ? 'gray' : 'amber'}>{STATUS_LABEL[p.status]}</Chip>
            {p.voucherId && (
              <a href={`/v2/finance-pc/vouchers/${p.voucherId}`} className="text-caption text-amber-fg">凭证 ›</a>
            )}
          </div>
          <div className="text-h1">{p.month} 工资 · {p.store.name}</div>
          {p.note && <p className="text-caption text-gray3 mt-1">{p.note}</p>}
          <div className="grid grid-cols-4 gap-4 mt-4">
            <Stat label="应发" value={p.totalGross != null ? fmtMoney(Number(p.totalGross)) : '—'} />
            <Stat label="实发" value={fmtMoney(Number(p.totalNet))} highlight />
            <Stat label="代扣社保" value={p.totalSocialSec != null ? fmtMoney(Number(p.totalSocialSec)) : '—'} />
            <Stat label="代扣个税" value={p.totalTax != null ? fmtMoney(Number(p.totalTax)) : '—'} />
          </div>
          {p.payDate && (
            <div className="border-t border-border mt-4 pt-3 text-caption">
              <div>发放: <b className="font-num">{dayjs(p.payDate).format('YYYY-MM-DD')}</b> · {p.payMethod}</div>
              {p.bankTxNo && <div>流水号: <span className="font-num">{p.bankTxNo}</span></div>}
            </div>
          )}
        </section>

        <section className="bg-white rounded-card border border-border overflow-hidden">
          <header className="px-4 py-3 border-b border-border">
            <h2 className="text-h2">明细 ({p.items.length} 人)</h2>
          </header>
          <table className="w-full">
            <thead className="bg-bg/40">
              <tr className="text-micro text-gray3 text-left">
                <th className="px-3 py-2 font-normal w-32">姓名</th>
                <th className="px-3 py-2 font-normal w-24">岗位</th>
                <th className="px-3 py-2 font-normal text-right">底薪</th>
                <th className="px-3 py-2 font-normal text-right">奖金</th>
                <th className="px-3 py-2 font-normal text-right">加班</th>
                <th className="px-3 py-2 font-normal text-right">社保扣</th>
                <th className="px-3 py-2 font-normal text-right">个税扣</th>
                <th className="px-3 py-2 font-normal text-right">实发</th>
              </tr>
            </thead>
            <tbody>
              {p.items.map(it => (
                <tr key={it.id} className="border-t border-border">
                  <td className="px-3 py-2 text-body">{it.employeeName}</td>
                  <td className="px-3 py-2 text-caption text-gray3">{it.position || '—'}</td>
                  <td className="px-3 py-2 font-num text-right text-caption">{it.baseSalary != null ? fmtMoney(Number(it.baseSalary)) : '—'}</td>
                  <td className="px-3 py-2 font-num text-right text-caption">{it.bonus != null ? fmtMoney(Number(it.bonus)) : '—'}</td>
                  <td className="px-3 py-2 font-num text-right text-caption">{it.overtime != null ? fmtMoney(Number(it.overtime)) : '—'}</td>
                  <td className="px-3 py-2 font-num text-right text-caption">{it.deductSocialSec != null ? fmtMoney(Number(it.deductSocialSec)) : '—'}</td>
                  <td className="px-3 py-2 font-num text-right text-caption">{it.deductTax != null ? fmtMoney(Number(it.deductTax)) : '—'}</td>
                  <td className="px-3 py-2 font-num text-right text-button">{fmtMoney(Number(it.netAmount))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </main>
    </div>
  )
}

function Stat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="bg-bg-warm rounded-card p-3">
      <div className="text-micro text-gray3">{label}</div>
      <div className={`font-num mt-0.5 ${highlight ? 'text-h1' : 'text-h2'}`}>{value}</div>
    </div>
  )
}
