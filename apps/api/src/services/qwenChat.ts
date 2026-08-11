/**
 * Qwen (OpenAI 兼容协议) 反馈 AI 对话服务
 *
 * - 直接 fetch `${QWEN_BASE_URL}/chat/completions`, model = QWEN_MODEL
 * - 可配置 AbortController 超时和尝试次数, 全部失败后返回兜底文案
 * - QWEN_API_KEY 缺失 → 优雅降级 (返回明确文案, 不抛错, 反馈仍落库)
 * - ⚠ 严禁把 key 写进代码 / 测试 / 文档, 只从 env 读
 */

/** OpenAI 兼容多模态消息段: 文本或图片 (base64 data URI / 可下载 URL) */
export type QwenContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface QwenChatMessage {
  role: 'system' | 'user' | 'assistant'
  /** 纯文本直接传 string; 带图消息传 content parts 数组 */
  content: string | QwenContentPart[]
}

export const QWEN_BUSY_FALLBACK = 'AI 助手暂时繁忙，你的反馈已记录，管理员会尽快处理'
export const QWEN_NOT_CONFIGURED = 'AI 助手暂未配置，你的反馈已记录，管理员会直接人工处理，无需重复提交'

const DEFAULT_BASE_URL = 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'
const DEFAULT_MODEL = 'qwen3.8-max-preview'
// qwen3.8-max-preview 强制思考模式, 真实 prompt 首响 30~60s; 默认 30s 会稳定撞线
const TIMEOUT_MS = Number(process.env.QWEN_TIMEOUT_MS) || 90_000

export interface QwenChatOptions {
  /** 测试注入用; 默认 globalThis.fetch */
  fetchImpl?: typeof fetch
  apiKey?: string
  baseUrl?: string
  model?: string
  timeoutMs?: number
  /** Maximum attempts for latency-sensitive callers. Defaults to the legacy 2 attempts. */
  maxAttempts?: number
}

/**
 * 调 Qwen chat completions. 永不抛错:
 *   - key 缺失 → QWEN_NOT_CONFIGURED
 *   - 超时/5xx/坏响应 (重试 1 次后) → QWEN_BUSY_FALLBACK
 */
export async function qwenChat(messages: QwenChatMessage[], opts: QwenChatOptions = {}): Promise<string> {
  const apiKey = opts.apiKey ?? process.env.QWEN_API_KEY
  if (!apiKey) return QWEN_NOT_CONFIGURED

  const baseUrl = (opts.baseUrl ?? process.env.QWEN_BASE_URL) || DEFAULT_BASE_URL
  const model = (opts.model ?? process.env.QWEN_MODEL) || DEFAULT_MODEL
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS
  const maxAttempts = Math.max(1, Math.min(2, Math.trunc(opts.maxAttempts ?? 2)))
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis)

  // 默认兼容旧行为: 失败后重试 1 次; 延迟敏感调用可设为单次尝试
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, messages, temperature: 0.3 }),
        signal: controller.signal,
      })
      if (!res.ok) {
        // 4xx (鉴权/参数) 重试无意义, 直接兜底; 5xx 重试一次
        if (res.status < 500) return QWEN_BUSY_FALLBACK
        continue
      }
      const data: any = await res.json()
      const content = data?.choices?.[0]?.message?.content
      if (typeof content === 'string' && content.trim()) return content.trim()
      // 坏结构也重试一次
    } catch {
      // 超时 / 网络错误 → 重试
    } finally {
      clearTimeout(timer)
    }
  }
  return QWEN_BUSY_FALLBACK
}

/** 反馈助手的 system prompt: 最少问题澄清到可处理粒度, 上下文不重复问 */
export function buildFeedbackSystemPrompt(context: {
  path?: string
  role?: string
  storeName?: string
  userAgent?: string
  clientTime?: string
  /** 本轮实际带入对话的截图张数 (已成功加载的附件图), 0 或无附件时不传 */
  attachmentCount?: number
}): string {
  const known: string[] = []
  if (context.path) known.push(`提交页面: ${context.path}`)
  if (context.role) known.push(`用户角色: ${context.role}`)
  if (context.storeName) known.push(`所在门店: ${context.storeName}`)
  if (context.clientTime) known.push(`提交时间: ${context.clientTime}`)

  const imageRule = context.attachmentCount
    ? `2. 用户随反馈附了 ${context.attachmentCount} 张截图, 你能直接看到图片内容。先仔细看图再结合文字分析, 不要再向用户索要截图。`
    : `2. 对话中用户无法补传图片, 所以不要要求用户发截图; 需要更多信息时, 请用户用文字描述出问题页面上的具体文字、按钮名称或数字。`

  return `你是「滇界」餐饮供应链系统的反馈助手。用户是门店店长、厨师长、供应商等非技术人员, 请用大白话交流, 不要技术黑话。

你的目标: 用最少的问题把反馈澄清到可处理粒度。
规则:
1. 已知上下文如下, 这些信息不要再问:
${known.length ? known.map(k => `   - ${k}`).join('\n') : '   (无)'}
${imageRule}
3. 一次最多问 2 个问题, 能不问就不问。
4. 分类判断:
   - 阻断正常业务 (如无法下单、无法验收、页面打不开) → BUG_BLOCKING
   - 对现有功能的体验改进 (如图片不能放大、按钮不明显) → IMPROVEMENT
   - 系统目前没有的能力 → NEW_FEATURE
   - 询问怎么操作 → QUESTION (直接给出操作步骤回答)
5. 信息足够分类和处理时, 在正常回复用户之后, 另起一行输出如下标记块 (用户看不到):
\`\`\`json
{"triage":{"category":"BUG_BLOCKING|IMPROVEMENT|NEW_FEATURE|QUESTION","title":"一句话标题","summary":"问题或方案摘要","proposal":{"scenario":"使用场景","expectation":"期望效果","estimatedDays":"初估人天"},"sufficient":true}}
\`\`\`
   proposal 只有 NEW_FEATURE 才需要填。信息不足时不要输出标记块, 继续提问澄清。`
}
