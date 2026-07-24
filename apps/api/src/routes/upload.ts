import { FastifyInstance } from 'fastify'
import OSS from 'ali-oss'
import path from 'path'
import { z } from 'zod'

const uuidv4 = () => Math.random().toString(36).slice(2) + Date.now().toString(36)

const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
// 报损/争议场景: 短视频证据 (供应商客户要求加视频)
// iOS .mov = quicktime; Android 录视频常用 mp4 / 3gpp
const VIDEO_MIMES = ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v', 'video/3gpp']
const DOC_MIMES = ['application/pdf', ...IMAGE_MIMES]
const MEDIA_MIMES = [...IMAGE_MIMES, ...VIDEO_MIMES]

// 文件大小上限 (byte). image/pdf 10MB; video 50MB (2026-06 客户: 手机视频常 >30MB)
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_VIDEO_BYTES = 50 * 1024 * 1024

const ALLOWED_CATEGORY_VALUES = [
  'loss-claims', 'invoices', 'capital', 'documents',
  'reimbursements', 'misc', 'chef-ack', 'products', 'inventory-counts',
] as const
const ALLOWED_CATEGORIES = new Set<string>(ALLOWED_CATEGORY_VALUES)
const uploadQuerySchema = z.object({
  category: z.enum(ALLOWED_CATEGORY_VALUES).default('misc'),
}).strict()
const signedUrlQuerySchema = z.object({
  key: z.string().trim().min(1).max(1024),
  expires: z.string().regex(/^\d+$/).optional().default('3600')
    .transform(Number).refine(value => value >= 60 && value <= 86_400, 'expires 必须是 60 至 86400 的整数秒'),
}).strict()

function ossClient() {
  return new OSS({
    region: process.env.OSS_REGION || 'oss-cn-hangzhou',
    accessKeyId: process.env.OSS_ACCESS_KEY_ID!,
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET!,
    bucket: process.env.OSS_BUCKET || 'dianjie-upload',
    // secure: true → signatureUrl 返回 https://. 不设则默认 http://, 而站点是 https,
    // 浏览器按 mixed content 直接拦掉所有证据图/视频 (报损碎图根因, 2026-06)
    secure: true,
  })
}

