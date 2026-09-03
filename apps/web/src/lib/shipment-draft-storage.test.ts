import { describe, expect, it } from 'vitest'
import {
  clearShipmentDraft,
  readShipmentDraft,
  shipmentDraftStorageKey,
  writeShipmentDraft,
} from './shipment-draft-storage'

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  }
}

describe('confirmed shipment draft storage', () => {
  it('scopes drafts by tenant, user, and order and restores a matching row version', () => {
    const storage = memoryStorage()
    const key = shipmentDraftStorageKey({ tenantId: 'tenant-a', userId: 'user-a', orderId: 'order-a' })
    expect(key).toBe('dianjie:v2:shipment-draft:tenant-a:user-a:order-a')
    const draft = {
      version: 1 as const,
      orderId: 'order-a', orderRowVersion: 3, userId: 'user-a',
      quantities: { 'item-a': 2.5 }, updatedAt: '2026-09-03T00:00:00.000Z',
    }
    writeShipmentDraft(storage, key, draft)
    expect(readShipmentDraft(storage, key, {
      orderId: 'order-a', orderRowVersion: 3, userId: 'user-a', itemIds: ['item-a'],
    })).toEqual(draft)
  })

  it('fails closed and removes stale, cross-user, or unknown-item drafts', () => {
    const storage = memoryStorage()
    const key = 'draft'
    writeShipmentDraft(storage, key, {
      version: 1, orderId: 'order-a', orderRowVersion: 2, userId: 'user-a',
      quantities: { 'item-a': 1 }, updatedAt: '2026-09-03T00:00:00.000Z',
    })
    expect(readShipmentDraft(storage, key, {
      orderId: 'order-a', orderRowVersion: 3, userId: 'user-a', itemIds: ['item-a'],
    })).toBeNull()
    expect(storage.getItem(key)).toBeNull()

    writeShipmentDraft(storage, key, {
      version: 1, orderId: 'order-a', orderRowVersion: 3, userId: 'user-a',
      quantities: { 'unknown-item': 1 }, updatedAt: '2026-09-03T00:00:00.000Z',
    })
    expect(readShipmentDraft(storage, key, {
      orderId: 'order-a', orderRowVersion: 3, userId: 'user-b', itemIds: ['item-a'],
    })).toBeNull()
    clearShipmentDraft(storage, key)
    expect(storage.getItem(key)).toBeNull()
  })

  it('fails closed when browser storage read or cleanup is blocked', () => {
    const readBlocked = {
      getItem: () => { throw new DOMException('blocked', 'SecurityError') },
      setItem: () => undefined,
      removeItem: () => { throw new DOMException('blocked', 'SecurityError') },
    }
    expect(() => readShipmentDraft(readBlocked, 'draft', {
      orderId: 'order-a', orderRowVersion: 1, userId: 'user-a', itemIds: ['item-a'],
    })).not.toThrow()
    expect(readShipmentDraft(readBlocked, 'draft', {
      orderId: 'order-a', orderRowVersion: 1, userId: 'user-a', itemIds: ['item-a'],
    })).toBeNull()
    expect(() => clearShipmentDraft(readBlocked, 'draft')).not.toThrow()

    const cleanupBlocked = {
      getItem: () => '{broken json',
      setItem: () => undefined,
      removeItem: () => { throw new DOMException('blocked', 'SecurityError') },
    }
    expect(() => readShipmentDraft(cleanupBlocked, 'draft', {
      orderId: 'order-a', orderRowVersion: 1, userId: 'user-a', itemIds: ['item-a'],
    })).not.toThrow()
  })

  it('rejects quantities beyond the order maximum or two-decimal precision', () => {
    const storage = memoryStorage()
    const key = 'draft'
    for (const quantity of [100_000_000, 1.001]) {
      writeShipmentDraft(storage, key, {
        version: 1, orderId: 'order-a', orderRowVersion: 1, userId: 'user-a',
        quantities: { 'item-a': quantity }, updatedAt: '2026-09-03T00:00:00.000Z',
      })
      expect(readShipmentDraft(storage, key, {
        orderId: 'order-a', orderRowVersion: 1, userId: 'user-a', itemIds: ['item-a'],
      })).toBeNull()
    }
  })
})
