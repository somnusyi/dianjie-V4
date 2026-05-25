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
 *
 * 历史: 2026-05-22 之前用 http://116.62.32.162:8080 (cleartext) 走 IP;
 *       njdianjie.com ICP 备案通过后切 https. 老 app 仍在客户手机里指 IP,
 *       服务器 nginx 同时开 IP:80 + njdianjie.com:443 两个入口, 直到所有
 *       客户重装新版本 app 后才能退役 IP 入口.
 *       新打包的 iOS/Android/Harmony app 走这里的 https 域名.
 */
import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.dianjie.cloud',
  appName: '滇界',
  // webDir 必填: cap copy 时把这里的内容拷进原生工程
  // 这里指 public 是因为我们目前走 server.url 在线模式, 离线不可用
  webDir: 'public',
  server: {
    // 生产: njdianjie.com 域名 + HTTPS (nginx vhost 已配 Let's Encrypt 证书)
    url: 'https://www.njdianjie.com',
    // HTTPS 不需要 cleartext; iOS ATS / Android NSC 自然允许
  },
  ios: {
    contentInset: 'automatic',
  },
  android: {
    // 局域网 HTTP 调试仍允许 (dev 模式 server.url 可能指 192.168.x.x)
    allowMixedContent: true,
  },
}

export default config
