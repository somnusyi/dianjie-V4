import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { prisma } from '@dianjie/db'
import { sendNotification } from '../notification'
import { fireAndForget as notify } from '../notify'
import { acquireDeployLock } from './deploymentLock'
import { inspectUnifiedDiff, isAutoDeploymentEnabled } from './policy'

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

async function markFailedRollback(runId: string, error: unknown, log: string) {
  const message = error instanceof Error ? error.message : String(error)
  const run = await prisma.autoFixRun.update({
    where: { id: runId },
    data: {
      status: 'FAILED_ROLLBACK' as any,
      error: message.slice(0, 20_000),
      deployLog: log.slice(-MAX_LOG_CHARS),
    },
  })
  await prisma.opLog.create({
    data: {
      tenantId: run.tenantId,
      role: 'AI',
      action: `AI 自动修复 ${run.id} 部署失败并执行回滚`,
      entityType: 'AutoFixRun',
      targetId: run.id,
      isAi: true,
      metadata: { status: 'FAILED_ROLLBACK', error: message.slice(0, 500) } as any,
    },
  })
  notify({
    tenantId: run.tenantId,
    event: 'AUTOFIX_ESCALATED',
    eventKey: `AUTOFIX:${run.id}:FAILED_ROLLBACK`,
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
  let tempDir = ''
  let modifiedFiles: string[] = []
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
    modifiedFiles = inspection.files.map((file) => file.path)
    await requireCleanPinnedRepo(repo, runRecord.baseCommitSha)

    tempDir = await mkdtemp(path.join(os.tmpdir(), 'dianjie-autofix-deploy-'))
    const patchFile = path.join(tempDir, 'approved.patch')
    await writeFile(patchFile, runRecord.diffPatch, { mode: 0o600 })
    await run(repo, 'git', ['apply', '--check', patchFile], 30_000)
    await run(repo, 'git', ['apply', '--whitespace=error-all', patchFile], 30_000)
    await run(repo, 'git', ['add', '--', ...inspection.files.map((file) => file.path)], 30_000)
    await run(repo, 'git', [
      '-c', 'user.name=Dianjie AutoFix',
      '-c', 'user.email=autofix@localhost',
      'commit', '-m', `fix(autofix): approved run ${runRecord.id}`,
    ], 30_000)
    commitSha = await gitOutput(repo, ['rev-parse', 'HEAD'])
    await run(repo, 'git', ['tag', `autofix-${runRecord.id}`, commitSha], 30_000)

    log = await buildAndSyncWeb(repo, target, runRecord.id)
    await prisma.autoFixRun.update({
      where: { id: runRecord.id },
      data: { status: 'VERIFY_PROD' as any, commitSha, deployLog: log },
    })
    const contextPath = String((runRecord.feedback.context as any)?.path || '/v2/login')
    const health = await verifyProduction(contextPath)
    await writeFile(path.join(target, '.deployed-commit'), `${commitSha}\n`, { mode: 0o600 })
    await resolveFeedback(runRecord.id, commitSha, health, log)
  } catch (error) {
    try {
      if (commitSha) {
        await run(repo, 'git', ['revert', '--no-edit', commitSha], 30_000)
        log = `${log}\n${(await buildAndSyncWeb(repo, target, `${runId}-rollback`)).slice(-20_000)}`
        await verifyProduction('/v2/login')
        const rollbackSha = await gitOutput(repo, ['rev-parse', 'HEAD'])
        await writeFile(path.join(target, '.deployed-commit'), `${rollbackSha}\n`, { mode: 0o600 })
      } else if (modifiedFiles.length > 0) {
        await run(repo, 'git', ['restore', '--staged', '--worktree', '--', ...modifiedFiles], 30_000)
      }
    } catch (rollbackError: any) {
      log = `${log}\nROLLBACK_ERROR=${rollbackError.message || String(rollbackError)}`
    }
    await markFailedRollback(runId, error, log)
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    if (releaseLock) await releaseLock().catch((error) => console.error('[autofix] 释放部署锁失败:', error))
  }
}

export async function executeManualRollback(runId: string) {
  const repo = sourceDir()
  const target = productionDir()
  let log = ''
  let releaseLock: (() => Promise<void>) | null = null
  try {
    if (!deploymentEnabled()) throw new Error('自动修复部署开关未启用')
    releaseLock = await acquireDeployLock(target, `${runId}-rollback`)
    const runRecord = await prisma.autoFixRun.findUnique({ where: { id: runId } })
    if (!runRecord?.commitSha || runRecord.status !== ('DEPLOYING' as any)) {
      throw new Error('当前记录不可回滚')
    }
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
    await markFailedRollback(runId, error, log)
  } finally {
    if (releaseLock) await releaseLock().catch((error) => console.error('[autofix] 释放部署锁失败:', error))
  }
}
