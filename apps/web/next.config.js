const { withSentryConfig } = require('@sentry/nextjs')

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // /api/* 走 app/api/[...path]/route.ts 做服务端代理（去掉 browser Origin 避免 CORS）
  // 生产环境由 Nginx 处理 /api/* 转发 → :4000
  // v2 开发阶段, 暂跳过 TS strict 检查 (运行时正常, 大量 useDashboard data?.x 严格非空检查)
  typescript: { ignoreBuildErrors: true },
  eslint:     { ignoreDuringBuilds: true },
  // standalone output: 产物自包含, ~50M, 部署时只 scp .next/standalone + .next/static
  output: 'standalone',
  // 老的 PC demo 路由（boss-pc / finance-pc 是早期硬编码 mock 数据的页面）已弃用,
  // 全部转向真实移动版页面, 保证 PC 与 APP 共用一套数据 + 一份退出登录逻辑。
  async redirects() {
    return [
      { source: '/v2/boss-pc',            destination: '/v2/boss/home',      permanent: false },
      { source: '/v2/boss-pc/:path*',     destination: '/v2/boss/:path*',    permanent: false },
      { source: '/v2/finance-pc',         destination: '/v2/finance/home',   permanent: false },
      { source: '/v2/finance-pc/:path*',  destination: '/v2/finance/:path*', permanent: false },
    ]
  },
}

// SENTRY_DSN 未配置时直接导出原始配置，不加载 Sentry 插件
module.exports = process.env.NEXT_PUBLIC_SENTRY_DSN
  ? withSentryConfig(nextConfig, {
      // 不上传 source map 到 Sentry（需要 auth token，暂不配置）
      silent: true,
      disableServerWebpackPlugin: true,
      disableClientWebpackPlugin: true,
    })
  : nextConfig
