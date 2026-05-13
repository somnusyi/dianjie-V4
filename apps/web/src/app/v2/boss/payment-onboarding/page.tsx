/**
 * 老板 · 收款方案上线追踪
 * 帮老板对接收钱吧 BD / 走完接入流程, 关键节点 checklist
 *
 * 状态存 localStorage (key: pay-onboarding:<tenantId>)
 * 后续可改为后端 PaymentOnboarding 表
 */
'use client'
import { useEffect, useState } from 'react'
import { getUser } from '@/lib/v2-auth'

type Item = {
  id: string
  title: string
  detail?: string
  category: 'BD' | 'TECH' | 'LIVE'
  blocking?: boolean
}

const ITEMS: Item[] = [
  // BD 沟通确认
  { id: 'fee-rate',     title: '0.31% 是否覆盖所有场景?',     detail: '微信/支付宝/银联云闪付 都按 0.31%? 是否有最低交易额门槛?', category: 'BD', blocking: true },
  { id: 'openid',       title: '顾客 openid 是否回传?',         detail: '关键: 不能拿 openid → 会员体系受限,只能用手机号', category: 'BD', blocking: true },
  { id: 'mp-flow',      title: '小程序付款是用微信原生还是 SDK?', detail: '优先选微信原生 wx.requestPayment, 减少锁定', category: 'BD' },
  { id: 'multi-store',  title: '多店分账规则确认',                detail: '8-20 家店,每家一张银行卡,按门店码自动分到对应卡', category: 'BD', blocking: true },
  { id: 'wechat-card',  title: '微信卡包/储值卡能集成吗?',       detail: '储值卡能否绑定微信会员卡(顾客微信里能直接看到)', category: 'BD' },
  { id: 'lock-period',  title: '合同锁定期 + 退出条款',           detail: '建议 1 年内可解约, 或者解约只收硬件折旧', category: 'BD', blocking: true },
  { id: 'data-export',  title: '订单流水 API + 历史数据导出',    detail: '实时 webhook + 历史数据 1 年回溯,API 文档完整否', category: 'BD' },
  { id: 'refund-api',   title: '退款 API + 退款时效',             detail: '我们 ERP 里能调 API 直接发起退款, T+0 或 T+1 退到顾客', category: 'BD' },

  // 技术接入
  { id: 'tech-account', title: '收钱吧 商户后台账号 + API Key', detail: '签合同后会下发, 录入到 ERP 门店配置', category: 'TECH' },
  { id: 'webhook-url',  title: '配置 webhook 回调地址',           detail: '指向我们 ERP 的 /api/pay-puller/webhook/qianqian', category: 'TECH' },
  { id: 'test-pay',     title: '联调 1 笔 ¥0.01 测试单',          detail: '走真实链路: 顾客扫码 → 收钱吧 → webhook → ERP RevenueRecord', category: 'TECH' },
  { id: 'csv-meituan',  title: '上传第 1 份美团 CSV 对账',        detail: '老板给店长培训 1 次, 周一上传上周的核销账单', category: 'TECH' },

  // 上线
  { id: 'pilot-store',  title: '选 1 家店做试点',                  detail: '建议人流量中等, 店长配合度高的, 跑 2 周观察', category: 'LIVE' },
  { id: 'sign-replace', title: '换桌签码 + 收银台二维码',         detail: '收钱吧寄硬件物料, 现场更换 1 小时', category: 'LIVE' },
  { id: 'staff-train',  title: '店长 / 收银员培训 1 小时',        detail: '操作差异 + 异常处理(扫码失败 / 退款流程)', category: 'LIVE' },
  { id: 'rollout',      title: '试点 OK 后全店推开',              detail: '8 家店 1-2 周陆续切换', category: 'LIVE' },
]

const CATEGORY_LABELS = {
  BD: { label: 'BD 沟通', desc: '签合同前问清楚', icon: '💬' },
  TECH: { label: '技术接入', desc: '签后 1 周', icon: '🔧' },
  LIVE: { label: '上线推开', desc: '试点 → 全店', icon: '🚀' },
}

const LS_KEY = (tenant: string) => `pay-onboarding:${tenant}`

