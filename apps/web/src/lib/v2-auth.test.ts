import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiDownload, apiFetch, pcRouteForRole, routeForRole } from './v2-auth'

describe('supply-chain role routes', () => {
  it('uses the dedicated read-only landing instead of supplier or manager portals', () => {
    expect(routeForRole('SUPPLY_CHAIN')).toBe('/v2/supply-chain/home')
    expect(pcRouteForRole('SUPPLY_CHAIN')).toBe('/v2/supply-chain/home')
    expect(routeForRole('SUPPLY_CHAIN')).not.toBe('/v2/manager/home')
    expect(routeForRole('SUPPLY_CHAIN')).not.toBe('/v2/supplier/home')
  })
})

describe('apiFetch error messages', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('prefers the actionable Fastify message over the generic HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      statusCode: 409,
      error: 'Conflict',
      message: '收货单已有未结差异，请处理完成后再补报',
    }), { status: 409, headers: { 'Content-Type': 'application/json' } })))

    await expect(apiFetch('/api/example')).rejects.toThrow('收货单已有未结差异')
  })

  it('returns authenticated download content and decodes the server filename', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('a,b\r\n1,2', {
      status: 200,
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent('月度对账.csv')}`,
      },
    })))
    const result = await apiDownload('/api/export', 'fallback.csv')
    expect(result.filename).toBe('月度对账.csv')
    expect(await result.blob.text()).toContain('1,2')
  })
})
