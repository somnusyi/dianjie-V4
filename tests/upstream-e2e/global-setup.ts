import type { FullConfig } from 'playwright/test'

const PASSWORD = 'VisualE2e!2026'

function assertSafeLocalDatabase() {
  if (process.env.UPSTREAM_E2E_ALLOW_LOCAL !== 'true') {
    throw new Error('安全护栏：运行浏览器验收前必须显式设置 UPSTREAM_E2E_ALLOW_LOCAL=true')
  }
  const databaseUrl = new URL(process.env.DATABASE_URL || '')
  const localHost = ['127.0.0.1', 'localhost'].includes(databaseUrl.hostname)
  const safeDatabase = /(local|test|ci)/i.test(databaseUrl.pathname)
  if (!localHost || !safeDatabase) {
    throw new Error('安全护栏：浏览器验收只能连接 localhost 的 local/test/ci 数据库')
  }
}

export default async function globalSetup(_config: FullConfig) {
  assertSafeLocalDatabase()
  const [{ prisma }, bcryptModule] = await Promise.all([
    import('@dianjie/db'),
    import('bcryptjs'),
  ])
  const bcrypt = bcryptModule.default || bcryptModule
  const tenantSlug = process.env.PREVIEW_TENANT_SLUG || 'yaohai-test'
  const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } })
  if (!tenant) throw new Error(`未找到本地验收租户 ${tenantSlug}`)

  const existingWarehouse = await prisma.warehouse.findFirst({
    where: { tenantId: tenant.id, isActive: true },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
  }) || await prisma.warehouse.create({
    data: { tenantId: tenant.id, code: 'default', name: 'E2E 总仓', isDefault: true, inventoryMode: 'STRICT' },
  })
  const warehouse = await prisma.warehouse.update({
    where: { id: existingWarehouse.id },
    data: {
      inventoryMode: 'STRICT',
      inventoryActivatedAt: existingWarehouse.inventoryActivatedAt || new Date(),
    },
  })
  const store = await prisma.store.upsert({
    where: { tenantId_no: { tenantId: tenant.id, no: 'E2E-VISUAL-STORE' } },
    update: { name: 'E2E 可视化验收门店', status: 'ENABLED' },
    create: { tenantId: tenant.id, no: 'E2E-VISUAL-STORE', name: 'E2E 可视化验收门店' },
  })

  const supplier = await prisma.supplier.upsert({
    where: { tenantId_no: { tenantId: tenant.id, no: 'E2E-UPSTREAM-01' } },
    update: {
      name: 'E2E 上游食材供应商',
      status: 'ENABLED',
      businessScopes: ['WAREHOUSE_UPSTREAM'],
      upstreamReceiptReviewThreshold: 10_000,
      postReceiptClaimHours: 48,
      upstreamSensitiveCategories: [],
    },
    create: {
      tenantId: tenant.id,
      no: 'E2E-UPSTREAM-01',
      name: 'E2E 上游食材供应商',
      status: 'ENABLED',
      businessScopes: ['WAREHOUSE_UPSTREAM'],
      upstreamReceiptReviewThreshold: 10_000,
      postReceiptClaimHours: 48,
      upstreamSensitiveCategories: [],
      category: '验收专用',
    },
  })
  const otherSupplier = await prisma.supplier.upsert({
    where: { tenantId_no: { tenantId: tenant.id, no: 'E2E-UPSTREAM-02' } },
    update: { name: 'E2E 隔离供应商', status: 'ENABLED', businessScopes: ['WAREHOUSE_UPSTREAM'] },
    create: {
      tenantId: tenant.id,
      no: 'E2E-UPSTREAM-02',
      name: 'E2E 隔离供应商',
      status: 'ENABLED',
      businessScopes: ['WAREHOUSE_UPSTREAM'],
      category: '验收专用',
    },
  })
  const fulfillmentSupplier = await prisma.supplier.upsert({
    where: { tenantId_no: { tenantId: tenant.id, no: 'E2E-INTERNAL-WAREHOUSE' } },
    update: {
      name: 'E2E 供应链总仓',
      status: 'ENABLED',
      businessScopes: ['STORE_FULFILLER'],
      sourceType: 'HEADQ_WAREHOUSE',
      inventoryMode: 'NOT_TRACKED',
    },
    create: {
      tenantId: tenant.id,
      no: 'E2E-INTERNAL-WAREHOUSE',
      name: 'E2E 供应链总仓',
      status: 'ENABLED',
      businessScopes: ['STORE_FULFILLER'],
      sourceType: 'HEADQ_WAREHOUSE',
      inventoryMode: 'NOT_TRACKED',
      category: '总仓内部调拨',
    },
  })

  const product = await prisma.product.upsert({
    where: { tenantId_code: { tenantId: tenant.id, code: 'E2E-VISUAL-SKU' } },
    update: {
      name: 'E2E 云南小土豆',
      spec: '10kg/箱',
      category: '蔬菜类',
      status: 'ENABLED',
      unit: 'kg',
      purchaseUnit: '箱',
      orderUnit: 'kg',
      costUnit: 'kg',
      inventoryUnit: 'kg',
      inventoryUnitsPerPurchaseUnit: 10,
      inventoryUnitsPerOrderUnit: 1,
      inventoryUnitsPerCostUnit: 1,
      unitConversionStatus: 'VERIFIED',
      price: 3.5,
      supplierId: fulfillmentSupplier.id,
    },
    create: {
      tenantId: tenant.id,
      code: 'E2E-VISUAL-SKU',
      name: 'E2E 云南小土豆',
      spec: '10kg/箱',
      category: '蔬菜类',
      status: 'ENABLED',
      unit: 'kg',
      purchaseUnit: '箱',
      orderUnit: 'kg',
      costUnit: 'kg',
      inventoryUnit: 'kg',
      inventoryUnitsPerPurchaseUnit: 10,
      inventoryUnitsPerOrderUnit: 1,
      inventoryUnitsPerCostUnit: 1,
      unitConversionStatus: 'VERIFIED',
      price: 3.5,
      supplierId: fulfillmentSupplier.id,
    },
  })
  const source = await prisma.productUpstreamSource.upsert({
    where: { tenantId_productId_supplierId: { tenantId: tenant.id, productId: product.id, supplierId: supplier.id } },
    update: {
      isPrimary: true,
      isActive: true,
      supplierSku: 'E2E-SUP-SKU-001',
      purchaseUnit: '箱',
      inventoryUnitsPerPurchaseUnit: 10,
      quotedUnitPrice: 100,
      minOrderQty: 1,
      leadTimeDays: 1,
    },
    create: {
      tenantId: tenant.id,
      productId: product.id,
      supplierId: supplier.id,
      isPrimary: true,
      isActive: true,
      supplierSku: 'E2E-SUP-SKU-001',
      purchaseUnit: '箱',
      inventoryUnitsPerPurchaseUnit: 10,
      quotedUnitPrice: 100,
      minOrderQty: 1,
      leadTimeDays: 1,
    },
  })

  // 门店预计库存必须从一次真实盘点基准向后滚动。E2E 专用门店只保留
  // 一份零库存基准；后续断言比较本次收货前后增量，不依赖历史测试残留。
  const baselineDate = new Date()
  baselineDate.setUTCHours(0, 0, 0, 0)
  baselineDate.setUTCDate(baselineDate.getUTCDate() - 1)
  await prisma.inventorySnapshot.deleteMany({ where: { tenantId: tenant.id, storeId: store.id } })
  await prisma.inventorySnapshot.create({
    data: {
      tenantId: tenant.id,
      storeId: store.id,
      snapshotDate: baselineDate,
      sourceFilename: 'E2E-BASELINE.json',
      totalValue: 0,
      itemCount: 1,
      nonzeroCount: 0,
      zeroCount: 1,
      matchedCount: 1,
      items: {
        create: [{
          productId: product.id,
          rawName: product.name,
          rawSpec: product.spec,
          unit: product.inventoryUnit || product.unit,
          quantity: 0,
          unitPrice: 0,
          amount: 0,
          normalizedQuantity: 0,
          normalizedUnit: product.inventoryUnit || product.unit,
          normalizationFactor: 1,
          normalizationStatus: 'EXACT',
          sortOrder: 0,
        }],
      },
    },
  })

  const password = await bcrypt.hash(PASSWORD, 10)
  const upsertUser = (input: { email: string; phone: string; name: string; role: any; supplierId?: string; storeId?: string }) =>
    prisma.user.upsert({
      where: { tenantId_email: { tenantId: tenant.id, email: input.email } },
      update: {
        phone: input.phone,
        password,
        name: input.name,
        role: input.role,
        status: 'ACTIVE',
        supplierId: input.supplierId || null,
        storeId: input.storeId || null,
        storeIds: input.storeId ? [input.storeId] : [],
      },
      create: {
        tenantId: tenant.id,
        email: input.email,
        phone: input.phone,
        password,
        name: input.name,
        role: input.role,
        status: 'ACTIVE',
        supplierId: input.supplierId || null,
        storeId: input.storeId || null,
        storeIds: input.storeId ? [input.storeId] : [],
      },
    })

  const [supplyChain, reviewer, finance, supplierOwner, otherSupplierOwner, unauthorized, kitchenLead] = await Promise.all([
    upsertUser({ email: 'e2e.supply-chain@local.invalid', phone: '13899000001', name: 'E2E 供应链采购', role: 'SUPPLY_CHAIN' }),
    upsertUser({ email: 'e2e.reviewer@local.invalid', phone: '13899000002', name: 'E2E 第二复核人', role: 'ADMIN' }),
    upsertUser({ email: 'e2e.finance@local.invalid', phone: '13899000003', name: 'E2E 财务', role: 'FINANCE' }),
    upsertUser({ email: 'e2e.supplier@local.invalid', phone: '13899000004', name: 'E2E 供应商负责人', role: 'SUPPLIER_OWNER', supplierId: supplier.id }),
    upsertUser({ email: 'e2e.other-supplier@local.invalid', phone: '13899000005', name: 'E2E 隔离供应商负责人', role: 'SUPPLIER_OWNER', supplierId: otherSupplier.id }),
    upsertUser({ email: 'e2e.unauthorized@local.invalid', phone: '13899000006', name: 'E2E 无权限店长', role: 'MANAGER', storeId: store.id }),
    upsertUser({ email: 'e2e.kitchen-lead@local.invalid', phone: '13899000007', name: 'E2E 厨师长', role: 'KITCHEN_LEAD', storeId: store.id }),
  ])

  const stamp = Date.now().toString(36).toUpperCase()
  process.env.UPSTREAM_E2E_FIXTURE_JSON = JSON.stringify({
    stamp,
    tenantId: tenant.id,
    tenantSlug,
    warehouseId: warehouse.id,
    storeId: store.id,
    supplierId: supplier.id,
    supplierName: supplier.name,
    otherSupplierId: otherSupplier.id,
    fulfillmentSupplierId: fulfillmentSupplier.id,
    fulfillmentSupplierName: fulfillmentSupplier.name,
    productId: product.id,
    productName: product.name,
    sourceId: source.id,
    password: PASSWORD,
    accounts: {
      supplyChain: { id: supplyChain.id, phone: supplyChain.phone },
      reviewer: { id: reviewer.id, phone: reviewer.phone },
      finance: { id: finance.id, phone: finance.phone },
      supplierOwner: { id: supplierOwner.id, phone: supplierOwner.phone },
      otherSupplierOwner: { id: otherSupplierOwner.id, phone: otherSupplierOwner.phone },
      unauthorized: { id: unauthorized.id, phone: unauthorized.phone },
      kitchenLead: { id: kitchenLead.id, phone: kitchenLead.phone },
    },
  })
}
