/**
 * 财务 PC Web · 报税口径报表
 *
 * Phase 4
 * 接 /api/finance/reports/tax/income-statement?month=YYYY-MM
 *     /api/finance/reports/tax/balance-sheet?asOf=YYYY-MM-DD
 *
 * PC UX:
 *   - 切换 tab: 利润表 / 资产负债表
 *   - 利润表: 月份选择, 行表 + 合计
 *   - 资产负债表: 截止日选择 (默认今天), 三栏 (资产 / 负债 / 权益) + 平衡指示
 *   - 导出 CSV (好会计兜底)
 */
'use client'
import { useEffect, useState } from 'react'
import dayjs from 'dayjs'
import { Chip, MonthPicker, DatePicker } from '@/components/v2'
import { apiFetch } from '@/lib/v2-auth'
import FinanceTopNav from '../../_topnav'

type IncomeStatementRow = { lineNo: number; label: string; amount: number; type?: string; indent?: number; note?: string }
type IncomeStatement = {
  month: string
  currency: string
  rows: IncomeStatementRow[]
  summary: {
    operatingRevenue: number; operatingCost: number
    sellingExp: number; mgmtExp: number; financeExp: number
    tax: number; otherIncome: number
    operatingProfit: number; totalProfit: number; netProfit: number
  }
}
type BalanceSheet = {
  asOf: string
  currency: string
  asset: any
  liability: any
  equity: any
  balanced: boolean
  diff: number
}

