// 显式自定义 404 — 按当前登录角色跳对应工作台, 避免被甩到登录页(造成"退出"错觉)
'use client'
import { useEffect, useState } from 'react'
export const dynamic = 'force-dynamic'

export default function NotFound() {
  const [homeHref, setHomeHref] = useState('/')
  useEffect(() => {
    try {
      const raw = localStorage.getItem('user')
      if (!raw) { setHomeHref('/v2/login'); return }
      const u = JSON.parse(raw)
      const role = u?.role || ''
      const map: Record<string, string> = {
        BOSS: '/v2/boss/home', ADMIN: '/v2/boss/home', SUPER_ADMIN: '/v2/boss/home',
        MANAGER: '/v2/manager/home', PURCHASER: '/v2/manager/home',
        KITCHEN_LEAD: '/v2/chef/home',
        CHEF_DIRECTOR: '/v2/chef-director/home', CHEF: '/v2/chef-director/home',
        FINANCE: '/v2/finance/home',
        SUPPLIER_OWNER: '/v2/supplier/home', SUPPLIER_STAFF: '/v2/supplier/home', SUPPLIER_SUB: '/v2/supplier/home',
        ENGINEERING: '/v2/engineer/home',
      }
      setHomeHref(map[role] || '/v2/login')
    } catch { setHomeHref('/v2/login') }
  }, [])
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#F1EFE8', color: '#1A1815', fontFamily: 'system-ui' }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 48, marginBottom: 12 }}>🤔</div>
        <h2 style={{ fontSize: 18, fontWeight: 600 }}>页面不存在</h2>
        <p style={{ fontSize: 13, color: '#5F5E5A', marginTop: 4 }}>请检查地址或返回工作台</p>
        <a href={homeHref} style={{ display: 'inline-block', marginTop: 16, padding: '8px 20px', background: '#1A1815', color: '#fff', borderRadius: 12, textDecoration: 'none', fontSize: 14 }}>返回工作台</a>
        <div style={{ marginTop: 12 }}>
          <a href="javascript:history.back()" style={{ fontSize: 13, color: '#5F5E5A' }}>‹ 返回上一页</a>
        </div>
      </div>
    </div>
  )
}
