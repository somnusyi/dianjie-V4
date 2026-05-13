/**
 * 滇界 鸿蒙 NEXT 入口 Ability
 * 职责: 启动主窗口, 加载 pages/Index.ets (WebView 壳)
 */
import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit'
import { hilog } from '@kit.PerformanceAnalysisKit'
import { window } from '@kit.ArkUI'

const TAG = 'dianjie/EntryAbility'

export default class EntryAbility extends UIAbility {
  onCreate(want: Want, _: AbilityConstant.LaunchParam): void {
    hilog.info(0x0000, TAG, 'onCreate')
  }

  onDestroy(): void {
    hilog.info(0x0000, TAG, 'onDestroy')
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.loadContent('pages/Index', (err) => {
      if (err.code) {
        hilog.error(0x0000, TAG, 'loadContent failed: %{public}s', JSON.stringify(err))
        return
      }
      hilog.info(0x0000, TAG, 'loadContent success')
    })
  }

  onWindowStageDestroy(): void {
    hilog.info(0x0000, TAG, 'onWindowStageDestroy')
  }

  onForeground(): void {
    hilog.info(0x0000, TAG, 'onForeground')
  }

  onBackground(): void {
    hilog.info(0x0000, TAG, 'onBackground')
  }
}
