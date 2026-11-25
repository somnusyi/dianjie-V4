import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8')

describe('fulfillment todo filter UI contract', () => {
  it('keeps the four status counts as compact filter controls instead of KPI cards', () => {
    expect(source).toContain('aria-label="订单状态筛选"')
    expect(source).toContain('className="flex flex-wrap gap-2 py-4"')
    expect(source).toContain('rounded-cta border px-3 py-1.5 text-button')
    expect(source).not.toContain('sm:grid-cols-2 xl:grid-cols-4')
  })

  it('preserves all four status filters and their counts', () => {
    for (const label of ['全部待办', '待接单', '待发货', '待送达']) {
      expect(source).toContain(`label: '${label}'`)
    }
    expect(source).toContain('counts[item.value]')
    expect(source).toContain('replaceFilters(item.value, orderDay)')
  })
})
