# 滇界 · 鸿蒙 NEXT 客户端

ArkTS WebView 壳, 加载 web 端 (跟 Capacitor APK 同源同登录系统).

## 编译前你需要

1. **DevEco Studio 5.0+** (Mac/Windows 都支持)
   下载: https://developer.huawei.com/consumer/cn/deveco-studio/
2. **华为开发者账号** (实名认证完成)
   注册: https://developer.huawei.com/
3. **签名文件 4 件套**:
   - `dianjie.p12` (密钥库)
   - `dianjie.csr` (证书签名请求)
   - `dianjie.cer` (证书)
   - `dianjie.p7b` (Profile)

   生成步骤:
   1. DevEco Studio → Build → Generate Key And CSR → 自动生成 .p12 + .csr
   2. AppGallery Connect → 我的项目 → 滇界 → 应用证书 → 上传 .csr → 下载 .cer
   3. AppGallery Connect → 我的项目 → 滇界 → Profile → 创建 → 选 .cer → 下载 .p7b

   把 4 个文件放到 `apps/harmony/signature/` 下 (.gitignore 已忽略)

## 编译

```bash
cd apps/harmony
# 第一次安装依赖
ohpm install
# debug 包 (可在模拟器/真机直接装)
hvigorw assembleHap --mode module -p product=default -p buildMode=debug
# release 包 (上架华为应用市场用)
hvigorw assembleHap --mode module -p product=default -p buildMode=release
```

产物在 `apps/harmony/entry/build/default/outputs/default/entry-default-signed.hap`

## 修改服务地址

`entry/src/main/ets/pages/Index.ets` 里的 `ENTRY_URL`:

```ts
const ENTRY_URL = 'http://116.62.32.162:8080/v2/login'  // 备案完切到 https://app.dianjie.cc
```

## 项目结构
~~~~
```
apps/harmony/
├── AppScope/
│   ├── app.json5                    # 全局 bundleName/version
│   └── resources/base/
│       ├── element/string.json
│       └── media/app_icon.png       # 1024x1024 主图标
├── entry/                            # 主模块
│   ├── build-profile.json5
│   ├── hvigorfile.ts
│   ├── oh-package.json5
│   └── src/main/
│       ├── module.json5             # 权限/能力声明
│       ├── ets/
│       │   ├── entryability/
│       │   │   └── EntryAbility.ets   # 应用入口生命周期
│       │   └── pages/
│       │       └── Index.ets          # 主页面 = WebView
│       └── resources/base/
│           ├── element/{string,color}.json
│           ├── media/{icon,startIcon,foreground,background}.png
│           └── profile/main_pages.json
├── build-profile.json5              # 项目级
├── hvigorfile.ts
├── oh-package.json5
└── signature/                        # ⬅ 你的签名 4 件套放这里 (.gitignore)
```

## 真机调试

1. 鸿蒙 NEXT 手机 USB 接电脑, 设置 → 关于本机 → 连点版本号 7 次开发者模式
2. 设置 → 系统 → 开发者选项 → USB 调试 + 选择 USB 配置 → 文件传输
3. DevEco Studio 自动识别, 点 ▶ Run → 自动 install + launch

## 分发

- **企业内部**: HAP 直接传给员工, 鸿蒙手机文件管理器双击安装 (要先开发者模式)
- **华为应用市场**: AGC 上传 release HAP → 提交审核 (3-7 天)

## 跟 Web / Android 关系

- 同一份业务逻辑 (Web 端), 鸿蒙仅是 WebView 壳
- 同一个 RDS 数据 + 同一个 API 域名
- 用户登录账号通用, 数据完全互通
- 升级业务功能时只需改 Web, 这个 HAP 不需要重新发版
