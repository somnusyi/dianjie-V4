type UpstreamFeatureFlag =
  | 'UPSTREAM_PROCUREMENT_ENABLED'
  | 'UPSTREAM_RECEIPT_POSTING_ENABLED'
  | 'UPSTREAM_MANUAL_INBOUND_RESTRICTED'

function defaultValue(flag: UpstreamFeatureFlag) {
  if (flag === 'UPSTREAM_MANUAL_INBOUND_RESTRICTED') return false
  return process.env.NODE_ENV !== 'production'
}

export function upstreamFeatureEnabled(flag: UpstreamFeatureFlag) {
  const raw = process.env[flag]
  if (raw == null || raw.trim() === '') return defaultValue(flag)
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase())
}

export function upstreamFeatureSnapshot() {
  return {
    procurement: upstreamFeatureEnabled('UPSTREAM_PROCUREMENT_ENABLED'),
    receiptPosting: upstreamFeatureEnabled('UPSTREAM_RECEIPT_POSTING_ENABLED'),
    manualInboundRestricted: upstreamFeatureEnabled('UPSTREAM_MANUAL_INBOUND_RESTRICTED'),
  }
}
