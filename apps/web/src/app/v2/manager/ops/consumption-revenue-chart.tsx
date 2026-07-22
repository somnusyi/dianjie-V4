/**
 * 食材消耗 × 营业额 共振折线图 (手写 SVG, 无图表库)
 *
 * 数据源: GET /api/consumption/daily-series?storeId&month=YYYY-MM
 *   consumptionCost = 当日 stock_consumptions (排除作废) costAmountSnapshot 合计
 *   revenue         = 当日 RevenueRecord.amount
 *   costRate        = consumptionCost/revenue×100 (revenue=0 时 null)
 *
 * 双折线: 营业额 (ink 深色) / 食材成本 (amber); 成本率用虚线 + 右轴。
 * 无数据日期补 0; viewBox + preserveAspectRatio 适配移动端宽度。
 * 点按任意一天查看当日明细。
 */
'use client'
import { useMemo, useState } from 'react'

export type DailySeriesPoint = {
  date: string
  consumptionCost: number
  revenue: number
  costRate: number | null
}

const W = 360
const H = 190
const PAD_L = 42
const PAD_R = 36
const PAD_T = 12
const PAD_B = 22

function polyline(points: Array<[number, number]>): string {
  return points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
}

/** Y 轴金额刻度: ≥10000 用「万」缩写, 否则千分位 */
function moneyTick(value: number): string {
  if (value >= 10000) {
    const wan = value / 10000
    return `${Number(wan.toFixed(1))}万`
  }
  return Math.round(value).toLocaleString('zh-CN')
}

