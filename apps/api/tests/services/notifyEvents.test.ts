import { describe, expect, it } from 'vitest'
import { EVENTS, renderTemplate } from '../../src/services/notify/events'
import { bomTaskDishNames } from '../../src/routes/dailyBusinessImports'
import {
  isStoreEligibleForReminder, previousBizDate, shanghaiDateText,
} from '../../src/services/dailyReportReminder'

describe('notify events: 新增待办事件定义', () => {
  it('registers metadata for the four new events', () => {
    expect(EVENTS.USER_APPLICATION_PENDING).toMatchObject({
      defaultRoles: ['ADMIN', 'SUPER_ADMIN'], scopedBy: 'tenant', urgent: false,
    })
    expect(EVENTS.BOM_TASK_PENDING).toMatchObject({
      defaultRoles: ['CHEF_DIRECTOR'], scopedBy: 'tenant', urgent: false,
    })
    expect(EVENTS.COUNT_PENDING_CONFIRM).toMatchObject({
      defaultRoles: ['KITCHEN_LEAD', 'MANAGER'], scopedBy: 'store', urgent: false,
    })
    expect(EVENTS.DAILY_REPORT_MISSING).toMatchObject({
      defaultRoles: ['MANAGER', 'KITCHEN_LEAD'], scopedBy: 'store', urgent: false,
    })
  })

  it('renders USER_APPLICATION_PENDING card with applicant info', () => {
    const msg = renderTemplate('USER_APPLICATION_PENDING', {
      name: '张三', phone: '13800001111', roleLabel: '店长', storeName: '合肥瑶海店',
    })
    expect(msg.kind).toBe('textcard')
    expect(msg.textcard!.description).toContain('张三')
    expect(msg.textcard!.description).toContain('13800001111')
    expect(msg.textcard!.description).toContain('店长')
    expect(msg.textcard!.description).toContain('合肥瑶海店')
    expect(msg.textcard!.url).toContain('/v2/me/applications')
  })

  it('renders BOM_TASK_PENDING card with aggregated dish names', () => {
    const msg = renderTemplate('BOM_TASK_PENDING', {
      storeName: '合肥瑶海店', bizDate: '2026-07-21', count: 3, dishNames: '土豆牛腩、酸汤鱼(大份)、米饭',
    })
    expect(msg.textcard!.title).toContain('3')
    expect(msg.textcard!.description).toContain('合肥瑶海店')
    expect(msg.textcard!.description).toContain('2026-07-21')
    expect(msg.textcard!.description).toContain('酸汤鱼(大份)')
    expect(msg.textcard!.url).toContain('/v2/chef-director/bom')
  })

  it('renders COUNT_PENDING_CONFIRM card with store/no/submitter', () => {
    const msg = renderTemplate('COUNT_PENDING_CONFIRM', {
      countId: 'c1', no: 'PD202607-001', storeName: '合肥瑶海店', submittedByName: '李四', itemCount: 42,
    })
    expect(msg.textcard!.title).toContain('PD202607-001')
    expect(msg.textcard!.description).toContain('合肥瑶海店')
    expect(msg.textcard!.description).toContain('李四')
    expect(msg.textcard!.description).toContain('42')
    expect(msg.textcard!.url).toContain('/v2/inventory-counts/c1')
  })

  it('renders DAILY_REPORT_MISSING card with store and biz date', () => {
    const msg = renderTemplate('DAILY_REPORT_MISSING', { storeName: '合肥瑶海店', bizDate: '2026-07-21' })
    expect(msg.textcard!.title).toContain('2026-07-21')
    expect(msg.textcard!.description).toContain('合肥瑶海店')
    expect(msg.textcard!.url).toContain('/v2/manager/upload-platform')
  })
})

describe('bomTaskDishNames 聚合', () => {
  it('dedupes dishes and keeps spec suffix', () => {
    const names = bomTaskDishNames([
      { rawDishName: '酸汤鱼', spec: '大份' },
      { rawDishName: '酸汤鱼', spec: '大份' },
      { rawDishName: '酸汤鱼', spec: null },
      { rawDishName: '米饭', spec: null },
    ])
    expect(names).toBe('酸汤鱼(大份)、酸汤鱼、米饭')
  })

  it('truncates long lists with 等 N 项', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ rawDishName: `菜${i + 1}`, spec: null }))
    const names = bomTaskDishNames(rows)
    expect(names).toContain('菜1')
    expect(names).toContain('菜8')
    expect(names).not.toContain('菜9、')
    expect(names).toContain('等 12 项')
  })
})

describe('dailyReportReminder 判定逻辑', () => {
  it('only reminds ENABLED stores that are OPERATING or already reported once', () => {
    expect(isStoreEligibleForReminder({ status: 'DISABLED', lifecyclePhase: 'OPERATING' }, true)).toBe(false)
    expect(isStoreEligibleForReminder({ status: 'ENABLED', lifecyclePhase: 'OPERATING' }, false)).toBe(true)
    // 未开业门店 (如 DJ002 包河万达筹建期) 不提醒
    expect(isStoreEligibleForReminder({ status: 'ENABLED', lifecyclePhase: 'CONSTRUCTION' }, false)).toBe(false)
    expect(isStoreEligibleForReminder({ status: 'ENABLED', lifecyclePhase: 'PLANNING' }, false)).toBe(false)
    // 试营业但从未传过日报 → 不催; 传过一次 → 视为已运行, 要催
    expect(isStoreEligibleForReminder({ status: 'ENABLED', lifecyclePhase: 'TRIAL' }, false)).toBe(false)
    expect(isStoreEligibleForReminder({ status: 'ENABLED', lifecyclePhase: 'TRIAL' }, true)).toBe(true)
  })

  it('computes the previous business day in Asia/Shanghai regardless of server tz', () => {
    // UTC 2026-07-22 02:00 = 上海 10:00 → 前一营业日 07-21
    expect(previousBizDate(new Date('2026-07-22T02:00:00.000Z'))).toBe('2026-07-21')
    // UTC 2026-07-21 16:30 = 上海 07-22 00:30 → 前一营业日仍是 07-21
    expect(previousBizDate(new Date('2026-07-21T16:30:00.000Z'))).toBe('2026-07-21')
    // UTC 2026-07-21 15:30 = 上海 07-21 23:30 → 前一营业日 07-20
    expect(previousBizDate(new Date('2026-07-21T15:30:00.000Z'))).toBe('2026-07-20')
    expect(shanghaiDateText(new Date('2026-07-21T16:30:00.000Z'))).toBe('2026-07-22')
  })
})
