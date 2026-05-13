'use client'

import * as Sentry from '@sentry/nextjs'
import { useEffect } from 'react'

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    const s = Sentry as any
    if (typeof s.captureException === 'function') s.captureException(error)
  }, [error])

  return (
    <html>
      <body>
        <div style={{
          minHeight: '100vh', display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', fontFamily: 'system-ui',
          background: '#f4f6f9', color: '#374151',
        }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>😵</div>
          <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>系统遇到了问题</h2>
          <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 20 }}>
            错误已自动上报，我们会尽快修复
          </p>
          <button onClick={reset} style={{
            padding: '8px 20px', borderRadius: 8, border: 'none',
            background: '#156b43', color: '#fff', fontSize: 13,
            fontWeight: 600, cursor: 'pointer',
          }}>重试</button>
        </div>
      </body>
    </html>
  )
}
