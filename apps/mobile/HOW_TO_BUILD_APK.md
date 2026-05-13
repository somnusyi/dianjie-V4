# 滇界云管 · APK 出包指南

## 当前状态

- ✅ Capacitor 6 已配置（[capacitor.config.ts](capacitor.config.ts)）
- ✅ Android 项目骨架已生成（`android/` 目录）
- ✅ 7 个 Capacitor 插件就位（app / camera / filesystem / network / preferences / splash-screen / status-bar）
- ❌ Android SDK 未安装
- ❌ Java JDK 17 未安装
- ❌ ANDROID_HOME 未设置

## 一次性环境准备（30 分钟）

### 1. 装 Android Studio（一站式）
下载：https://developer.android.com/studio
- 装完打开 Android Studio
- 首次启动会提示装 SDK，**全部默认接受**即可
- 装完后 SDK 默认路径：`~/Library/Android/sdk`

### 2. 装 Java JDK 17
方式 A · Homebrew（推荐）：
```bash
brew install openjdk@17
sudo ln -sfn $(brew --prefix openjdk@17)/libexec/openjdk.jdk /Library/Java/JavaVirtualMachines/openjdk-17.jdk
```

方式 B · 直接下载：https://adoptium.net/temurin/releases/?version=17

### 3. 配置环境变量（写到 `~/.zshrc`）
```bash
export ANDROID_HOME=$HOME/Library/Android/sdk
export PATH=$PATH:$ANDROID_HOME/emulator:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin
export JAVA_HOME=$(/usr/libexec/java_home -v 17)
```
然后 `source ~/.zshrc`

验证：
```bash
java -version          # 应显示 17.x
echo $ANDROID_HOME     # /Users/.../Library/Android/sdk
adb --version          # 1.0.41+
```

## 出 Debug APK（5 分钟）

每次代码改动后：

```bash
cd /Users/somnusyi/Projects/dianjie-local/apps/mobile
DJ_MOBILE_SERVER_URL=http://192.168.1.70:3200 npx cap sync android
cd android && ./gradlew assembleDebug
```

APK 在 `android/app/build/outputs/apk/debug/app-debug.apk`，约 5-10 MB。

## 装到手机

### 方式 1 · USB 数据线
1. 手机开发者选项 → 打开 USB 调试
2. 数据线连电脑
3. `adb install -r android/app/build/outputs/apk/debug/app-debug.apk`

### 方式 2 · 局域网传文件
- AirDrop / 微信文件传输 把 .apk 发到手机
- 手机点击 .apk → 允许"安装未知来源应用"
- 装完桌面有「滇界云管」图标

## 配置 server URL

App 启动时去访问 `DJ_MOBILE_SERVER_URL`。当前默认在 [capacitor.config.ts](capacitor.config.ts) 是 `http://localhost:3000`，但 `cap sync` 时被环境变量覆盖到 `192.168.1.70:3200`（笔记本 LAN）。

部署到生产后，改为：
```bash
DJ_MOBILE_SERVER_URL=https://app.dianjie.com npx cap sync android
```

## 上 Play Store

需要：
1. **签名 keystore**：`keytool -genkey -v -keystore release.keystore -alias dianjie -keyalg RSA -keysize 2048 -validity 10000`
2. **Release APK**：`./gradlew assembleRelease`
3. **Google Play Developer 账号**（一次性 $25）
4. **隐私政策网页**

## iOS（需 Mac + Apple 开发者账号）

```bash
cd apps/mobile
npm i @capacitor/ios
npx cap add ios
npx cap sync ios
npx cap open ios     # 打开 Xcode
```

Xcode 里：
- Signing & Capabilities 选 Apple Developer Team
- Archive → Distribute → App Store Connect

需要：
- macOS（你已有 ✅）
- Xcode 最新版（免费）
- Apple Developer Program 账号（$99/年）
- App Store Connect 上传 metadata + 截图
