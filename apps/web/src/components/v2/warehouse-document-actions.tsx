'use client'
import Link from 'next/link'
import {DocumentQualityImageButton} from './document-quality-image'
import {inventoryDocumentHref} from '@/lib/inventory-document-navigation'
import { getUser } from '@/lib/v2-auth'
import type { ManagementRow } from '@/lib/inventory-management'

/** Only warehouse documents share this lifecycle. Receipt/return states stay independent. */
export function WarehouseDocumentActions({ row, from }: { row: ManagementRow; from?:unknown }) {
  const role = getUser()?.role || ''
  const audit = role === 'SUPPLY_CHAIN'
  const edit = ['SUPPLY_CHAIN','SUPER_ADMIN','ADMIN','PURCHASER'].includes(role)
  const base = `/v2/supply-chain/docs/${encodeURIComponent(String(row.detailId))}/edit`
  const pending = row.docStatus === 'POSTED'
  const confirmed = row.docStatus === 'CONFIRMED'
  const reviewed = row.docReviewStatus === 'REVIEWED'
  return <div className="flex items-center gap-2 whitespace-nowrap text-accent">
    {pending && <>{edit && <Link href={inventoryDocumentHref(base,from)}>编辑</Link>}{audit && <Link href={inventoryDocumentHref(base,from,'audit')}>审核</Link>}</>}
    {confirmed && audit && !reviewed && <><Link href={inventoryDocumentHref(base,from,'unconfirm')}>反审核</Link><Link href={inventoryDocumentHref(base,from,'review')}>复审</Link></>}
    <span aria-hidden="true" className="text-gray3">｜</span>
    <Link href={inventoryDocumentHref(base,from,'print')}>打印</Link>
    {pending && edit ? <Link href={inventoryDocumentHref(base,from)} title="进入编辑页保存单据修改">保存</Link> : <button disabled title="单据尚未处于可编辑状态">保存</button>}
    {from === 'other-out' && <DocumentQualityImageButton kind="WAREHOUSE" sourceId={String(row.detailId)} />}
  </div>
}
