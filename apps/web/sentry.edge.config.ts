import { safeTelemetryEvent } from './src/lib/safe-telemetry'
import * as Sentry from '@sentry/nextjs'

if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    tracesSampleRate: 0,
    beforeSendTransaction() { return null },
    beforeBreadcrumb() { return null },
    sendDefaultPii: false,
    beforeSend(event) { return safeTelemetryEvent(event) },
  })
}
