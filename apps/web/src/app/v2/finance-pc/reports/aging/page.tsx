/**
 * 财务 PC · 应付账龄分析
 * 接 /api/finance/reports/aging  (实时, 无 month)
 * 分桶: 未到期 / 0-30 / 30-60 / 60-90 / 90+
 */
'use client'
import { useEffect, useMemo, useState } from 'react'
import dayjs from 'dayjs'
import { Chip } from '@/components/v2'
import { apiFetch } from '@/lib/v2-auth'
import { exportXlsx } from '@/lib/exportXlsx'
import FinanceTopNav from '../../_topnav'

type Bucket = { count: number; total: number; label: string }
type AgingItem = {
  scheduleId: string
  supplierId: string; supplierName: string
  storeId: string; storeName?: string
  amount: number
  dueAt: string
  overdueDays: number
  bucket: string
  status: string
}
type Aging = {
  asOf: string
  buckets: Record<'notDue' | 'd0_30' | 'd30_60' | 'd60_90' | 'd90plus', Bucket>
  totalOverdue: number
  totalNotDue: number
  grandTotal: number
  items: AgingItem[]
  supplierRank: Array<{ supplierId: string; name: string; total: number; count: number; oldest: number }>
}

const BUCKET_TONE: Record<string, 'gray' | 'amber' | 'orange' | 'red'> = {
  notDue: 'gray', d0_30: 'amber', d30_60: 'orange', d60_90: 'red', d90plus: 'red',
}
const BUCKET_ORDER = ['d90plus', 'd60_90', 'd30_60', 'd0_30', 'notDue']

const fmt = (n: number, d = 0) => n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })

