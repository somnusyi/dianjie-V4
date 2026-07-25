import { describe, expect, it } from 'vitest'
import { objectExtensionForMime } from '../../src/routes/upload'

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
