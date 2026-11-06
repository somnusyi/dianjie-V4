export function safeUrl(value: unknown): string {
  let path = String(value || '').split(/[?#]/)[0]
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) {
    try { const parsed = new URL(path); path = ['http:','https:'].includes(parsed.protocol) ? parsed.origin + parsed.pathname : '[REDACTED-URL]' } catch { path = '[REDACTED-URL]' }
  }
  return path
    .replace(/(\/invite-accept\/)[^/]+/g, '$1[REDACTED]')
    .replace(/(\/cmb\/receipt\/)[^/]+/g, '$1[REDACTED]')
}
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
