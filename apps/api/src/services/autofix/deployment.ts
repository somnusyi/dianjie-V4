import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { prisma } from '@dianjie/db'
import { sendNotification } from '../notification'
import { fireAndForget as notify } from '../notify'
import {
  classifyDeploymentFailure,
  type DeploymentRecoveryState,
} from './deploymentFailure'
import {
  preparePatchedDeploymentCandidate,
  removeDeploymentCandidate,
  type DeploymentCandidate,
} from './deploymentCandidate'
import { acquireDeployLock } from './deploymentLock'
import { inspectUnifiedDiff, isAutoDeploymentEnabled } from './policy'
import { requireProductionBaseline } from './productionBaseline'

const execFileAsync = promisify(execFile)
const MAX_LOG_CHARS = 40_000

interface RunCommandResult {
  output: string
}

function deploymentEnabled(): boolean {
  return isAutoDeploymentEnabled()
}

function sourceDir(): string {
  return process.env.AUTO_FIX_REPO_DIR || '/app/dianjie-src'
}

function productionDir(): string {
  return process.env.AUTO_FIX_PRODUCTION_DIR || '/app/dianjie-v4'
}

async function run(
  cwd: string,
  command: string,
  args: string[],
  timeout = 180_000,
): Promise<RunCommandResult> {
  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd,
    timeout,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, CI: '1' },
  })
  return { output: `${stdout || ''}${stderr || ''}`.slice(-20_000) }
}

async function gitOutput(repo: string, args: string[]): Promise<string> {
  return (await run(repo, 'git', args, 30_000)).output.trim()
}

async function requireCleanPinnedRepo(repo: string, expectedBase: string) {
  const status = await gitOutput(repo, ['status', '--porcelain'])
  if (status) throw new Error('自动修复源码副本不是干净状态')
  const head = await gitOutput(repo, ['rev-parse', 'HEAD'])
  if (head !== expectedBase) throw new Error(`源码基线已变化，预期 ${expectedBase}，实际 ${head}`)
}

async function buildAndSyncWeb(repo: string, target: string, runId: string): Promise<string> {
  const logs: string[] = []
  const backupDir = '/app/backups'
  const backupPath = `${backupDir}/autofix-web-${runId}-${Date.now()}.tar.gz`
  logs.push((await run(target, 'mkdir', ['-p', backupDir], 30_000)).output)
  logs.push((await run(
    target,
    'tar',
    ['-czf', backupPath, '-C', target, 'apps/web/apps/web'],
    120_000,
  )).output)
  logs.push((await run(repo, 'pnpm', ['--filter', '@dianjie/web', 'build'], 600_000)).output)

  const standalone = path.join(repo, 'apps/web/.next/standalone/apps/web/')
  const staticDir = path.join(repo, 'apps/web/.next/static/')
  const publicDir = path.join(repo, 'apps/web/public/')
  logs.push((await run(repo, 'rsync', ['-az', '--delete', standalone, `${target}/apps/web/apps/web/`], 120_000)).output)
  logs.push((await run(repo, 'rsync', ['-az', '--delete', staticDir, `${target}/apps/web/apps/web/.next/static/`], 120_000)).output)
  logs.push((await run(repo, 'rsync', ['-az', '--delete', publicDir, `${target}/apps/web/apps/web/public/`], 120_000)).output)
  logs.push((await run(repo, 'pm2', ['restart', 'dianjie-v4-web', '--update-env'], 60_000)).output)
  return `${logs.join('\n')}\nbackup=${backupPath}`.slice(-MAX_LOG_CHARS)
}

async function verifyProduction(contextPath: string) {
  const targetPath = contextPath.startsWith('/') ? contextPath : '/v2/login'
  let last = ''
  for (let attempt = 1; attempt <= 20; attempt++) {
    try {
      const [api, page] = await Promise.all([
        fetch('http://localhost:4004/api/health', { signal: AbortSignal.timeout(3_000) }),
        fetch(`http://localhost:3204${targetPath}`, { redirect: 'manual', signal: AbortSignal.timeout(3_000) }),
      ])
      last = `api=${api.status}, page=${page.status}`
      if (api.status === 200 && page.status >= 200 && page.status < 400) return last
    } catch (error: any) {
      last = error.message || String(error)
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000))
  }
  throw new Error(`生产健康检查 60 秒未通过: ${last}`)
}

