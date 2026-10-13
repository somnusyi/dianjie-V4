'use client'
import Link from 'next/link'
import {inventoryDocumentHref} from '@/lib/inventory-document-navigation'
import {getUser} from '@/lib/v2-auth'
import type {ManagementRow} from '@/lib/inventory-management'
import {procurementApprovalActions,type ProcurementApprovalSource} from '@/lib/procurement-approval'
import {DocumentQualityImageButton} from './document-quality-image'

export function ProcurementManagementActions({row,from}:{row:ManagementRow;from?:unknown}){
 const kind=row.recordType==='UPSTREAM_RECEIPT'?'RECEIPT':'RETURN'
 const id=String(row.detailId),role=getUser()?.role||''
 const source:ProcurementApprovalSource={id,status:String(row.sourceStatus),approvalStatus:row.approvalStatus as ProcurementApprovalSource['approvalStatus']}
 const base=`/v2/supply-chain/procurement/${kind==='RECEIPT'?'receipts':'returns'}/${encodeURIComponent(id)}/edit`
 const canEdit=['SUPPLY_CHAIN','ADMIN','SUPER_ADMIN'].includes(role)
 const knownSource=typeof row.sourceStatus==='string'&&row.sourceStatus.length>0
 const editable=knownSource&&canEdit&&!row.businessFieldsLocked&&!['POSTED','APPROVED','RECEIVED','REVERSED','CANCELLED','REJECTED'].includes(source.status)&&['DRAFT','PENDING'].includes(source.approvalStatus||'DRAFT')
 const labels={submit:'提交',audit:'审核',unconfirm:'反审核',review:'复审',save:'保存'}
 return <div className="flex items-center gap-2 whitespace-nowrap text-accent">
  {editable&&<Link href={inventoryDocumentHref(base,from)}>编辑</Link>}
  {knownSource&&procurementApprovalActions(source,role).map(action=><Link key={action} href={inventoryDocumentHref(base,from,action)}>{labels[action]}</Link>)}
  <span aria-hidden="true">｜</span>
  <Link href={inventoryDocumentHref(base,from,'print')}>打印</Link>
  {canEdit?<Link href={inventoryDocumentHref(base,from)} title={editable?'保存单据修改':'只补充备注，业务字段保持锁定'}>保存</Link>:<button disabled>保存</button>}
  <DocumentQualityImageButton kind={kind} sourceId={id}/>
 </div>
}
