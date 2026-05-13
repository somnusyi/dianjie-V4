import type { CapacitorConfig } from '@capacitor/cli'

const serverUrl = process.env.DJ_MOBILE_SERVER_URL || 'http://localhost:3000'

const config: CapacitorConfig = {
  appId: 'com.dianjie.cloud',
  appName: '滇界云管',
  webDir: 'www',
  bundledWebRuntime: false,
  server: {
    url: serverUrl,
    cleartext: true,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 1200,
      backgroundColor: '#F1EFE8',
      androidSplashResourceName: 'splash',
      androidScaleType: 'CENTER_CROP',
      showSpinner: false,
    },
    StatusBar: {
      style: 'LIGHT',
      backgroundColor: '#F1EFE8',
    },
  },
}

export default config
