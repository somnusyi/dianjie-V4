/**
 * 财务 · 对账自检
 * 比对本月「凭证 vs CashTransaction」, 找漏建/重复入账
 */
'use client'
import { useEffect, useState } from 'react'
import dayjs from 'dayjs'
import { Chip } from '@/components/v2'
import { ErrorScreen } from '@/components/v2/use-dashboard'
import { apiFetch } from '@/lib/v2-auth'

type ReconCheck = {
  month: string
  summary: {
    voucherEntries: number; cashTxs: number; matched: number
    unmatchedEntries: number; unmatchedTxs: number
  }
  unmatchedEntries: Array<{
    entryId: string; voucherId: string; voucherNo: string
    date: string; accountCode: string; accountName: string
    debit: number; credit: number
    summary: string; voucherSummary: string
  }>
  unmatchedTxs: Array<{
    txId: string; txDate: string; direction: number; amount: number
    category: string; note?: string | null; accountName?: string
  }>
}

function fmt(n: number) {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export default function ReconCheckPage() {
  const [month, setMonth] = useState(() => dayjs().format('YYYY-MM'))
  const [data, setData] = useState<ReconCheck | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setData(null); setError(null)
    apiFetch<ReconCheck>(`/api/finance/reports/recon-check?month=${month}`)
      .then(setData).catch(e => setError(String(e?.message || e)))
  }, [month])

  if (error) return <ErrorScreen message={error} />

  return (
    <div className="min-h-screen bg-bg pb-32">
      <header className="px-4 pt-4 pb-2">
        <h1 className="text-h1">对账自检</h1>
        <p className="text-caption text-gray3">凭证 vs 银行流水 · 找漏建/重复</p>
      </header>

      <div className="px-4 mt-3">
        <input type="month" value={month} onChange={e => setMonth(e.target.value)}
               className="bg-white border border-border rounded-cta px-3 py-1.5 text-body" />
      </div>

      {!data && <p className="text-caption text-gray3 text-center mt-12">扫描中…</p>}

      {data && (
        <>
          {/* hero */}
          <div className="mx-4 mt-3 bg-bg-warm rounded-card border border-border p-4">
            <div className="grid grid-cols-3 gap-2 text-caption">
              <div>
                <div className="text-gray3">凭证分录</div>
                <div className="font-num text-h2">{data.summary.voucherEntries}</div>
              </div>
              <div>
                <div className="text-gray3">银行流水</div>
                <div className="font-num text-h2">{data.summary.cashTxs}</div>
              </div>
              <div>
                <div className="text-gray3">已匹配</div>
                <div className={`font-num text-h2 ${data.summary.matched > 0 ? 'text-green-fg' : ''}`}>{data.summary.matched}</div>
              </div>
            </div>
            {(data.summary.unmatchedEntries > 0 || data.summary.unmatchedTxs > 0) ? (
              <div className="mt-3 pt-3 border-t border-border">
                <Chip tone="red">⚠ {data.summary.unmatchedEntries + data.summary.unmatchedTxs} 笔差异</Chip>
              </div>
            ) : (
              <div className="mt-3 pt-3 border-t border-border">
                <Chip tone="green">✓ 完全匹配</Chip>
              </div>
            )}
          </div>

          {/* 凭证有 / 流水没 */}
          {data.unmatchedEntries.length > 0 && (
            <div className="mx-4 mt-3 bg-white rounded-card border border-border p-3">
              <div className="text-h2 mb-2 text-amber-fg">
                凭证有 / 流水没 ({data.unmatchedEntries.length})
              </div>
              <p className="text-micro text-gray3 mb-2">可能凭证录错金额, 或流水还没同步到滇界</p>
              <ul className="space-y-2">
                {data.unmatchedEntries.map(e => (
                  <li key={e.entryId} className="py-2 border-b border-border last:border-b-0">
                    <a href={`/v2/finance/vouchers/${e.voucherId}`} className="block">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <span className="font-num text-caption">{e.voucherNo}</span>
                        <span className="text-micro text-gray3">{e.date}</span>
                        <span className={`font-num ml-auto ${e.debit > 0 ? 'text-green-fg' : 'text-red-fg'}`}>
                          {e.debit > 0 ? '+' : '−'}¥{fmt(e.debit || e.credit)}
                        </span>
                      </div>
                      <div className="text-caption text-gray2 truncate">{e.accountCode} {e.accountName} · {e.summary || e.voucherSummary}</div>
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* 流水有 / 凭证没 */}
          {data.unmatchedTxs.length > 0 && (
            <div className="mx-4 mt-3 bg-white rounded-card border border-border p-3">
              <div className="text-h2 mb-2 text-red-fg">
                流水有 / 凭证没 ({data.unmatchedTxs.length})
              </div>
              <p className="text-micro text-gray3 mb-2">可能漏建凭证 — 进凭证页手工补建</p>
              <ul className="space-y-2">
                {data.unmatchedTxs.map(t => (
                  <li key={t.txId} className="py-2 border-b border-border last:border-b-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <Chip tone={t.direction > 0 ? 'green' : 'red'}>{t.direction > 0 ? '收' : '付'}</Chip>
                      <span className="text-micro text-gray3">{t.txDate}</span>
                      <span className={`font-num ml-auto ${t.direction > 0 ? 'text-green-fg' : 'text-red-fg'}`}>
                        {t.direction > 0 ? '+' : '−'}¥{fmt(t.amount)}
                      </span>
                    </div>
                    <div className="text-caption text-gray2 truncate">{t.accountName} · {t.category} {t.note ? `· ${t.note}` : ''}</div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {data.summary.unmatchedEntries === 0 && data.summary.unmatchedTxs === 0 && data.summary.matched > 0 && (
            <div className="mx-4 mt-3 bg-green-bg border border-green/30 rounded-card p-4 text-center">
              <div className="text-h2 text-green-fg">✓ 本月对账完全平衡</div>
              <p className="text-caption text-gray2 mt-1">{data.summary.matched} 笔凭证流水一一对应</p>
            </div>
          )}
        </>
      )}
    </div>
  )
}
