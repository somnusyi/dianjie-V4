/**
 * Capacitor 配置 · 滇界餐饮 SaaS 原生 App
 *
 * Bundle ID:
 *  - iOS:        com.dianjie.cloud   (App Store Connect 已注册的 APP "滇界云管")
 *  - Android:    cc.dianjie.app      (华为/小米/腾讯应用宝)
 *  - HarmonyOS:  cc.dianjie.app      (AGC 注册)
 *
 * iOS 单独用 com.dianjie.cloud 是历史原因, 那个 APP 在 Apple 这边已经有审核记录,
 * 测试组都加好了, 不动它能继续走 TestFlight 增量更新.
 *
 * 加载策略：
 *  - dev: server.url 指向局域网 Next dev (3200), 改代码手机端 HMR 实时刷新
 *  - prod: 注释掉 server.url, 把 web build 静态化后通过 webDir 内嵌
 *          (项目用了 Next API 路由 + SSR, 真正"完全离线 App"需要先把
 *          /api/* 拆出去 → ECS, 把页面改成纯客户端渲染再 next export)
 *
 * 切环境只改 server.url 这一行。
 */
import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.dianjie.cloud',
  appName: '滇界',
  // webDir 必填: cap copy 时把这里的内容拷进原生工程
  // 这里指 public 是因为我们目前走 server.url 在线模式, 离线不可用
  webDir: 'public',
  server: {
    // staging: 阿里云 ECS, 走 nginx :8080 → web :3204 / api :4004
    // 域名+HTTPS 上线后改成 https://app.dianjie.cc
    url: 'http://116.62.32.162:8080',
    // 暂时无 HTTPS, 必须打开 cleartext
    cleartext: true,
  },
  ios: {
    contentInset: 'automatic',
  },
  android: {
    // 允许局域网 HTTP 调试
    allowMixedContent: true,
  },
}

export default config
