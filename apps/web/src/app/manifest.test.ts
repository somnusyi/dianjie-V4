import { describe, expect, it } from 'vitest'
import manifest from './manifest'

describe('web app manifest', () => {
  it('references only the checked-in application icon', () => {
    const value = manifest()

    expect(value.start_url).toBe('/')
    expect(value.display).toBe('standalone')
    expect(value.icons).toEqual([
      {
        src: '/icon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any',
      },
      {
        src: '/icon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'maskable',
      },
    ])
  })
})
