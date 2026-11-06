/** Routing diagnostics only; never serialize raw URL query, body or driver errors. */
export function safeUrl(value: unknown): string {
  let path = String(value || '').split(/[?#]/)[0]
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) {
    try { const parsed = new URL(path); path = ['http:','https:'].includes(parsed.protocol) ? parsed.origin + parsed.pathname : '[REDACTED-URL]' } catch { path = '[REDACTED-URL]' }
  }
  return path
    .replace(/(\/invite-accept\/)[^/]+/g, '$1[REDACTED]')
    .replace(/(\/cmb\/receipt\/)[^/]+/g, '$1[REDACTED]')
}
export function safeRequestLog(request: any) {
  const raw = request?.raw || request
  return { method: request?.method || raw?.method, url: safeUrl(request?.url || raw?.url), hostname: request?.hostname, remoteAddress: request?.ip || raw?.socket?.remoteAddress }
}
export function safeErrorLog(error: any) {
  return { type: 'Error', message: 'Request failed; sensitive details withheld', stack: '', statusCode: Number.isInteger(error?.statusCode) ? error.statusCode : 500,
    ...(typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? { code: error.code } : {}) }
}
/** Allowlist prevents unexpected third-party error payloads becoming telemetry. */
export function safeTelemetryEvent(event: any) {
  return {
    ...(event.event_id ? { event_id: event.event_id } : {}),
    ...(event.timestamp ? { timestamp: event.timestamp } : {}),
    type: undefined,
    platform: event.platform || 'node', level: event.level || 'error',
    ...(event.request ? { request: { method: event.request.method, url: safeUrl(event.request.url) } } : {}),
    ...(event.exception ? { exception: { values: (event.exception.values || []).map(() => ({ type: 'Error', value: 'Server exception; inspect local sanitized diagnostics' })) } } : {}),
  }
}
export const sensitiveLogPaths = [
  'req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]',
  'password', 'token', 'refreshToken', 'secret', 'appSecret', 'contactSecret',
  '*.password', '*.token', '*.refreshToken', '*.secret', '*.appSecret', '*.contactSecret',
  'req.body', 'request.body', 'config.headers.Authorization', 'err.config',
]
