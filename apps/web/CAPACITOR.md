# Capacitor 原生 App 打包说明

## 当前状态

✅ Capacitor v6 已装 (core / cli / ios / android + 4 个常用 plugin)
✅ `capacitor.config.ts` 已配 (Bundle ID: `cc.dianjie.app`, App Name: `滇界`)
✅ `ios/` Xcode 工程骨架已生成
✅ `android/` Gradle 工程骨架已生成
⚠️ 真机/模拟器跑还需要装原生工具链 (见下)

## 加载策略

**dev 模式**：`server.url = http://192.168.1.70:3200` ← 局域网 Next dev
- 改一行代码手机端立刻刷新, HMR 工作
- Mac 必须和手机在同一 WiFi
- 换网换 IP 时改 `capacitor.config.ts` 然后 `pnpm cap:sync`

**prod 模式**：注释掉 `server.url`, 走 `webDir`
- 项目用了 SSR + Next API 路由, 不能直接 `next export`
- 真离线方案需要：API 拆到 ECS，前端改纯客户端渲染再静态化
- 或者：`server.url` 永远指 ECS 域名 (`https://app.dianjie.cc`), App 是个壳

## 装工具链

### Android (国内安卓主战场, 优先级高)
```bash
brew install --cask android-studio          # 4-5 GB
brew install --cask temurin@17               # JDK 17
# 装完打开一次 Android Studio, 让它装 SDK Platform 34, Build Tools 34
echo 'export ANDROID_HOME=$HOME/Library/Android/sdk' >> ~/.zshrc
echo 'export PATH=$PATH:$ANDROID_HOME/platform-tools' >> ~/.zshrc
source ~/.zshrc
```

跑：
```bash
cd apps/web
pnpm cap:android        # 打开 Android Studio
# 或不开 IDE, 命令行直接装到连着的手机:
pnpm cap:run:android
```

第一次同步会下 ~500 MB Gradle 依赖, 慢一点正常。

### iOS (需要 Mac + Apple Developer)
```bash
# 安装 Xcode (从 App Store, 16+ GB), 装完跑:
sudo xcode-select --switch /Applications/Xcode.app
sudo xcodebuild -license accept
brew install cocoapods

cd apps/web
pnpm exec cap sync ios   # 触发 pod install
pnpm cap:ios             # 打开 Xcode 工程
```

在 Xcode 里：
1. 选 Signing & Capabilities → 选你的 Apple Developer Team
2. 把 iPhone 连 Mac 或选模拟器
3. 点 ▶ 运行

## 应用图标 / 启动屏

`@capacitor/assets` 工具一键生成所有尺寸：
```bash
pnpm add -D @capacitor/assets
mkdir resources
# 放进去：icon.png (1024×1024) + splash.png (2732×2732)
pnpm exec cap-assets generate --ios --android
```

Logo 文件 (滇/dianjie) 放好后我可以帮你跑。

## 常见命令

```bash
pnpm cap:sync          # 改了 config / 装了新 plugin 后跑这个
pnpm cap:android       # 打开 Android Studio
pnpm cap:ios           # 打开 Xcode
pnpm cap:run:android   # 命令行直接装到 USB 连接的安卓手机

# IP 换了就改这里
vim apps/web/capacitor.config.ts   # server.url
```

## 必须改 CORS 白名单 (后端 Fastify)

`apps/api/src/index.ts` 的 CORS 配置已经允许：
- `capacitor://localhost` (iOS Capacitor)
- `http://localhost` (Android Capacitor)
- `192.168.x.x` 局域网

Capacitor 包出来的 App fetch ECS API 不用额外改。