async function resolveFeedback(runId: string, commitSha: string, health: string, deployLog: string) {
  const result = await prisma.$transaction(async (tx) => {
    const run = await tx.autoFixRun.findUnique({
      where: { id: runId },
      include: { feedback: true },
    })
    if (!run) throw new Error('自动修复记录不存在')
    await tx.autoFixRun.update({
      where: { id: run.id },
      data: {
        status: 'RESOLVED' as any,
        commitSha,
        deployLog: `${deployLog}\n${health}`.slice(-MAX_LOG_CHARS),
        error: null,
      },
    })
    await tx.feedback.update({ where: { id: run.feedbackId }, data: { status: 'RESOLVED' } })
    await tx.feedbackMessage.create({
      data: {
        tenantId: run.tenantId,
        feedbackId: run.feedbackId,
        role: 'assistant',
        content: '该反馈已由管理员批准，系统完成自动修复和生产验证，问题已标记为解决。如仍有异常请继续留言。',
      },
    })
    await tx.opLog.create({
      data: {
        tenantId: run.tenantId,
        role: 'AI',
        action: `AI 自动修复 ${run.id} 已部署并通过生产验证`,
        entityType: 'AutoFixRun',
        targetId: run.id,
        isAi: true,
        metadata: { status: 'RESOLVED', commitSha, health } as any,
      },
    })
    return run
  })

  const reporter = await prisma.user.findUnique({
    where: { id: result.feedback.reporterId },
    select: { role: true },
  })
  await sendNotification({
    tenantId: result.tenantId,
    recipientRole: reporter?.role || 'MANAGER',
    recipientId: result.feedback.reporterId,
    type: 'FEEDBACK_RESULT',
    title: `反馈已自动修复: ${result.feedback.title || ''}`,
    body: '管理员批准后系统已自动完成开发、测试和生产验证。',
    refType: 'Feedback',
    refId: result.feedbackId,
    dedupeKey: `AUTOFIX_RESULT:${result.id}:resolved`,
  }).catch((error) => console.error('[autofix] 提报人通知失败:', error))

  notify({
    tenantId: result.tenantId,
    event: 'AUTOFIX_RESOLVED',
    eventKey: `AUTOFIX:${result.id}:RESOLVED`,
    payload: { runId: result.id, feedbackId: result.feedbackId, commitSha, health },
    bypassFrequency: true,
  })
}

async function markDeploymentFailure(
  runId: string,
  error: unknown,
  log: string,
  recovery: DeploymentRecoveryState,
  recoveryError = '',
) {
  const outcome = classifyDeploymentFailure(recovery)
  const primaryMessage = error instanceof Error ? error.message : String(error)
  const message = recoveryError
    ? `${primaryMessage}\n自动回滚异常: ${recoveryError}`
    : primaryMessage
  const run = await prisma.autoFixRun.update({
    where: { id: runId },
    data: {
      status: outcome.status as any,
      error: message.slice(0, 20_000),
      deployLog: log.slice(-MAX_LOG_CHARS),
    },
  })
  await prisma.opLog.create({
    data: {
      tenantId: run.tenantId,
      role: 'AI',
      action: `AI 自动修复 ${run.id} ${outcome.action}`,
      entityType: 'AutoFixRun',
      targetId: run.id,
      isAi: true,
      metadata: {
        status: outcome.status,
        reason: outcome.reason,
        error: message.slice(0, 500),
      } as any,
    },
  })
  notify({
    tenantId: run.tenantId,
    event: 'AUTOFIX_ESCALATED',
    eventKey: `AUTOFIX:${run.id}:${outcome.status}`,
    payload: { runId: run.id, feedbackId: run.feedbackId, error: message.slice(0, 500) },
    bypassFrequency: true,
    bypassSilent: true,
  })
}

