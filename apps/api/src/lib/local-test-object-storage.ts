import { createHash, createHmac, timingSafeEqual, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

/** An explicit deployment provider, never a mock or a fallback for failed OSS. */
export function localTestStorageEnabled() {
  if (process.env.OBJECT_STORAGE_PROVIDER !== 'local-test') return false
  let dedicatedLoopback = false
  try {
    const db = new URL(process.env.DATABASE_URL || '')
    dedicatedLoopback = process.env.PREVIEW_TENANT_SLUG === 'four-gap-local-20261028'
      && db.hostname === '127.0.0.1' && db.port === '15449' && db.pathname === '/dianjie_four_gap_test'
  } catch { /* No implicit local storage outside the named isolated fixture. */ }
  if (process.env.PREVIEW_MODE !== 'true' || !(process.env.PREVIEW_TENANT_SLUG === 'huaweicloud-uat' || dedicatedLoopback)) {
    throw new Error('Local test object storage requires the isolated Huawei test tenant')
  }
  return true
}

function checkedKey(key: string) {
  if (typeof key !== 'string' || key.length > 1024 || !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.-]+)+$/.test(key) || key.split('/').some(p => p === '.' || p === '..')) {
    throw Object.assign(new Error('Invalid attachment key'), {statusCode: 400})
  }
  return key
}

function root() {
  if (!localTestStorageEnabled()) throw new Error('Local test storage is not enabled')
  const directory = process.env.LOCAL_OBJECT_STORAGE_DIR
  if (!directory || !path.isAbsolute(directory)) throw new Error('An absolute attachment volume is required')
  return directory
}

function filePaths(key: string) {
  const id = createHash('sha256').update(checkedKey(key)).digest('hex')
  return {bytes: path.join(root(), id + '.bin'), metadata: path.join(root(), id + '.json')}
}

function endpoint() {
  const url = new URL(process.env.FRONTEND_URL || '')
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Invalid public attachment origin')
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('Public attachment URLs require HTTPS')
  }
  return new URL('/api/local-test-objects', url)
}

function signature(key: string, expires: number) {
  const secret = process.env.JWT_SECRET
  if (!secret || secret.length < 32) throw new Error('Attachment signing secret is unavailable')
  return createHmac('sha256', secret).update(`dianjie-local-test-object-v1\n${checkedKey(key)}\n${expires}`).digest('hex')
}

export class LocalTestObjectStorage {
  async put(key: string, bytes: Buffer, options: {mime: string}) {
    const files = filePaths(key)
    if (!Buffer.isBuffer(bytes) || bytes.length > 55 * 1024 * 1024) throw new Error('Invalid attachment size')
    if (!/^(image\/(jpeg|png|webp|gif)|video\/(mp4|quicktime|webm|x-m4v|3gpp)|application\/pdf)$/.test(options.mime)) throw new Error('Invalid attachment MIME')
    await fs.mkdir(root(), {recursive: true, mode: 0o700})
    const temporary = files.bytes + '.' + randomUUID() + '.tmp'
    try {
      await fs.writeFile(temporary, bytes, {mode: 0o600, flag: 'wx'})
      await fs.rename(temporary, files.bytes)
      await fs.writeFile(files.metadata, JSON.stringify({key, mime: options.mime, size: bytes.length}), {mode: 0o600})
    } finally { await fs.rm(temporary, {force: true}) }
    return {name: key}
  }

  async head(key: string) {
    const files = filePaths(key)
    try {
      const meta = JSON.parse(await fs.readFile(files.metadata, 'utf8'))
      const stat = await fs.stat(files.bytes)
      if (meta.key !== key || meta.size !== stat.size) throw new Error('Attachment metadata does not match stored file')
      return {res: {headers: {'content-type': String(meta.mime), 'content-length': String(stat.size)}}}
    } catch (error: any) {
      if (error.code === 'ENOENT') error.status = 404
      throw error
    }
  }

  async delete(key: string) {
    const files = filePaths(key)
    await fs.rm(files.metadata, {force: true})
    await fs.rm(files.bytes, {force: true})
    return {res: {status: 204}}
  }

  signatureUrl(key: string, {expires = 3600}: {expires?: number} = {}) {
    root()
    if (!Number.isInteger(expires) || expires < 1 || expires > 86400) throw new Error('Invalid attachment expiry')
    const deadline = Math.floor(Date.now() / 1000) + expires
    const url = endpoint()
    url.searchParams.set('key', checkedKey(key))
    url.searchParams.set('expires', String(deadline))
    url.searchParams.set('signature', signature(key, deadline))
    return url.toString()
  }
}

export function resignLocalTestObjectUrl(value: string) {
  if (!localTestStorageEnabled()) return null
  try {
    const url = new URL(value), expected = endpoint()
    if (url.origin !== expected.origin || url.pathname !== expected.pathname) return null
    return new LocalTestObjectStorage().signatureUrl(url.searchParams.get('key') || '')
  } catch { return null }
}

export async function readSignedLocalTestObject(query: unknown) {
  root()
  const q = query as Record<string, unknown>
  if (!q || Object.keys(q).some(key => !['key', 'expires', 'signature'].includes(key)) || typeof q.key !== 'string' || typeof q.expires !== 'string' || typeof q.signature !== 'string') {
    throw Object.assign(new Error('Invalid attachment link'), {statusCode: 400})
  }
  const deadline = Number(q.expires), now = Math.floor(Date.now() / 1000)
  if (!/^\d+$/.test(q.expires) || !Number.isSafeInteger(deadline) || deadline <= now || deadline > now + 86400 || !/^[a-f0-9]{64}$/.test(q.signature)) {
    throw Object.assign(new Error('Attachment link is invalid or expired'), {statusCode: 403})
  }
  const expected = signature(q.key, deadline)
  if (!timingSafeEqual(Buffer.from(q.signature, 'hex'), Buffer.from(expected, 'hex'))) throw Object.assign(new Error('Attachment link is invalid or expired'), {statusCode: 403})
  const headers = (await new LocalTestObjectStorage().head(q.key)).res.headers
  return {bytes: await fs.readFile(filePaths(q.key).bytes), mime: headers['content-type']}
}