export default function FinanceAgingPCPage() {
  const [data, setData] = useState<Aging | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [activeBucket, setActiveBucket] = useState<string>('all')
  const [supplierFilter, setSupplierFilter] = useState<string>('')

  useEffect(() => {
    setData(null); setError(null)
    apiFetch<Aging>('/api/finance/reports/aging')
      .then(setData)
      .catch(e => setError(String(e?.message || e)))
  }, [])

  const itemsFiltered = useMemo(() => {
    if (!data) return []
    let res = data.items
    if (activeBucket !== 'all') res = res.filter(i => i.bucket === activeBucket)
    if (supplierFilter) res = res.filter(i => i.supplierId === supplierFilter)
    return res
  }, [data, activeBucket, supplierFilter])

  async function doExport() {
    if (!data) return
    await exportXlsx(`应付账龄-${dayjs(data.asOf).format('YYYYMMDD')}.xlsx`, [
      {
        name: '账龄汇总',
        rows: [
          [`应付账龄 · 截至 ${dayjs(data.asOf).format('YYYY-MM-DD HH:mm')}`, '', '', ''],
          [],
          ['账龄区间', '笔数', '金额', '占比'],
          ...BUCKET_ORDER.map(k => {
            const b = data.buckets[k as keyof typeof data.buckets]
            return [b.label, b.count, Number(b.total.toFixed(2)), `${(b.total / Math.max(1, data.grandTotal) * 100).toFixed(1)}%`]
          }),
          ['合计', data.items.length, Number(data.grandTotal.toFixed(2)), '100%'],
        ],
        cols: [{ wch: 16 }, { wch: 10 }, { wch: 16 }, { wch: 10 }],
        merges: [{ s: { r: 0, c: 0 }, e: { r: 0, c: 3 } }],
        moneyCols: ['C'],
        headerRowIdx: 2,
      },
      {
        name: '明细',
        rows: [
          ['账龄', '供应商', '门店', '金额', '到期日', '逾期天数', '状态'],
          ...data.items.map(i => [
            data.buckets[i.bucket as keyof typeof data.buckets]?.label || i.bucket,
            i.supplierName,
            i.storeName || '',
            Number(i.amount.toFixed(2)),
            dayjs(i.dueAt).format('YYYY-MM-DD'),
            i.overdueDays,
            i.status,
          ]),
        ],
        cols: [{ wch: 10 }, { wch: 24 }, { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 10 }, { wch: 10 }],
        moneyCols: ['D'],
        headerRowIdx: 0,
      },
    ])
  }

  return (
    <div className="min-h-screen bg-bg">
      <FinanceTopNav />
      <main className="max-w-[1440px] mx-auto px-6 py-6">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <div>
            <h1 className="text-h1">应付账龄</h1>
            <p className="text-caption text-gray3">
              {data ? `截至 ${dayjs(data.asOf).format('YYYY-MM-DD HH:mm')}` : '加载中…'}
              {' · '}未到期 / 逾期 0-30 / 30-60 / 60-90 / 90+
            </p>
          </div>
          <button onClick={doExport} disabled={!data}
                  className="px-3 py-2 bg-[#1F7A4B] text-white rounded-cta text-button disabled:opacity-40">
            📊 导出 Excel
          </button>
        </div>

        {error && <div className="bg-red-bg text-red-fg rounded-card p-3 text-caption mb-4">{error}</div>}
        {!data && !error && <div className="text-center text-caption text-gray3 py-12">加载中…</div>}

        {data && (
          <>
            {/* Hero 4 卡 */}
            <div className="grid grid-cols-4 gap-3 mb-4">
              <Stat label="应付总额" value={`¥${fmt(data.grandTotal)}`} />
              <Stat label="已逾期" value={`¥${fmt(data.totalOverdue)}`} tone={data.totalOverdue > 0 ? 'red' : 'gray'} />
              <Stat label="未到期" value={`¥${fmt(data.totalNotDue)}`} tone="gray" />
              <Stat label="总笔数" value={String(data.items.length)} unit="笔" />
            </div>

            <div className="grid grid-cols-3 gap-4">
              {/* 左 1 列: 分桶 + 供应商 Top */}
              <div className="space-y-3">
                {/* 分桶 */}
                <section className="bg-white rounded-card border border-border overflow-hidden">
                  <header className="px-4 py-3 border-b border-border">
                    <h2 className="text-h2">账龄分布</h2>
                  </header>
                  <button
                    onClick={() => setActiveBucket('all')}
                    className={`w-full px-4 py-2.5 flex justify-between items-center border-b border-border ${activeBucket === 'all' ? 'bg-amber/10' : 'hover:bg-bg/40'}`}
                  >
                    <span className="text-body">全部</span>
                    <span className="font-num text-caption">{data.items.length} 笔 · ¥{fmt(data.grandTotal)}</span>
                  </button>
                  {BUCKET_ORDER.map(key => {
                    const b = data.buckets[key as keyof typeof data.buckets]
                    if (b.count === 0) return null
                    const tone = BUCKET_TONE[key]
                    return (
                      <button
                        key={key}
                        onClick={() => setActiveBucket(key)}
                        className={`w-full px-4 py-2.5 flex justify-between items-center border-b border-border last:border-b-0 ${activeBucket === key ? 'bg-amber/10' : 'hover:bg-bg/40'}`}
                      >
                        <span className="flex items-center gap-2">
                          <Chip tone={tone}>{b.label}</Chip>
                          <span className="text-caption text-gray3">{b.count} 笔</span>
                        </span>
                        <span className={`font-num text-caption ${tone === 'red' ? 'text-red-fg' : ''}`}>¥{fmt(b.total)}</span>
                      </button>
                    )
                  })}
                </section>

                {/* 供应商 Top */}
                {data.supplierRank.length > 0 && (
                  <section className="bg-white rounded-card border border-border overflow-hidden">
                    <header className="px-4 py-3 border-b border-border">
                      <h2 className="text-h2">供应商 Top {Math.min(8, data.supplierRank.length)}</h2>
                    </header>
                    <ul>
                      {data.supplierRank.slice(0, 8).map(s => (
                        <li key={s.supplierId}
                            className={`px-4 py-2.5 border-b border-border last:border-b-0 cursor-pointer ${supplierFilter === s.supplierId ? 'bg-amber/10' : 'hover:bg-bg/40'}`}
                            onClick={() => setSupplierFilter(supplierFilter === s.supplierId ? '' : s.supplierId)}>
                          <div className="flex justify-between items-start gap-2">
                            <div className="min-w-0 flex-1">
                              <div className="text-body truncate flex items-center gap-1">
                                {s.name}
                                {s.oldest >= 90 && <Chip tone="red">90+</Chip>}
                                {s.oldest >= 60 && s.oldest < 90 && <Chip tone="orange">60+</Chip>}
                              </div>
                              <div className="text-micro text-gray3 mt-0.5">
                                {s.count} 笔 · 最长 {s.oldest >= 0 ? `${s.oldest} 天` : '未到期'}
                              </div>
                            </div>
                            <span className="font-num text-body whitespace-nowrap">¥{fmt(s.total)}</span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
              </div>

              {/* 右 2 列: 明细 */}
              <section className="col-span-2 bg-white rounded-card border border-border overflow-hidden">
                <header className="px-4 py-3 border-b border-border flex justify-between items-center">
                  <h2 className="text-h2">
                    明细 ({itemsFiltered.length} 笔)
                    {activeBucket !== 'all' && (
                      <span className="ml-2 text-caption text-gray3">
                        · {data.buckets[activeBucket as keyof typeof data.buckets]?.label}
                      </span>
                    )}
                  </h2>
                  {(activeBucket !== 'all' || supplierFilter) && (
                    <button onClick={() => { setActiveBucket('all'); setSupplierFilter('') }}
                            className="text-caption text-gray3 hover:text-ink">× 清除筛选</button>
                  )}
                </header>
                <div className="overflow-auto max-h-[640px]">
                  <table className="w-full">
                    <thead className="bg-bg/40 sticky top-0">
                      <tr className="text-micro text-gray3 text-left">
                        <th className="px-3 py-2 font-normal w-20">账龄</th>
                        <th className="px-3 py-2 font-normal">供应商</th>
                        <th className="px-3 py-2 font-normal w-28">门店</th>
                        <th className="px-3 py-2 font-normal text-right w-28">金额</th>
                        <th className="px-3 py-2 font-normal w-24">到期</th>
                        <th className="px-3 py-2 font-normal w-20">逾期</th>
                      </tr>
                    </thead>
                    <tbody>
                      {itemsFiltered.length === 0 && (
                        <tr><td colSpan={6} className="text-center text-caption text-gray3 py-8">
                          {activeBucket === 'all' && !supplierFilter ? '暂无应付' : '该筛选下无明细'}
                        </td></tr>
                      )}
                      {itemsFiltered.map(i => (
                        <tr key={i.scheduleId} className="border-t border-border hover:bg-bg/40">
                          <td className="px-3 py-2">
                            <Chip tone={BUCKET_TONE[i.bucket]}>{data.buckets[i.bucket as keyof typeof data.buckets]?.label}</Chip>
                          </td>
                          <td className="px-3 py-2 text-body truncate max-w-[280px]">{i.supplierName}</td>
                          <td className="px-3 py-2 text-caption text-gray2">{i.storeName || '—'}</td>
                          <td className="px-3 py-2 font-num text-right">¥{fmt(i.amount, 2)}</td>
                          <td className="px-3 py-2 font-num text-caption">{dayjs(i.dueAt).format('MM-DD')}</td>
                          <td className="px-3 py-2 text-caption">
                            <span className={i.overdueDays > 0 ? 'text-red-fg font-num' : 'text-gray3 font-num'}>
                              {i.overdueDays > 0 ? `${i.overdueDays} 天` : `−${-i.overdueDays}`}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </div>
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
