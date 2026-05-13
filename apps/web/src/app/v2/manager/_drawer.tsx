/**
 * 店长 中央抽屉 ⊕ FAB  PDF: manager_central_drawer
 * 5 项发起入口 + 阈值前置告知文案
 */
'use client'
const ITEMS = [
  { icon: '¥', title: '录入营业额', sub: '今日 4 渠道 · 自营 + 平台券',                 href: '/v2/manager/revenue' },
  { icon: '✓', title: '券核销待办', sub: '美团 / 抖音 实时核销日记 + 平台后台快捷入口',  href: '/v2/manager/voucher-todo' },
  { icon: '⇪', title: '平台对账',   sub: '每周上传 美团 / 抖音 CSV · 自动入账',          href: '/v2/manager/upload-platform' },
  { icon: '◧', title: '月度杂费',   sub: '租金 / 水电 / 人工 / 管理 · 月度录入',          href: '/v2/manager/expenses' },
  { icon: '⊞', title: '筹建/代付',  sub: '本店合同 · 申请支出 · 老板审批后由总部代付',    href: '/v2/manager/capital' },
  { icon: '🍲', title: '食材采购单', sub: '面向供应商 · ≤¥3K 直送 · 含验收报损链',  href: '/v2/chef/purchase/new' },
  { icon: '⎙', title: '备用金申请', sub: '日常零钱周转 · 3,000 内自动批',          href: '/v2/manager/initiate?type=PETTY_CASH' },
  { icon: '⊞', title: '报销',       sub: '垫付费用回款 · 5,000 内财务直批',         href: '/v2/manager/initiate?type=REIMBURSEMENT' },
  { icon: '⌧', title: '非食材采购', sub: '办公 / 家具 / 设备 / 餐具 · 30,000 内自动', href: '/v2/manager/initiate?type=PURCHASE_NON_FOOD' },
  { icon: '☷', title: '调班 / 请假', sub: '临时调换班次 · 替工人指派 (P1)',          href: null },
]

export default function CentralDrawer({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50" onClick={onClose}>
      <div className="absolute inset-0 bg-ink/60" />
      <div
        className="absolute bottom-0 left-0 right-0 bg-white rounded-t-card shadow-drawer p-4 pb-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="w-12 h-1 bg-gray5 rounded-full mx-auto" />
        <div className="flex items-baseline justify-between mt-3 mb-1">
          <h3 className="text-h2">发起</h3>
          <span className="text-caption text-gray3">选择一项发起申请</span>
        </div>
        <ul className="mt-2 divide-y divide-border">
          {ITEMS.map((it) => {
            const enabled = !!it.href
            const Inner = (
              <>
                <span className={`w-9 h-9 rounded-md flex items-center justify-center text-h2 ${enabled ? 'bg-bg' : 'bg-bg/50'}`}>{it.icon}</span>
                <div className="flex-1">
                  <div className={`text-h2 ${enabled ? '' : 'text-gray3'}`}>{it.title}</div>
                  <div className="text-micro text-gray3">{it.sub}</div>
                </div>
                {enabled ? <span className="text-gray3">›</span> : <span className="text-micro text-gray4">P1</span>}
              </>
            )
            return (
              <li key={it.title}>
                {enabled ? (
                  <a href={it.href!} className="w-full flex items-center gap-3 py-3 text-left">{Inner}</a>
                ) : (
                  <div className="w-full flex items-center gap-3 py-3 opacity-60">{Inner}</div>
                )}
              </li>
            )
          })}
        </ul>
        <button onClick={onClose} className="w-full mt-3 py-3 text-button text-gray2 bg-bg rounded-cta">取消</button>
      </div>
    </div>
  )
}
