/**
 * PWA "添加到主屏幕" 一次性提示横条
 * - 仅在浏览器中显示 (display-mode != standalone)
 * - 用户关闭后 30 天不再弹
 * - iOS / Android 显示不同操作步骤
 */
'use client'
import { useEffect, useState } from 'react'

const KEY = 'v2-install-hint-dismissed'
const COOLDOWN_DAYS = 30

export function InstallHint() {
  const [show, setShow] = useState(false)
  const [platform, setPlatform] = useState<'ios' | 'android' | 'desktop'>('desktop')
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined') return
    // 已经是 standalone (PWA / Capacitor) 不显示
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as any).standalone === true ||
      window.location.href.includes('capacitor://')
    if (isStandalone) return
    // 30 天内已关过不显示
    const dismissedAt = localStorage.getItem(KEY)
    if (dismissedAt && Date.now() - parseInt(dismissedAt) < COOLDOWN_DAYS * 86400000) return

    const ua = navigator.userAgent.toLowerCase()
    if (/iphone|ipad|ipod/.test(ua)) setPlatform('ios')
    else if (/android|harmony/.test(ua)) setPlatform('android')
    else return  // 桌面浏览器不弹
    setShow(true)
  }, [])

  if (!show) return null

  function dismiss() {
    localStorage.setItem(KEY, String(Date.now()))
    setShow(false)
  }

  const tip = platform === 'ios'
    ? '点浏览器底部「分享 ↑」 → 选「添加到主屏幕」'
    : '点浏览器底部 / 右上「⋮」菜单 → 选「添加到主屏幕」'

  return (
    <div className="fixed bottom-2 left-2 right-2 z-[60] bg-amber/95 text-white rounded-card shadow-lg px-3 py-2.5 text-caption animate-in fade-in">
      <div className="flex items-start gap-3">
        <span className="text-h2 leading-none mt-0.5">📱</span>
        <div className="flex-1 min-w-0">
          <div className="font-medium">把「滇界」装到桌面</div>
          <div className="text-micro opacity-90 mt-0.5">{tip}</div>
        </div>
        <div className="flex flex-col gap-1 shrink-0">
          <button onClick={() => setOpen(o => !o)}
            className="px-2 py-1 rounded bg-white/20 text-micro">看不到?</button>
          <button onClick={dismiss}
            className="px-2 py-1 rounded bg-white/20 text-micro">知道了</button>
        </div>
      </div>
      {open && (
        <div className="mt-2 pt-2 border-t border-white/30 text-micro space-y-1.5 leading-relaxed">
          {platform === 'ios' ? (
            <>
              <div>· iOS Safari: 底部中间一个 ⬆️ 方框图标 → 滚到「添加到主屏幕」</div>
              <div>· iOS Chrome: 右上 ⋯ → 「分享」 → 「添加到主屏幕」</div>
            </>
          ) : (
            <>
              <div>· 鸿蒙 / 华为浏览器: <b>底部右下「⋮」</b> → 添加到主屏幕</div>
              <div>· Chrome / Edge: 右上「⋮」→ 安装应用 / 添加到主屏幕</div>
              <div>· UC / QQ 浏览器: 底部菜单 → 添加书签到主屏幕</div>
              <div className="opacity-75 mt-1">提示: 部分国产浏览器需要「桌面快捷方式」, 而非「PWA 应用」</div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
