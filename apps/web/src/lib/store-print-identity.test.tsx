import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { DeliveryNotePaper } from '@/components/v2/delivery-note-paper'
import { storePrintIdentity } from './store-print-identity'

describe('store names on printed documents', () => {
  it('keeps the receiver name and separates the confirmed brand, branch and store number', () => {
    expect(storePrintIdentity({
      no: 'DJ027',
      name: '澜苍谣·宜良烤麻鸭·云傣菜(南京金陵天地店)',
      brandCode: 'LANCANGYAO',
    })).toEqual({
      brand: '澜苍谣', branch: '南京金陵天地店', no: 'DJ027',
      fullName: '澜苍谣·宜良烤麻鸭·云傣菜(南京金陵天地店)',
    })
    expect(storePrintIdentity({ no: 'DJ012', name: '滇界·云南野鲜菌火锅(南京卡子门店)', brandCode: 'DIANJIE' }).branch).toBe('南京卡子门店')
    expect(storePrintIdentity({ no: 'DJ024', name: '滇界·云南山珍菌汤锅(浙江绍兴境湖龙湖店)', brandCode: 'DIANJIE' })).toMatchObject({ brand: '滇界', branch: '浙江绍兴境湖龙湖店' })
    expect(storePrintIdentity({ name: '尚未确认的门店' }).brand).toBe('未确认')
  })

  it('renders each delivery note with its own receiver and separate store fields', () => {
    const html = renderToStaticMarkup(<DeliveryNotePaper printedAt={new Date('2026-11-24T00:00:00Z')} order={{
      no: 'DO-1', createdAt: '2026-11-24T00:00:00Z', expectedDate: '2026-11-25T00:00:00Z', shippedAt: null,
      note: null, shippedNote: null, createdBy: { name: '店长' }, supplier: { name: '统一供应商' },
      store: { no: 'DJ025', name: '澜苍谣·宜良烤麻鸭·云傣菜(南京城北万象店)', brandCode: 'LANCANGYAO' },
      items: [],
    }} />)
    expect(html).toContain('统一供应商')
    expect(html).toContain('收货方：澜苍谣·宜良烤麻鸭·云傣菜(南京城北万象店)')
    expect(html).toContain('品牌：澜苍谣 · 门店：南京城北万象店')
    expect(html).toContain('门店编号：DJ025')
    expect(html).not.toContain('品牌：滇界')
  })
})
