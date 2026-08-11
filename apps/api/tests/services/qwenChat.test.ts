import { describe, expect, it, vi } from 'vitest'
import {
  QWEN_BUSY_FALLBACK, QWEN_NOT_CONFIGURED, buildFeedbackSystemPrompt, qwenChat,
} from '../../src/services/qwenChat'

const KEY = 'unit-test-placeholder-key'

function okResponse(content: string) {
  return {
    ok: true, status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
  } as any
}

describe('qwenChat (mock fetch)', () => {
  it('正常返回 assistant 内容', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse('你好，请问在哪个页面遇到的？'))
    const out = await qwenChat([{ role: 'user', content: '下单不了' }], { apiKey: KEY, fetchImpl })
    expect(out).toBe('你好，请问在哪个页面遇到的？')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as any
    expect(url).toContain('/chat/completions')
    expect(init.headers.Authorization).toBe(`Bearer ${KEY}`)
    const body = JSON.parse(init.body)
    expect(body.model).toBeTruthy()
    expect(body.messages[0].content).toBe('下单不了')
  })

  it('返回含 triage 块时原样返回 (由 feedbackTriage 解析)', async () => {
    const content = '已整理。\n```json\n{"triage":{"category":"QUESTION","sufficient":true}}\n```'
    const fetchImpl = vi.fn().mockResolvedValue(okResponse(content))
    const out = await qwenChat([{ role: 'user', content: '怎么改价' }], { apiKey: KEY, fetchImpl })
    expect(out).toContain('triage')
  })

  it('apiKey 缺失 → 优雅降级文案, 不发请求', async () => {
    const fetchImpl = vi.fn()
    const out = await qwenChat([{ role: 'user', content: 'x' }], { apiKey: '', fetchImpl })
    expect(out).toBe(QWEN_NOT_CONFIGURED)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('500 重试 1 次后成功', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500 } as any)
      .mockResolvedValueOnce(okResponse('重试成功'))
    const out = await qwenChat([{ role: 'user', content: 'x' }], { apiKey: KEY, fetchImpl })
    expect(out).toBe('重试成功')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('连续 500 → 兜底文案', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 502 } as any)
    const out = await qwenChat([{ role: 'user', content: 'x' }], { apiKey: KEY, fetchImpl })
    expect(out).toBe(QWEN_BUSY_FALLBACK)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('延迟敏感调用可限制为单次尝试', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 502 } as any)
    const out = await qwenChat([{ role: 'user', content: 'x' }], {
      apiKey: KEY,
      fetchImpl,
      maxAttempts: 1,
    })
    expect(out).toBe(QWEN_BUSY_FALLBACK)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('4xx 不重试直接兜底', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401 } as any)
    const out = await qwenChat([{ role: 'user', content: 'x' }], { apiKey: KEY, fetchImpl })
    expect(out).toBe(QWEN_BUSY_FALLBACK)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('超时 (abort) 重试后兜底', async () => {
    const fetchImpl = vi.fn().mockImplementation((_url: string, init: any) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')))
      }))
    const out = await qwenChat([{ role: 'user', content: 'x' }], { apiKey: KEY, fetchImpl, timeoutMs: 30 })
    expect(out).toBe(QWEN_BUSY_FALLBACK)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('坏响应结构重试后兜底', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) } as any)
    const out = await qwenChat([{ role: 'user', content: 'x' }], { apiKey: KEY, fetchImpl })
    expect(out).toBe(QWEN_BUSY_FALLBACK)
  })

  it('多模态 content parts 原样序列化进请求体', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse('看到图了'))
    const parts = [
      { type: 'text', text: '这张图什么问题' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } },
    ]
    const out = await qwenChat([{ role: 'user', content: parts as any }], { apiKey: KEY, fetchImpl })
    expect(out).toBe('看到图了')
    const body = JSON.parse((fetchImpl.mock.calls[0] as any)[1].body)
    expect(body.messages[0].content).toHaveLength(2)
    expect(body.messages[0].content[1].type).toBe('image_url')
    expect(body.messages[0].content[1].image_url.url).toContain('data:image/png;base64,')
  })
})

describe('buildFeedbackSystemPrompt', () => {
  it('包含已知上下文 (页面/角色/门店), 并要求不重复问', () => {
    const prompt = buildFeedbackSystemPrompt({
      path: '/v2/chef/purchase', role: 'KITCHEN_LEAD', storeName: '瑶海店', clientTime: '2026-07-26 10:00',
    })
    expect(prompt).toContain('/v2/chef/purchase')
    expect(prompt).toContain('KITCHEN_LEAD')
    expect(prompt).toContain('瑶海店')
    expect(prompt).toContain('不要再问')
    expect(prompt).toContain('BUG_BLOCKING')
    expect(prompt).toContain('IMPROVEMENT')
    expect(prompt).toContain('NEW_FEATURE')
    expect(prompt).toContain('QUESTION')
    expect(prompt).toContain('triage')
  })

  it('无上下文时也能生成', () => {
    const prompt = buildFeedbackSystemPrompt({})
    expect(prompt).toContain('反馈助手')
  })

  it('有附件时告知 AI 能看图且禁止再索要截图', () => {
    const prompt = buildFeedbackSystemPrompt({ attachmentCount: 2 })
    expect(prompt).toContain('2 张截图')
    expect(prompt).toContain('你能直接看到图片内容')
    expect(prompt).toContain('不要再向用户索要截图')
  })

  it('无附件时禁止索要截图, 改为请用户文字描述', () => {
    const prompt = buildFeedbackSystemPrompt({})
    expect(prompt).toContain('无法补传图片')
    expect(prompt).toContain('不要要求用户发截图')
    expect(prompt).toContain('文字描述')
  })
})