export default function PayOnboardingPage() {
  const [done, setDone] = useState<Record<string, boolean>>({})
  const [tenantId, setTenantId] = useState<string>('')

  useEffect(() => {
    const u = getUser()
    const tid = (u as any)?.tenantId || JSON.parse(localStorage.getItem('tenant') || '{}').id || 'default'
    setTenantId(tid)
    try {
      const raw = localStorage.getItem(LS_KEY(tid))
      if (raw) setDone(JSON.parse(raw))
    } catch {}
  }, [])

  function toggle(id: string) {
    const next = { ...done, [id]: !done[id] }
    setDone(next)
    if (tenantId) localStorage.setItem(LS_KEY(tenantId), JSON.stringify(next))
  }

  const total = ITEMS.length
  const doneCount = Object.values(done).filter(Boolean).length
  const blockingItems = ITEMS.filter(i => i.blocking)
  const blockingDone = blockingItems.filter(i => done[i.id]).length
  const pct = Math.round((doneCount / total) * 100)

  return (
    <div className="min-h-screen bg-bg pb-12">
      <header className="px-4 pt-4 pb-2 flex items-center gap-3">
        <button onClick={() => history.back()} className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center">‹</button>
        <div className="flex-1">
          <h1 className="text-h1">收款上线追踪</h1>
          <p className="text-caption text-gray3">收钱吧 接入 · 0.31% 全场景</p>
        </div>
      </header>

      {/* 总进度卡 */}
      <div className="mx-4 mt-3 bg-ink text-white rounded-card p-4">
        <div className="flex items-baseline justify-between mb-2">
          <span className="text-caption text-white/70">总进度</span>
          <span className="font-num text-h1">{doneCount}/{total}</span>
        </div>
        <div className="h-2 bg-white/10 rounded-full overflow-hidden mb-3">
          <div className="h-full bg-amber transition-all" style={{ width: `${pct}%` }} />
        </div>
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <div className="text-micro text-white/60">关键阻塞项</div>
            <div className="font-num text-button">{blockingDone}/{blockingItems.length} 解决</div>
          </div>
          <div className="flex-1">
            <div className="text-micro text-white/60">完成度</div>
            <div className="font-num text-button text-amber">{pct}%</div>
          </div>
        </div>
      </div>

      {/* 分组 */}
      {(['BD', 'TECH', 'LIVE'] as const).map(cat => {
        const meta = CATEGORY_LABELS[cat]
        const items = ITEMS.filter(i => i.category === cat)
        const subDone = items.filter(i => done[i.id]).length
        return (
          <section key={cat} className="px-4 mt-5">
            <div className="flex items-baseline justify-between mb-2">
              <h2 className="text-h2"><span className="mr-2">{meta.icon}</span>{meta.label}</h2>
              <span className="text-caption text-gray3">{subDone}/{items.length} · {meta.desc}</span>
            </div>
            <ul className="bg-white rounded-card border border-border divide-y divide-border">
              {items.map(i => {
                const isDone = !!done[i.id]
                return (
                  <li key={i.id} onClick={() => toggle(i.id)}
                      className={`px-3 py-3 cursor-pointer ${isDone ? 'bg-bg/40' : ''}`}>
                    <div className="flex items-start gap-3">
                      <div className={`w-5 h-5 rounded-full border-2 mt-0.5 shrink-0 flex items-center justify-center ${
                        isDone ? 'bg-amber border-amber text-white' : 'border-gray4 bg-white'
                      }`}>
                        {isDone && <span className="text-[10px] leading-none">✓</span>}
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <span className={`text-body ${isDone ? 'text-gray3 line-through' : ''}`}>{i.title}</span>
                          {i.blocking && !isDone && <span className="text-micro bg-red-bg text-red-fg px-1.5 py-0.5 rounded-chip">阻塞</span>}
                        </div>
                        {i.detail && <p className={`text-micro mt-0.5 ${isDone ? 'text-gray4' : 'text-gray3'}`}>{i.detail}</p>}
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          </section>
        )
      })}

      <div className="mx-4 mt-5 bg-bg-warm rounded-card border border-border p-3 text-caption text-gray2">
        <p><span className="text-amber-fg">💡 提示</span> 标"阻塞"的项必须在签合同前 / 上线前确认, 否则后期返工成本高</p>
        <p className="text-micro text-gray3 mt-1">这份 checklist 数据保存在本浏览器, 多设备查看请保持在同一登录环境</p>
      </div>
    </div>
  )
}
