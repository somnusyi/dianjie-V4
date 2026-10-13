export type ProcurementApprovalAction = 'save' | 'submit' | 'audit' | 'unconfirm' | 'review'
export type ProcurementApprovalSource = {
  id: string
  status: string
  approvalStatus?: 'DRAFT' | 'PENDING' | 'AUDITED' | 'REVIEWED' | null
  approvalVersion?: number
  rowVersion?: number
  sourceVersion?: number
}
export const PROCUREMENT_APPROVAL_LABELS = { DRAFT: '待提交', PENDING: '待审核', AUDITED: '已审核', REVIEWED: '已复审' }
export function procurementApprovalActions(row: ProcurementApprovalSource, role: string): ProcurementApprovalAction[] {
  if (['POSTED', 'APPROVED', 'RECEIVED', 'REVERSED', 'CANCELLED', 'REJECTED'].includes(row.status) || row.approvalStatus === 'REVIEWED') return []
  if (!['SUPPLY_CHAIN', 'ADMIN', 'SUPER_ADMIN'].includes(role)) return []
  const state = row.approvalStatus || 'DRAFT'
  if (state === 'DRAFT') return ['submit']
  if (state === 'PENDING') return role === 'SUPPLY_CHAIN' ? ['audit'] : []
  return role === 'SUPPLY_CHAIN' ? ['unconfirm', 'review'] : []
}
export function procurementApprovalRequest(row: ProcurementApprovalSource, requestId: string) {
  const sourceVersion = row.sourceVersion ?? row.rowVersion
  if (!Number.isInteger(row.approvalVersion) || !Number.isInteger(sourceVersion)) throw new Error('单据版本缺失，请重新打开单据')
  return { approvalVersion: row.approvalVersion!, sourceVersion: sourceVersion!, requestId }
}
