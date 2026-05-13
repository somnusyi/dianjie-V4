/**
 * 店长 · 录入营业额 (4 类渠道分组 + 抽成拆解)
 *
 * 自营 (系统能自动核对): 微信小程序 / 支付宝 / 现金
 * 平台券 (扣抽成): 美团核销 / 抖音核销
 *
 * 平台券需录"面值"和"实际到账", 系统自动算抽成 → 销售费用
 *
 * POST /api/revenue · 同日 upsert
 * rawData.channels = { wechatMini, alipay, cash, meituanGmv, meituanNet, douyinGmv, douyinNet }
 */
'use client'
import { useEffect, useState } from 'react'
import { apiFetch, getUser } from '@/lib/v2-auth'

type ChannelKey = 'wechatMini' | 'alipay' | 'cash' | 'meituanGmv' | 'meituanNet' | 'douyinGmv' | 'douyinNet'

const SELF_CHANNELS = [
  { key: 'wechatMini' as const, label: '微信小程序',  icon: 'W', hint: '自营点单 · 商户号收款' },
  { key: 'alipay'     as const, label: '支付宝',      icon: 'A', hint: '店内扫码 · 商户号收款' },
  { key: 'cash'       as const, label: '现金',        icon: '¥', hint: '收银员代收 · 闭店清点' },
]
// 平台券需要 GMV (面值) + Net (实际到账), 抽成 = GMV - Net
const PLATFORM_CHANNELS = [
  { gmv: 'meituanGmv' as const, net: 'meituanNet' as const, label: '美团/点评券', icon: 'M' },
  { gmv: 'douyinGmv'  as const, net: 'douyinNet'  as const, label: '抖音券',      icon: 'D' },
]

