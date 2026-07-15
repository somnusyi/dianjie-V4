import 'dotenv/config'
import { Prisma, prisma } from '@dianjie/db'
import { buildOrderSnapshot, snapshotHash } from '../src/services/purchaseOrderIntegrity'

const args = new Set(process.argv.slice(2))
const commit = args.has('--commit')
const force = args.has('--force')
const tenantArg = process.argv.find(arg => arg.startsWith('--tenant='))?.slice('--tenant='.length)
const batchArg = process.argv.find(arg => arg.startsWith('--batch='))?.slice('--batch='.length)
const batchSize = Math.min(500, Math.max(1, Number(batchArg || 100)))

async function main() {
  let cursor: string | undefined
  let scanned = 0
  let eligible = 0
  let updated = 0
  let failed = 0

  do {
    const orders = await prisma.purchaseOrder.findMany({
      where: {
        ...(tenantArg ? { tenantId: tenantArg } : {}),
        ...(force ? {} : { submittedSnapshot: { equals: Prisma.DbNull } }),
      },
      orderBy: { id: 'asc' },
      take: batchSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      include: {
        store: true,
        supplier: true,
        createdBy: { select: { id: true, name: true, role: true } },
        items: { include: { product: true } },
      },
    })
    if (orders.length === 0) break
    cursor = orders.at(-1)!.id
    scanned += orders.length

    for (const order of orders) {
      try {
        const original = buildOrderSnapshot(order as any, 'original')
        const hash = snapshotHash(original)
        eligible++
        if (!commit) continue
        await prisma.$transaction(async tx => {
          await tx.purchaseOrder.update({
            where: { id: order.id },
            data: {
              originalTotalAmount: original.totalAmount,
              currentOrderAmount: order.currentOrderAmount ?? original.totalAmount,
              submittedAt: order.submittedAt ?? order.createdAt,
              submittedSnapshot: original as any,
              submittedSnapshotHash: hash,
            },
          })
          const exists = await tx.purchaseOrderEvent.findFirst({
            where: { purchaseOrderId: order.id, eventType: 'LEGACY_MIGRATED' },
            select: { id: true },
          })
          if (!exists) {
            await tx.purchaseOrderEvent.create({
              data: {
                tenantId: order.tenantId,
                purchaseOrderId: order.id,
                eventType: 'LEGACY_MIGRATED',
                metadata: { snapshotHash: hash, source: 'backfill-purchase-order-snapshots' },
              },
            })
          }
        })
        updated++
      } catch (error: any) {
        failed++
        console.error(JSON.stringify({ orderId: order.id, no: order.no, error: error?.message || String(error) }))
      }
    }
  } while (true)

  console.log(JSON.stringify({ mode: commit ? 'commit' : 'dry-run', scanned, eligible, updated, failed, batchSize }))
  if (failed > 0) process.exitCode = 1
}

main().finally(() => prisma.$disconnect())
