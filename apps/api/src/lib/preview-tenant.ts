export function resolveLoginTenantSlug(requestedSlug: string, previewTenantSlug?: string): string | null {
  const previewSlug = previewTenantSlug?.trim()
  if (!previewSlug) return requestedSlug
  if (requestedSlug === previewSlug || requestedSlug === 'test') return previewSlug
  return null
}
