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
    await ossClient().put(key, buffer, {
      mime: data.mimetype,
      headers: { 'Cache-Control': 'public, max-age=31536000' },
    })
    const url = `https://${process.env.OSS_BUCKET || 'dianjie-upload'}.oss-cn-hangzhou.aliyuncs.com/${key}`
    return reply.send({ url, name: data.filename, mime: data.mimetype, size: totalSize })
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
}
