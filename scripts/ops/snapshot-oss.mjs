import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createWriteStream, createReadStream } from 'node:fs'
import { createRequire } from 'node:module'
import { pipeline } from 'node:stream/promises'
import { pathToFileURL } from 'node:url'

export async function listObjects(client, prefix = '') {
  const objects = [], seen = new Set(), tokens = new Set()
  let token
  do {
    const result = await client.listV2({ prefix, 'max-keys': 1000, ...(token ? { 'continuation-token': token } : {}) })
    for (const object of result.objects || []) {
      if (!object.name.startsWith(prefix) || seen.has(object.name)) throw new Error('Invalid or duplicate attachment listing')
      seen.add(object.name)
      objects.push({ key: object.name, etag: object.etag, size: Number(object.size), lastModified: object.lastModified })
    }
    token = result.nextContinuationToken
    if (result.isTruncated && !token) throw new Error('Incomplete attachment listing')
    if (token && tokens.has(token)) throw new Error('Attachment pagination repeated')
    if (token) tokens.add(token)
  } while (token)
  return objects.sort((a, b) => a.key.localeCompare(b.key))
}

async function fileDigest(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

export async function captureObjects(client, destination, prefix = '', cache) {
  let previous = []
  if (cache) {
    try { previous = JSON.parse(await fs.readFile(path.join(cache, 'oss-index.json'), 'utf8')).objects } catch (e) { if (e.code !== 'ENOENT') throw e }
  }
  const before = await listObjects(client, prefix)
  await fs.mkdir(path.join(destination, 'objects'), { recursive: true, mode: 0o700 })
  const mapping = []
  for (const object of before) {
    const file = createHash('sha256').update(object.key).digest('hex') + '.bin'
    const old = previous.find(o => o.key === object.key && o.etag === object.etag && o.size === object.size && o.lastModified === object.lastModified)
    let reused = false
    if (cache && old && /^[a-f0-9]{64}$/.test(old.sha256)) {
      const blob = path.join(cache, old.sha256)
      try {
        const stat = await fs.lstat(blob)
        if (stat.isFile() && stat.size === object.size && await fileDigest(blob) === old.sha256) {
          await fs.link(blob, path.join(destination, 'objects', file)); reused = true
        }
      } catch (e) { if (e.code !== 'ENOENT') throw e }
    }
    if (!reused) {
      const { stream } = await client.getStream(object.key)
      await pipeline(stream, createWriteStream(path.join(destination, 'objects', file), { flags: 'wx', mode: 0o600 }))
    }
    const actual = await fs.stat(path.join(destination, 'objects', file))
    if (actual.size !== object.size) throw new Error('Attachment size changed during snapshot')
    mapping.push({ ...object, file: 'objects/' + file })
  }
  const after = await listObjects(client, prefix)
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Attachments changed during snapshot')
  await fs.writeFile(path.join(destination, 'oss-inventory.json'), JSON.stringify({ prefix, objects: mapping }, null, 2), { mode: 0o600 })
  return { objectCount: mapping.length }
}

async function main() {
  for (const key of ['OSS_ACCESS_KEY_ID', 'OSS_ACCESS_KEY_SECRET', 'OSS_BUCKET']) {
    if (!process.env[key]) throw new Error('Missing attachment backup configuration')
  }
  const require = createRequire(new URL('../../apps/api/package.json', import.meta.url))
  const OSS = require('ali-oss')
  const client = new OSS({ region: process.env.OSS_REGION || 'oss-cn-hangzhou', secure: true,
    bucket: process.env.OSS_BUCKET, accessKeyId: process.env.OSS_ACCESS_KEY_ID, accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET })
  const [action, destination, prefix = '', cache] = process.argv.slice(2)
  if (action === 'capture') {
    console.log(JSON.stringify(await captureObjects(client, destination, prefix, cache)))
  } else if (action === 'check') {
    const stored = JSON.parse(await fs.readFile(path.join(destination, 'oss-inventory.json'), 'utf8'))
    const actual = await listObjects(client, stored.prefix)
    const before = stored.objects.map(({ file, ...object }) => object)
    if (JSON.stringify(before) !== JSON.stringify(actual)) throw new Error('Attachments changed during database snapshot')
    console.log('{"status":"unchanged"}')
  } else throw new Error('Unknown attachment backup action')
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Attachment snapshot failed; no credentials or cloud response logged.'); process.exitCode = 1 })
}
