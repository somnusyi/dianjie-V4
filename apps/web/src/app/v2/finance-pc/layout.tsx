/**
 * /v2/finance-pc/* server-side layout
 *
 * 用 metadata API 覆盖 root layout 的 manifest:
 *   - 整站默认 PWA = "滇界" (手机端用, /manifest.webmanifest)
 *   - 在 finance-pc 路径下注入 "滇界 · 财务工作台" PWA (/manifest-finance.webmanifest)
 *
 * 财务在 Chrome 打开 /v2/finance-pc/home 后:
 *   - 地址栏右侧自动弹 ⊕ 安装提示 (浏览器原生, 跟我无关)
 *   - 点击安装 → 桌面独立窗口启动, start_url=/v2/finance-pc/home
 *   - PWA shortcut: 右键桌面图标 → 直接跳 凭证/付款/应付/月结
 *
 * 注: 此文件不能加 'use client' — metadata 必须 server export
 *      下层 page.tsx 仍可 'use client'
 */
import type { Metadata, Viewport } from 'next'

export const metadata: Metadata = {
  title: '滇界 · 财务工作台',
  description: '财务 PC 工作台 — 凭证 / 月结 / 报税 / 对账 / 应付管理',
  applicationName: '滇界财务',
  manifest: '/manifest-finance.webmanifest',
  appleWebApp: {
    capable: true,
    title: '滇界财务',
    statusBarStyle: 'black-translucent',
  },
}

export const viewport: Viewport = {
  themeColor: '#0A0A0A',
}

export default function FinancePCLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