export default function ConsumptionRevenueChart({ series, monthLabel }: {
  series: DailySeriesPoint[] | null
  monthLabel: string
}) {
  const [selectedDate, setSelectedDate] = useState<string | null>(null)

  const model = useMemo(() => {
    if (!series || series.length === 0) return null
    const n = series.length
    const hasAnyData = series.some(d => d.revenue > 0 || d.consumptionCost > 0)
    const maxMoney = Math.max(1, ...series.map(d => Math.max(d.revenue, d.consumptionCost)))
    const rates = series.map(d => d.costRate).filter((r): r is number => r != null)
    const maxRate = rates.length > 0 ? Math.max(1, ...rates) : null

    const innerW = W - PAD_L - PAD_R
    const innerH = H - PAD_T - PAD_B
    const x = (i: number) => PAD_L + (n === 1 ? innerW / 2 : (i * innerW) / (n - 1))
    const yMoney = (v: number) => PAD_T + (1 - v / maxMoney) * innerH
    const yRate = (v: number) => PAD_T + (1 - v / (maxRate ?? 1)) * innerH

    const revenuePoints = series.map((d, i) => [x(i), yMoney(d.revenue)] as [number, number])
    const costPoints = series.map((d, i) => [x(i), yMoney(d.consumptionCost)] as [number, number])
    const ratePoints = maxRate == null
      ? null
      : series.map((d, i) => [x(i), yRate(d.costRate ?? 0)] as [number, number])

    // X 轴刻度: 1/5/10/15/20/25 + 月末
    const tickDays = new Set([1, 5, 10, 15, 20, 25, n])
    const ticks = series
      .map((d, i) => ({ day: i + 1, x: x(i) }))
      .filter(t => tickDays.has(t.day))

    return { n, hasAnyData, maxMoney, maxRate, x, yMoney, revenuePoints, costPoints, ratePoints, ticks }
  }, [series])

  if (!series) {
    return (
      <div className="bg-white rounded-card border border-border p-3">
        <p className="text-caption text-gray3 text-center py-6">加载中…</p>
      </div>
    )
  }
  if (!model?.hasAnyData) {
    return (
      <div className="bg-white rounded-card border border-border p-3">
        <p className="text-caption text-gray3 text-center py-6">{monthLabel}暂无消耗与营业额数据</p>
      </div>
    )
  }

  const defaultSelected = [...series].reverse().find(d => d.revenue > 0 || d.consumptionCost > 0) ?? series[series.length - 1]
  const selected = series.find(d => d.date === selectedDate) ?? defaultSelected
  const selectedIndex = series.indexOf(selected)
  const selectedX = model.x(selectedIndex)

  return (
    <div className="bg-white rounded-card border border-border p-3">
      {/* 图例 (右上) */}
      <div className="flex items-center justify-end gap-3 text-micro text-gray2">
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-0.5 bg-ink rounded-full" />营业额
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-0.5 bg-amber rounded-full" />食材成本
        </span>
        {model.maxRate != null && (
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 border-t border-dashed border-gray3" />成本率
          </span>
        )}
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        className="w-full h-auto mt-1"
        role="img"
        aria-label="食材消耗与营业额日线"
      >
        {/* 横向网格线 + 左轴金额刻度 (0 / 半值 / 峰值) */}
        {[0, 0.5, 1].map(ratio => {
          const y = PAD_T + (1 - ratio) * (H - PAD_T - PAD_B)
          return (
            <g key={ratio}>
              <line x1={PAD_L} y1={y} x2={W - PAD_R} y2={y} className="stroke-border" strokeWidth={ratio === 0 ? 1 : 0.5} />
              <text x={PAD_L - 4} y={y + 3} textAnchor="end" className="fill-gray3" fontSize="8">
                {moneyTick(model.maxMoney * ratio)}
              </text>
            </g>
          )
        })}
        {/* 右轴成本率刻度 */}
        {model.maxRate != null && (
          <>
            <text x={W - PAD_R + 4} y={PAD_T + 3} className="fill-gray3" fontSize="8">
              {Number(model.maxRate.toFixed(1))}%
            </text>
            <text x={W - PAD_R + 4} y={H - PAD_B + 3} className="fill-gray3" fontSize="8">0%</text>
          </>
        )}

        {/* X 轴日期刻度 */}
        {model.ticks.map(t => (
          <text key={t.day} x={t.x} y={H - 6} textAnchor="middle" className="fill-gray3" fontSize="8">
            {t.day}
          </text>
        ))}

        {/* 成本率虚线 (右轴) */}
        {model.ratePoints && (
          <polyline
            points={polyline(model.ratePoints)}
            fill="none" className="stroke-gray3" strokeWidth="1" strokeDasharray="3 2" strokeLinejoin="round"
          />
        )}
        {/* 营业额 (ink) / 食材成本 (amber) */}
        <polyline points={polyline(model.revenuePoints)} fill="none" className="stroke-ink" strokeWidth="1.6" strokeLinejoin="round" />
        <polyline points={polyline(model.costPoints)} fill="none" className="stroke-amber" strokeWidth="1.6" strokeLinejoin="round" />

        {/* 选中竖线 + 选中点 */}
        <line x1={selectedX} y1={PAD_T} x2={selectedX} y2={H - PAD_B} className="stroke-gray4" strokeWidth="0.6" strokeDasharray="2 2" />
        <circle cx={selectedX} cy={model.yMoney(selected.revenue)} r="2.6" className="fill-ink" />
        <circle cx={selectedX} cy={model.yMoney(selected.consumptionCost)} r="2.6" className="fill-amber" />

        {/* 每日点击热区 */}
        {series.map((d, i) => (
          <circle
            key={d.date}
            cx={model.x(i)}
            cy={model.yMoney(d.revenue)}
            r="7"
            fill="transparent"
            onClick={() => setSelectedDate(d.date)}
          >
            <title>{`${d.date} 营业额 ¥${d.revenue.toLocaleString('zh-CN')} · 食材成本 ¥${d.consumptionCost.toLocaleString('zh-CN')}`}</title>
          </circle>
        ))}
      </svg>

      {/* 选中日明细 */}
      <div className="mt-1 pt-2 border-t border-border flex items-center justify-between text-caption">
        <span className="text-gray2 font-num">{monthLabel}{selectedIndex + 1}日</span>
        <span className="font-num text-body">
          ¥{selected.revenue.toLocaleString('zh-CN')}
          <span className="text-micro text-gray3"> 营业额</span>
        </span>
        <span className="font-num text-body text-amber-fg">
          ¥{selected.consumptionCost.toLocaleString('zh-CN')}
          <span className="text-micro text-gray3"> 成本</span>
        </span>
        <span className="font-num text-body">
          {selected.costRate == null ? '—' : `${selected.costRate}%`}
          <span className="text-micro text-gray3"> 成本率</span>
        </span>
      </div>
    </div>
  )
}
