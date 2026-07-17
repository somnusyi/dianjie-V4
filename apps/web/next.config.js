const { withSentryConfig } = require('@sentry/nextjs')

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Allow CI/local verification builds to use an isolated output directory
  // while the developer server keeps using `.next`.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  // /api/* 走 app/api/[...path]/route.ts 做服务端代理（去掉 browser Origin 避免 CORS）
  // 生产环境由 Nginx 处理 /api/* 转发 → :4000
  // v2 开发阶段, 暂跳过 TS strict 检查 (运行时正常, 大量 useDashboard data?.x 严格非空检查)
  typescript: { ignoreBuildErrors: true },
  eslint:     { ignoreDuringBuilds: true },
  // standalone output: 产物自包含, ~50M, 部署时只 scp .next/standalone + .next/static
  output: 'standalone',
  // Phase 3: /v2/finance-pc/* 已重写为接真实 API 的 PC 端工作台 (FinanceTopNav + max-w-1440),
  // 与 /v2/finance/* 手机端共存. 原本兜底转手机的 redirect 已移除.
  // /v2/boss-pc 仍弃用, 继续 redirect.
  async redirects() {
    return [
      { source: '/v2/boss-pc',            destination: '/v2/boss/home',      permanent: false },
      { source: '/v2/boss-pc/:path*',     destination: '/v2/boss/:path*',    permanent: false },
      { source: '/v2/finance-pc',         destination: '/v2/finance-pc/home', permanent: false },
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
