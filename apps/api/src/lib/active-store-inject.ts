import type { FastifyRequest } from 'fastify'

/**
 * 多店活动门店注入（onRequest 钩子）。
 *
 * 前端门店切换器通过 X-Active-Store 头声明当前操作门店；
 * 仅对 query schema 声明了 storeId 的路由注入（等价于用户手动选店），
 * 其余路由不碰——strict query schema 收到多余 key 会直接 400
 * （2026-08-19：全量注入击穿 /api/suppliers 等 19 个 strict 列表，下单页瘫痪）。
 *
 * 新增"按活动门店过滤"的端点时，必须同步把前缀加进这张清单，
 * 并确认其 query schema 声明了 storeId。
 */
export const ACTIVE_STORE_INJECT_PREFIXES = [
  '/api/orders',
  '/api/deliveries',
  '/api/inventory',
  '/api/inventory-counts',
  '/api/daily-business-imports',
  '/api/applications',
  '/api/users',
]

// 必须保持 async：Fastify 钩子的同步函数若不回调 done() 且不返回 Promise，
// 请求链会永久挂起（2026-08-19 热修时改成同步函数导致全站请求超时）。
export async function activeStoreInjectHook(request: FastifyRequest) {
  const active = request.headers['x-active-store']
  if (typeof active !== 'string' || !active) return
  if (request.url.startsWith('/api/auth/')) return // 登录/申请等公开端点不注入
  const url = request.url
  const allowed = ACTIVE_STORE_INJECT_PREFIXES.some(prefix =>
    url === prefix || url.startsWith(`${prefix}/`) || url.startsWith(`${prefix}?`))
  if (!allowed) return
  const q = request.query as Record<string, unknown> | undefined
  if (q && typeof q === 'object' && q.storeId === undefined) q.storeId = active
}
