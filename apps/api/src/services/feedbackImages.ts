/**
 * 反馈附件图片 → Qwen 多模态 content parts
 *
 * 背景: 反馈附件存在 OSS, DB 里是签名已过期的 URL; Qwen 端点无法稳定下载外链
 * (实测 "Failed to download multimodal content"), 所以服务器端取图转 base64 data URI。
 * 取图走 resignOssUrlForAI (OSS 图片处理: 缩到 1024/jpg/q75), 单张 ~100KB。
 * 任何一张失败只跳过, 不影响整轮对话。
 */
import type { QwenContentPart } from './qwenChat'
import { resignOssUrlForAI } from '../routes/upload'

const MAX_IMAGES = 6
const MAX_BYTES_PER_IMAGE = 2 * 1024 * 1024
const FETCH_TIMEOUT_MS = 15_000

export interface FetchImagePartsOptions {
  fetchImpl?: typeof fetch
}

async function fetchOneAsDataUri(url: string, fetchImpl: typeof fetch): Promise<QwenContentPart | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetchImpl(url, { signal: controller.signal })
    if (!res.ok) return null
    const mime = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim()
    if (!mime.startsWith('image/')) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (!buf.length || buf.length > MAX_BYTES_PER_IMAGE) return null
    return { type: 'image_url', image_url: { url: `data:${mime};base64,${buf.toString('base64')}` } }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 把反馈附件 URL 列表转成 image_url parts (最多 6 张, 失败静默跳过)。
 * attachments 是 DB 里存的原始 (可能过期签名) URL 数组。
 */
export async function fetchFeedbackImageParts(
  attachments: unknown,
  opts: FetchImagePartsOptions = {},
): Promise<QwenContentPart[]> {
  if (!Array.isArray(attachments) || !attachments.length) return []
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis)
  const urls = attachments.filter((u): u is string => typeof u === 'string' && u.startsWith('http')).slice(0, MAX_IMAGES)
  const results = await Promise.all(urls.map((u) => fetchOneAsDataUri(resignOssUrlForAI(u), fetchImpl)))
  return results.filter((p): p is QwenContentPart => p !== null)
}
