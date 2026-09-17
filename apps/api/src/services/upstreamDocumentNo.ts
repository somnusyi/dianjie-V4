import { Prisma } from '@dianjie/db'
import { businessMonthKey } from '../lib/businessTime'
import { nextBusinessNo } from './purchaseOrderIntegrity'

const configs = {
  purchaseOrder: { scope: 'UPSTREAM_PO', prefix: 'UPO' },
  shipment: { scope: 'UPSTREAM_SHIP', prefix: 'USH' },
  receipt: { scope: 'UPSTREAM_RCPT', prefix: 'URC' },
  claim: { scope: 'UPSTREAM_CLAIM', prefix: 'UCL' },
  settlement: { scope: 'UPSTREAM_STMT', prefix: 'UST' },
} as const

export type UpstreamDocumentKind = keyof typeof configs

export function nextUpstreamDocumentNo(
  tx: Prisma.TransactionClient,
  tenantId: string,
  kind: UpstreamDocumentKind,
  at: Date = new Date(),
) {
  const period = businessMonthKey(at)
  const config = configs[kind]
  return nextBusinessNo(tx, tenantId, config.scope, period, config.prefix)
}
