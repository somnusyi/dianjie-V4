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

  // 转发原始 headers, 但 strip 掉浏览器侧 Origin/Referer/Host 避免 ECS CORS 检查触发
  const headers = new Headers()
  req.headers.forEach((v, k) => {
    const lk = k.toLowerCase()
    if (lk === 'origin' || lk === 'referer' || lk === 'host' || lk === 'connection') return
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
  }).catch((e) => {
    return new Response(JSON.stringify({ error: 'proxy fetch failed', detail: e?.message }), {
      status: 502, headers: { 'Content-Type': 'application/json' }
    })
  })

  // 透传响应
  const respHeaders = new Headers()
  upstream.headers.forEach((v, k) => {
    const lk = k.toLowerCase()
    if (lk.startsWith('access-control-') || lk === 'transfer-encoding') return  // 由 next 自己处理
    respHeaders.set(k, v)
  })
  const buf = await upstream.arrayBuffer()
  return new NextResponse(buf, { status: upstream.status, headers: respHeaders })
}

export const GET    = proxy
export const POST   = proxy
export const PATCH  = proxy
export const PUT    = proxy
export const DELETE = proxy
export const HEAD   = proxy
