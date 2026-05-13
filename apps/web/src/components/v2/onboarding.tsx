/**
 * 首次登录 onboarding · 按角色 2 屏教学
 * 触发: home 页挂载, localStorage 'v2-onboarded:<role>' 不存在则显示
 * 关闭: 「开始使用」按钮 / 右上叉
 */
'use client'
import { useEffect, useState } from 'react'
import { getUser } from '@/lib/v2-auth'

type Slide = { icon: string; title: string; body: string; tip?: string }

const BOSS_SLIDES: Slide[] = [
  { icon: '◰', title: '总览全部门店', body: '首屏 Hero 看本月集团 GMV / 净利 / 客流, 下方展开多店当月对比', tip: '点门店卡片进单店利润表' },
  { icon: '✓', title: '审批超阈值大额', body: '系统按金额自动路由到您, 决策上下文 (调价 / 退货 / 大额采购) 80% 嵌卡内' },
]
const SUPPLIER_SLIDES: Slide[] = [
  { icon: '☰', title: '订单流水线', body: '待接单 → 已接单 → 配送中 → 已送达, 滑卡操作; 红条 = 厨师长报损待您处理' },
  { icon: '△', title: '报损 24h 内回复', body: '同意 → 自动退款 / 换货; 拒绝 → 走总厨二审' },
]
const CHEF_DIR_SLIDES: Slide[] = [
  { icon: '✓', title: '集中审批 4 类单', body: '调价 / 新供应商 / 新菜品 / 大额食材, 顶部 Tab 一键过滤' },
  { icon: '⚡', title: '调价跳财务直送', body: '调价单不再走财务一审, 直送您拍板; 卡内显示原价 → 新价对比 + 涨幅%' },
]

const SLIDES: Record<string, Slide[]> = {
  // 老板（4 个旧/新别名都映射到老板内容）
  BOSS: BOSS_SLIDES,
  ADMIN: BOSS_SLIDES,
  SUPER_ADMIN: BOSS_SLIDES,
  // 店长
  MANAGER: [
    { icon: '¥', title: '每日 1 件事', body: '收档后录今日营业额 (5 渠道分录), 右上「+录营业额」一键进入', tip: '不录营业额 → 老板/财务报表会显示零' },
    { icon: '⊕', title: '中央 ⊕ 发起申请', body: '底部中央按钮 ⊕: 食材采购 / 备用金 / 报销 / 非食材 / 杂费录入' },
  ],
  PURCHASER: [
    { icon: '¥', title: '每日 1 件事', body: '收档后录今日营业额, 右上「+录营业额」一键进入', tip: '不录营业额 → 老板/财务报表会显示零' },
    { icon: '⊕', title: '中央 ⊕ 发起申请', body: '底部中央按钮 ⊕: 食材采购 / 备用金 / 报销 / 非食材 / 杂费录入' },
  ],
  // 厨师长
  KITCHEN_LEAD: [
    { icon: '🍲', title: '采购下单 → 收货', body: '中央 ⊕ 选食材采购单, 选供应商 + 商品 + 数量 → 一键提交; 货到点「收货」录入实际数量' },
    { icon: '△', title: '收货短量自动报损', body: '若实际 < 应到, 系统自动建报损单走总厨审批, 通过后退款流程跟进' },
  ],
  // 总厨
  CHEF_DIRECTOR: CHEF_DIR_SLIDES,
  CHEF: CHEF_DIR_SLIDES,
  // 财务
  FINANCE: [
    { icon: '◧', title: '待付款一览', body: '本月到期账期单 + 报销 + 备用金 一屏看, 招行直连一键打款' },
    { icon: '✓', title: '小额自动批', body: '备用金 ≤3K / 报销 ≤5K 自动跳过您, 您只看大额 + 异常单' },
  ],
  // 供应商
  SUPPLIER_OWNER: SUPPLIER_SLIDES,
  SUPPLIER_STAFF: SUPPLIER_SLIDES,
  SUPPLIER_SUB: SUPPLIER_SLIDES,
  // 工程部 (筹建)
  ENGINEERING: [
    { icon: '◰', title: '筹建看板', body: '我负责的所有筹建中门店一屏看 — 阶段 / 任务进度 / 阻塞', tip: '点店卡 → 进单店进度详情' },
    { icon: '☰', title: '任务清单', body: '默认 30 项 SOP 任务 (商务/装修/设备/证照/筹备), 勾选完成 / 标阻塞带原因' },
    { icon: '⚠', title: '上线需老板批', body: '阶段推进到「试营业」之前你自己改, 切到「已开业」要老板审批' },
  ],
}

export function Onboarding() {
  const [show, setShow] = useState(false)
  const [idx, setIdx] = useState(0)
  const [role, setRole] = useState<string | null>(null)

  useEffect(() => {
    const u = getUser()
    if (!u) return
    const key = `v2-onboarded:${u.role}`
    if (typeof localStorage !== 'undefined' && !localStorage.getItem(key)) {
      setRole(u.role); setShow(true)
    }
  }, [])

  if (!show || !role) return null
  const slides = SLIDES[role] || SLIDES.MANAGER
  const cur = slides[idx]
  const last = idx === slides.length - 1

  function dismiss() {
    if (role) localStorage.setItem(`v2-onboarded:${role}`, '1')
    setShow(false)
  }

  return (
    <div className="fixed inset-0 z-[60] bg-ink/80 flex items-end sm:items-center justify-center" onClick={dismiss}>
      <div className="bg-white w-full sm:max-w-md rounded-t-card sm:rounded-card p-5 pb-6" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <div className="flex gap-1.5">
            {slides.map((_, i) => (
              <span key={i} className={`h-1.5 rounded-full transition-all ${i === idx ? 'w-6 bg-amber' : 'w-1.5 bg-gray5'}`} />
            ))}
          </div>
          <button onClick={dismiss} className="text-gray3 text-h2" aria-label="关闭">×</button>
        </div>

        <div className="text-center py-6">
          <div className="text-[64px] mb-3">{cur.icon}</div>
          <h2 className="text-h1 mb-2">{cur.title}</h2>
          <p className="text-body text-gray2 leading-relaxed">{cur.body}</p>
          {cur.tip && <p className="text-caption text-amber-fg mt-3">💡 {cur.tip}</p>}
        </div>

        <div className="flex gap-2 mt-4">
          {idx > 0 && (
            <button onClick={() => setIdx(idx - 1)}
                    className="flex-1 py-3 bg-white border border-border rounded-cta text-button text-gray2">上一步</button>
          )}
          {!last ? (
            <button onClick={() => setIdx(idx + 1)}
                    className="flex-1 py-3 bg-ink text-white rounded-cta text-button">下一步</button>
          ) : (
            <button onClick={dismiss}
                    className="flex-1 py-3 bg-amber text-white rounded-cta text-button">开始使用</button>
          )}
        </div>
      </div>
    </div>
  )
}
