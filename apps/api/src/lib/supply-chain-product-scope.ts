import type { Prisma } from '@dianjie/db'

type SupplyChainProductScopeOptions = {
  includeBomMapping?: boolean
}

// Legacy store-count imports created tenant-wide products using <store>-INV-<row>.
export function supplyChainProductScope(
  tenantId: string,
  options: SupplyChainProductScopeOptions = {},
): Prisma.ProductWhereInput {
  const bomExclusions: Prisma.ProductWhereInput[] = options.includeBomMapping
    ? []
    : [
      // DJ-BOM-* rows are temporary recipe ingredients created before a
      // reliable purchasing SKU is mapped. Historical operators may have
      // renamed their category, so category alone is not a safe boundary.
      { code: { startsWith: 'DJ-BOM-', mode: 'insensitive' } },
      { category: { in: ['BOM待采购映射', '本地配方镜像'] } },
    ]
  return {
    NOT: [
      ...bomExclusions,
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
