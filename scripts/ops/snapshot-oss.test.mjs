import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { captureObjects, listObjects } from './snapshot-oss.mjs'

test('attachment pagination includes every page and exact downloaded bytes', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'dianjie-oss-'))
  try {
    const client = { listV2: async args => args['continuation-token']
      ? { objects: [{ name: 'invoice/b', size: 3, etag: 'b' }] }
      : { objects: [{ name: 'invoice/a', size: 3, etag: 'a' }], nextContinuationToken: 'next', isTruncated: true },
      getStream: async key => ({ stream: Readable.from([key.endsWith('a') ? 'one' : 'two']) }) }
    assert.deepEqual(await captureObjects(client, temp, 'invoice/'), { objectCount: 2 })
    const mapping = JSON.parse(await fs.readFile(path.join(temp, 'oss-inventory.json'), 'utf8'))
    assert.equal(await fs.readFile(path.join(temp, mapping.objects[1].file), 'utf8'), 'two')
  } finally { await fs.rm(temp, { recursive: true, force: true }) }
})
test('truncated and repeated pages never become a successful partial snapshot', async () => {
  await assert.rejects(() => listObjects({ listV2: async () => ({ objects: [], isTruncated: true }) }))
  await assert.rejects(() => listObjects({ listV2: async () => ({ objects: [], nextContinuationToken: 'same' }) }))
})
test('a later-page failure propagates instead of hiding attachments', async () => {
  await assert.rejects(() => listObjects({ listV2: async args => {
    if (args['continuation-token']) throw new Error('offline')
    return { objects: [], nextContinuationToken: 'next' }
  } }))
})
test('changed object metadata invalidates a snapshot', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'dianjie-oss-'))
  let calls = 0
  try { await assert.rejects(() => captureObjects({
    listV2: async () => ({ objects: [{ name: 'x', size: 1, etag: String(calls++) }] }),
    getStream: async () => ({ stream: Readable.from(['x']) }),
  }, temp)) } finally { await fs.rm(temp, { recursive: true, force: true }) }
})
test('verified unchanged blobs are reused without downloading them again', async () => {
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'dianjie-cache-'))
 try {
  const cache=path.join(temp,'blobs');await fs.mkdir(cache)
  const {createHash}=await import('node:crypto');const checksum=createHash('sha256').update('pic').digest('hex')
  await fs.writeFile(path.join(cache,checksum),'pic')
  await fs.writeFile(path.join(cache,'oss-index.json'),JSON.stringify({objects:[{key:'invoices/a',etag:'stable',size:3,sha256:checksum}]}))
  const client={listV2:async()=>({objects:[{name:'invoices/a',etag:'stable',size:3}]}),getStream:async()=>{throw Error('unexpected download')}}
  assert.deepEqual(await captureObjects(client,path.join(temp,'snapshot'),'invoices/',cache),{objectCount:1})
  const mapping=JSON.parse(await fs.readFile(path.join(temp,'snapshot','oss-inventory.json'),'utf8'))
  assert.equal(await fs.readFile(path.join(temp,'snapshot',mapping.objects[0].file),'utf8'),'pic')
 } finally {await fs.rm(temp,{recursive:true,force:true})}
})
