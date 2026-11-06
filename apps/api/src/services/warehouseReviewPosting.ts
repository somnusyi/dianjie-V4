import { Prisma } from '@dianjie/db'
import { createHash } from 'node:crypto'
import { ensureWarehouseDocInTransaction, type EnsureWarehouseDocInput } from './warehouseDocs'
import {
  prepareBatchManualWarehouseInbound, prepareBatchManualWarehouseOutbound,
  type BatchManualWarehouseInboundInput, type BatchManualWarehouseOutboundInput,
} from './warehouseLedger'

const fail = (message: string, statusCode = 409) => Object.assign(new Error(message), { statusCode })
type Header = Pick<EnsureWarehouseDocInput, 'attachments' | 'note' | 'reason'> & { documentKey: string }

// Only a new submission opts into this policy. Legacy already-posted documents
// never acquire it during reads, edits, audits or retries.
export async function createReviewInbound(tx: Prisma.TransactionClient, input: BatchManualWarehouseInboundInput & Header) {
  const { warehouseId, lines } = await prepareBatchManualWarehouseInbound(input, tx)
  const supplier = input.supplierId ? await tx.supplier.findFirst({ where: { id: input.supplierId, tenantId: input.tenantId, status: 'ENABLED', businessScopes: { has: 'WAREHOUSE_UPSTREAM' } } }) : null
  if (!supplier) throw fail('请选择启用的总仓上游供应商', 400)
  return ensureWarehouseDocInTransaction(tx, {
    ...input, type: 'MANUAL_INBOUND', warehouseId, postingPolicy: 'REVIEW',
    supplierName: supplier.name, idempotencyKey: input.documentKey,
    lines: lines.map(line => ({
      productId: line.product.id, productName: line.product.name,
      quantity: line.purchaseQuantity, unit: line.contract.purchaseUnit,
      unitPrice: line.unitPrice, amount: line.totalAmount, isGift: line.isGift,
      inventoryQuantity: line.inventoryQuantity, inventoryUnit: line.contract.inventoryUnit,
      batchNo: line.batchNo, manufactureDate: line.manufactureDate, expiryDate: line.expiryDate,
      note: input.items[line.index].note,
    })),
  })
}

export async function createReviewOutbound(tx: Prisma.TransactionClient, input: BatchManualWarehouseOutboundInput & Header) {
  const { warehouseId, lines } = await prepareBatchManualWarehouseOutbound(input, tx)
  const balances = await tx.warehouseLedgerBalance.findMany({ where: { tenantId: input.tenantId, warehouseId, productId: { in: lines.map(line => line.product.id) } } })
  const byId = new Map(balances.map(row => [row.productId, row]))
  return ensureWarehouseDocInTransaction(tx, {
    ...input, type: 'MANUAL_OUTBOUND', warehouseId, postingPolicy: 'REVIEW',
    idempotencyKey: input.documentKey,
    lines: lines.map(line => {
      const balance = byId.get(line.product.id)
      const estimate = balance && balance.physicalQty.gt(0) ? balance.inventoryValue.div(balance.physicalQty).mul(line.inventoryQuantity).toDecimalPlaces(4) : new Prisma.Decimal(0)
      return {
        productId: line.product.id, productName: line.product.name,
        quantity: line.inventoryQuantity, unit: line.contract.inventoryUnit,
        // null preserves automatic costing until the final transaction.
        unitPrice: line.specifiedAmount == null ? null : line.specifiedAmount.div(line.inventoryQuantity).toDecimalPlaces(6),
        amount: line.specifiedAmount ?? estimate,
        inventoryQuantity: line.inventoryQuantity, inventoryUnit: line.contract.inventoryUnit,
        note: line.note,
      }
    }),
  })
}

export function reviewPostingKey(docId: string) {
  return `review-${createHash('sha256').update(docId).digest('hex').slice(0, 48)}`
}
