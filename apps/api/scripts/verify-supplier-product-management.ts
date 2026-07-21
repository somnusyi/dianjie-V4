import 'dotenv/config'
import assert from 'node:assert/strict'
import bcrypt from 'bcryptjs'
import { prisma } from '@dianjie/db'

const API_BASE = process.env.TEST_API_BASE || 'http://localhost:4444'
const TENANT_SLUG = process.env.PREVIEW_TENANT_SLUG || 'yaohai-test'
const IDENTIFIER = 'supplier-delivery-verify@local.test'
const PASSWORD = 'yaohai@123'

function assertLocalOnly() {
  const url = process.env.DATABASE_URL || ''
  if (process.env.PREVIEW_MODE !== 'true' || process.env.NODE_ENV === 'production' || !url.includes('dianjie_v4_local')) {
    throw new Error('安全护栏：商品管理验证仅允许本地 PREVIEW_MODE 隔离库')
  }
}

async function api(path: string, token: string | null, init: RequestInit = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(init.body instanceof FormData ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {}),
    },
  })
  const body = await response.json().catch(() => ({}))
  return { status: response.status, body }
}

async function main() {
  assertLocalOnly()
  const startedAt = new Date()
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: TENANT_SLUG } })
  const user = await prisma.user.findFirstOrThrow({
    where: { tenantId: tenant.id, email: IDENTIFIER, supplierId: { not: null } },
  })
  const supplierId = user.supplierId!
  const categoryNames = ['验证分类A', '验证分类B', '验证分类C']
  const concurrentImportCategories = Array.from({ length: 4 }, (_, index) => `并发导入分类-${Date.now()}-${index}`)
  for (let index = 0; index < categoryNames.length; index++) {
    await prisma.supplierProductCategory.upsert({
      where: { tenantId_supplierId_name: { tenantId: tenant.id, supplierId, name: categoryNames[index] } },
      create: { tenantId: tenant.id, supplierId, name: categoryNames[index], sortOrder: 900 + index },
      update: { isActive: true },
    })
  }
  const code = `VERIFY-SKU-${Date.now()}`
  const products = await Promise.all([
    { code, name: '本地商品管理验证品' },
    { code: `${code}-B`, name: '并发停售验证品 B' },
    { code: `${code}-C`, name: '并发停售验证品 C' },
  ].map(item => prisma.product.create({
    data: {
      tenantId: tenant.id, supplierId, code: item.code,
      name: item.name, spec: '1kg/件', category: '验证分类A', unit: '件',
      price: 10, stock: 0, minStock: 0, status: 'ENABLED',
    },
  })))
  const [product, productB, productC] = products
  const documentIds: string[] = []
  const batchIds: string[] = []
  const batchProductIds: string[] = []
  const rollbackMarker = Date.now()
  const rollbackFilename = `verify-rollback-${rollbackMarker}.xlsx`
  const rollbackCode = `VERIFY-ROLLBACK-${rollbackMarker}`
  const rollbackCategory = `验证回滚分类${rollbackMarker}`
  const singleRollbackCode = `VERIFY-SINGLE-ROLLBACK-${rollbackMarker}`
  const singleRollbackCategory = `验证单条回滚分类${rollbackMarker}`
  let rollbackTriggerInstalled = false
  let temporaryAdminId: string | null = null
  let temporaryUnboundSupplierId: string | null = null
  let temporaryChefId: string | null = null
  let temporaryTenantId: string | null = null
  let temporarySupplierId: string | null = null
  let temporaryForeignProductId: string | null = null
  let batch500RowsMs = 0

  try {
    const login = await api('/api/auth/login', null, {
      method: 'POST',
      body: JSON.stringify({ identifier: IDENTIFIER, password: PASSWORD, tenantSlug: TENANT_SLUG }),
    })
    assert.equal(login.status, 200, JSON.stringify(login.body))
    const token = login.body.token as string

    const concurrentImports = await Promise.all(concurrentImportCategories.map((category, index) => api('/api/products/batch', token, {
      method: 'POST',
      body: JSON.stringify({
        filename: `verify-concurrent-category-${index}.xlsx`,
        items: [{
          code: `VERIFY-CATEGORY-${Date.now()}-${index}`, name: `并发分类导入验证品 ${index}`,
          category, unit: '件', price: 10 + index,
        }],
      }),
    })))
    concurrentImports.forEach(result => {
      assert.equal(result.status, 201, JSON.stringify(result.body))
      assert.equal(result.body.createdCount, 1, JSON.stringify(result.body))
      batchIds.push(result.body.batchId)
      batchProductIds.push(result.body.created[0].id)
    })
    const concurrentImportDocs = await prisma.document.findMany({
      where: { tenantId: tenant.id, no: { in: concurrentImports.map(result => result.body.approvalDocNo) } },
    })
    assert.equal(concurrentImportDocs.length, concurrentImportCategories.length)
    documentIds.push(...concurrentImportDocs.map(document => document.id))
    const importedCategories = await prisma.supplierProductCategory.findMany({
      where: { tenantId: tenant.id, supplierId, name: { in: concurrentImportCategories } },
    })
    assert.equal(importedCategories.length, concurrentImportCategories.length)
    assert.equal(new Set(importedCategories.map(category => category.sortOrder)).size, concurrentImportCategories.length, '并发导入自动分类排序号必须唯一')

    const chefMarker = Date.now()
    const chefEmail = `verify-product-chef-${chefMarker}@local.test`
    const chefPassword = `verify-chef-${chefMarker}`
    const temporaryChef = await prisma.user.create({
      data: {
        tenantId: tenant.id, name: '商品审批并发验证总厨', email: chefEmail,
        password: await bcrypt.hash(chefPassword, 4), role: 'CHEF_DIRECTOR',
      },
    })
    temporaryChefId = temporaryChef.id
    const chefLogin = await api('/api/auth/login', null, {
      method: 'POST',
      body: JSON.stringify({ identifier: chefEmail, password: chefPassword, tenantSlug: TENANT_SLUG }),
    })
    assert.equal(chefLogin.status, 200, JSON.stringify(chefLogin.body))
    const chefToken = chefLogin.body.token as string

    const categories = await api('/api/products/categories', token)
    assert.equal(categories.status, 200, JSON.stringify(categories.body))
    assert.ok(categories.body.some((item: any) => item.name === '验证分类A'))

    const beforeInvalidPatches = await prisma.product.findUniqueOrThrow({ where: { id: product.id } })
    for (const invalidBody of [
      { stock: 999 },
      { name: '供应商不可静默改名' },
      { unexpected: true },
    ]) {
      const invalidPatch = await api(`/api/products/${product.id}`, token, {
        method: 'PATCH', body: JSON.stringify(invalidBody),
      })
      assert.equal(invalidPatch.status, 400, JSON.stringify(invalidPatch.body))
    }
    assert.deepEqual(
      await prisma.product.findUniqueOrThrow({ where: { id: product.id } }),
      beforeInvalidPatches,
      '不允许字段必须整体拒绝且零写入',
    )

    const patch = await api(`/api/products/${product.id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ category: '验证分类B', imageKey: `products/${tenant.id}/verify.jpg` }),
    })
    assert.equal(patch.status, 200, JSON.stringify(patch.body))
    assert.equal(patch.body.product.category, '验证分类B')

    const batchCategory = await api('/api/products/batch-category', token, {
      method: 'PATCH',
      body: JSON.stringify({ ids: [product.id], category: '验证分类C' }),
    })
    assert.equal(batchCategory.status, 200, JSON.stringify(batchCategory.body))
    assert.equal(batchCategory.body.count, 1)

    const independentDisable = await Promise.all([
      api('/api/products/batch-status', token, {
        method: 'PATCH', body: JSON.stringify({ ids: [productB.id], status: 'DISABLED' }),
      }),
      api('/api/products/batch-status', token, {
        method: 'PATCH', body: JSON.stringify({ ids: [productC.id], status: 'DISABLED' }),
      }),
    ])
    independentDisable.forEach(result => assert.equal(result.status, 200, JSON.stringify(result.body)))
    assert.notEqual(independentDisable[0].body.documentNo, independentDisable[1].body.documentNo, '并发审批单号必须唯一')
    const independentDocs = await prisma.document.findMany({
      where: { tenantId: tenant.id, no: { in: independentDisable.map(result => result.body.documentNo) } },
    })
    assert.equal(independentDocs.length, 2)
    documentIds.push(...independentDocs.map(doc => doc.id))

    const duplicateDisable = await Promise.all([
      api('/api/products/batch-status', token, {
        method: 'PATCH', body: JSON.stringify({ ids: [product.id], status: 'DISABLED' }),
      }),
      api('/api/products/batch-status', token, {
        method: 'PATCH', body: JSON.stringify({ ids: [product.id], status: 'DISABLED' }),
      }),
    ])
    const successfulDisable = duplicateDisable.filter(result => result.status === 200)
    const rejectedDisable = duplicateDisable.filter(result => result.status === 400 || result.status === 409)
    assert.equal(successfulDisable.length, 1, JSON.stringify(duplicateDisable))
    assert.equal(rejectedDisable.length, 1, JSON.stringify(duplicateDisable))
    const duplicateDoc = await prisma.document.findFirstOrThrow({
      where: { tenantId: tenant.id, no: successfulDisable[0].body.documentNo },
    })
    documentIds.push(duplicateDoc.id)
    assert.equal(await prisma.document.count({
      where: {
        tenantId: tenant.id, status: 'PENDING',
        payload: { path: ['productIds'], array_contains: [product.id] },
      },
    }), 1, '重复停售只能生成一张待审批单')
    const pendingProducts = await prisma.product.findMany({
      where: { id: { in: products.map(item => item.id) } }, select: { status: true },
    })
    assert.ok(pendingProducts.every(item => item.status === 'PENDING_DISABLE'))

    const history = await api('/api/products/history?limit=100', token)
    assert.equal(history.status, 200, JSON.stringify(history.body))
    assert.ok(history.body.some((row: any) => row.targetId === product.id || row.action.includes('批量')))

    const decimalBoundaryMarker = Date.now()
    const invalidSingle = await api('/api/products', token, {
      method: 'POST',
      body: JSON.stringify({ name: `数值上限单条-${decimalBoundaryMarker}`, price: 100_000_000 }),
    })
    assert.equal(invalidSingle.status, 400, JSON.stringify(invalidSingle.body))
    const invalidBatch = await api('/api/products/batch', token, {
      method: 'POST',
      body: JSON.stringify({
        filename: `verify-decimal-boundary-${decimalBoundaryMarker}.xlsx`,
        items: [{ name: `数值上限批量-${decimalBoundaryMarker}`, minOrderQty: 100_000_000 }],
      }),
    })
    assert.equal(invalidBatch.status, 201, JSON.stringify(invalidBatch.body))
    assert.equal(invalidBatch.body.createdCount, 0, JSON.stringify(invalidBatch.body))
    assert.equal(invalidBatch.body.failedCount, 1, JSON.stringify(invalidBatch.body))
    batchIds.push(invalidBatch.body.batchId)
    assert.equal(await prisma.product.count({
      where: { tenantId: tenant.id, name: { contains: `数值上限` } },
    }), 0)

    const batchCode = `VERIFY-BATCH-${Date.now()}`
    const batchCreate = await api('/api/products/batch', token, {
      method: 'POST',
      body: JSON.stringify({
        filename: `verify-batch-${Date.now()}.xlsx`,
        items: [
          { code: batchCode, name: '批量事务验证品', category: '验证分类A', unit: '件', price: 12 },
          { code, name: '重复编码验证品', category: '验证分类A', unit: '件', price: 12 },
          { name: '自动编码验证品一', category: '验证分类B', unit: '件', price: 13 },
          { name: '自动编码验证品二', category: '验证分类B', unit: '件', price: 14 },
        ],
      }),
    })
    assert.equal(batchCreate.status, 201, JSON.stringify(batchCreate.body))
    assert.equal(batchCreate.body.createdCount, 3, JSON.stringify(batchCreate.body))
    assert.equal(batchCreate.body.failedCount, 1, JSON.stringify(batchCreate.body))
    assert.equal(new Set(batchCreate.body.created.map((item: any) => item.code)).size, 3, '自动编码必须批内唯一')
    assert.ok(batchCreate.body.approvalDocNo)
    batchIds.push(batchCreate.body.batchId)
    batchProductIds.push(...batchCreate.body.created.map((item: any) => item.id))
    const batchState = await prisma.productBatch.findFirstOrThrow({
      where: { id: batchCreate.body.batchId, tenantId: tenant.id, supplierId },
      include: { products: { select: { id: true, status: true } } },
    })
    assert.equal(batchState.createdCount, 3)
    assert.equal(batchState.failedCount, 1)
    assert.ok(batchState.products.every(item => item.status === 'PENDING_APPROVAL'))
    const batchDocument = await prisma.document.findFirstOrThrow({
      where: { tenantId: tenant.id, no: batchCreate.body.approvalDocNo },
    })
    documentIds.push(batchDocument.id)
    const batchPayload = batchDocument.payload as any
    assert.equal(batchPayload.batchId, batchState.id)
    assert.equal(batchPayload.supplierId, supplierId)
    assert.deepEqual(new Set(batchPayload.productIds), new Set(batchState.products.map(item => item.id)))
    const duplicateApproval = await Promise.all([
      api(`/api/documents/${batchDocument.id}/decisions`, chefToken, {
        method: 'POST', body: JSON.stringify({ decision: 'APPROVE', comment: '并发审批验证' }),
      }),
      api(`/api/documents/${batchDocument.id}/decisions`, chefToken, {
        method: 'POST', body: JSON.stringify({ decision: 'APPROVE', comment: '并发审批验证' }),
      }),
    ])
    assert.equal(duplicateApproval.filter(result => result.status === 200).length, 1, JSON.stringify(duplicateApproval))
    assert.equal(duplicateApproval.filter(result => [404, 409].includes(result.status)).length, 1, JSON.stringify(duplicateApproval))
    assert.equal(await prisma.documentDecision.count({ where: { documentId: batchDocument.id } }), 1)
    assert.equal((await prisma.document.findUniqueOrThrow({ where: { id: batchDocument.id } })).status, 'APPROVED')
    assert.equal(await prisma.product.count({
      where: { id: { in: batchState.products.map(item => item.id) }, status: 'ENABLED' },
    }), batchState.products.length)

    const batch500Marker = Date.now()
    const batch500StartedAt = performance.now()
    const batch500 = await api('/api/products/batch', token, {
      method: 'POST',
      body: JSON.stringify({
        filename: `verify-500-${batch500Marker}.xlsx`,
        items: Array.from({ length: 500 }, (_, index) => ({
          code: `VERIFY-500-${batch500Marker}-${String(index + 1).padStart(3, '0')}`,
          name: `五百行事务验证品 ${index + 1}`,
          category: '验证分类A', unit: '件', price: 10 + (index % 10),
        })),
      }),
    })
    batch500RowsMs = Math.round(performance.now() - batch500StartedAt)
    assert.equal(batch500.status, 201, JSON.stringify(batch500.body))
    assert.equal(batch500.body.createdCount, 500)
    assert.equal(batch500.body.failedCount, 0)
    assert.ok(batch500.body.approvalDocNo)
    batchIds.push(batch500.body.batchId)
    batchProductIds.push(...batch500.body.created.map((item: any) => item.id))
    const batch500Document = await prisma.document.findFirstOrThrow({
      where: { tenantId: tenant.id, no: batch500.body.approvalDocNo },
    })
    documentIds.push(batch500Document.id)
    assert.equal((batch500Document.payload as any).count, 500)
    assert.equal((batch500Document.payload as any).productIds.length, 500)

    const createRevokeBatch = async (label: string) => {
      const marker = `${Date.now()}-${label}`
      const response = await api('/api/products/batch', token, {
        method: 'POST',
        body: JSON.stringify({
          filename: `verify-revoke-${marker}.xlsx`,
          items: [{
            code: `VERIFY-REVOKE-${marker}`, name: `撤回审批验证品 ${label}`,
            category: '验证分类A', unit: '件', price: 18,
          }],
        }),
      })
      assert.equal(response.status, 201, JSON.stringify(response.body))
      assert.equal(response.body.createdCount, 1)
      batchIds.push(response.body.batchId)
      batchProductIds.push(response.body.created[0].id)
      const document = await prisma.document.findFirstOrThrow({
        where: { tenantId: tenant.id, no: response.body.approvalDocNo },
      })
      documentIds.push(document.id)
      return { response, document, productId: response.body.created[0].id as string }
    }

    const sequentialRevoke = await createRevokeBatch('sequential')
    const revoked = await api(`/api/products/batches/${sequentialRevoke.response.body.batchId}/revoke`, token, {
      method: 'PATCH', body: JSON.stringify({}),
    })
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body))
    assert.equal((await prisma.document.findUniqueOrThrow({ where: { id: sequentialRevoke.document.id } })).status, 'CANCELED')
    assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: sequentialRevoke.productId } })).status, 'DISABLED')
    const approveRevoked = await api(`/api/documents/${sequentialRevoke.document.id}/decisions`, chefToken, {
      method: 'POST', body: JSON.stringify({ decision: 'APPROVE', comment: '撤回后审批验证' }),
    })
    assert.ok([404, 409].includes(approveRevoked.status), JSON.stringify(approveRevoked.body))
    assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: sequentialRevoke.productId } })).status, 'DISABLED')

    const concurrentRevoke = await createRevokeBatch('concurrent')
    const [revokeRace, approveRace] = await Promise.all([
      api(`/api/products/batches/${concurrentRevoke.response.body.batchId}/revoke`, token, {
        method: 'PATCH', body: JSON.stringify({}),
      }),
      api(`/api/documents/${concurrentRevoke.document.id}/decisions`, chefToken, {
        method: 'POST', body: JSON.stringify({ decision: 'APPROVE', comment: '撤回审批竞争验证' }),
      }),
    ])
    assert.equal(revokeRace.status, 200, JSON.stringify(revokeRace.body))
    assert.ok([200, 404, 409].includes(approveRace.status), JSON.stringify(approveRace.body))
    assert.equal((await prisma.productBatch.findUniqueOrThrow({
      where: { id: concurrentRevoke.response.body.batchId },
    })).revokedAt instanceof Date, true)
    assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: concurrentRevoke.productId } })).status, 'DISABLED')
    assert.ok(['APPROVED', 'CANCELED'].includes((await prisma.document.findUniqueOrThrow({
      where: { id: concurrentRevoke.document.id },
    })).status))

    await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS verify_product_batch_document_failure_trigger ON documents')
    await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS verify_product_batch_document_failure()')
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION verify_product_batch_document_failure()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.payload ->> 'filename' = '${rollbackFilename}'
           OR NEW.payload ->> 'productCode' = '${singleRollbackCode}' THEN
          RAISE EXCEPTION 'verify product batch document rollback';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `)
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER verify_product_batch_document_failure_trigger
      BEFORE INSERT ON documents
      FOR EACH ROW EXECUTE FUNCTION verify_product_batch_document_failure()
    `)
    rollbackTriggerInstalled = true
    try {
      const rollbackBatch = await api('/api/products/batch', token, {
        method: 'POST',
        body: JSON.stringify({
          filename: rollbackFilename,
          items: [{ code: rollbackCode, name: '事务回滚验证品', category: rollbackCategory, unit: '件', price: 15 }],
        }),
      })
      assert.equal(rollbackBatch.status, 500, JSON.stringify(rollbackBatch.body))
      const rollbackSingle = await api('/api/products', token, {
        method: 'POST',
        body: JSON.stringify({
          code: singleRollbackCode, name: '单条事务回滚验证品',
          category: singleRollbackCategory, unit: '件', price: 15,
        }),
      })
      assert.equal(rollbackSingle.status, 500, JSON.stringify(rollbackSingle.body))
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS verify_product_batch_document_failure_trigger ON documents')
      await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS verify_product_batch_document_failure()')
      rollbackTriggerInstalled = false
    }
    assert.equal(await prisma.product.count({ where: { tenantId: tenant.id, code: rollbackCode } }), 0)
    assert.equal(await prisma.productBatch.count({ where: { tenantId: tenant.id, filename: rollbackFilename } }), 0)
    assert.equal(await prisma.supplierProductCategory.count({
      where: { tenantId: tenant.id, supplierId, name: rollbackCategory },
    }), 0)
    assert.equal(await prisma.product.count({ where: { tenantId: tenant.id, code: singleRollbackCode } }), 0)
    assert.equal(await prisma.supplierProductCategory.count({
      where: { tenantId: tenant.id, supplierId, name: singleRollbackCategory },
    }), 0)

    const isolationMarker = Date.now()
    const temporaryTenant = await prisma.tenant.create({
      data: { name: '批量租户隔离验证', slug: `verify-batch-isolation-${isolationMarker}` },
    })
    temporaryTenantId = temporaryTenant.id
    const temporarySupplier = await prisma.supplier.create({
      data: { tenantId: temporaryTenant.id, no: 'VERIFY-SUP', name: '跨租户验证供应商' },
    })
    temporarySupplierId = temporarySupplier.id
    const adminEmail = `verify-batch-admin-${isolationMarker}@local.test`
    const adminPassword = `verify-local-${isolationMarker}`
    const temporaryAdmin = await prisma.user.create({
      data: {
        tenantId: tenant.id, name: '批量租户隔离验证管理员', email: adminEmail,
        password: await bcrypt.hash(adminPassword, 4), role: 'ADMIN',
      },
    })
    temporaryAdminId = temporaryAdmin.id
    const adminLogin = await api('/api/auth/login', null, {
      method: 'POST',
      body: JSON.stringify({ identifier: adminEmail, password: adminPassword, tenantSlug: TENANT_SLUG }),
    })
    assert.equal(adminLogin.status, 200, JSON.stringify(adminLogin.body))
    const adminScopePatch = await api(`/api/products/${product.id}`, adminLogin.body.token, {
      method: 'PATCH', body: JSON.stringify({ supplierId: temporarySupplier.id }),
    })
    assert.equal(adminScopePatch.status, 400, JSON.stringify(adminScopePatch.body))
    assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).supplierId, supplierId)
    const foreignProduct = await prisma.product.create({
      data: {
        tenantId: temporaryTenant.id, supplierId: temporarySupplier.id,
        code: `VERIFY-FOREIGN-${isolationMarker}`, name: '外租户预览验证品',
        category: '其他', unit: '件', price: 99,
      },
    })
    temporaryForeignProductId = foreignProduct.id
    const currentSupplier = await prisma.supplier.findFirstOrThrow({
      where: { id: supplierId, tenantId: tenant.id }, select: { name: true },
    })
    const foreignPreviewDocument = await prisma.document.create({
      data: {
        tenantId: tenant.id, no: `VERIFY-PREVIEW-${isolationMarker}`, type: 'NEW_DISH',
        title: '跨租户商品预览隔离验证', initiatorId: user.id,
        payload: {
          action: 'CREATE', productId: foreignProduct.id,
          supplierId, supplierName: currentSupplier.name,
        },
      },
    })
    documentIds.push(foreignPreviewDocument.id)
    const foreignPreview = await api(`/api/documents/${foreignPreviewDocument.id}/preview`, token)
    assert.equal(foreignPreview.status, 200, JSON.stringify(foreignPreview.body))
    assert.equal(foreignPreview.body.product, null, '审批预览不得返回外租户商品')

    const otherSupplierDocument = await prisma.document.create({
      data: {
        tenantId: tenant.id, no: `VERIFY-SUPPLIER-VIS-${isolationMarker}`, type: 'NEW_DISH',
        title: '其他供应商单据可见性验证', initiatorId: temporaryAdmin.id,
        payload: { action: 'CREATE', supplierName: temporarySupplier.name },
      },
    })
    documentIds.push(otherSupplierDocument.id)
    const otherSupplierDetail = await api(`/api/documents/${otherSupplierDocument.id}`, token)
    const otherSupplierPreview = await api(`/api/documents/${otherSupplierDocument.id}/preview`, token)
    assert.equal(otherSupplierDetail.status, 403, JSON.stringify(otherSupplierDetail.body))
    assert.equal(otherSupplierPreview.status, 403, JSON.stringify(otherSupplierPreview.body))

    const isolationCode = `VERIFY-ISOLATION-${isolationMarker}`
    const isolatedBatch = await api('/api/products/batch', adminLogin.body.token, {
      method: 'POST',
      body: JSON.stringify({
        filename: `verify-isolation-${isolationMarker}.xlsx`,
        items: [{
          code: isolationCode, name: '跨租户供应商验证品', supplierId: temporarySupplier.id,
          category: '其他', unit: '件', price: 16,
        }],
      }),
    })
    assert.equal(isolatedBatch.status, 201, JSON.stringify(isolatedBatch.body))
    assert.equal(isolatedBatch.body.createdCount, 0)
    assert.equal(isolatedBatch.body.failedCount, 1)
    assert.match(isolatedBatch.body.failed[0].error, /不属于当前租户/)
    batchIds.push(isolatedBatch.body.batchId)
    assert.equal(await prisma.product.count({ where: { tenantId: tenant.id, code: isolationCode } }), 0)
    const isolatedSingleCode = `${isolationCode}-SINGLE`
    const isolatedSingle = await api('/api/products', adminLogin.body.token, {
      method: 'POST',
      body: JSON.stringify({
        code: isolatedSingleCode, name: '单条跨租户供应商验证品', supplierId: temporarySupplier.id,
        category: '其他', unit: '件', price: 16,
      }),
    })
    if (isolatedSingle.body?.id) batchProductIds.push(isolatedSingle.body.id)
    assert.equal(isolatedSingle.status, 400, JSON.stringify(isolatedSingle.body))
    assert.equal(await prisma.product.count({ where: { tenantId: tenant.id, code: isolatedSingleCode } }), 0)

    const unboundEmail = `verify-unbound-supplier-${isolationMarker}@local.test`
    const unboundPassword = `verify-unbound-${isolationMarker}`
    const unboundSupplier = await prisma.user.create({
      data: {
        tenantId: tenant.id, name: '未绑定供应商隔离验证', email: unboundEmail,
        password: await bcrypt.hash(unboundPassword, 4), role: 'SUPPLIER_STAFF', supplierId: null,
      },
    })
    temporaryUnboundSupplierId = unboundSupplier.id
    const unboundLogin = await api('/api/auth/login', null, {
      method: 'POST',
      body: JSON.stringify({ identifier: unboundEmail, password: unboundPassword, tenantSlug: TENANT_SLUG }),
    })
    assert.equal(unboundLogin.status, 200, JSON.stringify(unboundLogin.body))
    const unboundList = await api('/api/products?page=1&pageSize=20', unboundLogin.body.token)
    assert.equal(unboundList.status, 401, JSON.stringify(unboundList.body))

    const clearAll = await api('/api/products/clear-all', token, {
      method: 'DELETE', body: JSON.stringify({ confirm: 'CLEAR_ALL' }),
    })
    assert.equal(clearAll.status, 410)

    console.log(JSON.stringify({
      ok: true,
      categoryFilter: true,
      imageKey: true,
      strictPatchFields: true,
      concurrentImportCategoryOrder: true,
      batchCategory: true,
      batchDisableApproval: true,
      concurrentDocumentNumbers: true,
      duplicateDisableRejected: true,
      databaseDecimalBounds: true,
      batchPartialSuccessAtomic: true,
      batch500RowsMs,
      duplicateApprovalSerialized: true,
      revokeApprovalRaceSafe: true,
      batchDocumentFailureRolledBack: true,
      singleDocumentFailureRolledBack: true,
      crossTenantSupplierBlocked: true,
      crossTenantPreviewBlocked: true,
      otherSupplierDocumentBlocked: true,
      unboundSupplierListBlocked: true,
      auditHistory: true,
      destructiveClearBlocked: true,
    }))
  } finally {
    if (rollbackTriggerInstalled) {
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS verify_product_batch_document_failure_trigger ON documents')
      await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS verify_product_batch_document_failure()')
    }
    await prisma.opLog.deleteMany({
      where: {
        tenantId: tenant.id,
        userId: {
          in: [user.id, ...(temporaryAdminId ? [temporaryAdminId] : []),
            ...(temporaryUnboundSupplierId ? [temporaryUnboundSupplierId] : []),
            ...(temporaryChefId ? [temporaryChefId] : [])],
        },
        createdAt: { gte: startedAt },
        entityType: { in: ['Product', 'ProductBatch', 'ProductCategory'] },
      },
    })
    if (temporaryAdminId) {
      await prisma.opLog.deleteMany({ where: { tenantId: tenant.id, userId: temporaryAdminId } })
    }
    if (temporaryUnboundSupplierId) {
      await prisma.opLog.deleteMany({ where: { tenantId: tenant.id, userId: temporaryUnboundSupplierId } })
    }
    if (temporaryChefId) {
      await prisma.opLog.deleteMany({ where: { tenantId: tenant.id, userId: temporaryChefId } })
    }
    if (documentIds.length) await prisma.document.deleteMany({ where: { id: { in: documentIds } } })
    await prisma.product.deleteMany({ where: { id: { in: [...products.map(item => item.id), ...batchProductIds] } } })
    await prisma.product.deleteMany({ where: { tenantId: tenant.id, code: { in: [rollbackCode, singleRollbackCode] } } })
    if (batchIds.length) await prisma.productBatch.deleteMany({ where: { id: { in: batchIds } } })
    await prisma.supplierProductCategory.deleteMany({
      where: { tenantId: tenant.id, supplierId, name: { in: [...categoryNames, ...concurrentImportCategories, rollbackCategory, singleRollbackCategory] } },
    })
    const temporaryUserIds = [temporaryAdminId, temporaryUnboundSupplierId, temporaryChefId].filter(Boolean) as string[]
    if (temporaryUserIds.length) await prisma.user.deleteMany({ where: { id: { in: temporaryUserIds } } })
    if (temporaryForeignProductId) await prisma.product.deleteMany({ where: { id: temporaryForeignProductId } })
    if (temporarySupplierId) await prisma.supplier.deleteMany({ where: { id: temporarySupplierId } })
    if (temporaryTenantId) await prisma.tenant.deleteMany({ where: { id: temporaryTenantId } })
  }
}

main().finally(() => prisma.$disconnect())
