/**
 * 店长 · 平台券核销待办
 *
 * 流程提醒(L1) — 在我们没接美团/抖音 API 之前的现实方案
 * 核心目标: 不让收银员漏核销, 闭店前提醒批量处理
 *
 * 数据来源:
 *   - 收银员录入"今日已核销"(简记本数字, 1 周后 CSV 复核)
 *   - 闭店时点提醒
 *   - 历史核销日均(从 RevenueRecord 取 meituanGmv / douyinGmv)
 */
'use client'
import { useEffect, useState } from 'react'
import { apiFetch, getUser } from '@/lib/v2-auth'

type RevenueRecord = {
  date: string
  amount: string
  rawData?: { channels?: Record<string, number> }
}

type DailyTrack = {
  meituanCount?: number   // 今日已核销美团张数
  meituanGmv?: number     // 今日已核销美团面值
  douyinCount?: number
  douyinGmv?: number
  notedAt?: string
}

const LS_KEY = (storeId: string, date: string) => `voucher-track:${storeId}:${date}`
const todayStr = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export default function VoucherTodoPage() {
  const [storeId, setStoreId] = useState<string | null>(null)
  const [storeName, setStoreName] = useState('本店')
  const [date] = useState(todayStr())
  const [track, setTrack] = useState<DailyTrack>({})
  const [vals, setVals] = useState<Record<string, string>>({})
  const [history, setHistory] = useState<RevenueRecord[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [savedOk, setSavedOk] = useState(false)

  useEffect(() => {
    const u = getUser()
    const sid = u?.storeId || u?.store?.id || null
    setStoreId(sid)
    setStoreName(u?.store?.name || '本店')
    if (!sid) return
    // 今日已记录
    try {
      const raw = localStorage.getItem(LS_KEY(sid, date))
      if (raw) {
        const d: DailyTrack = JSON.parse(raw)
        setTrack(d)
        setVals({
          meituanCount: d.meituanCount?.toString() || '',
          meituanGmv:   d.meituanGmv?.toString() || '',
          douyinCount:  d.douyinCount?.toString() || '',
          douyinGmv:    d.douyinGmv?.toString() || '',
        })
      }
    } catch {}
    // 历史 7 天作为参考(估算今日预期核销)
    apiFetch<RevenueRecord[]>(`/api/revenue?month=${date.slice(0, 7)}`)
      .then(rows => setHistory(rows.slice(0, 14)))
      .catch(() => setHistory([]))
  }, [date])

  // 历史日均(过去 7 天平均美团/抖音 GMV)
  const avg7d = (() => {
    if (!history) return null
    const recent = history.filter(r => r.date.slice(0, 10) !== date).slice(0, 7)
    if (recent.length === 0) return null
    let mt = 0, dy = 0
    recent.forEach(r => {
      const ch = r.rawData?.channels || {}
      mt += Number(ch.meituanGmv || ch.meituan || 0)
      dy += Number(ch.douyinGmv || ch.douyin || 0)
    })
    return { meituan: Math.round(mt / recent.length), douyin: Math.round(dy / recent.length), days: recent.length }
  })()

  function setV(k: string, v: string) { setVals(s => ({ ...s, [k]: v })); setSavedOk(false) }

  function save() {
    if (!storeId) return
    setError(null)
    const next: DailyTrack = {
      meituanCount: Number(vals.meituanCount) || 0,
      meituanGmv:   Number(vals.meituanGmv) || 0,
      douyinCount:  Number(vals.douyinCount) || 0,
      douyinGmv:    Number(vals.douyinGmv) || 0,
      notedAt: new Date().toISOString(),
    }
    try {
      localStorage.setItem(LS_KEY(storeId, date), JSON.stringify(next))
      setTrack(next); setSavedOk(true)
    } catch (e: any) { setError(e.message) }
  }

  const totalGmv = Number(vals.meituanGmv || 0) + Number(vals.douyinGmv || 0)
  const totalCount = Number(vals.meituanCount || 0) + Number(vals.douyinCount || 0)

  return (
    <div className="min-h-screen bg-bg pb-12">
      <header className="px-4 pt-4 pb-2 flex items-center gap-3">
        <button onClick={() => history.back()} className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center">‹</button>
        <div>
          <h1 className="text-h1">平台券核销</h1>
          <p className="text-caption text-gray3">{storeName} · {date}</p>
        </div>
      </header>

      {/* 引导卡 */}
      <div className="mx-4 mt-3 bg-bg-warm rounded-card border border-border p-3">
        <p className="text-caption text-gray2"><span className="text-amber-fg">流程</span>: 顾客到店 → 出示券码 → 收银员到 <a className="text-amber-fg underline" href="https://shanggou.meituan.com/" target="_blank" rel="noreferrer">美团掌柜</a> 输码核销 → 这里记录张数 + 面值</p>
        <p className="text-micro text-gray3 mt-1">⏰ 建议每日闭店前处理一次, 漏核销 = 平台不结算这笔钱</p>
      </div>

      {/* 历史日均参考 */}
      {avg7d && (avg7d.meituan > 0 || avg7d.douyin > 0) && (
        <div className="mx-4 mt-3 bg-white rounded-card border border-border p-3">
          <p className="text-micro text-gray3">最近 {avg7d.days} 天日均参考</p>
          <div className="flex items-center gap-4 mt-1">
            <div><span className="text-caption text-gray2">美团 </span><span className="font-num text-button">¥{avg7d.meituan.toLocaleString()}</span></div>
            <div><span className="text-caption text-gray2">抖音 </span><span className="font-num text-button">¥{avg7d.douyin.toLocaleString()}</span></div>
          </div>
        </div>
      )}

      {/* 录入卡 */}
      <Section title={`今日已核销 · ${date}`}>
        <div className="bg-white rounded-card border border-border overflow-hidden">
          <Group icon="M" label="美团/大众点评" tone="orange">
            <Field label="张数">
              <input type="number" inputMode="numeric" min="0" value={vals.meituanCount || ''}
                     onChange={e => setV('meituanCount', e.target.value)}
                     placeholder="0" className={INP} />
            </Field>
            <Field label="累计面值">
              <input type="number" inputMode="decimal" min="0" step="0.01" value={vals.meituanGmv || ''}
                     onChange={e => setV('meituanGmv', e.target.value)}
                     placeholder="0" className={INP + ' font-num'} />
            </Field>
          </Group>
          <Group icon="D" label="抖音生活服务" tone="red">
            <Field label="张数">
              <input type="number" inputMode="numeric" min="0" value={vals.douyinCount || ''}
                     onChange={e => setV('douyinCount', e.target.value)}
                     placeholder="0" className={INP} />
            </Field>
            <Field label="累计面值">
              <input type="number" inputMode="decimal" min="0" step="0.01" value={vals.douyinGmv || ''}
                     onChange={e => setV('douyinGmv', e.target.value)}
                     placeholder="0" className={INP + ' font-num'} />
            </Field>
          </Group>
        </div>
      </Section>

      {/* 汇总 */}
      <div className="mx-4 mt-3 bg-ink text-white rounded-card p-3">
        <div className="flex items-center justify-between">
          <span className="text-caption text-white/70">今日核销合计</span>
          <span className="font-num text-h1">¥{totalGmv.toLocaleString()}</span>
        </div>
        <div className="flex items-center justify-between mt-1 text-caption text-white/60">
          <span>共 {totalCount} 张</span>
          <span>预估抽成 ~¥{Math.round(totalGmv * 0.08).toLocaleString()} (按 8%)</span>
        </div>
      </div>

      {/* 操作快捷 */}
      <Section title="快捷动作">
        <ul className="bg-white rounded-card border border-border divide-y divide-border">
          <li>
            <a href="https://shanggou.meituan.com/" target="_blank" rel="noreferrer"
               className="flex items-center px-3 py-3">
              <span className="w-8 h-8 rounded-md bg-orange-bg text-orange-fg flex items-center justify-center mr-3">M</span>
              <div className="flex-1">
                <div className="text-body">打开美团掌柜核销</div>
                <div className="text-micro text-gray3">商户后台 → 验券</div>
              </div>
              <span className="text-gray3">↗</span>
            </a>
          </li>
          <li>
            <a href="https://life.douyin.com/" target="_blank" rel="noreferrer"
               className="flex items-center px-3 py-3">
              <span className="w-8 h-8 rounded-md bg-red-bg text-red-fg flex items-center justify-center mr-3">D</span>
              <div className="flex-1">
                <div className="text-body">打开抖音生活服务核销</div>
                <div className="text-micro text-gray3">商户后台 → 验券</div>
              </div>
              <span className="text-gray3">↗</span>
            </a>
          </li>
          <li>
            <a href="/v2/manager/upload-platform" className="flex items-center px-3 py-3">
              <span className="w-8 h-8 rounded-md bg-amber/10 text-amber-fg flex items-center justify-center mr-3">⇪</span>
              <div className="flex-1">
                <div className="text-body">每周上传对账 CSV</div>
                <div className="text-micro text-gray3">系统按面值/抽成自动入账, 复核日记</div>
              </div>
              <span className="text-gray3">›</span>
            </a>
          </li>
        </ul>
      </Section>

      {error && <div className="mx-4 mt-3 bg-red-bg text-red-fg rounded-card p-3 text-caption">{error}</div>}
      {savedOk && <div className="mx-4 mt-3 bg-green-bg text-green-fg rounded-card p-3 text-caption">✓ 已记录今日核销 · 闭店前别忘了到平台后台核销实际券码</div>}

      <div className="mx-4 mt-3">
        <button onClick={save}
                className="w-full py-3 bg-ink text-white rounded-cta text-button">
          保存今日记录
        </button>
      </div>

      <p className="text-micro text-gray3 px-4 mt-3">
        💡 这里记录的是"日记账"用于实时报表, 周末上传 CSV 时系统会自动复核 · 数据存本浏览器
      </p>
    </div>
  )
}

const INP = 'w-24 text-right text-body bg-bg rounded-chip px-2 py-1 outline-none'

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="px-4 mt-4">
      <h2 className="text-h2 mb-2">{title}</h2>
      {children}
    </section>
  )
}

function Group({ icon, label, tone, children }: { icon: string; label: string; tone: 'orange'|'red'; children: React.ReactNode }) {
  const toneCls = tone === 'orange' ? 'bg-orange-bg text-orange-fg' : 'bg-red-bg text-red-fg'
  return (
    <div className="border-b border-border last:border-b-0">
      <div className="px-3 py-2.5 bg-bg/30 flex items-center gap-3">
        <span className={`w-8 h-8 rounded-md ${toneCls} flex items-center justify-center text-button`}>{icon}</span>
        <span className="text-h2">{label}</span>
      </div>
      <div className="divide-y divide-border">{children}</div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center px-3 py-2">
      <span className="flex-1 text-caption text-gray2">{label}</span>
      {children}
    </div>
  )
}
