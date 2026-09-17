import 'dotenv/config'

import { prisma } from '@dianjie/db'
import bcrypt from 'bcryptjs'

const DEFAULT_TENANT_SLUG = 'supply-chain-uat'

function assertSafeUatTarget() {
  if (process.env.UAT_SEED_CONFIRM !== 'SEED_SUPPLY_CHAIN_UAT') {
    throw new Error('安全护栏：必须设置 UAT_SEED_CONFIRM=SEED_SUPPLY_CHAIN_UAT')
  }

  const url = new URL(process.env.DATABASE_URL || '')
  const databaseName = url.pathname.replace(/^\//, '')
  if (!/(uat|staging|test)/i.test(databaseName)) {
    throw new Error(`安全护栏：UAT 种子只能写入 uat/staging/test 数据库，当前为 ${databaseName || '空'}`)
  }

  const password = process.env.UAT_SEED_PASSWORD || ''
  if (password.length < 12) {
    throw new Error('安全护栏：UAT_SEED_PASSWORD 必须至少 12 位')
  }
  return password
}

async function main() {
  const plainPassword = assertSafeUatTarget()
  const password = await bcrypt.hash(plainPassword, 10)
  const tenantSlug = process.env.UAT_TENANT_SLUG?.trim() || DEFAULT_TENANT_SLUG

  const tenant = await prisma.tenant.upsert({
    where: { slug: tenantSlug },
    update: { name: '滇界供应链灰度测试', status: 'ACTIVE' },
    create: {
      slug: tenantSlug,
      name: '滇界供应链灰度测试',
      status: 'ACTIVE',
      plan: 'PROFESSIONAL',
    },
  })

  // 数据库触发器 tenants_create_default_warehouse_trg 会在建租户时自动创建
  // code='default' 的默认仓，且 warehouses_one_default_per_tenant_key 部分唯一索引
  // 限制每租户只能有一个 isDefault 仓。这里必须领养默认仓，不能另建第二个默认仓。
  const warehouse = await prisma.warehouse.upsert({
    where: { tenantId_code: { tenantId: tenant.id, code: 'default' } },
    update: {
      name: 'UAT 供应链总仓',
      isActive: true,
      isDefault: true,
      inventoryMode: 'STRICT',
      inventoryActivatedAt: new Date(),
    },
    create: {
      tenantId: tenant.id,
      code: 'default',
      name: 'UAT 供应链总仓',
      isActive: true,
      isDefault: true,
      inventoryMode: 'STRICT',
      inventoryActivatedAt: new Date(),
    },
  })

  const store = await prisma.store.upsert({
    where: { tenantId_no: { tenantId: tenant.id, no: 'UAT-STORE-01' } },
    update: { name: 'UAT 灰度测试门店', status: 'ENABLED' },
    create: {
      tenantId: tenant.id,
      no: 'UAT-STORE-01',
      name: 'UAT 灰度测试门店',
      address: '灰度测试专用地址（非真实配送地址）',
      status: 'ENABLED',
    },
  })

  const upstreamSupplier = await prisma.supplier.upsert({
    where: { tenantId_no: { tenantId: tenant.id, no: 'UAT-UPSTREAM-01' } },
    update: {
      name: 'UAT 上游食材供应商',
      status: 'ENABLED',
      businessScopes: ['WAREHOUSE_UPSTREAM'],
      upstreamReceiptReviewThreshold: 10_000,
      postReceiptClaimHours: 48,
      upstreamSensitiveCategories: [],
    },
    create: {
      tenantId: tenant.id,
      no: 'UAT-UPSTREAM-01',
      name: 'UAT 上游食材供应商',
      category: '灰度测试专用',
      status: 'ENABLED',
      businessScopes: ['WAREHOUSE_UPSTREAM'],
      upstreamReceiptReviewThreshold: 10_000,
      postReceiptClaimHours: 48,
      upstreamSensitiveCategories: [],
      creditDays: 30,
    },
  })

  const isolatedSupplier = await prisma.supplier.upsert({
    where: { tenantId_no: { tenantId: tenant.id, no: 'UAT-UPSTREAM-02' } },
    update: {
      name: 'UAT 隔离验证供应商',
      status: 'ENABLED',
      businessScopes: ['WAREHOUSE_UPSTREAM'],
    },
    create: {
      tenantId: tenant.id,
      no: 'UAT-UPSTREAM-02',
      name: 'UAT 隔离验证供应商',
      category: '权限隔离验证',
      status: 'ENABLED',
      businessScopes: ['WAREHOUSE_UPSTREAM'],
    },
  })

  const fulfillmentSupplier = await prisma.supplier.upsert({
    where: { tenantId_no: { tenantId: tenant.id, no: 'UAT-INTERNAL-WH' } },
    update: {
      name: 'UAT 供应链总仓',
      status: 'ENABLED',
      businessScopes: ['STORE_FULFILLER'],
      sourceType: 'HEADQ_WAREHOUSE',
      inventoryMode: 'NOT_TRACKED',
    },
    create: {
      tenantId: tenant.id,
      no: 'UAT-INTERNAL-WH',
      name: 'UAT 供应链总仓',
      category: '内部总仓调拨',
      status: 'ENABLED',
      businessScopes: ['STORE_FULFILLER'],
      sourceType: 'HEADQ_WAREHOUSE',
      inventoryMode: 'NOT_TRACKED',
    },
  })

  const product = await prisma.product.upsert({
    where: { tenantId_code: { tenantId: tenant.id, code: 'UAT-SKU-001' } },
    update: {
      name: 'UAT 云南小土豆',
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
      code: 'UAT-SKU-001',
      name: 'UAT 云南小土豆',
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

  await prisma.productUpstreamSource.upsert({
    where: {
      tenantId_productId_supplierId: {
        tenantId: tenant.id,
        productId: product.id,
        supplierId: upstreamSupplier.id,
      },
    },
    update: {
      isPrimary: true,
      isActive: true,
      supplierSku: 'UAT-SUP-SKU-001',
      purchaseUnit: '箱',
      inventoryUnitsPerPurchaseUnit: 10,
      quotedUnitPrice: 100,
      minOrderQty: 1,
      leadTimeDays: 1,
    },
    create: {
      tenantId: tenant.id,
      productId: product.id,
      supplierId: upstreamSupplier.id,
      isPrimary: true,
      isActive: true,
      supplierSku: 'UAT-SUP-SKU-001',
      purchaseUnit: '箱',
      inventoryUnitsPerPurchaseUnit: 10,
      quotedUnitPrice: 100,
      minOrderQty: 1,
      leadTimeDays: 1,
    },
  })

  const baselineDate = new Date()
  baselineDate.setUTCHours(0, 0, 0, 0)
  baselineDate.setUTCDate(baselineDate.getUTCDate() - 1)
  const existingBaseline = await prisma.inventorySnapshot.findFirst({
    where: { tenantId: tenant.id, storeId: store.id, sourceFilename: 'UAT-BASELINE.json' },
  })
  if (!existingBaseline) {
    await prisma.inventorySnapshot.create({
      data: {
        tenantId: tenant.id,
        storeId: store.id,
        snapshotDate: baselineDate,
        sourceFilename: 'UAT-BASELINE.json',
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
  }

  const upsertUser = (input: {
    email: string
    phone: string
    name: string
    role: any
    supplierId?: string
    storeId?: string
  }) => prisma.user.upsert({
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

  const accounts = await Promise.all([
    upsertUser({ email: 'uat.supply-chain@local.invalid', phone: '13970000001', name: 'UAT 供应链采购', role: 'SUPPLY_CHAIN' }),
    upsertUser({ email: 'uat.reviewer@local.invalid', phone: '13970000002', name: 'UAT 第二复核人', role: 'ADMIN' }),
    upsertUser({ email: 'uat.finance@local.invalid', phone: '13970000003', name: 'UAT 财务', role: 'FINANCE' }),
    upsertUser({ email: 'uat.supplier@local.invalid', phone: '13970000004', name: 'UAT 供应商负责人', role: 'SUPPLIER_OWNER', supplierId: upstreamSupplier.id }),
    upsertUser({ email: 'uat.other-supplier@local.invalid', phone: '13970000005', name: 'UAT 隔离供应商负责人', role: 'SUPPLIER_OWNER', supplierId: isolatedSupplier.id }),
    upsertUser({ email: 'uat.manager@local.invalid', phone: '13970000006', name: 'UAT 门店经理', role: 'MANAGER', storeId: store.id }),
    upsertUser({ email: 'uat.kitchen-lead@local.invalid', phone: '13970000007', name: 'UAT 厨师长', role: 'KITCHEN_LEAD', storeId: store.id }),
  ])

  console.log(JSON.stringify({
    tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name },
    warehouse: { id: warehouse.id, code: warehouse.code, name: warehouse.name },
    store: { id: store.id, no: store.no, name: store.name },
    suppliers: [
      { id: upstreamSupplier.id, no: upstreamSupplier.no, name: upstreamSupplier.name },
      { id: isolatedSupplier.id, no: isolatedSupplier.no, name: isolatedSupplier.name },
      { id: fulfillmentSupplier.id, no: fulfillmentSupplier.no, name: fulfillmentSupplier.name },
    ],
    product: { id: product.id, code: product.code, name: product.name },
    accounts: accounts.map(account => ({
      name: account.name,
      role: account.role,
      phone: account.phone,
      email: account.email,
    })),
  }, null, 2))
}

main()
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
