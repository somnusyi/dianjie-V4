import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { deliveryRoutes } from '../../src/routes/deliveries'

describe('delivery mutation safety boundary', () => {
  let app: ReturnType<typeof Fastify> | undefined

  afterEach(async () => {
    if (app) await app.close()
    app = undefined
  })

  it('does not expose the retired post-shipment remove-item endpoint', async () => {
    app = Fastify()
    app.decorate('authenticate', async () => {})
    await app.register(deliveryRoutes, { prefix: '/api/deliveries' })
    await app.ready()

    expect(app.printRoutes()).not.toContain('remove-item')
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/deliveries/delivery-id/remove-item',
      payload: { itemId: 'item-id', rowVersion: 0 },
    })
    expect(response.statusCode).toBe(404)
  })
})
