import { FastifyInstance } from 'fastify'
import OSS from 'ali-oss'
import path from 'path'

const uuidv4 = () => Math.random().toString(36).slice(2) + Date.now().toString(36)

const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
const DOC_MIMES = ['application/pdf', ...IMAGE_MIMES]

const ALLOWED_CATEGORIES = new Set(['loss-claims', 'invoices', 'capital', 'documents', 'reimbursements', 'misc'])

function ossClient() {
  return new OSS({
    region: process.env.OSS_REGION || 'oss-cn-hangzhou',
    accessKeyId: process.env.OSS_ACCESS_KEY_ID!,
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET!,
    bucket: process.env.OSS_BUCKET || 'dianjie-upload',
  })
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

    const chunks: Buffer[] = []
    let totalSize = 0
    for await (const chunk of data.file) {
      totalSize += chunk.length
      if (totalSize > 10 * 1024 * 1024) {
        return reply.status(400).send({ error: '文件大小不能超过 10MB' })
      }
      chunks.push(chunk)
    }
    const buffer = Buffer.concat(chunks)
    const ext = path.extname(data.filename) || (data.mimetype === 'application/pdf' ? '.pdf' : '.jpg')
    const key = `${opts.category}/${user.tenantId}/${uuidv4()}${ext}`
    const client = ossClient()
    await client.put(key, buffer, {
      mime: data.mimetype,
      headers: { 'Cache-Control': 'private, max-age=300' },
    })
    // P0 安全修复: 返回签名 URL (1 小时过期), 避免敏感图片/PDF 被链接传出去后无限期暴露
    // 长期保留: bucket 内对象仍在, 需要再次下载时调 /api/upload/signed-url?key=...
    const url = client.signatureUrl(key, { expires: 3600 })
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
  app.post('/upload', { preHandler: [(app as any).authenticate] }, (req: any, reply: any) => {
    const category = (req.query?.category || 'misc') as string
    return uploadOne(req, reply, { allowedMimes: DOC_MIMES, category })
  })

  // 重新签名: GET /api/upload/signed-url?key=xxx&expires=3600
  // 上传时返回的签名 URL 1h 过期, 后续要再访问需重新签
  app.get('/upload/signed-url', { preHandler: [(app as any).authenticate] }, async (req: any, reply: any) => {
    const { key, expires } = req.query as any
    if (!key || !key.startsWith) return reply.status(400).send({ error: 'key 必填' })
    // 防越权: 只能签自己 tenant 的对象 (路径里包含 tenantId)
    if (!String(key).includes(`/${req.user.tenantId}/`)) return reply.status(403).send({ error: '无权访问' })
    const url = ossClient().signatureUrl(String(key), { expires: Math.min(86400, Math.max(60, parseInt(expires as string) || 3600)) })
    return reply.send({ url })
  })
}
