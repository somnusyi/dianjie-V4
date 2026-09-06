import { NextRequest, NextResponse } from 'next/server'

const ALLOWED_IMAGE_HOSTS = new Set([
  'dianjie-upload.oss-cn-hangzhou.aliyuncs.com',
  'images.unsplash.com',
])
const MAX_IMAGE_BYTES = 10 * 1024 * 1024

export const runtime = 'nodejs'

function isAllowedPath(url: URL) {
  if (url.hostname === 'dianjie-upload.oss-cn-hangzhou.aliyuncs.com') {
    return url.pathname.startsWith('/loss-claims/')
  }
  return url.hostname === 'images.unsplash.com' && url.pathname.startsWith('/photo-')
}

export async function GET(request: NextRequest) {
  const rawUrl = request.nextUrl.searchParams.get('url')
  if (!rawUrl) {
    return NextResponse.json({ error: '缺少图片地址' }, { status: 400 })
  }

  let sourceUrl: URL
  try {
    sourceUrl = new URL(rawUrl)
  } catch {
    return NextResponse.json({ error: '图片地址无效' }, { status: 400 })
  }

  if (
    sourceUrl.protocol !== 'https:'
    || !ALLOWED_IMAGE_HOSTS.has(sourceUrl.hostname)
    || !isAllowedPath(sourceUrl)
  ) {
    return NextResponse.json({ error: '不允许的图片地址' }, { status: 400 })
  }

  try {
    const upstream = await fetch(sourceUrl, { cache: 'no-store', redirect: 'manual' })
    if (!upstream.ok || (upstream.status >= 300 && upstream.status < 400)) {
      return NextResponse.json({ error: '图片加载失败' }, { status: 502 })
    }

    const contentType = upstream.headers.get('content-type') || ''
    if (!contentType.startsWith('image/')) {
      return NextResponse.json({ error: '返回内容不是图片' }, { status: 415 })
    }
    const announcedLength = Number(upstream.headers.get('content-length') || 0)
    if (announcedLength > MAX_IMAGE_BYTES) {
      return NextResponse.json({ error: '图片文件过大' }, { status: 413 })
    }

    const bytes = await upstream.arrayBuffer()
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      return NextResponse.json({ error: '图片文件过大' }, { status: 413 })
    }
    return new NextResponse(bytes, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'private, max-age=300',
      },
    })
  } catch {
    return NextResponse.json({ error: '图片加载失败' }, { status: 502 })
  }
}
