/**
 * 财务 PC Web · 资金 Tab  PDF: finance_web_funds
 * Hero 总账户余额 + 4 账户表格 + 7 day calendar + 应付到期表格
 */
'use client'
import { BlackHero, Chip } from '@/components/v2'
import FinanceTopNav from '../_topnav'

const ACCOUNTS = [
  { name: '招商银行 · 主账户', tail: '****6123', amount: 185000, pct: 65, status: '正常' as const },
  { name: '微信支付商户',      sub: '8 家店',     amount: 48000,  pct: 17, status: '正常' as const },
  { name: '支付宝商户',         sub: '8 家店',     amount: 40000,  pct: 14, status: '正常' as const },
  { name: '各店现金备用金',     sub: '8 家店合计', amount: 12000,  pct: 4,  status: '告警' as const, anomaly: true },
]
const WEEK = [
  { day: '三', date: '04/28', isToday: true,  amount: null },
  { day: '四', date: '04/29', amount: '¥11.2K', highlight: true },
  { day: '五', date: '04/30', amount: null },
  { day: '六', date: '05/01', amount: '¥3.8K', highlight: true },
  { day: '日', date: '05/02', amount: '¥6.4K', highlight: true },
  { day: '一', date: '05/03', amount: null },
  { day: '二', date: '05/04', amount: null },
]
const PAYABLE = [
  { supplier: '京西生鲜', type: '周结', date: '04/29 周四', amount: 11200, voucher: '已收',    action: '安排付款' },
  { supplier: '大唐调味', type: '月结', date: '05/01 周六', amount: 3800,  voucher: '已收',    action: '查看' },
  { supplier: '草原牧业', type: '月结', date: '05/02 周日', amount: 6400,  voucher: '已收',    action: '查看' },
]

export default function FinancePCFundsPage() {
  return (
    <div className="min-h-screen bg-bg">
      <FinanceTopNav />
      <main className="max-w-[1440px] mx-auto px-6 py-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-h1">资金</h1>
            <p className="text-caption text-gray3">集团 · 4 个账户 · 04/28 14:23</p>
          </div>
          <button className="px-4 py-2 bg-white border border-border rounded-cta text-button text-gray2">导出对账单</button>
        </div>

        <BlackHero
          density="desktop"
          label="总账户余额 ● 实时"
          value="¥285K"
          delta={{ text: '↑ ¥45K 较月初 · 覆盖 1.6 个月运营支出 · 健康', trend: 'up' }}
          stats={[
            { label: '月流入', value: '+¥420K', tone: 'green' },
            { label: '月流出', value: '−¥235K', tone: 'red' },
            { label: '月净',   value: '+¥185K', tone: 'green' },
          ]}
        />

        <div className="grid grid-cols-2 gap-4 mt-4">
          <section className="bg-white rounded-card border border-border overflow-hidden">
            <header className="px-4 py-3 border-b border-border flex items-center justify-between">
              <h2 className="text-h2">账户余额</h2>
              <span className="text-caption text-gray3">4 个账户 · ¥285K</span>
            </header>
            <table className="w-full">
              <thead className="bg-bg/40">
                <tr className="text-micro text-gray3 text-left">
                  <th className="px-3 py-2 font-normal">账户</th>
                  <th className="px-3 py-2 font-normal text-right">余额</th>
                  <th className="px-3 py-2 font-normal w-[100px]">占比</th>
                  <th className="px-3 py-2 font-normal text-right">状态</th>
                  <th className="px-3 py-2 font-normal text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {ACCOUNTS.map(a => (
                  <tr key={a.name} className={`border-t border-border ${a.anomaly ? 'bg-orange-bg/30' : ''}`}>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <span className="w-7 h-7 rounded-md bg-bg flex items-center justify-center font-num text-caption">{a.name[0]}</span>
                        <div>
                          <div className="text-body">{a.name}</div>
                          <div className="text-micro text-gray3">{a.tail || a.sub}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 font-num text-right">¥{a.amount.toLocaleString()}</td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-1.5">
                        <div className="h-1.5 bg-bg rounded-full overflow-hidden flex-1">
                          <div className={`h-full ${a.anomaly ? 'bg-red' : 'bg-gray2'}`} style={{ width: `${a.pct}%` }} />
                        </div>
                        <span className="text-micro font-num text-gray3 w-8 text-right">{a.pct}%</span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <Chip tone={a.anomaly ? 'orange' : 'green'}>{a.status}</Chip>
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <a href="#" className="text-caption text-gray2 hover:text-ink">{a.anomaly ? '补拨 ›' : '流水 ›'}</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="bg-white rounded-card border border-border p-4">
            <header className="flex items-center justify-between mb-3">
              <h2 className="text-h2">本周应付到期</h2>
              <span className="text-caption text-gray3">3 笔 · ¥21,400</span>
            </header>
            <div className="grid grid-cols-7 gap-1 mb-3">
              {WEEK.map(d => (
                <div key={d.date} className={`flex flex-col items-center text-center py-2 rounded-card ${d.isToday ? 'border border-ink' : d.highlight ? 'bg-bg' : ''}`}>
                  <span className="text-micro text-gray3">{d.day}</span>
                  <span className="text-caption">{d.date}</span>
                  {d.isToday && <span className="text-micro text-gray2 mt-0.5">今日</span>}
                  {d.amount && <span className="font-num text-button text-ink mt-1">{d.amount}</span>}
                </div>
              ))}
            </div>
            <table className="w-full">
              <thead className="bg-bg/40">
                <tr className="text-micro text-gray3 text-left">
                  <th className="px-3 py-2 font-normal">供应商</th>
                  <th className="px-3 py-2 font-normal">类型</th>
                  <th className="px-3 py-2 font-normal">到期日</th>
                  <th className="px-3 py-2 font-normal text-right">金额</th>
                  <th className="px-3 py-2 font-normal">发票</th>
                  <th className="px-3 py-2 font-normal text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {PAYABLE.map((p, i) => (
                  <tr key={i} className="border-t border-border">
                    <td className="px-3 py-2.5 text-body">{p.supplier}</td>
                    <td className="px-3 py-2.5"><Chip tone="gray">{p.type}</Chip></td>
                    <td className="px-3 py-2.5 text-body font-num">{p.date}</td>
                    <td className="px-3 py-2.5 font-num text-right">¥{p.amount.toLocaleString()}</td>
                    <td className="px-3 py-2.5"><Chip tone="green">{p.voucher}</Chip></td>
                    <td className="px-3 py-2.5 text-right">
                      <button className="px-3 py-1 bg-ink text-white rounded-cta text-micro">{p.action}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
      </main>
    </div>
  )
}
