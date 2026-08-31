import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { deliveryRoutes } from '../../src/routes/deliveries'

describe('delivery item removal safety boundary', () => {
  let app: ReturnType<typeof Fastify> | undefined

  afterEach(async () => {
    if (app) await app.close()
    app = undefined
  })

  it('exposes only the authenticated supplier mutation route', async () => {
    app = Fastify()
    app.decorate('authenticate', async (request: any) => {
      request.user = {
        tenantId: 'tenant-test',
        userId: 'user-test',
        role: 'SUPPLY_CHAIN',
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
    expect(response.json()).toEqual({ error: '仅供应商负责人或供应商员工可移除商品' })
  })

  it('does not allow a supplier sub-account to remove an item', async () => {
    app = Fastify()
    app.decorate('authenticate', async (request: any) => {
      request.user = {
        tenantId: 'tenant-test',
        userId: 'user-test',
        role: 'SUPPLIER_SUB',
        supplierId: 'supplier-test',
      }
    })
    await app.register(deliveryRoutes, { prefix: '/api/deliveries' })
    await app.ready()

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/deliveries/delivery-id/remove-item',
      payload: { itemId: 'item-id', rowVersion: 0 },
    })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual({ error: '仅供应商负责人或供应商员工可移除商品' })
  })
})
