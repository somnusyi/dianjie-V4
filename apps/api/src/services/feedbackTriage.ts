/**
 * 反馈 AI 分诊: 解析 Qwen 回复末尾的 triage 标记块 + 分类 → 状态/通知决策
 *
 * Qwen 在信息足够时会在回复末尾输出:
 *   ```json
 *   {"triage":{"category":"...","title":"...","summary":"...","proposal":{...},"sufficient":true}}
 *   ```
 * 服务端解析后把标记块 strip 掉, 不展示给用户。
 */
import { z } from 'zod'

export const FEEDBACK_CATEGORIES = ['BUG_BLOCKING', 'IMPROVEMENT', 'NEW_FEATURE', 'QUESTION'] as const
export type FeedbackCategoryKey = (typeof FEEDBACK_CATEGORIES)[number]

const triageSchema = z.object({
  category: z.enum(FEEDBACK_CATEGORIES),
  title: z.string().trim().min(1).max(80).optional(),
  summary: z.string().trim().min(1).max(1000).optional(),
  proposal: z.object({
    scenario: z.string().trim().max(500).optional(),
    expectation: z.string().trim().max(500).optional(),
    estimatedDays: z.union([z.string().trim().max(40), z.number()]).optional(),
  }).passthrough().optional(),
  sufficient: z.literal(true),
}).passthrough()

export type TriageResult = z.infer<typeof triageSchema>

export interface ParsedAssistantReply {
  /** 剥掉 triage 标记块后的干净文本 (展示给用户) */
  clean: string
  /** 解析成功且 sufficient=true 时分诊结果; 否则 null */
  triage: TriageResult | null
}

/**
 * 容错解析 AI 回复:
 * - 正常: 末尾 ```json fence 内含 triage → 剥掉 + 返回 triage
 * - fence 内 JSON 残缺 / 多余文字 → 剥掉含 "triage" 的 fence, triage=null (不把半成品展示给用户)
 * - 没有 fence → 原文返回
 */
export function parseTriageBlock(raw: string): ParsedAssistantReply {
  if (!raw || typeof raw !== 'string') return { clean: '', triage: null }

  const fenceRe = /```(?:json)?\s*\n?([\s\S]*?)```/g
  let triage: TriageResult | null = null
  const spans: Array<[number, number]> = []

  for (const match of raw.matchAll(fenceRe)) {
    const body = match[1] ?? ''
    const start = match.index ?? 0
    const end = start + match[0].length
    if (!body.includes('triage')) continue
    // 这个 fence 是想当 triage 标记块的, 无论解析成败都要剥掉
    spans.push([start, end])
    if (triage) continue // 只取第一个有效 triage
    try {
      const obj = JSON.parse(body.trim())
      const parsed = triageSchema.safeParse(obj?.triage)
      if (parsed.success) triage = parsed.data
    } catch {
      // 残缺 JSON → triage 保持 null
    }
  }

  let clean = raw
  // 从后往前删, 保持 index 有效
  for (const [start, end] of spans.reverse()) {
    clean = clean.slice(0, start) + clean.slice(end)
  }
  // 未闭合的 fence (AI 输出被截断): 含 triage 关键字 → 从 fence 起点截掉
  const openFence = clean.lastIndexOf('```')
  if (openFence >= 0 && clean.slice(openFence).includes('triage')) {
    clean = clean.slice(0, openFence)
  }
  return { clean: clean.trim(), triage }
}

export interface TriageAction {
  /** 分诊后反馈应进入的状态 */
  status: 'CLARIFYING' | 'AWAITING_APPROVAL' | 'CLOSED'
  /** 企微通知事件 (fireAndForget), 无则 null */
  notifyEvent: 'FEEDBACK_URGENT_BUG' | 'FEEDBACK_APPROVAL_PENDING' | null
  /** 追加一条 system 消息, 让提报人在对话里看到进度 */
  systemNote: string | null
}

/**
 * 分诊 → 状态流转 + 通知决策 (纯函数, 路由负责落库/发通知)
 * - BUG_BLOCKING: P0 只发紧急企微通知人工处理, 不进审批流, 状态保持 CLARIFYING (人工跟进)
 * - IMPROVEMENT / NEW_FEATURE: → AWAITING_APPROVAL, 推审批卡片
 * - QUESTION: AI 已直接回答 → CLOSED 闭环
 */
export function decideTriageAction(triage: TriageResult): TriageAction {
  switch (triage.category) {
    case 'BUG_BLOCKING':
      return {
        status: 'CLARIFYING',
        notifyEvent: 'FEEDBACK_URGENT_BUG',
        systemNote: '该问题已标记为紧急故障并通知管理员，会尽快人工处理，请留意消息中心进展。',
      }
    case 'IMPROVEMENT':
      return {
        status: 'AWAITING_APPROVAL',
        notifyEvent: 'FEEDBACK_APPROVAL_PENDING',
        systemNote: '已为你整理好改进方案并提交给管理员审批，审批结果会在消息中心通知你。',
      }
    case 'NEW_FEATURE':
      return {
        status: 'AWAITING_APPROVAL',
        notifyEvent: 'FEEDBACK_APPROVAL_PENDING',
        systemNote: '已为你整理好需求方案并提交给管理员审批，审批结果会在消息中心通知你。',
      }
    case 'QUESTION':
      return {
        status: 'CLOSED',
        notifyEvent: null,
        systemNote: null,
      }
  }
}
