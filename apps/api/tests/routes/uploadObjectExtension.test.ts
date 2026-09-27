import { describe, expect, it } from 'vitest'
import { canReadWarehouseDocument, canUploadWarehouseDocument, objectExtensionForMime } from '../../src/routes/upload'

describe('upload object extension', () => {
  it.each([
    ['image/jpeg', '.jpg'],
    ['image/png', '.png'],
    ['image/webp', '.webp'],
    ['image/gif', '.gif'],
    ['video/mp4', '.mp4'],
    ['video/quicktime', '.mov'],
    ['video/webm', '.webm'],
    ['video/x-m4v', '.m4v'],
    ['video/3gpp', '.3gp'],
    ['application/pdf', '.pdf'],
  ])('derives %s objects from the validated MIME type', (mime, extension) => {
    expect(objectExtensionForMime(mime)).toBe(extension)
  })

  it('never preserves an unrecognized user-controlled extension', () => {
    expect(objectExtensionForMime('text/html')).toBe('.bin')
  })
})

describe('warehouse document upload role boundary', () => {
  it.each(['SUPER_ADMIN', 'ADMIN', 'PURCHASER', 'SUPPLY_CHAIN'])('allows %s', role => {
    expect(canUploadWarehouseDocument(role)).toBe(true)
  })

  it.each(['FINANCE', 'MANAGER', 'CHEF', 'SUPPLIER_OWNER', 'SUPPLIER_STAFF', '', undefined])('rejects %s', role => {
    expect(canUploadWarehouseDocument(role)).toBe(false)
  })
})

describe('warehouse document signed-url read boundary', () => {
  it.each(['SUPER_ADMIN', 'ADMIN', 'FINANCE', 'PURCHASER', 'SUPPLY_CHAIN'])('allows %s', role => {
    expect(canReadWarehouseDocument(role)).toBe(true)
  })

  it.each(['MANAGER', 'CHEF', 'SUPPLIER_OWNER', 'SUPPLIER_STAFF', '', undefined])('rejects %s', role => {
    expect(canReadWarehouseDocument(role)).toBe(false)
  })
})
