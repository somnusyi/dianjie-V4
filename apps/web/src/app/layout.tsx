import type { Metadata, Viewport } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: '滇界云管 · 连锁餐饮管理平台',
  description: '连锁餐饮数字化管理平台',
  manifest: '/manifest.webmanifest',
  applicationName: '滇界',
  appleWebApp: {
    capable: true,
    title: '滇界',
    statusBarStyle: 'default',
  },
  icons: {
    icon: [
      { url: '/icons/icon-192.webp', sizes: '192x192', type: 'image/webp' },
      { url: '/icons/icon-512.webp', sizes: '512x512', type: 'image/webp' },
    ],
    apple: '/icons/icon-512.webp',
    shortcut: '/icons/icon-192.webp',
  },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover',
  themeColor: '#E07A3C',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  )
}
