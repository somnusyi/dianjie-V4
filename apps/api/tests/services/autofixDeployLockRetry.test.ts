import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  acquireDeployLock,
  DEPLOY_LOCK_BUSY_MESSAGE,
  isDeployLockBusyError,
} from '../../src/services/autofix/deploymentLock'

const mocks = vi.hoisted(() => ({
  autoFixRun: {
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  opLog: { create: vi.fn() },
}))

vi.mock('@dianjie/db', () => ({
  prisma: { autoFixRun: mocks.autoFixRun, opLog: mocks.opLog },
}))
vi.mock('../../src/services/notification', () => ({ sendNotification: vi.fn() }))
vi.mock('../../src/services/notify', () => ({ fireAndForget: vi.fn() }))

import {
  executeApprovedRun,
  LOCK_RETRY_INTERVAL_MS,
  LOCK_RETRY_MAX,
} from '../../src/services/autofix/deployment'

let tempDir = ''
let releaseBusyLock: (() => Promise<void>) | null = null
const oldEnv: Record<string, string | undefined> = {}

beforeEach(async () => {
  for (const key of ['AUTO_FIX_MODE', 'AUTO_FIX_DEPLOY_ENABLED', 'AUTO_FIX_PRODUCTION_DIR']) {
    oldEnv[key] = process.env[key]
  }
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'dianjie-autofix-retry-test-'))
  const target = path.join(tempDir, 'production')
  await mkdir(target)
  // 另一个发布任务先占住部署锁
  releaseBusyLock = await acquireDeployLock(target, 'other-run')
  process.env.AUTO_FIX_MODE = 'approved_auto'
  process.env.AUTO_FIX_DEPLOY_ENABLED = 'true'
  process.env.AUTO_FIX_PRODUCTION_DIR = target
  mocks.autoFixRun.findUnique.mockReset()
  mocks.autoFixRun.update.mockReset()
  mocks.autoFixRun.update.mockResolvedValue({ id: 'run-mock', tenantId: 't1' })
  mocks.autoFixRun.updateMany.mockReset()
  mocks.opLog.create.mockReset()
})

afterEach(async () => {
  if (releaseBusyLock) await releaseBusyLock().catch(() => undefined)
  releaseBusyLock = null
  for (const [key, value] of Object.entries(oldEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  if (tempDir) await rm(tempDir, { recursive: true, force: true })
  tempDir = ''
})

describe('部署锁冲突自动重试', () => {
  it('锁占用错误可以被类型守卫准确识别', () => {
    expect(isDeployLockBusyError(new Error(DEPLOY_LOCK_BUSY_MESSAGE))).toBe(true)
    expect(isDeployLockBusyError(new Error('生产部署锁所有者已变化，拒绝释放其他发布任务的锁'))).toBe(false)
    expect(isDeployLockBusyError(new Error('其他错误'))).toBe(false)
    expect(isDeployLockBusyError('生产部署锁已被其他发布占用')).toBe(false)
  })

  it('重试策略：每 5 分钟一次，最多 12 次', () => {
    expect(LOCK_RETRY_INTERVAL_MS).toBe(5 * 60_000)
    expect(LOCK_RETRY_MAX).toBe(12)
  })

  it('锁被占用时保持 DEPLOYING 并排队 5 分钟后重试，不转人工', async () => {
    mocks.autoFixRun.findUnique.mockResolvedValue({ tenantId: 't1', retryCount: 0, status: 'DEPLOYING' })

    await executeApprovedRun('run-lock-retry')

    expect(mocks.autoFixRun.update).toHaveBeenCalledTimes(1)
    const updateArgs = mocks.autoFixRun.update.mock.calls[0][0]
    expect(updateArgs.where).toEqual({ id: 'run-lock-retry' })
    expect(updateArgs.data.retryCount).toBe(1)
    expect(updateArgs.data.error).toContain('部署冲突中')
    expect(updateArgs.data.error).toContain(`第 1/${LOCK_RETRY_MAX} 次`)
    expect(updateArgs.data.nextRetryAt.getTime()).toBeGreaterThan(Date.now() + LOCK_RETRY_INTERVAL_MS - 5000)
    expect(updateArgs.data.status).toBeUndefined()
    // 排队成功：不走 markDeploymentFailure，没有 ESCALATED 状态写入
    expect(
      mocks.autoFixRun.update.mock.calls.some((call) => call[0]?.data?.status === 'ESCALATED'),
    ).toBe(false)
    expect(mocks.opLog.create).toHaveBeenCalledTimes(1)
    expect(mocks.opLog.create.mock.calls[0][0].data.action).toContain('部署锁冲突')
  })

  it('重试次数用完后才转人工', async () => {
    mocks.autoFixRun.findUnique.mockResolvedValue({
      tenantId: 't1',
      retryCount: LOCK_RETRY_MAX,
      status: 'DEPLOYING',
    })

    await executeApprovedRun('run-lock-exhausted')

    const escalated = mocks.autoFixRun.update.mock.calls.find(
      (call) => call[0]?.data?.status === 'ESCALATED',
    )
    expect(escalated).toBeTruthy()
    expect(escalated[0].data.error).toContain('部署锁冲突重试')
    expect(escalated[0].data.error).toContain('转人工')
  })

  it('锁释放后重试路径不再命中排队（干跑：直接验证锁可获取）', async () => {
    if (releaseBusyLock) await releaseBusyLock()
    releaseBusyLock = null
    // 锁已释放，同目录可直接获取新锁——模拟 worker 到期重试时的前置条件
    const release = await acquireDeployLock(process.env.AUTO_FIX_PRODUCTION_DIR!, 'run-lock-retry')
    await release()
  })
})
