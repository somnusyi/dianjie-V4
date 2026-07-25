const CANCELLABLE_STATUSES = new Set(['SUBMITTED', 'CONFIRMED'])
const CANCELLING_ROLES = new Set(['MANAGER', 'ADMIN'])

export function canCancelLegacyOrder(status: string, role: string | null | undefined) {
  return CANCELLABLE_STATUSES.has(status) && CANCELLING_ROLES.has(role || '')
}

export function validateCancelReason(value: string | null | undefined):
  { success: true; reason: string } | { success: false; error: string } {
  const reason = value?.trim() || ''
  if (!reason) return { success: false, error: '请填写撤回原因' }
  if (reason.length > 200) return { success: false, error: '撤回原因最长 200 字' }
  return { success: true, reason }
}
