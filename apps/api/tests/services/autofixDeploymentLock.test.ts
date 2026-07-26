import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { acquireDeployLock } from '../../src/services/autofix/deploymentLock'

let tempDir = ''

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true })
  tempDir = ''
})

async function makeTarget(): Promise<string> {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'dianjie-autofix-lock-test-'))
  const target = path.join(tempDir, 'production')
  await mkdir(target)
  return target
}

describe('AutoFix production deployment lock', () => {
  it('allows only one holder and lets that holder release the lock', async () => {
    const target = await makeTarget()
    const release = await acquireDeployLock(target, 'run-a')

    const owner = await readFile(path.join(target, '.deploy-lock/owner'), 'utf8')
    expect(owner).toMatch(/^autofix:run-a \S+ token=[0-9a-f-]+\n$/)
    await expect(acquireDeployLock(target, 'run-b')).rejects.toThrow('生产部署锁已被其他发布占用')

    await release()
    await expect(readFile(path.join(target, '.deploy-lock/owner'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves a lock that was taken over while the old task was paused', async () => {
    const target = await makeTarget()
    const releaseOld = await acquireDeployLock(target, 'old-run')
    const ownerPath = path.join(target, '.deploy-lock/owner')
    const replacementOwner = 'standard-deploy:operator 2026-07-26T20:00:00.000Z\n'
    await writeFile(ownerPath, replacementOwner, { mode: 0o600 })

    await expect(releaseOld()).rejects.toThrow('生产部署锁所有者已变化')
    await expect(readFile(ownerPath, 'utf8')).resolves.toBe(replacementOwner)
  })

  it('refuses to remove an ownerless lock directory', async () => {
    const target = await makeTarget()
    const release = await acquireDeployLock(target, 'old-run')
    await rm(path.join(target, '.deploy-lock/owner'))

    await expect(release()).rejects.toThrow('所有者记录缺失')
    await expect(readFile(path.join(target, '.deploy-lock/owner'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
    await expect(acquireDeployLock(target, 'new-run')).rejects.toThrow('生产部署锁已被其他发布占用')
  })
})
