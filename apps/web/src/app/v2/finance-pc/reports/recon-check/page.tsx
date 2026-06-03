/**
 * 财务 PC · 对账自检
 * 接 /api/finance/reports/recon-check?month=YYYY-MM
 * 比对本月「凭证 vs CashTransaction」, 找漏建/重复入账
 */
'use client'
import { useEffect, useState } from 'react'
import dayjs from 'dayjs'
import { Chip, MonthPicker } from '@/components/v2'
import { apiFetch } from '@/lib/v2-auth'
import { exportXlsx } from '@/lib/exportXlsx'
import FinanceTopNav from '../../_topnav'

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

const fmt = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export default function ReconCheckPCPage() {
  const [month, setMonth] = useState(() => dayjs().format('YYYY-MM'))
  const [data, setData] = useState<ReconCheck | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setData(null); setError(null)
    apiFetch<ReconCheck>(`/api/finance/reports/recon-check?month=${month}`)
      .then(setData).catch(e => setError(String(e?.message || e)))
  }, [month])

  async function doExport() {
    if (!data) return
    await exportXlsx(`对账自检-${month}.xlsx`, [
      {
        name: '汇总',
        rows: [
          [`对账自检 · ${month}`, '', ''],
          [],
          ['项', '数量', '说明'],
          ['凭证分录数', data.summary.voucherEntries, '本月所有现金类凭证分录'],
          ['银行流水数', data.summary.cashTxs, '本月 CashTransaction 数'],
          ['已匹配', data.summary.matched, '凭证 ↔ 流水 金额方向都对得上'],
          ['凭证有 / 流水没', data.summary.unmatchedEntries, '凭证录了但流水没同步 (或金额录错)'],
          ['流水有 / 凭证没', data.summary.unmatchedTxs, '银行有钱进出但漏建凭证'],
        ],
        cols: [{ wch: 22 }, { wch: 10 }, { wch: 36 }],
        merges: [{ s: { r: 0, c: 0 }, e: { r: 0, c: 2 } }],
        headerRowIdx: 2,
      },
      ...(data.unmatchedEntries.length > 0 ? [{
        name: '凭证有_流水没',
        rows: [
          ['凭证号', '日期', '科目', '借', '贷', '摘要'],
          ...data.unmatchedEntries.map(e => [
            e.voucherNo, e.date, `${e.accountCode} ${e.accountName}`,
            Number((e.debit || 0).toFixed(2)),
            Number((e.credit || 0).toFixed(2)),
            e.summary || e.voucherSummary,
          ]),
        ],
        cols: [{ wch: 14 }, { wch: 12 }, { wch: 22 }, { wch: 12 }, { wch: 12 }, { wch: 36 }],
        moneyCols: ['D', 'E'],
        headerRowIdx: 0,
      }] : []),
      ...(data.unmatchedTxs.length > 0 ? [{
        name: '流水有_凭证没',
        rows: [
          ['日期', '收/付', '账户', '金额', '类目', '备注'],
          ...data.unmatchedTxs.map(t => [
            t.txDate, t.direction > 0 ? '收' : '付',
            t.accountName || '', Number(t.amount.toFixed(2)),
            t.category, t.note || '',
          ]),
        ],
        cols: [{ wch: 12 }, { wch: 8 }, { wch: 18 }, { wch: 14 }, { wch: 18 }, { wch: 36 }],
        moneyCols: ['D'],
        headerRowIdx: 0,
      }] : []),
    ])
  }

  const hasDiff = data ? (data.summary.unmatchedEntries > 0 || data.summary.unmatchedTxs > 0) : false

  return (
    <div className="min-h-screen bg-bg">
      <FinanceTopNav />
      <main className="max-w-[1440px] mx-auto px-6 py-6">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <div>
            <h1 className="text-h1">对账自检</h1>
            <p className="text-caption text-gray3">凭证 vs 银行流水 · 找漏建/金额错/重复</p>
          </div>
          <div className="flex items-center gap-2">
            <MonthPicker value={month} onChange={setMonth} />
            <button onClick={doExport} disabled={!data}
                    className="px-3 py-2 bg-[#1F7A4B] text-white rounded-cta text-button disabled:opacity-40">
              📊 导出 Excel
            </button>
          </div>
        </div>

        {error && <div className="bg-red-bg text-red-fg rounded-card p-3 text-caption mb-4">{error}</div>}
        {!data && !error && <div className="text-center text-caption text-gray3 py-12">扫描中…</div>}

        {data && (
          <>
            {/* Hero 5 卡 */}
            <div className="grid grid-cols-5 gap-3 mb-4">
              <Stat label="凭证分录" value={String(data.summary.voucherEntries)} unit="条" />
              <Stat label="银行流水" value={String(data.summary.cashTxs)} unit="条" />
              <Stat label="已匹配" value={String(data.summary.matched)} unit="条" tone={data.summary.matched > 0 ? 'green' : 'gray'} />
              <Stat label="凭证有/流水没" value={String(data.summary.unmatchedEntries)} unit="条" tone={data.summary.unmatchedEntries > 0 ? 'amber' : 'gray'} />
              <Stat label="流水有/凭证没" value={String(data.summary.unmatchedTxs)} unit="条" tone={data.summary.unmatchedTxs > 0 ? 'red' : 'gray'} />
            </div>

            {!hasDiff && data.summary.matched > 0 && (
              <div className="bg-green-bg border border-green/30 rounded-card p-6 text-center mb-4">
                <div className="text-h1 text-green-fg">✓ 本月对账完全平衡</div>
                <p className="text-caption text-gray2 mt-2">{data.summary.matched} 笔凭证流水一一对应</p>
              </div>
            )}

            {!hasDiff && data.summary.matched === 0 && data.summary.voucherEntries === 0 && data.summary.cashTxs === 0 && (
              <div className="bg-white rounded-card border border-border p-8 text-center">
                <div className="text-body text-gray2">本月暂无凭证 / 流水数据</div>
              </div>
            )}

            {hasDiff && (
              <div className="grid grid-cols-2 gap-4">
                {/* 凭证有 / 流水没 */}
                <section className="bg-white rounded-card border border-border overflow-hidden">
                  <header className="px-4 py-3 border-b border-border">
                    <div className="flex items-center gap-2">
                      <h2 className="text-h2 text-amber-fg">凭证有 / 流水没</h2>
                      <Chip tone="amber">{data.unmatchedEntries.length}</Chip>
                    </div>
                    <p className="text-micro text-gray3 mt-1">凭证录了但流水没同步, 或凭证金额录错</p>
                  </header>
                  {data.unmatchedEntries.length === 0 ? (
                    <div className="px-4 py-8 text-center text-caption text-gray3">✓ 无差异</div>
                  ) : (
                    <div className="overflow-auto max-h-[520px]">
                      <table className="w-full">
                        <thead className="bg-bg/40 sticky top-0">
                          <tr className="text-micro text-gray3 text-left">
                            <th className="px-3 py-2 font-normal w-28">凭证号 / 日期</th>
                            <th className="px-3 py-2 font-normal">科目 / 摘要</th>
                            <th className="px-3 py-2 font-normal text-right w-28">金额</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.unmatchedEntries.map(e => (
                            <tr key={e.entryId} className="border-t border-border hover:bg-bg/40">
                              <td className="px-3 py-2">
                                <a href={`/v2/finance-pc/vouchers/${e.voucherId}`} className="text-button font-num hover:text-ink underline">
                                  {e.voucherNo}
                                </a>
                                <div className="text-micro text-gray3 font-num">{e.date}</div>
                              </td>
                              <td className="px-3 py-2">
                                <div className="text-caption truncate"><span className="font-num text-gray3">{e.accountCode}</span> {e.accountName}</div>
                                <div className="text-micro text-gray3 truncate">{e.summary || e.voucherSummary}</div>
                              </td>
                              <td className="px-3 py-2 text-right">
                                <span className={`font-num ${e.debit > 0 ? 'text-green-fg' : 'text-red-fg'}`}>
                                  {e.debit > 0 ? '+' : '−'}¥{fmt(e.debit || e.credit)}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>

                {/* 流水有 / 凭证没 */}
                <section className="bg-white rounded-card border border-border overflow-hidden">
                  <header className="px-4 py-3 border-b border-border">
                    <div className="flex items-center gap-2">
                      <h2 className="text-h2 text-red-fg">流水有 / 凭证没</h2>
                      <Chip tone="red">{data.unmatchedTxs.length}</Chip>
                    </div>
                    <p className="text-micro text-gray3 mt-1">银行流水进/出但漏建凭证 — 进凭证页手工补建</p>
                  </header>
                  {data.unmatchedTxs.length === 0 ? (
                    <div className="px-4 py-8 text-center text-caption text-gray3">✓ 无差异</div>
                  ) : (
                    <div className="overflow-auto max-h-[520px]">
                      <table className="w-full">
                        <thead className="bg-bg/40 sticky top-0">
                          <tr className="text-micro text-gray3 text-left">
                            <th className="px-3 py-2 font-normal w-20">日期</th>
                            <th className="px-3 py-2 font-normal w-12">收/付</th>
                            <th className="px-3 py-2 font-normal">类目 / 备注</th>
                            <th className="px-3 py-2 font-normal text-right w-28">金额</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.unmatchedTxs.map(t => (
                            <tr key={t.txId} className="border-t border-border hover:bg-bg/40">
                              <td className="px-3 py-2 text-caption font-num">{dayjs(t.txDate).format('MM-DD')}</td>
                              <td className="px-3 py-2">
                                <Chip tone={t.direction > 0 ? 'green' : 'red'}>{t.direction > 0 ? '收' : '付'}</Chip>
                              </td>
                              <td className="px-3 py-2">
                                <div className="text-caption truncate">{t.accountName || '—'}</div>
                                <div className="text-micro text-gray3 truncate">{t.category}{t.note ? ` · ${t.note}` : ''}</div>
                              </td>
                              <td className="px-3 py-2 text-right">
                                <span className={`font-num ${t.direction > 0 ? 'text-green-fg' : 'text-red-fg'}`}>
                                  {t.direction > 0 ? '+' : '−'}¥{fmt(t.amount)}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  )
}

function Stat({ label, value, unit, tone }: { label: string; value: string; unit?: string; tone?: 'red' | 'amber' | 'green' | 'gray' }) {
  const cls = tone === 'red' ? 'text-red-fg' : tone === 'amber' ? 'text-amber-fg' : tone === 'green' ? 'text-green-fg' : tone === 'gray' ? 'text-gray3' : ''
  return (
    <div className="bg-white rounded-card border border-border p-3">
      <div className="text-micro text-gray3">{label}</div>
      <div className={`text-h1 font-num mt-0.5 ${cls}`}>
        {value}
        {unit && <span className="text-caption text-gray3 ml-1">{unit}</span>}
      </div>
    </div>
  )
}