/** 把已签名 URL 的 scheme 强制成 https (防御历史 http 残留 / SDK 兜底) */
function toHttps(url: string): string {
  return typeof url === 'string' ? url.replace(/^http:\/\//i, 'https://') : url
}

/**
 * 重新签名一个 OSS URL: 把存在 DB 里、签名已过期的 URL 换成 1h 有效的新 URL
 * 不是 OSS 域名的 URL(外链/CDN等)原样返回
 */
export function resignOssUrl(url: string | null | undefined): string {
  if (!url || typeof url !== 'string') return url as any
  try {
    const u = new URL(url)
    const bucket = process.env.OSS_BUCKET || 'dianjie-upload'
    if (!u.hostname.startsWith(bucket + '.') || !u.hostname.includes('.aliyuncs.com')) return url
    const key = decodeURIComponent(u.pathname.replace(/^\//, ''))
    if (!key) return url
    return toHttps(ossClient().signatureUrl(key, { expires: 3600 }))
  } catch {
    return url
  }
}

export function resignOssUrls(urls: any): string[] {
  if (!Array.isArray(urls)) return urls
  return urls.map((u) => resignOssUrl(u))
}

/** 用持久化对象 key 生成短期可访问 URL；数据库不保存会过期的签名 URL。 */
export function signOssKey(key: string | null | undefined): string | null {
  if (!key) return null
  try {
    return toHttps(ossClient().signatureUrl(key, { expires: 3600 }))
  } catch {
    return null
  }
}

async function uploadOne(req: any, reply: any, opts: { allowedMimes: string[]; category: string }) {
  const user = req.user
  if (!user) return reply.status(401).send({ error: '未登录' })
  if (!ALLOWED_CATEGORIES.has(opts.category)) {
    return reply.status(400).send({ error: `category 必须是 ${[...ALLOWED_CATEGORIES].join(' / ')}` })
  }
  try {
    const data = await req.file()
    if (!data) return reply.status(400).send({ error: '未收到文件' })
    if (!opts.allowedMimes.includes(data.mimetype)) {
      return reply.status(400).send({ error: `不支持的文件类型: ${data.mimetype}` })
    }

    // 按 mime 分级限大小: 视频 30MB, 图片/PDF 10MB
    const isVideo = data.mimetype.startsWith('video/')
    const maxBytes = isVideo ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES
    const maxMb = Math.floor(maxBytes / 1024 / 1024)

    const chunks: Buffer[] = []
    let totalSize = 0
    for await (const chunk of data.file) {
      totalSize += chunk.length
      if (totalSize > maxBytes) {
        return reply.status(400).send({ error: `文件大小不能超过 ${maxMb}MB` })
      }
      chunks.push(chunk)
    }
    // multipart fileSize 闸门触发会把流截断 → 存进去就是坏文件 (视频"加载不了"根因之一)
    if ((data.file as any).truncated) {
      return reply.status(400).send({ error: `文件过大被截断, 请压缩到 ${maxMb}MB 内重试` })
    }
    const buffer = Buffer.concat(chunks)
    const ext = path.extname(data.filename) || (
      data.mimetype === 'application/pdf' ? '.pdf' :
      isVideo ? (data.mimetype === 'video/quicktime' ? '.mov' : '.mp4') :
      '.jpg'
    )
    const key = `${opts.category}/${user.tenantId}/${uuidv4()}${ext}`
    const client = ossClient()
    await client.put(key, buffer, {
      mime: data.mimetype,
      headers: { 'Cache-Control': 'private, max-age=300' },
    })
    // P0 安全修复: 返回签名 URL (1 小时过期), 避免敏感图片/PDF 被链接传出去后无限期暴露
    // 长期保留: bucket 内对象仍在, 需要再次下载时调 /api/upload/signed-url?key=...
    const url = toHttps(client.signatureUrl(key, { expires: 3600 }))
    return reply.send({ url, key, name: data.filename, mime: data.mimetype, size: totalSize })
  } catch (err: any) {
    req.log.error(err)
    return reply.status(500).send({ error: '上传失败：' + err.message })
  }
}

export async function uploadRoutes(app: FastifyInstance) {
  // 老路径：仅图片，固定为 loss-claims 目录（保留兼容）
  app.post('/upload/image', { preHandler: [(app as any).authenticate] }, (req, reply) =>
    uploadOne(req, reply, { allowedMimes: IMAGE_MIMES, category: 'loss-claims' })
  )

  // 通用路径：支持图片 + PDF, category 通过 query 指定
  // 使用：POST /api/upload?category=invoices
  // 例外:
  //   - category=loss-claims 允许图片+视频 (供应商客户要求加视频证据), 不接 PDF
  //   - category=chef-ack    只接图片 (验收单就是拍照, PDF/视频没意义)
  app.post('/upload', { preHandler: [(app as any).authenticate] }, (req: any, reply: any) => {
    const parsed = uploadQuerySchema.safeParse(req.query || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const category = parsed.data.category
    const allowedMimes =
      category === 'loss-claims' ? MEDIA_MIMES
        : category === 'chef-ack' || category === 'products' || category === 'inventory-counts' ? IMAGE_MIMES
          : DOC_MIMES
    return uploadOne(req, reply, { allowedMimes, category })
  })

  // 重新签名: GET /api/upload/signed-url?key=xxx&expires=3600
  // 上传时返回的签名 URL 1h 过期, 后续要再访问需重新签
  app.get('/upload/signed-url', { preHandler: [(app as any).authenticate] }, async (req: any, reply: any) => {
    const parsed = signedUrlQuerySchema.safeParse(req.query || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const { key, expires } = parsed.data
    const [category, tenantId, ...objectPath] = key.split('/')
    // 防越权: 只签“允许类别/当前租户/对象名”结构的对象。
    if (!ALLOWED_CATEGORIES.has(category) || tenantId !== req.user.tenantId || objectPath.length === 0 || objectPath.some(part => !part)) {
      return reply.status(403).send({ error: '无权访问' })
    }
    const url = toHttps(ossClient().signatureUrl(key, { expires }))
    return reply.send({ url })
  })
}