function todayStr() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export default function ManagerRevenuePage() {
  const [date, setDate] = useState(todayStr())
  const [vals, setVals] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [storeName, setStoreName] = useState('本店')
  const [existing, setExisting] = useState<any | null>(null)
  const [loadingExisting, setLoadingExisting] = useState(false)

  useEffect(() => {
    const u = getUser()
    setStoreName(u?.store?.name || '本店')
  }, [])

  // 同日已有记录 → 回填
  useEffect(() => {
    if (!date) return
    setLoadingExisting(true)
    apiFetch<any[]>(`/api/revenue?month=${date.slice(0, 7)}`)
      .then(rows => {
        const hit = (rows || []).find(r => r.date?.slice(0, 10) === date)
        if (hit) {
          setExisting(hit)
          const ch = hit.rawData?.channels || {}
          const m: Record<string, string> = {}
          ;['wechatMini','alipay','cash','meituanGmv','meituanNet','douyinGmv','douyinNet'].forEach(k => {
            if (ch[k] != null) m[k] = String(ch[k])
          })
          // 兼容旧字段(直接 wechat/meituan/douyin)
          if (!m.wechatMini && ch.wechat) m.wechatMini = String(ch.wechat)
          if (!m.meituanGmv && ch.meituan) m.meituanGmv = String(ch.meituan)
          if (!m.douyinGmv && ch.douyin) m.douyinGmv = String(ch.douyin)
          setVals(m)
        } else { setExisting(null); setVals({}) }
      })
      .catch(() => {})
      .finally(() => setLoadingExisting(false))
  }, [date])

  const num = (k: ChannelKey) => Number(vals[k]) || 0

  // 自营 = 顾客花的钱 = 直接进商户号
  const selfTotal = SELF_CHANNELS.reduce((s, c) => s + num(c.key as ChannelKey), 0)
  // 平台 GMV = 顾客花的钱(券面值)
  const platformGmv = PLATFORM_CHANNELS.reduce((s, c) => s + num(c.gmv), 0)
  // 平台 Net = 平台扣抽成后实际打你卡的(店长可不录,默认 = GMV)
  const platformNet = PLATFORM_CHANNELS.reduce((s, c) => {
    const g = num(c.gmv); const n = num(c.net) || g
    return s + n
  }, 0)
  const platformFee = Math.max(0, platformGmv - platformNet)
  const totalGmv = selfTotal + platformGmv          // 总营收 (报表 Hero 显示)
  const totalNet = selfTotal + platformNet          // 净到账 (现金流)

  async function submit() {
    setError(null)
    if (totalGmv <= 0) { setError('请至少填写一个渠道金额'); return }
    setSubmitting(true)
    try {
      const channels: Record<string, number> = {}
      ;([...SELF_CHANNELS.map(c=>c.key), ...PLATFORM_CHANNELS.flatMap(c=>[c.gmv, c.net])]).forEach(k => {
        const n = Number(vals[k]) || 0
        if (n > 0) channels[k] = n
      })
      await apiFetch('/api/revenue', {
        method: 'POST',
        body: JSON.stringify({
          date, channels, amount: totalGmv,        // amount 取 GMV
          source: 'manual',
        }),
      })
      location.href = '/v2/manager/ops'
    } catch (e: any) {
      setError(e.message || '提交失败')
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen bg-bg pb-28">
      <header className="px-4 pt-4 pb-2 flex items-center gap-3">
        <button onClick={() => history.back()} className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center">‹</button>
        <div>
          <h1 className="text-h1">{existing ? '编辑营业额' : '录入营业额'}</h1>
          <p className="text-caption text-gray3">{storeName} · 自营 + 平台券分录</p>
        </div>
      </header>

      <div className="px-4 mt-2 space-y-3">
        <div className="bg-white rounded-card border border-border p-3">
          <label className="text-micro text-gray3 block mb-1">营业日</label>
          <input type="date" value={date} max={todayStr()} onChange={e => setDate(e.target.value)}
                 className="w-full text-body bg-transparent outline-none font-num" />
          {existing && <p className="text-micro text-amber-fg mt-1">该日已有记录, 提交将覆盖</p>}
          {loadingExisting && <p className="text-micro text-gray3 mt-1">加载中…</p>}
        </div>

        {/* 自营 */}
        <Section title="自营" right="商户号 / 现金 · 全额到账">
          <div className="bg-white rounded-card border border-border overflow-hidden">
            {SELF_CHANNELS.map((c, i) => (
              <div key={c.key} className={`flex items-center px-3 py-2.5 ${i < SELF_CHANNELS.length - 1 ? 'border-b border-border' : ''}`}>
                <span className="w-8 h-8 rounded-md bg-bg text-gray2 flex items-center justify-center text-button mr-3">{c.icon}</span>
                <div className="flex-1">
                  <div className="text-h2">{c.label}</div>
                  <div className="text-micro text-gray3">{c.hint}</div>
                </div>
                <Money value={vals[c.key] || ''} onChange={v => setVals(s => ({ ...s, [c.key]: v }))} />
              </div>
            ))}
          </div>
        </Section>

        {/* 平台券 */}
        <Section title="平台券" right="含平台抽成 · 区分面值/到账">
          {PLATFORM_CHANNELS.map(c => {
            const g = Number(vals[c.gmv]) || 0
            const n = Number(vals[c.net]) || 0
            const fee = g > 0 && n > 0 ? Math.max(0, g - n) : 0
            const feePct = g > 0 && n > 0 ? Math.round(fee / g * 1000) / 10 : null
            return (
              <div key={c.gmv} className="bg-white rounded-card border border-border overflow-hidden mb-2">
                <div className="px-3 py-2.5 bg-bg/30 flex items-center gap-3">
                  <span className="w-8 h-8 rounded-md bg-white text-gray2 flex items-center justify-center text-button">{c.icon}</span>
                  <span className="text-h2">{c.label}</span>
                  {feePct != null && <span className="text-micro text-orange-fg ml-auto">抽成 {feePct}%</span>}
                </div>
                <div className="flex items-center px-3 py-2 border-b border-border">
                  <div className="flex-1 text-caption text-gray2">核销面值 (GMV)</div>
                  <Money value={vals[c.gmv] || ''} onChange={v => setVals(s => ({ ...s, [c.gmv]: v }))} />
                </div>
                <div className="flex items-center px-3 py-2">
                  <div className="flex-1 text-caption text-gray2">实际到账 <span className="text-micro text-gray3">(可选)</span></div>
                  <Money value={vals[c.net] || ''} onChange={v => setVals(s => ({ ...s, [c.net]: v }))} placeholder={g > 0 ? String(g) : '0'} />
                </div>
              </div>
            )
          })}
        </Section>

        {/* 汇总卡 */}
        <div className="bg-ink text-white rounded-card p-4 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-caption text-white/70">总营收 (GMV)</span>
            <span className="font-num text-h1">¥{totalGmv.toLocaleString()}</span>
          </div>
          <div className="border-t border-white/10" />
          <div className="flex items-center justify-between text-caption">
            <span className="text-white/60">  自营 (3 渠道)</span>
            <span className="font-num text-white/80">¥{selfTotal.toLocaleString()}</span>
          </div>
          <div className="flex items-center justify-between text-caption">
            <span className="text-white/60">  平台券 GMV</span>
            <span className="font-num text-white/80">¥{platformGmv.toLocaleString()}</span>
          </div>
          {platformFee > 0 && (
            <div className="flex items-center justify-between text-caption">
              <span className="text-orange-fg">  平台抽成 (销售费用)</span>
              <span className="font-num text-orange-fg">−¥{platformFee.toLocaleString()}</span>
            </div>
          )}
          <div className="border-t border-white/10" />
          <div className="flex items-center justify-between">
            <span className="text-caption text-amber-fg">实际到账</span>
            <span className="font-num text-h2 text-amber-fg">¥{totalNet.toLocaleString()}</span>
          </div>
        </div>

        {error && <div className="bg-red-bg text-red-fg rounded-card p-3 text-caption">{error}</div>}
      </div>

      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-border p-3">
        <button onClick={submit} disabled={submitting || totalGmv <= 0}
                className="w-full py-3 bg-ink text-white rounded-cta text-button disabled:opacity-40">
          {submitting ? '提交中…' : `提交 · ¥${totalGmv.toLocaleString()}`}
        </button>
      </div>
    </div>
  )
}

function Money({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div className="flex items-center">
      <span className="text-gray3 mr-1 font-num">¥</span>
      <input
        type="number" inputMode="decimal" min="0" step="0.01"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder || '0'}
        className="w-24 text-right font-num text-body bg-transparent outline-none"
      />
    </div>
  )
}

function Section({ title, right, children }: { title: string; right?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1.5 px-1">
        <h2 className="text-h2">{title}</h2>
        {right && <span className="text-micro text-gray3">{right}</span>}
      </div>
      {children}
    </div>
  )
}
