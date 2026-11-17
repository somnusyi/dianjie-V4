import {afterEach, beforeEach, expect, it, vi} from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {LocalTestObjectStorage, localTestStorageEnabled, readSignedLocalTestObject, resignLocalTestObjectUrl} from '../../src/lib/local-test-object-storage'

let directory: string
const key = 'products/tenant-a/batch-a/photo.png'
const bytes = Buffer.from('isolated synthetic attachment')
const query = (url: string) => Object.fromEntries(new URL(url).searchParams)
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dianjie-test-objects-'))
  vi.stubEnv('OBJECT_STORAGE_PROVIDER', 'local-test')
  vi.stubEnv('PREVIEW_MODE', 'true')
  vi.stubEnv('PREVIEW_TENANT_SLUG', 'huaweicloud-uat')
  vi.stubEnv('LOCAL_OBJECT_STORAGE_DIR', directory)
  vi.stubEnv('FRONTEND_URL', 'http://127.0.0.1:18085')
  vi.stubEnv('JWT_SECRET', 'synthetic-local-signing-key-longer-than-32-characters')
})
afterEach(async () => {vi.unstubAllEnvs(); await fs.rm(directory, {recursive: true, force: true})})

it('stores real bytes, metadata and reads signed URLs with a new client instance', async () => {
  const first = new LocalTestObjectStorage()
  await first.put(key, bytes, {mime: 'image/png'})
  const second = new LocalTestObjectStorage()
  expect((await second.head(key)).res.headers).toEqual({'content-type': 'image/png', 'content-length': String(bytes.length)})
  const signed = second.signatureUrl(key)
  expect((await readSignedLocalTestObject(query(signed))).bytes).toEqual(bytes)
  for (const file of await fs.readdir(directory)) expect((await fs.stat(path.join(directory, file))).mode & 0o777).toBe(0o600)
})

it('rejects unsigned links and changing the key to a different tenant or batch', async () => {
  const client = new LocalTestObjectStorage()
  await client.put(key, bytes, {mime: 'image/png'})
  const signed = query(client.signatureUrl(key))
  await expect(readSignedLocalTestObject({key})).rejects.toMatchObject({statusCode: 400})
  await expect(readSignedLocalTestObject({...signed, key: key.replace('tenant-a', 'tenant-b')})).rejects.toMatchObject({statusCode: 403})
  await expect(readSignedLocalTestObject({...signed, key: key.replace('batch-a', 'batch-b')})).rejects.toMatchObject({statusCode: 403})
})

it('rejects expired, modified-signature and overlong-expiry URLs', async () => {
  const signed = query(new LocalTestObjectStorage().signatureUrl(key))
  for (const change of [{expires: '1'}, {signature: '0'.repeat(64)}, {expires: String(Math.floor(Date.now()/1000)+86401)}]) {
    await expect(readSignedLocalTestObject({...signed, ...change})).rejects.toMatchObject({statusCode: 403})
  }
})

it('rejects path traversal, executable MIME and nonabsolute storage roots', async () => {
  const client = new LocalTestObjectStorage()
  await expect(client.put('products/../outside.png', bytes, {mime: 'image/png'})).rejects.toMatchObject({statusCode: 400})
  await expect(client.put(key, bytes, {mime: 'text/html'})).rejects.toThrow('MIME')
  vi.stubEnv('LOCAL_OBJECT_STORAGE_DIR', 'relative')
  await expect(client.put(key, bytes, {mime: 'image/png'})).rejects.toThrow('absolute')
})

it('does not enable the local provider outside its exact isolated test deployment', () => {
  vi.stubEnv('PREVIEW_TENANT_SLUG', 'dianjie')
  expect(localTestStorageEnabled).toThrow('isolated')
  vi.stubEnv('OBJECT_STORAGE_PROVIDER', '')
  expect(localTestStorageEnabled()).toBe(false)
})

it('permits the named loopback fixture only with its exact dedicated database', () => {
  vi.stubEnv('PREVIEW_TENANT_SLUG', 'four-gap-local-20261028')
  vi.stubEnv('DATABASE_URL', 'postgresql://unused@127.0.0.1:15449/dianjie_four_gap_test')
  expect(localTestStorageEnabled()).toBe(true)
  for (const url of ['postgresql://unused@remote.invalid:15449/dianjie_four_gap_test', 'postgresql://unused@127.0.0.1:5432/dianjie', '']) {
    vi.stubEnv('DATABASE_URL', url)
    expect(localTestStorageEnabled).toThrow('isolated')
  }
})

it('requires HTTPS for nonlocal origins and never resigns an unrelated URL', () => {
  expect(resignLocalTestObjectUrl('https://example.invalid/a')).toBeNull()
  vi.stubEnv('FRONTEND_URL', 'http://example.invalid')
  expect(() => new LocalTestObjectStorage().signatureUrl(key)).toThrow('HTTPS')
  vi.stubEnv('FRONTEND_URL', 'https://example.invalid')
  expect(new LocalTestObjectStorage().signatureUrl(key)).toMatch(/^https:\/\/example.invalid\/api\/local-test-objects\?/)
})

it('deletes its own object and refuses missing or mismatched metadata', async () => {
  const client = new LocalTestObjectStorage()
  await client.put(key, bytes, {mime: 'image/png'})
  const bin = (await fs.readdir(directory)).find(name => name.endsWith('.bin'))!
  await fs.writeFile(path.join(directory, bin), 'different size')
  await expect(client.head(key)).rejects.toThrow('metadata')
  await client.delete(key)
  await expect(client.head(key)).rejects.toMatchObject({status: 404})
})