const fmtMoney = (n: number) => `¥${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

function downloadCsv(filename: string, rows: any[][]) {
  const csv = '\ufeff' + rows.map(r => r.map(c => {
    const s = String(c ?? '')
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }).join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename
  document.body.appendChild(a); a.click(); document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

export default function FinancePCTaxReportsPage() {
  const [tab, setTab] = useState<'income' | 'balance'>('income')
  const [month, setMonth] = useState(() => dayjs().format('YYYY-MM'))
  const [asOf, setAsOf] = useState(() => dayjs().format('YYYY-MM-DD'))
  const [income, setIncome] = useState<IncomeStatement | null>(null)
  const [balance, setBalance] = useState<BalanceSheet | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (tab !== 'income') return
    setIncome(null); setError(null)
    apiFetch<IncomeStatement>(`/api/finance/reports/tax/income-statement?month=${month}`)
      .then(setIncome).catch(e => setError(e.message))
  }, [tab, month])

  useEffect(() => {
    if (tab !== 'balance') return
    setBalance(null); setError(null)
    apiFetch<BalanceSheet>(`/api/finance/reports/tax/balance-sheet?asOf=${asOf}`)
      .then(setBalance).catch(e => setError(e.message))
  }, [tab, asOf])

  function exportIncome() {
    if (!income) return
    downloadCsv(`利润表-${month}.csv`,
      [['行', '项目', '本月金额', '备注'],
       ...income.rows.map(r => [r.lineNo, (r.indent ? '  ' : '') + r.label, r.amount.toFixed(2), r.note || ''])])
  }
  function exportBalance() {
    if (!balance) return
    downloadCsv(`资产负债表-${asOf}.csv`,
      [['分类', '项目', '金额'],
       ['资产', '库存现金', balance.asset.cash.toFixed(2)],
       ['资产', '银行存款', balance.asset.bank.toFixed(2)],
       ['资产', '其他货币资金', (balance.asset.otherCash || 0).toFixed(2)],
       ['资产', '应收账款', balance.asset.ar.toFixed(2)],
       ['资产', '库存商品', balance.asset.inventory.toFixed(2)],
       ['资产', '固定资产', balance.asset.fixedAsset.toFixed(2)],
       ['资产', '累计折旧', balance.asset.accumDep.toFixed(2)],
       ['资产', '资产总计', balance.asset.total.toFixed(2)],
       ['负债', '应付账款', balance.liability.ap.toFixed(2)],
       ['负债', '应付职工薪酬', balance.liability.payroll.toFixed(2)],
       ['负债', '应交税费', balance.liability.taxPayable.toFixed(2)],
       ['负债', '负债总计', balance.liability.total.toFixed(2)],
       ['权益', '实收资本', balance.equity.paidInCapital.toFixed(2)],
       ['权益', '盈余公积', (balance.equity.surplusReserve || 0).toFixed(2)],
       ['权益', '本年利润', balance.equity.profitThisYear.toFixed(2)],
       ['权益', '利润分配', balance.equity.retainedEarnings.toFixed(2)],
       ['权益', '权益总计', balance.equity.total.toFixed(2)]])
  }

  return (
    <div className="min-h-screen bg-bg">
      <FinanceTopNav />
      <main className="max-w-[1440px] mx-auto px-6 py-6">
        <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
          <div>
            <h1 className="text-h1">报税口径报表</h1>
            <p className="text-caption text-gray3">利润表 / 资产负债表 — 与好会计/电子税局口径一致</p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex bg-bg rounded-cta p-0.5">
              <button onClick={() => setTab('income')}
                      className={`px-4 py-1.5 rounded-cta text-button ${tab === 'income' ? 'bg-ink text-white' : 'text-gray2'}`}>利润表</button>
              <button onClick={() => setTab('balance')}
                      className={`px-4 py-1.5 rounded-cta text-button ${tab === 'balance' ? 'bg-ink text-white' : 'text-gray2'}`}>资产负债表</button>
            </div>
            {tab === 'income' && (
              <MonthPicker value={month} onChange={setMonth} />
            )}
            {tab === 'balance' && (
              <DatePicker value={asOf} onChange={setAsOf} quickButtons={['today', 'yesterday', 'monthEnd', 'lastMonthEnd']} />
            )}
            <button onClick={tab === 'income' ? exportIncome : exportBalance}
                    disabled={tab === 'income' ? !income : !balance}
                    className="px-3 py-2 bg-ink text-white rounded-cta text-button disabled:opacity-40">⬇ 导出 CSV</button>
          </div>
        </div>

        {error && <div className="bg-red-bg text-red-fg rounded-card p-3 text-caption mb-4">{error}</div>}

        {/* 利润表 */}
        {tab === 'income' && (
          <>
            {!income && !error && <div className="text-caption text-gray3 text-center py-12">加载中…</div>}
            {income && (
              <>
                {/* Hero 4 卡 */}
                <div className="grid grid-cols-4 gap-3 mb-4">
                  <Card label="营业收入" value={fmtMoney(income.summary.operatingRevenue)} tone="default" />
                  <Card label="营业成本" value={fmtMoney(income.summary.operatingCost)} tone="amber" />
                  <Card label="营业利润" value={fmtMoney(income.summary.operatingProfit)} tone={income.summary.operatingProfit < 0 ? 'red' : 'green'} />
                  <Card label="净利润"   value={fmtMoney(income.summary.netProfit)} tone={income.summary.netProfit < 0 ? 'red' : 'green'} />
                </div>

                <div className="bg-white rounded-card border border-border overflow-hidden">
                  <header className="px-5 py-3 border-b border-border flex items-center justify-between">
                    <h2 className="text-h2">{income.month} 月度利润表</h2>
                    <span className="text-caption text-gray3">单位: 元</span>
                  </header>
                  <table className="w-full">
                    <thead className="bg-bg/40">
                      <tr className="text-micro text-gray3 text-left">
                        <th className="px-3 py-2 font-normal w-16">行次</th>
                        <th className="px-3 py-2 font-normal">项目</th>
                        <th className="px-3 py-2 font-normal text-right w-40">本月金额</th>
                        <th className="px-3 py-2 font-normal w-48">备注</th>
                      </tr>
                    </thead>
                    <tbody>
                      {income.rows.map(r => {
                        const bold = r.type === 'subtotal' || r.type === 'total' || r.type === 'grand'
                        const big = r.type === 'grand'
                        const bgCls = r.type === 'grand' ? 'bg-bg-warm' : r.type === 'total' ? 'bg-bg/40' : ''
                        return (
                          <tr key={r.lineNo} className={`border-t border-border ${bgCls}`}>
                            <td className="px-3 py-2.5 text-caption text-gray3 font-num">{r.lineNo}</td>
                            <td className={`px-3 py-2.5 ${bold ? 'font-medium' : ''} ${big ? 'text-h2' : 'text-body'}`}>{r.label}</td>
                            <td className={`px-3 py-2.5 font-num text-right ${big ? 'text-h2' : 'text-body'} ${r.amount < 0 ? 'text-red-fg' : ''}`}>{fmtMoney(r.amount)}</td>
                            <td className="px-3 py-2.5 text-micro text-gray3">{r.note || ''}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        )}

        {/* 资产负债表 */}
        {tab === 'balance' && (
          <>
            {!balance && !error && <div className="text-caption text-gray3 text-center py-12">加载中…</div>}
            {balance && (
              <>
                {/* 平衡指示 */}
                <div className={`bg-white rounded-card border border-border p-4 mb-4 flex items-center justify-between ${!balance.balanced ? 'border-red bg-red-bg/30' : ''}`}>
                  <div>
                    <div className="text-h2">截止 {dayjs(balance.asOf).format('YYYY-MM-DD')}</div>
                    <div className="text-caption text-gray3 mt-1">资产 {fmtMoney(balance.asset.total)} {balance.balanced ? '=' : '≠'} 负债 {fmtMoney(balance.liability.total)} + 权益 {fmtMoney(balance.equity.total)}</div>
                  </div>
                  {balance.balanced ? (
                    <Chip tone="green">资负平衡 ✓</Chip>
                  ) : (
                    <Chip tone="red">不平衡! 差额 {fmtMoney(balance.diff)}</Chip>
                  )}
                </div>

                <div className="grid grid-cols-3 gap-4">
                  {/* 资产 */}
                  <section className="bg-white rounded-card border border-border overflow-hidden">
                    <header className="px-4 py-3 border-b border-border flex items-center justify-between">
                      <h2 className="text-h2">资产</h2>
                      <span className="font-num text-h2">{fmtMoney(balance.asset.total)}</span>
                    </header>
                    <table className="w-full">
                      <tbody>
                        <SubHead label="流动资产" />
                        <Row label="库存现金 (1001)" value={balance.asset.cash} />
                        <Row label="银行存款 (1002)" value={balance.asset.bank} />
                        <Row label="其他货币资金 (1012)" value={balance.asset.otherCash || 0} />
                        <Row label="应收账款 (1122)" value={balance.asset.ar} />
                        <Row label="其他应收款 (1221)" value={balance.asset.otherAr} />
                        <Row label="预付账款 (1123)" value={balance.asset.prepaid} />
                        <Row label="库存商品 (1405)" value={balance.asset.inventory} />
                        <SubTotal label="流动资产合计" value={balance.asset.currentAsset} />
                        <SubHead label="非流动资产" />
                        <Row label="固定资产 (1601)" value={balance.asset.fixedAsset} />
                        <Row label="累计折旧 (1602)" value={balance.asset.accumDep} />
                        <Row label="长期待摊 (1801)" value={balance.asset.longExp} />
                        <SubTotal label="非流动资产合计" value={balance.asset.longTermAsset} />
                      </tbody>
                    </table>
                  </section>

                  {/* 负债 */}
                  <section className="bg-white rounded-card border border-border overflow-hidden">
                    <header className="px-4 py-3 border-b border-border flex items-center justify-between">
                      <h2 className="text-h2">负债</h2>
                      <span className="font-num text-h2">{fmtMoney(balance.liability.total)}</span>
                    </header>
                    <table className="w-full">
                      <tbody>
                        <SubHead label="流动负债" />
                        <Row label="短期借款 (2001)" value={balance.liability.shortLoan || 0} />
                        <Row label="应付账款 (2202)" value={balance.liability.ap} />
                        <Row label="预收账款 (2203)" value={balance.liability.advance} />
                        <Row label="应付职工薪酬 (2211)" value={balance.liability.payroll} />
                        <Row label="应交税费 (2221)" value={balance.liability.taxPayable} />
                        <Row label="其他应付款 (2241)" value={balance.liability.otherAp} />
                        <SubTotal label="流动负债合计" value={balance.liability.currentLiab} />
                      </tbody>
                    </table>
                  </section>

                  {/* 权益 */}
                  <section className="bg-white rounded-card border border-border overflow-hidden">
                    <header className="px-4 py-3 border-b border-border flex items-center justify-between">
                      <h2 className="text-h2">所有者权益</h2>
                      <span className="font-num text-h2">{fmtMoney(balance.equity.total)}</span>
                    </header>
                    <table className="w-full">
                      <tbody>
                        <Row label="实收资本 (3001/4001)" value={balance.equity.paidInCapital} />
                        <Row label="资本公积 (3002/4002)" value={balance.equity.capitalReserve} />
                        <Row label="盈余公积 (3101/4101)" value={balance.equity.surplusReserve || 0} />
                        <Row label="本年利润 (3103/4103)" value={balance.equity.profitThisYear} />
                        <Row label="利润分配 (3104/4104)" value={balance.equity.retainedEarnings} />
                        <SubTotal label="权益合计" value={balance.equity.total} />
                      </tbody>
                    </table>
                  </section>
                </div>
              </>
            )}
          </>
        )}
      </main>
    </div>
  )
}

function Card({ label, value, tone = 'default' }: { label: string; value: string; tone?: 'default' | 'red' | 'green' | 'amber' }) {
  const cls = tone === 'red' ? 'text-red-fg' : tone === 'green' ? 'text-green-fg' : tone === 'amber' ? 'text-amber-fg' : ''
  return (
    <div className="bg-white rounded-card border border-border p-3">
      <div className="text-micro text-gray3">{label}</div>
      <div className={`text-h1 font-num mt-0.5 ${cls}`}>{value}</div>
    </div>
  )
}

function SubHead({ label }: { label: string }) {
  return <tr><td colSpan={2} className="px-3 py-1.5 text-micro text-gray3 bg-bg/20 border-t border-border">{label}</td></tr>
}
function Row({ label, value }: { label: string; value: number }) {
  return (
    <tr className="border-t border-border">
      <td className="px-3 py-2 text-caption text-gray2">{label}</td>
      <td className={`px-3 py-2 text-right font-num text-caption ${value < 0 ? 'text-red-fg' : ''}`}>{`¥${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}</td>
    </tr>
  )
}
function SubTotal({ label, value }: { label: string; value: number }) {
  return (
    <tr className="border-t border-border bg-bg/40">
      <td className="px-3 py-2 text-caption font-medium">{label}</td>
      <td className={`px-3 py-2 text-right font-num text-body font-medium ${value < 0 ? 'text-red-fg' : ''}`}>{`¥${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}</td>
    </tr>
  )
}
