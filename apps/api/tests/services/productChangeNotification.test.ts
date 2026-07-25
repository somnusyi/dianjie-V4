import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  findFirst: vi.fn(),
  upsert: vi.fn(),
  notify: vi.fn(),
}))

vi.mock('@dianjie/db', () => ({
  prisma: {
    user: {
      findMany: mocks.findMany,
      findFirst: mocks.findFirst,
    },
    notification: {
      upsert: mocks.upsert,
    },
  },
}))

vi.mock('../../src/services/notify/index', () => ({
  notify: mocks.notify,
}))

import { EVENTS, renderTemplate } from '../../src/services/notify/events'
import {
  fireAndForgetNotifyProductChange,
  notifyProductChange,
  type NotifyProductChangeInput,
} from '../../src/services/notify/productChange'

const input: NotifyProductChangeInput = {
  tenantId: 'tenant-a',
  productId: 'product-a',
  action: 'PRICE_CHANGE',
  operatorId: 'operator-a',
  eventKey: 'PRODUCT:product-a:PRICE_CHANGE:v2',
  before: { name: '白菜', price: 8, status: 'ENABLED' },
  after: { name: '白菜', price: 7, status: 'ENABLED' },
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.findMany.mockResolvedValue([{ id: 'chef-a' }, { id: 'legacy-chef-a' }])
  mocks.findFirst.mockResolvedValue({ name: '供应链专员' })
  mocks.upsert.mockResolvedValue({})
  mocks.notify.mockResolvedValue({ sent: 2, suppressed: 0, failed: 0 })
})

describe('product change notification', () => {
  it('resolves only active same-tenant chef directors and sends exact toUsers', async () => {
    const result = await notifyProductChange(input)

    expect(mocks.findMany).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-a',
        status: 'ACTIVE',
        role: { in: ['CHEF_DIRECTOR', 'CHEF'] },
      },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    })
    expect(mocks.findFirst).toHaveBeenCalledWith({
      where: { id: 'operator-a', tenantId: 'tenant-a' },
      select: { name: true },
    })
    expect(result.notifiedUserIds).toEqual(['chef-a', 'legacy-chef-a'])
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-a',
      event: 'PRODUCT_CHANGED',
      eventKey: input.eventKey,
      toUsers: ['chef-a', 'legacy-chef-a'],
    }))
    expect(mocks.notify.mock.calls[0][0]).not.toHaveProperty('toRoles')
  })

  it('creates one idempotent system message per explicit recipient', async () => {
    await notifyProductChange(input)

    expect(mocks.upsert).toHaveBeenCalledTimes(2)
    for (const recipientId of ['chef-a', 'legacy-chef-a']) {
      const dedupeKey = `${input.eventKey}:${recipientId}`
      expect(mocks.upsert).toHaveBeenCalledWith({
        where: { tenantId_dedupeKey: { tenantId: input.tenantId, dedupeKey } },
        create: expect.objectContaining({
          tenantId: input.tenantId,
          dedupeKey,
          recipientId,
          recipientRole: 'CHEF_DIRECTOR',
          type: 'PRODUCT_CHANGED',
          refType: 'Product',
          refId: input.productId,
        }),
        update: {},
      })
    }
  })

  it('does not query an operator or send when no active chef exists', async () => {
    mocks.findMany.mockResolvedValue([])

    await expect(notifyProductChange(input)).resolves.toEqual({
      notifiedUserIds: [],
      skipped: { noRecipients: true },
    })
    expect(mocks.findFirst).not.toHaveBeenCalled()
    expect(mocks.upsert).not.toHaveBeenCalled()
    expect(mocks.notify).not.toHaveBeenCalled()
  })

  it('keeps the event exact-user-only and renders the action payload', () => {
    expect(EVENTS.PRODUCT_CHANGED).toMatchObject({
      defaultRoles: [],
      scopedBy: 'tenant',
      urgent: false,
    })
    const rendered = renderTemplate('PRODUCT_CHANGED', {
      action: 'PRICE_CHANGE',
      productName: '白菜',
      operatorName: '供应链专员',
      oldPrice: 8,
      newPrice: 7,
    })
    expect(rendered.kind).toBe('textcard')
    expect(rendered.textcard?.title).toContain('白菜')
    expect(rendered.textcard?.description).toContain('8')
    expect(rendered.textcard?.description).toContain('7')
  })

  it('renders exact category changes in both the system message and WeCom payload', async () => {
    await notifyProductChange({
      ...input,
      action: 'UPDATE',
      eventKey: 'PRODUCT:product-a:UPDATE:category-v1',
      before: { name: '白菜', category: '叶菜' },
      after: { name: '白菜', category: '生鲜' },
    })

    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        body: expect.stringContaining('分类: 叶菜 → 生鲜'),
      }),
    }))
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        oldCategory: '叶菜',
        newCategory: '生鲜',
      }),
    }))

    const rendered = renderTemplate('PRODUCT_CHANGED', {
      action: 'UPDATE',
      productName: '白菜',
      operatorName: '供应链专员',
      oldCategory: '叶菜',
      newCategory: '生鲜',
    })
    expect(rendered.textcard?.description).toContain('分类: 叶菜 → 生鲜')
  })

  it('returns immediately and contains a downstream rejection', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.notify.mockRejectedValue(new Error('test-only downstream failure'))

    expect(() => fireAndForgetNotifyProductChange(input)).not.toThrow()
    await vi.waitFor(() => {
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('fireAndForgetNotifyProductChange'),
        expect.any(Error),
      )
    })
  })
})
