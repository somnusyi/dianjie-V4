import type { Prisma } from '@dianjie/db'

// Legacy store-count imports created tenant-wide products using <store>-INV-<row>.
export function supplyChainProductScope(tenantId: string): Prisma.ProductWhereInput {
  return {
    NOT: [
      { category: 'BOM待采购映射' },
      {
        code: { contains: '-INV-', mode: 'insensitive' },
        inventorySnapshotItems: { some: { snapshot: { tenantId } } },
      },
      {
        supplier: {
          is: {
            tenantId,
            businessScopes: { has: 'DIRECT_STORE_VENDOR' },
            NOT: { businessScopes: { hasSome: ['WAREHOUSE_UPSTREAM', 'STORE_FULFILLER'] } },
          },
        },
        upstreamSources: { none: { tenantId, isActive: true } },
      },
    ],
  }
}
