import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

export type ReleaseDeployLock = () => Promise<void>

export const DEPLOY_LOCK_BUSY_MESSAGE = '生产部署锁已被其他发布占用'

export function isDeployLockBusyError(error: unknown): boolean {
  return error instanceof Error && error.message === DEPLOY_LOCK_BUSY_MESSAGE
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}

export async function acquireDeployLock(target: string, runId: string): Promise<ReleaseDeployLock> {
  const lockDir = path.join(target, '.deploy-lock')
  const ownerPath = path.join(lockDir, 'owner')
  const owner = `autofix:${runId} ${new Date().toISOString()} token=${randomUUID()}\n`
  let created = false

  try {
    await mkdir(lockDir)
    created = true
    await writeFile(ownerPath, owner, { mode: 0o600 })
  } catch {
    if (created) await rm(lockDir, { recursive: true, force: true }).catch(() => undefined)
    throw new Error(DEPLOY_LOCK_BUSY_MESSAGE)
  }

  return async () => {
    let currentOwner: string
    try {
      currentOwner = await readFile(ownerPath, 'utf8')
    } catch (error) {
      if (isMissing(error)) {
        try {
          await lstat(lockDir)
        } catch (lockError) {
          if (isMissing(lockError)) return
          throw lockError
        }
        throw new Error('生产部署锁仍存在但所有者记录缺失，拒绝自动释放')
      }
      throw error
    }

    if (currentOwner !== owner) {
      throw new Error('生产部署锁所有者已变化，拒绝释放其他发布任务的锁')
    }
    await rm(lockDir, { recursive: true, force: true })
  }
}
