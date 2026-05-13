/**
 * v2 通用「我的」页 · 账户信息 + 设置 + 登出
 * BOSS / FINANCE / SUPPLIER 等共用
 */
'use client'
import { useEffect, useState } from 'react'
import { getUser, getToken, clearSession, routeForRole } from '@/lib/v2-auth'
import { ROLE_LABELS } from '@/components/v2/role-labels'
import { ConfirmSheet, useConfirmSheet } from '@/components/v2/confirm-sheet'

export default function MePage() {
  const [u, setU] = useState<any>(null)
  const [pendingCount, setPendingCount] = useState(0)
  const [confirmState, openConfirm] = useConfirmSheet()
  useEffect(() => {
    const user = getUser()
    setU(user)
    if (user && (user.role === 'BOSS' || user.role === 'ADMIN' || user.role === 'SUPER_ADMIN')) {
      const t = getToken()
      fetch('/api/applications/pending-count', { headers: { Authorization: `Bearer ${t}` } })
        .then(r => r.ok ? r.json() : { count: 0 })
        .then(d => setPendingCount(d.count || 0))
        .catch(() => {})
    }
  }, [])
  if (!u) return null

  function back() {
    location.href = routeForRole(u.role)
  }
  function resetOnboarding() {
    Object.keys(localStorage).filter(k => k.startsWith('v2-onboarded:')).forEach(k => localStorage.removeItem(k))
    alert('引导已重置, 下次进入工作台会重新显示')
  }
  function logout() {
    openConfirm({
      title: '退出登录?',
      body: '退出后需重新输入账号密码。',
      confirmLabel: '退出',
      tone: 'danger',
      onConfirm: () => {
        clearSession()
        location.href = '/v2/login'
      },
    })
  }

  return (
    <div className="min-h-screen bg-bg pb-12">
      <header className="px-4 pt-4 pb-2 flex items-center gap-3">
        <button onClick={back} className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center">‹</button>
        <h1 className="text-h1">我的</h1>
      </header>

      <div className="px-4 mt-2 space-y-3">
        {/* 账户卡 */}
        <div className="bg-white rounded-card border border-border p-4 flex items-center gap-3">
          <div className="w-14 h-14 rounded-full bg-amber text-white flex items-center justify-center text-h1">
            {u.name?.[0] || '?'}
          </div>
          <div className="flex-1">
            <div className="text-h1">{u.name}</div>
            <div className="text-caption text-gray3 mt-0.5">
              {ROLE_LABELS[u.role] || u.role}
              {u.store?.name && ` · ${u.store.name}`}
              {u.supplier?.name && ` · ${u.supplier.name}`}
            </div>
            <div className="text-micro text-gray3 font-num truncate mt-0.5">{u.email}</div>
          </div>
        </div>

        {/* 入口 */}
        <ul className="bg-white rounded-card border border-border divide-y divide-border">
          <li>
            <a href="/v2/notifications" className="flex items-center px-3 py-3">
              <span className="w-8 h-8 rounded-md bg-bg flex items-center justify-center mr-3">⌬</span>
              <span className="flex-1 text-body">消息中心</span>
              <span className="text-gray3">›</span>
            </a>
          </li>
          {(u.role === 'BOSS' || u.role === 'ADMIN' || u.role === 'SUPER_ADMIN' || u.role === 'FINANCE') && (
            <>
              <li>
                <a href="/v2/profit" className="flex items-center px-3 py-3">
                  <span className="w-8 h-8 rounded-md bg-amber/10 text-amber-fg flex items-center justify-center mr-3">⛁</span>
                  <span className="flex-1 text-body">净利总览</span>
                  <span className="text-micro text-gray3 mr-1">月/季/年/累计</span>
                  <span className="text-gray3">›</span>
                </a>
              </li>
              <li>
                <a href="/v2/budget" className="flex items-center px-3 py-3">
                  <span className="w-8 h-8 rounded-md bg-amber/10 text-amber-fg flex items-center justify-center mr-3">¥</span>
                  <span className="flex-1 text-body">建店资金台账</span>
                  <span className="text-micro text-gray3 mr-1">财务上传 / 老板可改</span>
                  <span className="text-gray3">›</span>
                </a>
              </li>
            </>
          )}
          {(u.role === 'BOSS' || u.role === 'ADMIN' || u.role === 'SUPER_ADMIN') && (
            <>
              <li>
                <a href="/v2/me/team" className="flex items-center px-3 py-3">
                  <span className="w-8 h-8 rounded-md bg-amber/10 text-amber-fg flex items-center justify-center mr-3">人</span>
                  <span className="flex-1 text-body">团队成员</span>
                  <span className="text-micro text-gray3 mr-1">店长/财务/厨师长</span>
                  <span className="text-gray3">›</span>
                </a>
              </li>
              <li>
                <a href="/v2/me/suppliers" className="flex items-center px-3 py-3">
                  <span className="w-8 h-8 rounded-md bg-amber/10 text-amber-fg flex items-center justify-center mr-3">供</span>
                  <span className="flex-1 text-body">供应商管理</span>
                  <span className="text-micro text-gray3 mr-1">建供应商 / 发邀请</span>
                  <span className="text-gray3">›</span>
                </a>
              </li>
              <li>
                <a href="/v2/me/applications" className="flex items-center px-3 py-3">
                  <span className="w-8 h-8 rounded-md bg-amber/10 text-amber-fg flex items-center justify-center mr-3">✓</span>
                  <span className="flex-1 text-body">账号申请审批</span>
                  {pendingCount > 0 && (
                    <span className="text-micro px-1.5 py-0.5 rounded-full bg-amber text-white mr-1">{pendingCount}</span>
                  )}
                  <span className="text-gray3">›</span>
                </a>
              </li>
            </>
          )}
          {(u.role === 'BOSS' || u.role === 'ADMIN' || u.role === 'SUPER_ADMIN' || u.role === 'FINANCE') && (
            <>
              <li>
                <a href="/v2/boss/payment-config" className="flex items-center px-3 py-3">
                  <span className="w-8 h-8 rounded-md bg-amber/10 text-amber-fg flex items-center justify-center mr-3">¥</span>
                  <span className="flex-1 text-body">门店收款配置</span>
                  <span className="text-micro text-gray3 mr-1">收钱吧/银行卡</span>
                  <span className="text-gray3">›</span>
                </a>
              </li>
              <li>
                <a href="/v2/boss/payment-onboarding" className="flex items-center px-3 py-3">
                  <span className="w-8 h-8 rounded-md bg-amber/10 text-amber-fg flex items-center justify-center mr-3">⇅</span>
                  <span className="flex-1 text-body">收款上线追踪</span>
                  <span className="text-micro text-gray3 mr-1">BD/技术/上线</span>
                  <span className="text-gray3">›</span>
                </a>
              </li>
              <li>
                <a href="/v2/boss/capital" className="flex items-center px-3 py-3">
                  <span className="w-8 h-8 rounded-md bg-amber/10 text-amber-fg flex items-center justify-center mr-3">⊞</span>
                  <span className="flex-1 text-body">代付项目总览</span>
                  <span className="text-micro text-gray3 mr-1">所有店</span>
                  <span className="text-gray3">›</span>
                </a>
              </li>
              <li>
                <a href="/v2/finance/capital-review" className="flex items-center px-3 py-3">
                  <span className="w-8 h-8 rounded-md bg-amber/10 text-amber-fg flex items-center justify-center mr-3">⇲</span>
                  <span className="flex-1 text-body">代付申请审批</span>
                  <span className="text-micro text-gray3 mr-1">店长申请</span>
                  <span className="text-gray3">›</span>
                </a>
              </li>
            </>
          )}
          <li>
            <button onClick={resetOnboarding} className="w-full flex items-center px-3 py-3 text-left">
              <span className="w-8 h-8 rounded-md bg-bg flex items-center justify-center mr-3">？</span>
              <span className="flex-1 text-body">重看新手引导</span>
              <span className="text-gray3">›</span>
            </button>
          </li>
          <li>
            <div className="flex items-center px-3 py-3 opacity-60">
              <span className="w-8 h-8 rounded-md bg-bg flex items-center justify-center mr-3">⚙</span>
              <span className="flex-1 text-body">设置</span>
              <span className="text-micro text-gray4">P1</span>
            </div>
          </li>
          <li>
            <div className="flex items-center px-3 py-3 opacity-60">
              <span className="w-8 h-8 rounded-md bg-bg flex items-center justify-center mr-3">⊞</span>
              <span className="flex-1 text-body">关于滇界</span>
              <span className="text-micro text-gray3">v1.1</span>
            </div>
          </li>
        </ul>

        <button
          onClick={logout}
          className="w-full py-3 bg-white border border-border rounded-cta text-button text-red-fg"
        >
          退出登录
        </button>
      </div>

      <ConfirmSheet {...confirmState} />
    </div>
  )
}
