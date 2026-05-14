/**
 * 滇界 主页面 = WebView 加载远程 web
 * - 等价于 Capacitor 的 WebView 壳
 * - URL: https://app.dianjie.cc (域名备案完启用) / 或 IP:8080
 * - 支持: 摄像头/相册上传 / 后退键返回上一页 / 网络异常占位页
 */
import { webview } from '@kit.ArkWeb'
import { abilityAccessCtrl, common, Permissions } from '@kit.AbilityKit'
import { promptAction } from '@kit.ArkUI'

// 单一可改的发布点 — 域名备案后切到 https://app.dianjie.cc
const ENTRY_URL = 'http://116.62.32.162:8080/v2/login'

@Entry
@Component
struct Index {
  controller: webview.WebviewController = new webview.WebviewController()
  @State loading: boolean = true
  @State error: string = ''

  // 启动时申请相机/媒体权限 (供应商上传凭证、店长拍照报损用)
  aboutToAppear(): void {
    const ctx = getContext(this) as common.UIAbilityContext
    const perms: Array<Permissions> = [
      'ohos.permission.CAMERA',
    ]
    abilityAccessCtrl.createAtManager().requestPermissionsFromUser(ctx, perms)
      .catch((e: Error) => console.error('perm request failed', e))
  }

  // 物理后退键: 让 WebView 返回上一页, 否则按系统默认 (退出)
  onBackPress(): boolean | void {
    if (this.controller.accessBackward()) {
      this.controller.backward()
      return true
    }
    return false
  }

  build() {
    Stack() {
      // 主 WebView
      Web({ src: ENTRY_URL, controller: this.controller })
        .domStorageAccess(true)
        .fileAccess(true)
        .geolocationAccess(true)
        .imageAccess(true)
        .mixedMode(MixedMode.All)            // 允许 HTTP (备案前过渡)
        .javaScriptAccess(true)
        .multiWindowAccess(false)
        .cacheMode(CacheMode.Default)
        .userAgent('Mozilla/5.0 (Linux; HarmonyOS 6.1; cc.dianjie.app) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36 DianjieHarmonyOS/1.0')
        .width('100%').height('100%')
        .onPageBegin(() => { this.loading = true; this.error = '' })
        .onPageEnd(() => { this.loading = false })
        .onErrorReceive((event) => {
          if (event && event.error) {
            const code = event.error.getErrorInfo()
            console.error('web error', code)
            // 仅主框架错误显示, 子资源失败不挡用户
            if (event.request && event.request.isMainFrame()) {
              this.error = `网络异常: ${code}`
              this.loading = false
            }
          }
        })
        // PDF / 文件下载: WebView 默认会拦截 .pdf 链接, 这里转给系统浏览器打开
        // (鸿蒙 ArkWeb 内置 PDF 渲染较弱, 让用户用更稳的 系统浏览器 / 文件管理 处理)
        .onDownloadStart((event) => {
          console.log('download start:', event.url)
          try {
            const ctx = getContext(this) as common.UIAbilityContext
            ctx.startAbility({
              action: 'ohos.want.action.viewData',
              uri: event.url,
              type: event.mimetype || 'application/pdf',
            }).catch((e: Error) => {
              console.error('startAbility failed:', e)
              promptAction.showToast({ message: '无法打开下载链接, 请截图保存或复制链接到浏览器', duration: 3000 })
            })
          } catch (e) {
            console.error('download handler err:', e)
          }
        })

      // 加载中遮罩 (短暂网络抖动场景)
      if (this.loading) {
        Column() {
          LoadingProgress().width(48).height(48).color('#E07A3C')
          Text('加载中…').fontSize(14).fontColor('#7B6E5B').margin({ top: 12 })
        }
        .width('100%').height('100%')
        .justifyContent(FlexAlign.Center)
        .backgroundColor('#FAF6EF')
      }

      // 网络错误重试页
      if (this.error) {
        Column() {
          Text('⚠').fontSize(48).fontColor('#E07A3C').margin({ bottom: 12 })
          Text('连不上服务器').fontSize(18).fontWeight(FontWeight.Medium)
          Text(this.error).fontSize(13).fontColor('#7B6E5B').margin({ top: 6 })
          Button('重试')
            .margin({ top: 24 })
            .backgroundColor('#E07A3C')
            .onClick(() => {
              this.error = ''
              this.controller.loadUrl(ENTRY_URL)
            })
        }
        .width('100%').height('100%')
        .justifyContent(FlexAlign.Center)
        .backgroundColor('#FAF6EF')
      }
    }
    .width('100%').height('100%')
  }
}
