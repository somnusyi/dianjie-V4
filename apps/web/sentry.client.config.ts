import * as Sentry from '@sentry/nextjs'

if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: 0.2,
    replaysSessionSampleRate: 0,     // 不录制回放（节省配额）
    replaysOnErrorSampleRate: 0.5,   // 出错时 50% 概率录制回放
  })
}