export async function executeApprovedRun(runId: string) {
  const repo = sourceDir()
  const target = productionDir()
  let commitSha = ''
  let log = ''
  let candidate: DeploymentCandidate | null = null
  let deploymentStarted = false
  let recovery: DeploymentRecoveryState = 'NOT_REQUIRED'
  let recoveryError = ''
  let releaseLock: (() => Promise<void>) | null = null
  try {
    if (!deploymentEnabled()) throw new Error('自动修复部署开关未启用')
    releaseLock = await acquireDeployLock(target, runId)
    const runRecord = await prisma.autoFixRun.findUnique({
      where: { id: runId },
      include: { feedback: true },
    })
    if (!runRecord || runRecord.status !== ('DEPLOYING' as any) || !runRecord.diffPatch || !runRecord.baseCommitSha) {
      throw new Error('自动修复记录状态或补丁不完整')
    }
    const inspection = inspectUnifiedDiff(runRecord.diffPatch)
    if (!inspection.ok) throw new Error(inspection.errors.join('；'))
    await requireProductionBaseline(target, runRecord.baseCommitSha)
    await requireCleanPinnedRepo(repo, runRecord.baseCommitSha)

    candidate = await preparePatchedDeploymentCandidate({
      repo,
      baseCommitSha: runRecord.baseCommitSha,
      diffPatch: runRecord.diffPatch,
      files: inspection.files.map((file) => file.path),
      runId: runRecord.id,
    })
    commitSha = candidate.commitSha
    await run(repo, 'git', ['tag', `autofix-${runRecord.id}`, commitSha], 30_000)

    deploymentStarted = true
    log = await buildAndSyncWeb(candidate.worktreeDir, target, runRecord.id)
    await prisma.autoFixRun.update({
      where: { id: runRecord.id },
      data: { status: 'VERIFY_PROD' as any, commitSha, deployLog: log },
    })
    const contextPath = String((runRecord.feedback.context as any)?.path || '/v2/login')
    const health = await verifyProduction(contextPath)
    await writeFile(path.join(target, '.deployed-commit'), `${commitSha}\n`, { mode: 0o600 })
    await resolveFeedback(runRecord.id, commitSha, health, log)
    try {
      await requireCleanPinnedRepo(repo, runRecord.baseCommitSha)
      await run(repo, 'git', ['merge', '--ff-only', commitSha], 30_000)
    } catch (sourceSyncError) {
      console.error('[autofix] 生产已验证，但源码分支快进待维护:', sourceSyncError)
    }
  } catch (error) {
    try {
      if (deploymentStarted) {
        recovery = 'FAILED'
        const baseCommitSha = candidate
          ? await gitOutput(candidate.worktreeDir, ['rev-parse', 'HEAD^'])
          : ''
        await requireCleanPinnedRepo(repo, baseCommitSha)
        log = `${log}\n${(await buildAndSyncWeb(repo, target, `${runId}-rollback`)).slice(-20_000)}`
        await verifyProduction('/v2/login')
        await writeFile(path.join(target, '.deployed-commit'), `${baseCommitSha}\n`, { mode: 0o600 })
        recovery = 'COMPLETED'
      }
    } catch (rollbackError: any) {
      recoveryError = rollbackError.message || String(rollbackError)
      log = `${log}\nROLLBACK_ERROR=${recoveryError}`
    }
    await markDeploymentFailure(runId, error, log, recovery, recoveryError)
  } finally {
    if (candidate) {
      await removeDeploymentCandidate(repo, candidate).catch((error) => {
        console.error('[autofix] 清理部署 worktree 失败:', error)
      })
    }
    if (releaseLock) await releaseLock().catch((error) => console.error('[autofix] 释放部署锁失败:', error))
  }
}

export async function executeManualRollback(runId: string) {
  const repo = sourceDir()
  const target = productionDir()
  let log = ''
  let recovery: DeploymentRecoveryState = 'NOT_REQUIRED'
  let releaseLock: (() => Promise<void>) | null = null
  try {
    if (!deploymentEnabled()) throw new Error('自动修复部署开关未启用')
    releaseLock = await acquireDeployLock(target, `${runId}-rollback`)
    const runRecord = await prisma.autoFixRun.findUnique({ where: { id: runId } })
    if (!runRecord?.commitSha || runRecord.status !== ('DEPLOYING' as any)) {
      throw new Error('当前记录不可回滚')
    }
    await requireProductionBaseline(target, runRecord.commitSha)
    recovery = 'FAILED'
    await run(repo, 'git', ['revert', '--no-edit', runRecord.commitSha], 30_000)
    log = await buildAndSyncWeb(repo, target, `${runId}-manual-rollback`)
    const health = await verifyProduction('/v2/login')
    const rollbackSha = await gitOutput(repo, ['rev-parse', 'HEAD'])
    await writeFile(path.join(target, '.deployed-commit'), `${rollbackSha}\n`, { mode: 0o600 })
    const runRecordUpdated = await prisma.autoFixRun.update({
      where: { id: runId },
      data: { status: 'ROLLED_BACK' as any, deployLog: `${log}\n${health}`.slice(-MAX_LOG_CHARS) },
    })
    await prisma.opLog.create({
      data: {
        tenantId: runRecordUpdated.tenantId,
        role: 'AI',
        action: `AI 自动修复 ${runId} 已人工一键回滚`,
        entityType: 'AutoFixRun',
        targetId: runId,
        isAi: true,
        metadata: { status: 'ROLLED_BACK', health } as any,
      },
    })
    notify({
      tenantId: runRecordUpdated.tenantId,
      event: 'AUTOFIX_ROLLED_BACK',
      eventKey: `AUTOFIX:${runId}:ROLLED_BACK`,
      payload: { runId, feedbackId: runRecordUpdated.feedbackId, health },
      bypassFrequency: true,
      bypassSilent: true,
    })
  } catch (error) {
    await markDeploymentFailure(runId, error, log, recovery)
  } finally {
    if (releaseLock) await releaseLock().catch((error) => console.error('[autofix] 释放部署锁失败:', error))
  }
}
