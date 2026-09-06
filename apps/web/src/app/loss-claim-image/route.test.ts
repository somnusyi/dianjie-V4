import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from './route'

const source = readFileSync(new URL('./route.ts', import.meta.url), 'utf8')

describe('loss claim evidence image endpoint', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('only accepts HTTPS images from explicit hosts and paths', () => {
    expect(source).toContain("sourceUrl.protocol !== 'https:'")
    expect(source).toContain("'dianjie-upload.oss-cn-hangzhou.aliyuncs.com'")
    expect(source).toContain("url.pathname.startsWith('/loss-claims/')")
    expect(source).toContain('ALLOWED_IMAGE_HOSTS.has(sourceUrl.hostname)')
  })

  it('rejects redirects, non-images, and files above the upload limit', () => {
    expect(source).toContain("redirect: 'manual'")
    expect(source).toContain("contentType.startsWith('image/')")
    expect(source).toContain('bytes.byteLength > MAX_IMAGE_BYTES')
  })

  it('returns an allowed image through the same origin', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'Content-Type': 'image/jpeg', 'Content-Length': '3' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const sourceUrl = 'https://dianjie-upload.oss-cn-hangzhou.aliyuncs.com/loss-claims/tenant/proof.jpg'
    const response = await GET(new NextRequest(`http://localhost/loss-claim-image?url=${encodeURIComponent(sourceUrl)}`))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/jpeg')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
    expect(fetchMock).toHaveBeenCalledWith(expect.any(URL), { cache: 'no-store', redirect: 'manual' })
  })

  it('rejects a different host without fetching it', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const response = await GET(new NextRequest(
      `http://localhost/loss-claim-image?url=${encodeURIComponent('https://example.com/loss-claims/proof.jpg')}`,
    ))

    expect(response.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not follow an upstream redirect', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 302 })))
    const sourceUrl = 'https://dianjie-upload.oss-cn-hangzhou.aliyuncs.com/loss-claims/tenant/proof.jpg'
    const response = await GET(new NextRequest(`http://localhost/loss-claim-image?url=${encodeURIComponent(sourceUrl)}`))

    expect(response.status).toBe(502)
  })
})
