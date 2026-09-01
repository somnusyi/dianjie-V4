import Fastify from 'fastify'
import { Prisma } from '@dianjie/db'
import { afterEach, describe, expect, it } from 'vitest'
import { deliveryAddItemBodySchema, deliveryRoutes } from '../../src/routes/deliveries'
import { customDeliveryLinePrice } from '../../src/services/deliveryItemRemoval'

describe('delivery add-item amount safety', () => {
  it('rejects a custom unit price with more than two decimal places', () => {
    const parsed = deliveryAddItemBodySchema.safeParse({
      customProduct: { name: '测试商品', unit: '件', unitPrice: 12.345 },
      quantity: 2,
      rowVersion: 0,
    })

    expect(parsed.success).toBe(false)
    if (!parsed.success) expect(parsed.error.issues[0].message).toBe('商品价格最多保留 2 位小数')
  })

  it('calculates amount from the frozen two-decimal custom unit price', () => {
    const priced = customDeliveryLinePrice(new Prisma.Decimal(3), new Prisma.Decimal('1.235'))

    expect(priced.unitPrice.toFixed(2)).toBe('1.24')
    expect(priced.amount.toFixed(2)).toBe('3.72')
  })
})

describe('delivery item removal safety boundary', () => {
  let app: ReturnType<typeof Fastify> | undefined

  afterEach(async () => {
    if (app) await app.close()
    app = undefined
  })

  it('rejects store-side access before touching a delivery', async () => {
    app = Fastify()
    app.decorate('authenticate', async (request: any) => {
      request.user = {
        tenantId: 'tenant-test',
        userId: 'user-test',
        role: 'MANAGER',
        supplierId: null,
      }
    })
    await app.register(deliveryRoutes, { prefix: '/api/deliveries' })
    await app.ready()

    expect(app.printRoutes()).toContain('remove-item')
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/deliveries/delivery-id/remove-item',
      payload: { itemId: 'item-id', rowVersion: 0 },
    })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual({ error: '仅内部供应链可调整配送商品' })
  })

  it('does not allow any supplier account to mutate delivery items', async () => {
    app = Fastify()
    app.decorate('authenticate', async (request: any) => {
      request.user = {
        tenantId: 'tenant-test',
        userId: 'user-test',
        role: 'SUPPLIER_OWNER',
        supplierId: 'supplier-test',
      }
    })
    await app.register(deliveryRoutes, { prefix: '/api/deliveries' })
    await app.ready()

    for (const mutation of [
      { method: 'PATCH' as const, url: '/api/deliveries/delivery-id/remove-item', payload: { itemId: 'item-id', rowVersion: 0 } },
      { method: 'PATCH' as const, url: '/api/deliveries/delivery-id/item-quantity', payload: { itemId: 'item-id', targetQuantity: 2, rowVersion: 0 } },
      { method: 'POST' as const, url: '/api/deliveries/delivery-id/add-item', payload: { productId: 'product-id', quantity: 1, rowVersion: 0 } },
    ]) {
      const response = await app.inject(mutation)
      expect(response.statusCode).toBe(403)
      expect(response.json()).toEqual({ error: '仅内部供应链可调整配送商品' })
    }
  })
})
