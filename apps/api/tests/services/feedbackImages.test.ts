import { describe, expect, it, vi } from 'vitest'
import { fetchFeedbackImageParts } from '../../src/services/feedbackImages'

/** 非 OSS 域名 URL: resignOssUrlForAI 原样返回, 方便 mock fetch 断言 */
const imgUrl = (n: number) => `https://cdn.example.com/fb/${n}.png`

function imgResponse(bytes: number[] = [1, 2, 3], mime = 'image/png') {
  return {
    ok: true, status: 200,
    headers: new Map([['content-type', mime]]),
    arrayBuffer: async () => new Uint8Array(bytes).buffer,
  } as any
}

describe('fetchFeedbackImageParts', () => {
  it('空/非数组附件 → 空 parts', async () => {
    expect(await fetchFeedbackImageParts(undefined)).toEqual([])
    expect(await fetchFeedbackImageParts(null)).toEqual([])
    expect(await fetchFeedbackImageParts([])).toEqual([])
    expect(await fetchFeedbackImageParts('not-array')).toEqual([])
  })

  it('图片转 base64 data URI part, content-type 取响应头', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(imgResponse([104, 105])) // "hi"
    const parts = await fetchFeedbackImageParts([imgUrl(1)], { fetchImpl })
    expect(parts).toHaveLength(1)
    expect(parts[0].type).toBe('image_url')
    if (parts[0].type === 'image_url') {
      expect(parts[0].image_url.url).toBe(`data:image/png;base64,${Buffer.from('hi').toString('base64')}`)
    }
    expect((fetchImpl.mock.calls[0] as any)[0]).toBe(imgUrl(1))
  })

  it('http 失败 / 非图片 content-type / 空 body → 静默跳过', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 403 } as any)
      .mockResolvedValueOnce(imgResponse([1], 'video/mp4'))
      .mockResolvedValueOnce(imgResponse([]))
    const parts = await fetchFeedbackImageParts([imgUrl(1), imgUrl(2), imgUrl(3)], { fetchImpl })
    expect(parts).toEqual([])
  })

  it('单张抛异常不拖垮其他图', async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(imgResponse([1, 2, 3]))
    const parts = await fetchFeedbackImageParts([imgUrl(1), imgUrl(2)], { fetchImpl })
    expect(parts).toHaveLength(1)
  })

  it('最多取 6 张, 非 http 项被过滤', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(imgResponse([1]))
    const urls = ['notaurl', ...Array.from({ length: 9 }, (_, i) => imgUrl(i))]
    const parts = await fetchFeedbackImageParts(urls, { fetchImpl })
    expect(parts).toHaveLength(6)
    expect(fetchImpl).toHaveBeenCalledTimes(6)
  })

  it('超尺寸图片跳过 (>2MB)', async () => {
    const big = new Uint8Array(2 * 1024 * 1024 + 1)
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      headers: new Map([['content-type', 'image/jpeg']]),
      arrayBuffer: async () => big.buffer,
    } as any)
    const parts = await fetchFeedbackImageParts([imgUrl(1)], { fetchImpl })
    expect(parts).toEqual([])
  })
})
