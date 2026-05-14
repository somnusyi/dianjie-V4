/**
 * 滇界 v2 · 客户端 token / user 存储 + API 封装
 *
 * - 沿用现有 /api/auth/login 返回 { token, user: {role, storeId, ...}, tenant }
 * - localStorage key 与旧 UI 兼容：'token' / 'user' / 'tenant'
 * - role 路由由 routeForRole() 决定
 */

export type StoredUser = {
  id: string
  name: string
  email: string
  role: string
  storeId?: string | null
  store?: { id: string; name: string; no: string } | null
  supplierId?: string | null
  supplier?: { id: string; name: string } | null
}

const TOKEN_KEY = 'token'
const USER_KEY  = 'user'
const TENANT_KEY = 'tenant'

export function getToken(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem(TOKEN_KEY)
}
export function getUser(): StoredUser | null {
  if (typeof window === 'undefined') return null
  const raw = localStorage.getItem(USER_KEY)
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
}
export function setSession(token: string, user: StoredUser, tenant?: any) {
  localStorage.setItem(TOKEN_KEY, token)
  localStorage.setItem(USER_KEY, JSON.stringify(user))
  if (tenant) localStorage.setItem(TENANT_KEY, JSON.stringify(tenant))
}
export function clearSession() {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(USER_KEY)
  localStorage.removeItem(TENANT_KEY)
}

/** 角色 → 默认 home 路由（手机端） */
export function routeForRole(role: string): string {
  // dual-role 兼容期：旧角色字面值仍可能存在
  const map: Record<string, string> = {
    BOSS:           '/v2/boss/home',
    ADMIN:          '/v2/boss/home',          // legacy
    SUPER_ADMIN:    '/v2/boss/home',
    MANAGER:        '/v2/manager/home',
    PURCHASER:      '/v2/manager/home',       // legacy
    KITCHEN_LEAD:   '/v2/chef/home',
    CHEF_DIRECTOR:  '/v2/chef-director/home',
    CHEF:           '/v2/chef-director/home', // legacy（旧 CHEF=总厨）
    FINANCE:        '/v2/finance/home',
    SUPPLIER_OWNER: '/v2/supplier/home',
    SUPPLIER_STAFF: '/v2/supplier/home',      // legacy
    SUPPLIER_SUB:   '/v2/supplier/home',
    STAFF:          '/v2/login',              // 基层员工不登录
    ENGINEERING:    '/v2/engineer/home',      // 工程部
  }
  return map[role] || '/v2/login'
}

/** 角色 → PC home 路由
 * boss-pc / finance-pc 是早期纯 demo（硬编码 mock 数据，未接 API、无退出按钮），已弃用。
 * 现在 PC 与移动端共用一套真实页面（boss/home, finance/home 等）。
 * 返回 null 让调用方走 routeForRole() 的真实页面。
 */
export function pcRouteForRole(_role: string): string | null {
  return null
}

/**
 * 带 token 的 fetch 封装。失败时抛错，401 自动清 session 并跳 login。
 */
export async function apiFetch<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken()
  const headers = new Headers(init.headers)
  // 只在有 body 时设 Content-Type. 否则 Fastify 看到 "application/json" 但 body 为空会 400.
  // FormData / Blob 不要设 — 浏览器会自动加 multipart boundary
  if (init.body != null && !headers.has('Content-Type')
      && !(init.body instanceof FormData)
      && !(init.body instanceof Blob)) {
    headers.set('Content-Type', 'application/json')
  }
  if (token) headers.set('Authorization', `Bearer ${token}`)
  const res = await fetch(path, { ...init, headers })
  if (res.status === 401) {
    // 解析后端原因. 只有"真 token 过期/无效"才清 session, 其他 401 (如某端点权限误判) 不踢人
    let msg = '未登录或会话已过期'
    let isAuthExpired = false
    try {
      const j = await res.json()
      msg = j.error || j.message || msg
      const lc = String(msg).toLowerCase()
      // 真过期标志: jwt expired / invalid token / unauthorized 等关键词
      isAuthExpired = !token   // 没 token 才认定真未登录
        || /expired|invalid token|jwt|未登录|token/i.test(msg) && !/权限|不能|无权/.test(msg)
    } catch {
      isAuthExpired = !token
    }
    if (isAuthExpired) {
      clearSession()
      if (typeof window !== 'undefined' && !location.pathname.startsWith('/v2/login')) {
        location.href = '/v2/login'
      }
    }
    throw new Error(msg)
  }
  if (!res.ok) {
    let msg = res.statusText
    try { const j = await res.json(); msg = j.error || j.message || msg } catch {}
    throw new Error(msg)
  }
  return res.json()
}
