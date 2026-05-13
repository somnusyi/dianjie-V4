/**
 * v2 顶角用户菜单（头像点开下拉）
 * - 显示当前角色 + 门店
 * - 切换/登出
 */
'use client'
import { useState, useEffect } from 'react'
import { getUser, clearSession } from '@/lib/v2-auth'
import { ROLE_LABELS } from './role-labels'
import { NotificationBell } from './notification-bell'

export function UserMenu() {
  const [u, setU] = useState<any>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => { setU(getUser()) }, [])
  if (!u) return null

  const initial = u.name?.[0] || '?'

  return (
    <div className="flex items-center gap-2"><NotificationBell />
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="w-9 h-9 rounded-full bg-amber text-white flex items-center justify-center font-num shadow-sm"
      >
        {initial}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-11 z-50 bg-white rounded-card border border-border shadow-fab w-56 overflow-hidden">
            <div className="px-3 py-3 border-b border-border">
              <div className="text-h2">{u.name}</div>
              <div className="text-micro text-gray3">
                {ROLE_LABELS[u.role] || u.role}
                {u.store?.name && ` · ${u.store.name}`}
                {u.supplier?.name && ` · ${u.supplier.name}`}
              </div>
              <div className="text-micro text-gray3 font-num truncate mt-0.5">{u.email}</div>
            </div>
            <button
              onClick={() => {
                clearSession()
                location.href = '/v2/login'
              }}
              className="w-full text-left px-3 py-3 text-button text-red-fg hover:bg-red-bg"
            >
              退出登录
            </button>
          </div>
        </>
      )}
    </div>
    </div>
  )
}
