/**
 * 滇界 v2 · 客户端 token / user 存储 + API 封装
 *
 * - 沿用现有 /api/auth/login 返回 { token, refreshToken, user, tenant }
 * - access token (token) 2h 短寿; refresh token (refreshToken) 30d
 * - apiFetch 拿到 401 且 token 看似过期 时, 静默调 /api/auth/refresh 续期, 再重试原请求
 *   refresh 失败 → 清 session + 跳 /v2/login
 * - localStorage key 与旧 UI 兼容: 'token' / 'user' / 'tenant' / 'refreshToken'
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
const REFRESH_KEY = 'refreshToken'
const USER_KEY  = 'user'
const TENANT_KEY = 'tenant'

export function getToken(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem(TOKEN_KEY) || localStorage.getItem('dj_token')
}
export function getRefreshToken(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem(REFRESH_KEY) || localStorage.getItem('dj_refresh')
}
export function getUser(): StoredUser | null {
  if (typeof window === 'undefined') return null
  const raw = localStorage.getItem(USER_KEY) || localStorage.getItem('dj_user')
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
}
export function setSession(token: string, user: StoredUser, tenant?: any, refreshToken?: string) {
  localStorage.setItem(TOKEN_KEY, token)
  localStorage.setItem(USER_KEY, JSON.stringify(user))
  // 兼容仍在使用旧 AppLayout/axios 的桌面页面。
  localStorage.setItem('dj_token', token)
  localStorage.setItem('dj_user', JSON.stringify(user))
  if (tenant) localStorage.setItem(TENANT_KEY, JSON.stringify(tenant))
  if (refreshToken) {
    localStorage.setItem(REFRESH_KEY, refreshToken)
    localStorage.setItem('dj_refresh', refreshToken)
  }
}
export function clearSession() {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(REFRESH_KEY)
  localStorage.removeItem(USER_KEY)
  localStorage.removeItem(TENANT_KEY)
  localStorage.removeItem('dj_token')
  localStorage.removeItem('dj_refresh')
  localStorage.removeItem('dj_user')
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
 * /v2/login 是手机端统一登录, 财务/老板/店长 一律走原来的移动端 home (即使在 PC 宽屏上)
 * 财务想用新的 PC 工作台必须显式访问 /v2/finance-pc/login (独立 PWA scope, 独立登录页)
 * 返回 null 让调用方走 routeForRole() 的移动端真实页面
 */
export function pcRouteForRole(_role: string): string | null {
  return null
}

// ── refresh 单例 + 并发去重 ────────────────────────────
// 多个请求同时 401 时, 只发一次 /api/auth/refresh, 其余等结果复用
let _refreshInFlight: Promise<string | null> | null = null

async function refreshAccessOnce(): Promise<string | null> {
  if (_refreshInFlight) return _refreshInFlight
  const rt = getRefreshToken()
  if (!rt) return null
  _refreshInFlight = (async () => {
    try {
      const res = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: rt }),
      })
      if (!res.ok) return null
      const j = await res.json()
      if (!j?.token) return null
      localStorage.setItem(TOKEN_KEY, j.token)
      localStorage.setItem('dj_token', j.token)
      // user 也可能因角色变更被刷掉, 同步存
      if (j.user) localStorage.setItem(USER_KEY, JSON.stringify(j.user))
      return j.token as string
    } catch {
      return null
    } finally {
      _refreshInFlight = null
    }
  })()
  return _refreshInFlight
}

/**
 * 带 token 的 fetch 封装. 401 且 token 看似过期时, 自动 refresh + 重试一次.
 * refresh 失败 → 清 session + 跳 /v2/login.
 */
export async function apiFetch<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const doFetch = async (token: string | null) => {
    const headers = new Headers(init.headers)
    // 只在有 body 时设 Content-Type. 否则 Fastify 看到 "application/json" 但 body 为空会 400.
    // FormData / Blob 不要设 — 浏览器会自动加 multipart boundary
    if (init.body != null && !headers.has('Content-Type')
        && !(init.body instanceof FormData)
        && !(init.body instanceof Blob)) {
      headers.set('Content-Type', 'application/json')
    }
    if (token) headers.set('Authorization', `Bearer ${token}`)
    return fetch(path, { ...init, headers })
  }

  let token = getToken()
  let res = await doFetch(token)

  if (res.status === 401) {
    // 解析后端原因: 真过期 vs 权限不足 (后者不应触发 refresh, 也不应踢人)
    let msg = '未登录或会话已过期'
    let isAuthExpired = false
    let bodyClone: any
    try {
      bodyClone = await res.clone().json()
      msg = bodyClone.message || bodyClone.error || msg
      const lc = String(msg).toLowerCase()
      isAuthExpired = !token
        || (/expired|invalid token|jwt|未登录|token/i.test(msg) && !/权限|不能|无权/.test(msg))
    } catch {
      isAuthExpired = !token
    }

    if (isAuthExpired) {
      // 尝试 refresh 续期
      const newToken = await refreshAccessOnce()
      if (newToken) {
        res = await doFetch(newToken)
        if (res.ok) return res.json()
        // refresh 后仍 401: 真过期 / refresh 被撤销
        if (res.status === 401) {
          clearSession()
          if (typeof window !== 'undefined' && !location.pathname.startsWith('/v2/login')) {
            location.href = '/v2/login'
          }
          throw new Error('会话已过期')
        }
      } else {
        // 没 refresh / refresh 失败 → 踢回登录
        clearSession()
        if (typeof window !== 'undefined' && !location.pathname.startsWith('/v2/login')) {
          location.href = '/v2/login'
        }
        throw new Error(msg)
      }
    } else {
      // 不是过期 (是权限不足等), 抛错但不清 session
      throw new Error(msg)
    }
  }

  if (!res.ok) {
    let msg = res.statusText
    let data: any = null
    // Fastify's default error envelope contains both error="Conflict" and a
    // domain-specific message. Always surface the actionable domain message.
    try { data = await res.json(); msg = data.message || data.error || msg } catch {}
    const error = new Error(msg) as Error & { status?: number; data?: any }
    error.status = res.status
    error.data = data
    throw error
  }
  return res.json()
}

/** Download an authenticated non-JSON API response using the same refresh policy. */
export async function apiDownload(path: string, fallbackFilename: string) {
  const request = (token: string | null) => fetch(path, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  })
  let res = await request(getToken())
  if (res.status === 401) {
    const refreshed = await refreshAccessOnce()
    if (refreshed) res = await request(refreshed)
    if (!refreshed || res.status === 401) {
      clearSession()
      if (typeof window !== 'undefined' && !location.pathname.startsWith('/v2/login')) location.href = '/v2/login'
      throw new Error('会话已过期')
    }
  }
  if (!res.ok) {
    let message = res.statusText || '下载失败'
    try {
      const data = await res.clone().json()
      message = data.message || data.error || message
    } catch {}
    throw new Error(message)
  }
  const disposition = res.headers.get('Content-Disposition') || ''
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
  const plain = disposition.match(/filename="?([^";]+)"?/i)?.[1]
  let filename = fallbackFilename
  try { filename = encoded ? decodeURIComponent(encoded) : plain || fallbackFilename } catch {}
  return { blob: await res.blob(), filename }
}
