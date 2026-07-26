import { Prisma } from '@dianjie/db'

type BatchIncreaseInput = {
  tenantId: string
  warehouseId?: string
  supplierId: string
  productId: string
  quantity: number | Prisma.Decimal
  movementId: string
  createdById?: string | null
  kind: 'OPENING' | 'INBOUND' | 'ADJUSTMENT' | 'RETURN'
  manufactureDate?: Date | null
  expiryDate?: Date | null
  batchNo?: string | null
}

type BatchConsumptionInput = {
  tenantId: string
  warehouseId?: string
  supplierId: string
  productId: string
  quantity: number | Prisma.Decimal
  movementId: string
}

type BatchDeltaInput = Omit<BatchIncreaseInput, 'quantity' | 'kind'> & {
  delta: number | Prisma.Decimal
  positiveKind?: 'ADJUSTMENT' | 'RETURN'
}

function businessError(message: string, statusCode = 409) {
  return Object.assign(new Error(message), { statusCode })
}

function generatedBatchNo(kind: BatchIncreaseInput['kind'], movementId: string) {
  const date = new Date().toISOString().slice(0, 10).replaceAll('-', '')
  return `${kind}-${date}-${movementId.slice(-10).toUpperCase()}`.slice(0, 80)
}

/** Create a positive, independently traceable inventory lot. */
export async function createSupplierStockBatchIncrease(
  tx: Prisma.TransactionClient,
  input: BatchIncreaseInput,
) {
  const quantity = new Prisma.Decimal(input.quantity)
  if (quantity.lessThanOrEqualTo(0)) throw businessError('批次入账数量必须大于 0', 400)

  return tx.supplierStockBatch.create({
    data: {
      tenantId: input.tenantId,
      ...(input.warehouseId === undefined ? {} : { warehouseId: input.warehouseId }),
      supplierId: input.supplierId,
      productId: input.productId,
      batchNo: input.batchNo?.trim() || generatedBatchNo(input.kind, input.movementId),
      kind: input.kind,
      initialQty: quantity,
      remainingQty: quantity,
      manufactureDate: input.manufactureDate || null,
      expiryDate: input.expiryDate || null,
      sourceMovementId: input.movementId,
      createdById: input.createdById || null,
    },
  })
}

/**
 * Consume lots under the caller's already-held Product row lock.
 * Historical opening stock is used first; subsequent lots follow FEFO, with
 * undated lots last. Allocations make every negative movement reproducible.
 */
export async function consumeSupplierStockBatches(
  tx: Prisma.TransactionClient,
  input: BatchConsumptionInput,
) {
  const requested = new Prisma.Decimal(input.quantity)
  if (requested.lessThanOrEqualTo(0)) throw businessError('批次扣减数量必须大于 0', 400)
  const warehouseFilter = input.warehouseId === undefined
    ? Prisma.empty
    : Prisma.sql`AND "warehouseId" = ${input.warehouseId}`

  const batches = await tx.$queryRaw<Array<{
    id: string
    remainingQty: Prisma.Decimal
  }>>(Prisma.sql`
    SELECT "id", "remainingQty"
    FROM "supplier_stock_batches"
    WHERE "tenantId" = ${input.tenantId}
      AND "supplierId" = ${input.supplierId}
      AND "productId" = ${input.productId}
      ${warehouseFilter}
      AND "remainingQty" > 0
    ORDER BY
      CASE WHEN "kind" = 'OPENING' THEN 0 ELSE 1 END,
      "expiryDate" ASC NULLS LAST,
      "createdAt" ASC,
      "id" ASC
    FOR UPDATE
  `)

  const available = batches.reduce(
    (total, batch) => total.plus(batch.remainingQty),
    new Prisma.Decimal(0),
  )
  if (available.lessThan(requested)) {
    throw businessError(
      `批次余额与物理库存不一致：批次可用 ${available.toFixed(3)}，本次需扣 ${requested.toFixed(3)}`,
    )
  }

  let remaining = requested
  const allocations: Array<{ batchId: string; quantity: Prisma.Decimal }> = []
  for (const batch of batches) {
    if (remaining.lessThanOrEqualTo(0)) break
    const allocated = Prisma.Decimal.min(batch.remainingQty, remaining)
    const next = batch.remainingQty.minus(allocated)
    await tx.supplierStockBatch.update({
      where: { id: batch.id },
      data: {
        remainingQty: next,
        depletedAt: next.isZero() ? new Date() : null,
      },
    })
    await tx.supplierStockBatchAllocation.create({
      data: {
        tenantId: input.tenantId,
        ...(input.warehouseId === undefined ? {} : { warehouseId: input.warehouseId }),
        supplierId: input.supplierId,
        productId: input.productId,
        batchId: batch.id,
        movementId: input.movementId,
        quantity: allocated,
      },
    })
    allocations.push({ batchId: batch.id, quantity: allocated })
    remaining = remaining.minus(allocated)
  }
  return allocations
}

/** Keep positive adjustments as new lots and allocate negative deltas by FEFO. */
export async function applySupplierStockBatchDelta(
  tx: Prisma.TransactionClient,
  input: BatchDeltaInput,
) {
  const delta = new Prisma.Decimal(input.delta)
  if (delta.isZero()) return []
  if (delta.isPositive()) {
    const batch = await createSupplierStockBatchIncrease(tx, {
      ...input,
      quantity: delta,
      kind: input.positiveKind || 'ADJUSTMENT',
    })
    return [{ batchId: batch.id, quantity: delta }]
  }
  return consumeSupplierStockBatches(tx, {
    tenantId: input.tenantId,
    warehouseId: input.warehouseId,
    supplierId: input.supplierId,
    productId: input.productId,
    movementId: input.movementId,
    quantity: delta.abs(),
  })
}
