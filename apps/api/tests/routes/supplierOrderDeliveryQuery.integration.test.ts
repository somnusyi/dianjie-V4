import Fastify from 'fastify'
import ExcelJS from 'exceljs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@dianjie/db'
import {
  exceedsOrderExportLimit,
  ORDER_EXPORT_MAX_ROWS,
  orderCreationSource,
  purchaseOrderRoutes,
} from '../../src/routes/orders'
import { deliveryRoutes } from '../../src/routes/deliveries'

const suffix = `supplier-query-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let tenantId = ''
let supplierAId = ''
let supplierBId = ''
let storeId = ''
let chefUserId = ''
let supplierAUserId = ''
let supplierBUserId = ''
let productAId = ''
let productBId = ''
let orderA: any
let orderAId = ''
let orderBId = ''
let deliveryAId = ''
let app: ReturnType<typeof Fastify>

describe('supplier order and delivery list query (integration)', () => {
  beforeAll(async () => {
    const tenant = await prisma.tenant.create({
      data: { name: `供应商查询测试 ${suffix}`, slug: suffix },
    })
    tenantId = tenant.id

    const [supplierA, supplierB, store] = await Promise.all([
      prisma.supplier.create({ data: { tenantId, no: `A-${suffix}`, name: '查询供应商 A' } }),
      prisma.supplier.create({ data: { tenantId, no: `B-${suffix}`, name: '查询供应商 B' } }),
      prisma.store.create({ data: { tenantId, no: `S-${suffix}`, name: '查询测试门店' } }),
    ])
    supplierAId = supplierA.id
    supplierBId = supplierB.id
    storeId = store.id

    const [chef, supplierAUser, supplierBUser] = await Promise.all([
      prisma.user.create({
        data: {
          tenantId, storeId, storeIds: [storeId], name: '查询厨师长', email: `chef-${suffix}@local.test`,
          password: 'test-only', role: 'KITCHEN_LEAD',
        },
      }),
      prisma.user.create({
        data: {
          tenantId, supplierId: supplierAId, name: '查询供应商 A 账号', email: `a-${suffix}@local.test`,
          password: 'test-only', role: 'SUPPLIER_OWNER',
        },
      }),
      prisma.user.create({
        data: {
          tenantId, supplierId: supplierBId, name: '查询供应商 B 账号', email: `b-${suffix}@local.test`,
          password: 'test-only', role: 'SUPPLIER_OWNER',
        },
      }),
    ])
    chefUserId = chef.id
    supplierAUserId = supplierAUser.id
    supplierBUserId = supplierBUser.id

    const [productA, productB] = await Promise.all([
      prisma.product.create({
        data: {
          tenantId, supplierId: supplierAId, code: `A-CODE-${suffix}`, name: `A商品-${suffix}`,
          category: '菌菇', unit: '斤', price: 10, stock: 100, minOrderQty: 1, stepQty: 1,
        },
      }),
      prisma.product.create({
        data: {
          tenantId, supplierId: supplierBId, code: `B-CODE-${suffix}`, name: `B商品-${suffix}`,
          category: '蔬菜', unit: 'kg', price: 20, stock: 100, minOrderQty: 1, stepQty: 1,
        },
      }),
    ])
    productAId = productA.id
    productBId = productB.id

    const orderDate = new Date('2026-07-15T08:00:00.000Z')
    const [orderACreated, orderB] = await Promise.all([
      prisma.purchaseOrder.create({
        data: {
          tenantId, no: `PO-A-${suffix}`, storeId, supplierId: supplierAId,
          expectedDate: orderDate, totalAmount: 100, status: 'SUBMITTED',
          createdById: chefUserId, createdAt: orderDate,
          items: {
            create: {
              productId: productAId, quantity: 10, unitPrice: 10, amount: 100,
            },
          },
        },
        include: { items: true },
      }),
      prisma.purchaseOrder.create({
        data: {
          tenantId, no: `PO-B-${suffix}`, storeId, supplierId: supplierBId,
          expectedDate: orderDate, totalAmount: 200, status: 'CONFIRMED',
          createdById: chefUserId, createdAt: new Date('2026-07-20T08:00:00.000Z'),
          items: {
            create: {
              productId: productBId, quantity: 10, unitPrice: 20, amount: 200,
            },
          },
        },
        include: { items: true },
      }),
    ])
    orderA = orderACreated
    orderAId = orderACreated.id
    orderBId = orderB.id
    await prisma.purchaseOrder.update({
      where: { id: orderAId },
      data: {
        submittedSnapshot: {
          items: [{
            productId: productAId,
            name: `A商品-${suffix}`,
            code: `A-CODE-${suffix}`,
            quantity: '10.00',
            unitPrice: '10.00',
          }],
        },
      },
    })
    await prisma.purchaseOrderEvent.createMany({
      data: [
        {
          tenantId, purchaseOrderId: orderAId, eventType: 'CREATED', actorId: chefUserId,
          actorRole: 'KITCHEN_LEAD', occurredAt: new Date('2026-07-15T08:00:00.000Z'),
          metadata: { creationSource: '门店提交', creationType: '常规订货' },
        },
        {
          tenantId, purchaseOrderId: orderAId, eventType: 'ACCEPTED', actorId: supplierAUserId,
          actorRole: 'SUPPLIER_OWNER', occurredAt: new Date('2026-07-15T09:00:00.000Z'),
        },
      ],
    })

    const delivery = await prisma.deliveryOrder.create({
      data: {
        tenantId, no: `DO-A-${suffix}`, purchaseOrderId: orderAId, storeId, supplierId: supplierAId,
        status: 'SHIPPED', actualTotalAmount: 100, createdById: supplierAUserId,
        createdAt: orderDate, shippedById: supplierAUserId, shippedAt: orderDate,
        items: {
          create: {
            purchaseOrderItemId: orderA.items[0].id, productId: productAId,
            orderedQtySnapshot: 10, shippedQty: 10, unitPriceSnapshot: 10, amount: 100,
            productCodeSnapshot: `A-CODE-${suffix}`, productNameSnapshot: `A商品-${suffix}`,
          },
        },
      },
    })
    deliveryAId = delivery.id

    app = Fastify()
    app.decorate('authenticate', async (request: any) => {
      const actor = String(request.headers['x-test-actor'] || 'chef')
      request.user = actor === 'supplierA'
        ? { tenantId, supplierId: supplierAId, userId: supplierAUserId, role: 'SUPPLIER_OWNER' }
        : actor === 'supplierB'
          ? { tenantId, supplierId: supplierBId, userId: supplierBUserId, role: 'SUPPLIER_OWNER' }
          : actor === 'unboundSupplier'
            ? { tenantId, userId: supplierAUserId, role: 'SUPPLIER_OWNER' }
            : actor === 'unboundStore'
              ? { tenantId, userId: chefUserId, role: 'KITCHEN_LEAD' }
            : actor === 'engineering'
              ? { tenantId, userId: chefUserId, role: 'ENGINEERING' }
              : actor === 'staff'
                ? { tenantId, userId: chefUserId, role: 'STAFF' }
                : actor === 'finance'
                  ? { tenantId, userId: chefUserId, role: 'FINANCE' }
                  : actor === 'admin'
                    ? { tenantId, userId: chefUserId, role: 'ADMIN' }
          : { tenantId, storeId, storeIds: [storeId], userId: chefUserId, role: 'KITCHEN_LEAD' }
    })
    await app.register(purchaseOrderRoutes, { prefix: '/api/orders' })
    await app.register(deliveryRoutes, { prefix: '/api/deliveries' })
    await app.ready()
  })

  afterAll(async () => {
    if (app) await app.close()
    await new Promise(resolve => setTimeout(resolve, 100))
    if (!tenantId) return
    await prisma.deliveryOrderItem.deleteMany({ where: { deliveryOrder: { tenantId } } })
    await prisma.deliveryOrder.deleteMany({ where: { tenantId } })
    await prisma.purchaseOrderEvent.deleteMany({ where: { tenantId } })
    await prisma.purchaseOrderItem.deleteMany({ where: { purchaseOrder: { tenantId } } })
    await prisma.purchaseOrder.deleteMany({ where: { tenantId } })
    await prisma.product.deleteMany({ where: { tenantId } })
    await prisma.user.deleteMany({ where: { tenantId } })
    await prisma.store.deleteMany({ where: { tenantId } })
    await prisma.supplier.deleteMany({ where: { tenantId } })
    await prisma.tenant.delete({ where: { id: tenantId } })
  })

  it('lists purchase orders with tenant + supplier isolation', async () => {
    const aList = await app.inject({
      method: 'GET', url: '/api/orders?page=1&pageSize=20', headers: { 'x-test-actor': 'supplierA' },
    })
    expect(aList.statusCode).toBe(200)
    const aJson = aList.json()
    expect(aJson.items.map((o: any) => o.id)).toEqual([orderAId])
    expect(aJson.total).toBe(1)
    expect(aJson.items[0]).toMatchObject({
      creationSource: '门店提交',
      creationType: '常规订货',
      printStatus: '未打印',
    })
    expect(aJson.items[0].splitAt).toBe('2026-07-15T09:00:00.000Z')
    expect(aJson.items[0].downstreamDocuments).toEqual([
      expect.objectContaining({ id: deliveryAId, no: `DO-A-${suffix}`, status: 'SHIPPED' }),
    ])

    const bList = await app.inject({
      method: 'GET', url: '/api/orders?page=1&pageSize=20', headers: { 'x-test-actor': 'supplierB' },
    })
    expect(bList.statusCode).toBe(200)
    expect(bList.json().items.map((o: any) => o.id)).toEqual([orderBId])
    expect(bList.json().items[0].creationSource).toBe('历史记录')
  })

  it('uses stable creation-source values and never derives a historical row from the current user role', () => {
    expect(orderCreationSource('KITCHEN_LEAD')).toBe('门店端')
    expect(orderCreationSource('MANAGER')).toBe('门店端')
    expect(orderCreationSource('CHEF_DIRECTOR')).toBe('管理后台')
    expect(orderCreationSource('SUPPLY_CHAIN')).toBe('管理后台')
    expect(orderCreationSource('ADMIN')).toBe('管理后台')
    expect(orderCreationSource('SUPER_ADMIN')).toBe('管理后台')
    expect(orderCreationSource('FINANCE')).toBe('历史记录')
  })

  it('accepts exactly 10,000 export rows and rejects the 10,001st row', () => {
    expect(exceedsOrderExportLimit(ORDER_EXPORT_MAX_ROWS)).toBe(false)
    expect(exceedsOrderExportLimit(ORDER_EXPORT_MAX_ROWS + 1)).toBe(true)
  })

  it('filters purchase orders by date range', async () => {
    const matched = await app.inject({
      method: 'GET',
      url: `/api/orders?dateFrom=2026-07-15&dateTo=2026-07-16&page=1&pageSize=20`,
      headers: { 'x-test-actor': 'supplierA' },
    })
    expect(matched.statusCode).toBe(200)
    expect(matched.json().items.map((o: any) => o.id)).toEqual([orderAId])

    const empty = await app.inject({
      method: 'GET',
      url: `/api/orders?dateFrom=2026-07-01&dateTo=2026-07-14&page=1&pageSize=20`,
      headers: { 'x-test-actor': 'supplierA' },
    })
    expect(empty.statusCode).toBe(200)
    expect(empty.json().items).toHaveLength(0)
    expect(empty.json().total).toBe(0)

    const invalid = await app.inject({
      method: 'GET',
      url: `/api/orders?dateFrom=2026-07-20&dateTo=2026-07-15&page=1&pageSize=20`,
      headers: { 'x-test-actor': 'supplierA' },
    })
    expect(invalid.statusCode).toBe(400)
  })

  it('filters purchase orders by product name / code keyword', async () => {
    for (const keyword of [`A商品-${suffix}`, `A-CODE-${suffix}`]) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/orders?keyword=${encodeURIComponent(keyword)}&page=1&pageSize=20`,
        headers: { 'x-test-actor': 'supplierA' },
      })
      expect(response.statusCode).toBe(200)
      expect(response.json().items.map((o: any) => o.id)).toEqual([orderAId])
    }

    const noMatch = await app.inject({
      method: 'GET',
      url: `/api/orders?keyword=${encodeURIComponent(`B商品-${suffix}`)}&page=1&pageSize=20`,
      headers: { 'x-test-actor': 'supplierA' },
    })
    expect(noMatch.statusCode).toBe(200)
    expect(noMatch.json().items).toHaveLength(0)
  })

  it('keeps purchase orders searchable by the first-submission snapshot after product rename', async () => {
    await prisma.product.update({
      where: { id: productAId },
      data: { name: `A商品-已改名-${suffix}`, code: `A-CODE-NEW-${suffix}` },
    })

    for (const keyword of [`A商品-${suffix}`, `A-CODE-${suffix}`]) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/orders?keyword=${encodeURIComponent(keyword)}&page=1&pageSize=20`,
        headers: { 'x-test-actor': 'supplierA' },
      })
      expect(response.statusCode).toBe(200)
      expect(response.json().items.map((order: any) => order.id)).toEqual([orderAId])
    }

    const currentName = await app.inject({
      method: 'GET',
      url: `/api/orders?keyword=${encodeURIComponent(`A商品-已改名-${suffix}`)}&page=1&pageSize=20`,
      headers: { 'x-test-actor': 'supplierA' },
    })
    expect(currentName.statusCode).toBe(200)
    expect(currentName.json().items.map((order: any) => order.id)).toEqual([orderAId])
  })

  it('paginates purchase orders server-side', async () => {
    const first = await app.inject({
      method: 'GET', url: '/api/orders?page=1&pageSize=1', headers: { 'x-test-actor': 'chef' },
    })
    expect(first.statusCode).toBe(200)
    expect(first.json().items).toHaveLength(1)
    expect(first.json().total).toBe(2)

    const second = await app.inject({
      method: 'GET', url: '/api/orders?page=2&pageSize=1', headers: { 'x-test-actor': 'chef' },
    })
    expect(second.statusCode).toBe(200)
    expect(second.json().items).toHaveLength(1)
    expect(second.json().items[0].id).not.toBe(first.json().items[0].id)
  })

  it('exports every filtered order in stable order with the retained meeting fields', async () => {
    const exportPeerId = `zz-export-${suffix}`
    await prisma.purchaseOrder.create({
      data: {
        id: exportPeerId,
        tenantId, no: `PO-A2-${suffix}`, storeId, supplierId: supplierAId,
        expectedDate: new Date('2026-07-15T08:00:00.000Z'), totalAmount: 50, status: 'SUBMITTED',
        createdById: chefUserId, createdAt: new Date('2026-07-15T08:00:00.000Z'),
        submittedSnapshot: {
          items: [{ productId: productAId, name: `A商品-${suffix}`, code: `A-CODE-${suffix}`, quantity: '5.00', unitPrice: '10.00' }],
        },
        items: { create: { productId: productAId, quantity: 5, unitPrice: 10, amount: 50 } },
      },
    })
    const response = await app.inject({
      method: 'GET',
      url: `/api/orders/export.xlsx?keyword=${encodeURIComponent(`A商品-${suffix}`)}&page=99&pageSize=1`,
      headers: { 'x-test-actor': 'supplierA' },
    })
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(response.rawPayload as any)
    await prisma.purchaseOrderItem.deleteMany({ where: { purchaseOrderId: exportPeerId } })
    await prisma.purchaseOrder.delete({ where: { id: exportPeerId } })
    const sheet = workbook.getWorksheet('门店订货单')!
    expect(sheet.rowCount).toBe(3)
    expect((sheet.getRow(1).values as any[]).slice(1)).toEqual([
      '序号', '订货单号', '门店', '供应商', '创建时间', '创建来源', '创建类型', '单据状态',
      '期望到货时间', '单据提交时间', '分单时间', '操作时间', '备注', '打印状态', '创建人',
      '下游单据', '商品摘要', '金额',
    ])
    expect(sheet.getRow(2).getCell(2).value).toBe(`PO-A2-${suffix}`)
    expect(sheet.getRow(3).getCell(2).value).toBe(`PO-A-${suffix}`)
    expect(sheet.getRow(2).getCell(5).value).toBe('2026-07-15 16:00')
    expect(String(sheet.getRow(3).getCell(16).value)).toContain(`DO-A-${suffix}`)
    expect(String(sheet.getRow(3).getCell(17).value)).toContain(`A商品-${suffix}`)
    expect(Number(sheet.getRow(3).getCell(18).value)).toBeGreaterThan(0)
  })

  it('rejects order reads, exports and print artifacts for non-business or unbound roles', async () => {
    for (const actor of ['engineering', 'staff', 'finance', 'unboundSupplier', 'unboundStore']) {
      const listed = await app.inject({
        method: 'GET', url: '/api/orders?page=1&pageSize=20', headers: { 'x-test-actor': actor },
      })
      expect(listed.statusCode, actor).toBe(403)

      const detailed = await app.inject({
        method: 'GET', url: `/api/orders/${orderAId}`, headers: { 'x-test-actor': actor },
      })
      expect(detailed.statusCode, actor).toBe(403)

      const revisions = await app.inject({
        method: 'GET', url: `/api/orders/${orderAId}/revisions`, headers: { 'x-test-actor': actor },
      })
      expect(revisions.statusCode, actor).toBe(403)

      const exported = await app.inject({
        method: 'GET', url: '/api/orders/export.xlsx?page=1&pageSize=20', headers: { 'x-test-actor': actor },
      })
      expect(exported.statusCode, actor).toBe(403)

      const printed = await app.inject({
        method: 'POST', url: '/api/orders/print-events', headers: { 'x-test-actor': actor },
        payload: { action: 'BROWSER_PRINT', orderIds: [orderAId] },
      })
      expect(printed.statusCode, actor).toBe(403)
    }
  })

  it('keeps an allowed tenant-wide reader isolated from a second tenant', async () => {
    const foreignTenant = await prisma.tenant.create({
      data: { name: `外部租户 ${suffix}`, slug: `foreign-${suffix}` },
    })
    const foreignSupplier = await prisma.supplier.create({
      data: { tenantId: foreignTenant.id, no: `FS-${suffix}`, name: '外部供应商' },
    })
    const foreignStore = await prisma.store.create({
      data: { tenantId: foreignTenant.id, no: `FST-${suffix}`, name: '外部门店' },
    })
    const foreignUser = await prisma.user.create({
      data: {
        tenantId: foreignTenant.id, name: '外部管理员', email: `foreign-${suffix}@local.test`,
        password: 'test-only', role: 'ADMIN',
      },
    })
    const foreignProduct = await prisma.product.create({
      data: {
        tenantId: foreignTenant.id, supplierId: foreignSupplier.id, code: `FOREIGN-${suffix}`,
        name: `外部商品-${suffix}`, category: '测试', unit: '件', price: 1, stock: 1,
        minOrderQty: 1, stepQty: 1,
      },
    })
    const foreignOrder = await prisma.purchaseOrder.create({
      data: {
        tenantId: foreignTenant.id, no: `PO-FOREIGN-${suffix}`, storeId: foreignStore.id,
        supplierId: foreignSupplier.id, expectedDate: new Date('2026-07-15T00:00:00.000Z'),
        totalAmount: 1, status: 'SUBMITTED', createdById: foreignUser.id,
        items: { create: { productId: foreignProduct.id, quantity: 1, unitPrice: 1, amount: 1 } },
      },
    })
    try {
      const listed = await app.inject({
        method: 'GET',
        url: `/api/orders?keyword=${encodeURIComponent(foreignOrder.no)}&page=1&pageSize=20`,
        headers: { 'x-test-actor': 'admin' },
      })
      expect(listed.statusCode).toBe(200)
      expect(listed.json().items).toHaveLength(0)

      const detailed = await app.inject({
        method: 'GET', url: `/api/orders/${foreignOrder.id}`, headers: { 'x-test-actor': 'admin' },
      })
      expect(detailed.statusCode).toBe(404)

      const revisions = await app.inject({
        method: 'GET', url: `/api/orders/${foreignOrder.id}/revisions`, headers: { 'x-test-actor': 'admin' },
      })
      expect(revisions.statusCode).toBe(404)

      const exported = await app.inject({
        method: 'GET',
        url: `/api/orders/export.xlsx?keyword=${encodeURIComponent(foreignOrder.no)}&page=1&pageSize=20`,
        headers: { 'x-test-actor': 'admin' },
      })
      expect(exported.statusCode).toBe(200)
      const workbook = new ExcelJS.Workbook()
      await workbook.xlsx.load(exported.rawPayload as any)
      expect(workbook.getWorksheet('门店订货单')?.rowCount).toBe(1)

      const printed = await app.inject({
        method: 'POST', url: '/api/orders/print-events', headers: { 'x-test-actor': 'admin' },
        payload: { action: 'BROWSER_PRINT', orderIds: [foreignOrder.id] },
      })
      expect(printed.statusCode).toBe(404)
      expect(await prisma.purchaseOrderEvent.count({
        where: { purchaseOrderId: foreignOrder.id, eventType: 'PRINT_REQUESTED' },
      })).toBe(0)
    } finally {
      await prisma.purchaseOrderItem.deleteMany({ where: { purchaseOrderId: foreignOrder.id } })
      await prisma.purchaseOrder.delete({ where: { id: foreignOrder.id } })
      await prisma.product.delete({ where: { id: foreignProduct.id } })
      await prisma.user.delete({ where: { id: foreignUser.id } })
      await prisma.store.delete({ where: { id: foreignStore.id } })
      await prisma.supplier.delete({ where: { id: foreignSupplier.id } })
      await prisma.tenant.delete({ where: { id: foreignTenant.id } })
    }
  })

  it('records a scoped print request and exposes its truthful status', async () => {
    const forbidden = await app.inject({
      method: 'POST', url: '/api/orders/print-events',
      headers: { 'x-test-actor': 'supplierB' }, payload: { action: 'BROWSER_PRINT', orderIds: [orderAId] },
    })
    expect(forbidden.statusCode).toBe(404)

    const exportIsNotPrint = await app.inject({
      method: 'POST', url: '/api/orders/print-events',
      headers: { 'x-test-actor': 'supplierA' }, payload: { action: 'EXCEL_EXPORTED', orderIds: [orderAId] },
    })
    expect(exportIsNotPrint.statusCode).toBe(400)

    const beforeMixed = await prisma.purchaseOrderEvent.count({
      where: { tenantId, eventType: 'PRINT_REQUESTED' },
    })
    const mixed = await app.inject({
      method: 'POST', url: '/api/orders/print-events',
      headers: { 'x-test-actor': 'supplierA' }, payload: { action: 'BROWSER_PRINT', orderIds: [orderAId, orderBId] },
    })
    expect(mixed.statusCode).toBe(404)
    expect(await prisma.purchaseOrderEvent.count({
      where: { tenantId, eventType: 'PRINT_REQUESTED' },
    })).toBe(beforeMixed)

    const created = await app.inject({
      method: 'POST', url: '/api/orders/print-events',
      headers: { 'x-test-actor': 'supplierA' }, payload: { action: 'BROWSER_PRINT', orderIds: [orderAId, orderAId] },
    })
    expect(created.statusCode).toBe(201)
    expect(created.json().printStatus).toBe('已发起打印')
    expect(created.json().count).toBe(1)

    const list = await app.inject({
      method: 'GET', url: '/api/orders?page=1&pageSize=20', headers: { 'x-test-actor': 'supplierA' },
    })
    expect(list.statusCode).toBe(200)
    expect(list.json().items[0].printStatus).toBe('已发起打印')
    expect(list.json().items[0].lastPrintRequestedAt).toBeTruthy()
  })

  it('uses the latest delivery milestone for operation time', async () => {
    const deliveredAt = new Date('2030-07-15T10:00:00.000Z')
    await prisma.deliveryOrder.update({
      where: { id: deliveryAId },
      data: { deliveredAt },
    })
    const list = await app.inject({
      method: 'GET', url: '/api/orders?page=1&pageSize=20', headers: { 'x-test-actor': 'supplierA' },
    })
    expect(list.statusCode).toBe(200)
    expect(list.json().items[0].lastOperationAt).toBe(deliveredAt.toISOString())
  })

  it('lists delivery orders with tenant + supplier isolation', async () => {
    const aList = await app.inject({
      method: 'GET', url: '/api/deliveries?page=1&pageSize=20', headers: { 'x-test-actor': 'supplierA' },
    })
    expect(aList.statusCode).toBe(200)
    expect(aList.json().items.map((d: any) => d.id)).toEqual([deliveryAId])

    const bList = await app.inject({
      method: 'GET', url: '/api/deliveries?page=1&pageSize=20', headers: { 'x-test-actor': 'supplierB' },
    })
    expect(bList.statusCode).toBe(200)
    expect(bList.json().items).toHaveLength(0)
  })

  it('filters delivery orders by date range and status', async () => {
    const matched = await app.inject({
      method: 'GET',
      url: `/api/deliveries?dateFrom=2026-07-15&dateTo=2026-07-16&status=SHIPPED&page=1&pageSize=20`,
      headers: { 'x-test-actor': 'supplierA' },
    })
    expect(matched.statusCode).toBe(200)
    expect(matched.json().items.map((d: any) => d.id)).toEqual([deliveryAId])

    const wrongStatus = await app.inject({
      method: 'GET',
      url: `/api/deliveries?status=DELIVERED&page=1&pageSize=20`,
      headers: { 'x-test-actor': 'supplierA' },
    })
    expect(wrongStatus.statusCode).toBe(200)
    expect(wrongStatus.json().items).toHaveLength(0)
  })

  it('filters delivery orders by product keyword and snapshot after rename', async () => {
    for (const keyword of [`A商品-${suffix}`, `A-CODE-${suffix}`]) {
      const beforeRename = await app.inject({
        method: 'GET',
        url: `/api/deliveries?keyword=${encodeURIComponent(keyword)}&page=1&pageSize=20`,
        headers: { 'x-test-actor': 'supplierA' },
      })
      expect(beforeRename.statusCode).toBe(200)
      expect(beforeRename.json().items.map((d: any) => d.id)).toEqual([deliveryAId])
    }

    await prisma.product.update({
      where: { id: productAId },
      data: { name: `A商品-已改名-${suffix}`, code: `A-CODE-NEW-${suffix}` },
    })

    const bySnapshotName = await app.inject({
      method: 'GET',
      url: `/api/deliveries?keyword=${encodeURIComponent(`A商品-${suffix}`)}&page=1&pageSize=20`,
      headers: { 'x-test-actor': 'supplierA' },
    })
    expect(bySnapshotName.statusCode).toBe(200)
    expect(bySnapshotName.json().items.map((d: any) => d.id)).toEqual([deliveryAId])

    const bySnapshotCode = await app.inject({
      method: 'GET',
      url: `/api/deliveries?keyword=${encodeURIComponent(`A-CODE-${suffix}`)}&page=1&pageSize=20`,
      headers: { 'x-test-actor': 'supplierA' },
    })
    expect(bySnapshotCode.statusCode).toBe(200)
    expect(bySnapshotCode.json().items.map((d: any) => d.id)).toEqual([deliveryAId])

    const byNewName = await app.inject({
      method: 'GET',
      url: `/api/deliveries?keyword=${encodeURIComponent(`A商品-已改名-${suffix}`)}&page=1&pageSize=20`,
      headers: { 'x-test-actor': 'supplierA' },
    })
    expect(byNewName.statusCode).toBe(200)
    expect(byNewName.json().items.map((d: any) => d.id)).toEqual([deliveryAId])
  })

  it('paginates delivery orders server-side', async () => {
    const secondDelivery = await prisma.deliveryOrder.create({
      data: {
        tenantId, no: `DO-A-2-${suffix}`, purchaseOrderId: orderAId, storeId, supplierId: supplierAId,
        status: 'SHIPPED', actualTotalAmount: 50, createdById: supplierAUserId,
        createdAt: new Date('2026-07-16T08:00:00.000Z'), shippedById: supplierAUserId, shippedAt: new Date(),
        items: {
          create: {
            purchaseOrderItemId: orderA.items[0].id, productId: productAId,
            orderedQtySnapshot: 10, shippedQty: 5, unitPriceSnapshot: 10, amount: 50,
            productCodeSnapshot: `A-CODE-${suffix}`, productNameSnapshot: `A商品-${suffix}`,
          },
        },
      },
    })

    const first = await app.inject({
      method: 'GET', url: '/api/deliveries?page=1&pageSize=1', headers: { 'x-test-actor': 'supplierA' },
    })
    expect(first.statusCode).toBe(200)
    expect(first.json().items).toHaveLength(1)
    expect(first.json().total).toBe(2)

    await prisma.deliveryOrder.delete({ where: { id: secondDelivery.id } })
  })
})
