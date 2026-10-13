'use client'
import Link from 'next/link'
import { procurementApprovalActions, PROCUREMENT_APPROVAL_LABELS, type ProcurementApprovalSource, type ProcurementApprovalAction } from '@/lib/procurement-approval'
const labels: Record<ProcurementApprovalAction, string> = { save: '保存', submit: '提交', audit: '审核', unconfirm: '反审核', review: '复审' }
export function ProcurementProgressActions({ row, kind, role, busy, onAction }: { row: ProcurementApprovalSource; kind:'RECEIPT'|'RETURN'; role: string; busy: boolean; onAction: (action: ProcurementApprovalAction) => void }) {
  const base=`/v2/supply-chain/procurement/${kind==='RECEIPT'?'receipts':'returns'}/${encodeURIComponent(row.id)}/edit`
  const editable=['SUPPLY_CHAIN','ADMIN','SUPER_ADMIN'].includes(role)&&!['POSTED','APPROVED','RECEIVED','REVERSED','CANCELLED','REJECTED'].includes(row.status)&&['DRAFT','PENDING'].includes(row.approvalStatus||'DRAFT')
  return <div className="flex flex-wrap items-center gap-2">
    {editable&&!busy&&<Link className="text-accent" href={base}>编辑</Link>}
    {row.approvalStatus && (row.approvalStatus === 'REVIEWED' || !['POSTED','APPROVED','RECEIVED','REVERSED','CANCELLED','REJECTED'].includes(row.status)) && <span className="text-caption text-gray2">{PROCUREMENT_APPROVAL_LABELS[row.approvalStatus]}</span>}
    {procurementApprovalActions(row, role).map(action => <button key={action} type="button" disabled={busy} className="rounded-lg border border-accent bg-white px-3 py-2 text-caption font-medium text-accent disabled:opacity-50" onClick={() => onAction(action)}>{labels[action]}</button>)}
    <Link className="text-accent" href={`${base}?action=print`}>打印</Link>
    {['SUPPLY_CHAIN','ADMIN','SUPER_ADMIN'].includes(role)&&!busy?<Link className="text-accent" href={base} title={editable?'保存单据修改':'只补充备注，业务字段保持锁定'}>保存</Link>:<button disabled>保存</button>}
  </div>
}
