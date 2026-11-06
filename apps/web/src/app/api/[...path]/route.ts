/**
 * /api/* 服务端代理 → 生产 ECS Fastify
 *
 * 设计目的：dev 时浏览器看到 /api/* 是同源，避免 CORS。
 * 服务端 fetch 不带 Origin，ECS CORS 白名单不需要包含 dev 端口。
 *
 * 生产环境：Nginx 直接 location /api/ → :4000，本路由不会被命中。
 */
import { NextRequest, NextResponse } from 'next/server'

// 本地 dev fallback: localhost:4444 (新 V4 API_PORT)
// 生产: Nginx 直接 location /api/ → :4004, 本路由不会被命中
// 自定义环境（staging / 反代到别的 host）: export NEXT_PUBLIC_API_BASE 覆盖
const API_BASE = process.env.NEXT_PUBLIC_API_BASE || 'http://localhost:4444'

async function proxy(req: NextRequest, ctx: { params: { path: string[] } }) {
  const path = ctx.params.path.join('/')
  const search = req.nextUrl.search
  const target = `${API_BASE}/api/${path}${search}`

  // Cookie会话必须保留浏览器来源供后端CSRF校验，不能伪造或删除来源。
  const browserSession = req.headers.get('x-dianjie-session') === 'cookie-v1'
  // 旧Authorization客户端保持原代理行为。
  const headers = new Headers()
  req.headers.forEach((v, k) => {
    const lk = k.toLowerCase()
    if (lk === 'host' || lk === 'connection' || !browserSession && (lk === 'origin' || lk === 'referer')) return
    headers.set(k, v)
  })

  // 只对有 body 的方法读 body
  const hasBody = !['GET', 'HEAD'].includes(req.method)
  const body = hasBody ? await req.arrayBuffer() : undefined

  const upstream = await fetch(target, {
    method: req.method,
    headers,
    body,
    redirect: 'manual',
  }).catch(() => {
    return new Response(JSON.stringify({ error: '服务暂时不可用，请稍后重试' }), {
      status: 502, headers: { 'Content-Type': 'application/json' }
    })
  })

  // 透传响应
  const respHeaders = new Headers()
  upstream.headers.forEach((v, k) => {
    const lk = k.toLowerCase()
    if (lk.startsWith('access-control-') || lk === 'transfer-encoding' || lk === 'set-cookie') return  // 由 next 自己处理
    respHeaders.set(k, v)
  })
  // OAuth可能同时清nonce并设置refresh；不可合并为一个Set-Cookie值。
  for (const cookie of upstream.headers.getSetCookie()) respHeaders.append('set-cookie', cookie)
  const buf = await upstream.arrayBuffer()
  return new NextResponse(buf, { status: upstream.status, headers: respHeaders })
}

export const GET    = proxy
export const POST   = proxy
export const PATCH  = proxy
export const PUT    = proxy
export const DELETE = proxy
export const HEAD   = proxy
