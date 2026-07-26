import { describe, expect, it } from 'vitest'
import { decideTriageAction, parseTriageBlock } from '../../src/services/feedbackTriage'
import { EVENTS, renderTemplate } from '../../src/services/notify/events'

describe('parseTriageBlock: triage 标记解析', () => {
  it('解析正常回复末尾的 triage 块并 strip', () => {
    const raw = '明白了，下单按钮点不动确实是阻断问题，我马上帮你上报。\n```json\n{"triage":{"category":"BUG_BLOCKING","title":"无法提交订单","summary":"门店点击提交订单无反应","sufficient":true}}\n```'
    const { clean, triage } = parseTriageBlock(raw)
    expect(triage).toMatchObject({ category: 'BUG_BLOCKING', title: '无法提交订单', sufficient: true })
    expect(clean).toBe('明白了，下单按钮点不动确实是阻断问题，我马上帮你上报。')
    expect(clean).not.toContain('```')
  })

  it('解析 NEW_FEATURE 的 proposal 结构', () => {
    const raw = '好的，我整理好了。\n```json\n{"triage":{"category":"NEW_FEATURE","title":"图片放大查看","summary":"验收照片希望可放大","proposal":{"scenario":"验收时看细节","expectation":"点击图片全屏放大","estimatedDays":"2"},"sufficient":true}}\n```'
    const { triage } = parseTriageBlock(raw)
    expect(triage?.proposal).toMatchObject({ scenario: '验收时看细节', expectation: '点击图片全屏放大' })
  })

  it('triage 块后面还有多余文本也能解析', () => {
    const raw = '已记录。\n```json\n{"triage":{"category":"QUESTION","title":"如何改价","summary":"问怎么改供应商报价","sufficient":true}}\n```\n还有其他问题随时问我。'
    const { clean, triage } = parseTriageBlock(raw)
    expect(triage?.category).toBe('QUESTION')
    expect(clean).toContain('已记录。')
    expect(clean).toContain('还有其他问题随时问我。')
    expect(clean).not.toContain('```')
  })

  it('残缺 JSON 的 triage 块: 剥掉但不分诊', () => {
    const raw = '我再确认一下。\n```json\n{"triage":{"category":"BUG_BLOCKING","title":'
    const { clean, triage } = parseTriageBlock(raw)
    expect(triage).toBeNull()
    expect(clean).toBe('我再确认一下。')
  })

  it('sufficient=false 视为未分诊, 但仍剥掉标记', () => {
    const raw = '还需要补充。\n```json\n{"triage":{"category":"IMPROVEMENT","sufficient":false}}\n```'
    const { clean, triage } = parseTriageBlock(raw)
    expect(triage).toBeNull()
    expect(clean).toBe('还需要补充。')
  })

  it('非法 category 不分诊', () => {
    const raw = '好的。\n```json\n{"triage":{"category":"SOMETHING_ELSE","sufficient":true}}\n```'
    expect(parseTriageBlock(raw).triage).toBeNull()
  })

  it('普通代码块 (不含 triage) 保留原文', () => {
    const raw = '步骤如下:\n```\n1. 打开订单页\n2. 点提交\n```'
    const { clean, triage } = parseTriageBlock(raw)
    expect(triage).toBeNull()
    expect(clean).toContain('1. 打开订单页')
  })

  it('没有标记块时原文返回', () => {
    const raw = '请问是在哪个页面遇到的？大概几点钟？'
    const { clean, triage } = parseTriageBlock(raw)
    expect(triage).toBeNull()
    expect(clean).toBe(raw)
  })

  it('空输入容错', () => {
    expect(parseTriageBlock('')).toEqual({ clean: '', triage: null })
    expect(parseTriageBlock(null as any)).toEqual({ clean: '', triage: null })
  })
})

describe('decideTriageAction: 分诊路由决策', () => {
  it('BUG_BLOCKING → 保持 CLARIFYING + 紧急企微通知 (P0 人工处理, 不进审批流)', () => {
    const action = decideTriageAction({ category: 'BUG_BLOCKING', sufficient: true })
    expect(action.status).toBe('CLARIFYING')
    expect(action.notifyEvent).toBe('FEEDBACK_URGENT_BUG')
    expect(action.systemNote).toBeTruthy()
  })

  it('IMPROVEMENT → AWAITING_APPROVAL + 审批卡片', () => {
    const action = decideTriageAction({ category: 'IMPROVEMENT', sufficient: true })
    expect(action.status).toBe('AWAITING_APPROVAL')
    expect(action.notifyEvent).toBe('FEEDBACK_APPROVAL_PENDING')
  })

  it('NEW_FEATURE → AWAITING_APPROVAL + 审批卡片 (同一事件, payload 区分)', () => {
    const action = decideTriageAction({ category: 'NEW_FEATURE', sufficient: true })
    expect(action.status).toBe('AWAITING_APPROVAL')
    expect(action.notifyEvent).toBe('FEEDBACK_APPROVAL_PENDING')
  })

  it('QUESTION → CLOSED 闭环, 不发通知', () => {
    const action = decideTriageAction({ category: 'QUESTION', sufficient: true })
    expect(action.status).toBe('CLOSED')
    expect(action.notifyEvent).toBeNull()
  })
})

describe('notify events: 反馈系统事件定义', () => {
  it('FEEDBACK_APPROVAL_PENDING → SUPER_ADMIN tenant scope 非紧急', () => {
    expect(EVENTS.FEEDBACK_APPROVAL_PENDING).toMatchObject({
      defaultRoles: ['SUPER_ADMIN'], scopedBy: 'tenant', urgent: false,
    })
  })

  it('FEEDBACK_URGENT_BUG → SUPER_ADMIN+ADMIN 紧急', () => {
    expect(EVENTS.FEEDBACK_URGENT_BUG).toMatchObject({
      defaultRoles: ['SUPER_ADMIN', 'ADMIN'], scopedBy: 'tenant', urgent: true,
    })
  })

  it('审批卡片指向 /v2/boss/feedback/[id] 且区分改进/新需求文案', () => {
    const improvement = renderTemplate('FEEDBACK_APPROVAL_PENDING', {
      feedbackId: 'fb1', category: 'IMPROVEMENT', title: '图片放大', summary: '验收图看不清', reporterName: '张三',
    })
    expect(improvement.kind).toBe('textcard')
    expect(improvement.textcard!.url).toBe('https://www.njdianjie.com/v2/boss/feedback/fb1')
    expect(improvement.textcard!.title).toContain('体验改进')
    expect(improvement.textcard!.description).toContain('张三')

    const feature = renderTemplate('FEEDBACK_APPROVAL_PENDING', {
      feedbackId: 'fb2', category: 'NEW_FEATURE', title: '语音下单', summary: '想语音创建订单',
    })
    expect(feature.textcard!.title).toContain('新需求')
  })

  it('紧急 bug 卡片带 🚨 且指向审批详情页', () => {
    const msg = renderTemplate('FEEDBACK_URGENT_BUG', {
      feedbackId: 'fb3', title: '无法下单', summary: '提交按钮点了没反应', reporterName: '李四', storeName: '瑶海店',
    })
    expect(msg.textcard!.title).toContain('🚨')
    expect(msg.textcard!.description).toContain('瑶海店')
    expect(msg.textcard!.url).toContain('/v2/boss/feedback/fb3')
  })
})
