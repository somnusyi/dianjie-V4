import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
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
  prepareRevertedDeploymentCandidate,
  removeDeploymentCandidate,
  type DeploymentCandidate,
} from './deploymentCandidate'
import { acquireDeployLock, isDeployLockBusyError } from './deploymentLock'
import { planDeploymentComponents, type DeployComponent } from './changePlan'
import { inspectUnifiedDiff, isAutoDeploymentEnabled, reviewDeploymentPatch } from './policy'
import { planBaselineResolution, readProductionBaseline, requireProductionBaseline } from './productionBaseline'

const execFileAsync = promisify(execFile)
const MAX_LOG_CHARS = 40_000

/** 部署锁冲突重试策略：每 5 分钟一次，最多 12 次（1 小时窗口，与停滞看门狗阈值对齐） */
export const LOCK_RETRY_INTERVAL_MS = 5 * 60_000
export const LOCK_RETRY_MAX = 12

/**
 * 部署锁被占用时不直接转人工：保持 DEPLOYING，记录下次重试时间，由 worker 每分钟扫描恢复。
 * 返回 true 表示已成功排队等待重试。
 */
async function scheduleLockRetry(runId: string): Promise<boolean> {
  const run = await prisma.autoFixRun.findUnique({
    where: { id: runId },
    select: { tenantId: true, retryCount: true, status: true },
  })
  if (!run || run.status !== ('DEPLOYING' as any)) return false
  const attempt = run.retryCount + 1
  if (attempt > LOCK_RETRY_MAX) return false
  const nextRetryAt = new Date(Date.now() + LOCK_RETRY_INTERVAL_MS)
  await prisma.autoFixRun.update({
    where: { id: runId },
    data: {
      retryCount: attempt,
      nextRetryAt,
      error: `部署冲突中：其他发布正在执行，将于约 5 分钟后自动重试（第 ${attempt}/${LOCK_RETRY_MAX} 次）`,
    },
  })
  await prisma.opLog.create({
    data: {
      tenantId: run.tenantId,
      role: 'AI',
      action: `AI 自动修复 ${runId} 部署锁冲突，排队等待第 ${attempt}/${LOCK_RETRY_MAX} 次重试`,
      entityType: 'AutoFixRun',
      targetId: runId,
      isAi: true,
      metadata: { reason: 'deploy_lock_busy', attempt, nextRetryAt: nextRetryAt.toISOString() } as any,
    },
  })
  return true
}

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

/**
 * 解析部署基线：生产基线与开发基线不一致时，若基线只是前移且补丁能干净应用，
 * 自动把任务重基线到当前生产基线放行（避免每次人工部署与 AI 部署撞车都要老板重新批准）。
 * 分叉/回退或补丁冲突仍拒绝，需重新开发。
 */
async function resolveDeployBaseline(input: {
  repo: string
  target: string
  runId: string
  tenantId: string
  baseCommitSha: string
  diffPatch: string
}): Promise<string> {
  const { repo, target, runId, tenantId, baseCommitSha, diffPatch } = input
  const deployed = await readProductionBaseline(target)
  if (deployed === baseCommitSha) return baseCommitSha

  const isAncestor = await gitOutput(repo, ['merge-base', '--is-ancestor', baseCommitSha, deployed])
    .then(() => true)
    .catch(() => false)

  let appliesClean = false
  if (isAncestor) {
    let patchDir = ''
    try {
      await requireCleanPinnedRepo(repo, deployed)
      patchDir = await mkdtemp(path.join(os.tmpdir(), 'autofix-rebase-'))
      const patchFile = path.join(patchDir, 'approved.patch')
      await writeFile(patchFile, diffPatch, 'utf8')
      await run(repo, 'git', ['apply', '--check', patchFile], 30_000)
      appliesClean = true
    } catch {
      appliesClean = false
    } finally {
      if (patchDir) await rm(patchDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  const plan = planBaselineResolution({ base: baseCommitSha, deployed, isAncestor, appliesClean })
  if (plan === 'rebase') {
    await prisma.autoFixRun.update({
      where: { id: runId },
      data: { baseCommitSha: deployed },
    })
    await prisma.opLog.create({
      data: {
        tenantId,
        role: 'AI',
        action: `AI 自动修复 ${runId} 自动重基线: ${baseCommitSha.slice(0, 8)} → ${deployed.slice(0, 8)}（基线前移且补丁可干净应用）`.slice(0, 500),
        entityType: 'AutoFixRun',
        targetId: runId,
        isAi: true,
        metadata: { reason: 'auto_rebase_forward', from: baseCommitSha, to: deployed } as any,
      },
    })
    return deployed
  }
  if (plan === 'reject_diverged') {
    throw new Error(`生产基线与开发基线分叉或回退（开发基线 ${baseCommitSha}，生产 ${deployed}），需重新开发`)
  }
  throw new Error(`生产基线前移但补丁无法干净应用到新基线 ${deployed}，需重新开发`)
}

/** 单条部署命令：command + args 数组，绝不拼 shell 字符串。 */
export interface DeployCommand {
  label: string
  command: string
  args: string[]
  cwd: string
  timeoutMs: number
}

/**
 * 不触碰生产的纯部署计划：由变更文件路径推导需要发布的运行时组件，
 * 并按「先全部构建 → 统一备份受影响生产目录 → 再同步/重启」的阶段排好命令。
 * 正常发布与失败恢复/人工回滚共用同一份 changedPaths，保证恢复相同组件，绝不退化为只恢复 Web。
 */
export interface DeploymentPlan {
  components: DeployComponent[]
  web: boolean
  api: boolean
  /** 无运行组件（如仅测试改动）：不构建、不备份、不同步、不重启 */
  noRuntime: boolean
  /** 阶段一：所有组件的构建命令（先于备份与同步全部完成） */
  builds: DeployCommand[]
  /** 阶段二：备份受影响生产目录（mkdir + 单个 tar，混合时一个包含两目录） */
  backups: DeployCommand[]
  /** 阶段三：把候选产物同步到生产 */
  syncs: DeployCommand[]
  /** 阶段四：重启对应 pm2 进程 */
  restarts: DeployCommand[]
  /** 备份归档绝对路径；noRuntime 时为 null */
  backupArchivePath: string | null
  /** 受影响的生产目录（相对 target），用于日志与校验 */
  backupDirs: string[]
}

export interface PlanDeploymentInput {
  /** 候选 worktree（正常发布）或源码副本（恢复）目录，构建与同步的来源 */
  repo: string
  /** 生产目录 */
  target: string
  runId: string
  /** 原始变更文件路径（正常/恢复/回滚必须一致） */
  changedPaths: string[]
  /** 备份目录，默认 /app/backups */
  backupDir?: string
  /** 备份归档时间戳，默认 Date.now()；测试可注入以保证确定性 */
  timestamp?: number
}

export function planDeployment(input: PlanDeploymentInput): DeploymentPlan {
  const { repo, target, runId, changedPaths } = input
  const backupDir = input.backupDir ?? '/app/backups'
  const timestamp = input.timestamp ?? Date.now()
  const { components, web, api } = planDeploymentComponents(changedPaths)
  const noRuntime = components.length === 0

  const builds: DeployCommand[] = []
  const syncs: DeployCommand[] = []
  const restarts: DeployCommand[] = []
  const backupDirs: string[] = []

  if (web) {
    builds.push({
      label: 'Web 构建',
      command: 'pnpm',
      args: ['--filter', '@dianjie/web', 'build'],
      cwd: repo,
      timeoutMs: 600_000,
    })
    backupDirs.push('apps/web/apps/web')
    const standalone = path.join(repo, 'apps/web/.next/standalone/apps/web/')
    const staticDir = path.join(repo, 'apps/web/.next/static/')
    const publicDir = path.join(repo, 'apps/web/public/')
    syncs.push(
      {
        label: 'Web 同步 standalone',
        command: 'rsync',
        args: ['-az', '--delete', standalone, `${target}/apps/web/apps/web/`],
        cwd: repo,
        timeoutMs: 120_000,
      },
      {
        label: 'Web 同步 static',
        command: 'rsync',
        args: ['-az', '--delete', staticDir, `${target}/apps/web/apps/web/.next/static/`],
        cwd: repo,
        timeoutMs: 120_000,
      },
      {
        label: 'Web 同步 public',
        command: 'rsync',
        args: ['-az', '--delete', publicDir, `${target}/apps/web/apps/web/public/`],
        cwd: repo,
        timeoutMs: 120_000,
      },
    )
    // 不带 --update-env：API 进程自身的 PORT=4004 不能污染 Web 的 3204 配置。
    restarts.push({
      label: 'Web 重启',
      command: 'pm2',
      args: ['restart', 'dianjie-v4-web'],
      cwd: repo,
      timeoutMs: 60_000,
    })
  }

  if (api) {
    builds.push({
      label: 'API 构建',
      command: 'pnpm',
      args: ['--filter', '@dianjie/api', 'build'],
      cwd: repo,
      timeoutMs: 600_000,
    })
    // 只同步编译产物 dist：绝不触碰 package/schema/migration/依赖/环境变量。
    backupDirs.push('apps/api/dist')
    const distDir = path.join(repo, 'apps/api/dist/')
    syncs.push({
      label: 'API 同步 dist',
      command: 'rsync',
      args: ['-az', '--delete', distDir, `${target}/apps/api/dist/`],
      cwd: repo,
      timeoutMs: 120_000,
    })
    // 不带 --update-env，避免污染 Web 的 3204 配置。
    restarts.push({
      label: 'API 重启',
      command: 'pm2',
      args: ['restart', 'dianjie-v4-api'],
      cwd: repo,
      timeoutMs: 60_000,
    })
  }

  const backups: DeployCommand[] = []
  let backupArchivePath: string | null = null
  if (!noRuntime) {
    backupArchivePath = `${backupDir}/autofix-${components.join('-')}-${runId}-${timestamp}.tar.gz`
    backups.push(
      { label: '创建备份目录', command: 'mkdir', args: ['-p', backupDir], cwd: target, timeoutMs: 30_000 },
      {
        label: `备份生产目录(${backupDirs.join(',')})`,
        command: 'tar',
        args: ['-czf', backupArchivePath, '-C', target, ...backupDirs],
        cwd: target,
        timeoutMs: 120_000,
      },
    )
  }

  return {
    components,
    web,
    api,
    noRuntime,
    builds,
    backups,
    syncs,
    restarts,
    backupArchivePath,
    backupDirs,
  }
}

async function runCommand(cmd: DeployCommand): Promise<RunCommandResult> {
  return run(cmd.cwd, cmd.command, cmd.args, cmd.timeoutMs)
}

/**
 * 按计划执行生产发布：先全部构建，再统一备份，最后同步并重启。
 * noRuntime（仅测试改动）时不触碰生产，仅记录跳过日志。
 */
async function executeDeploymentPlan(plan: DeploymentPlan): Promise<string> {
  const logs: string[] = []
  if (plan.noRuntime) {
    logs.push('[deploy] 无运行组件变更（仅测试/非运行产物），跳过构建/备份/同步/重启')
    return logs.join('\n').slice(-MAX_LOG_CHARS)
  }
  logs.push(`[deploy] 组件=${plan.components.join('+')} 备份=${plan.backupArchivePath}`)
  for (const cmd of plan.builds) logs.push((await runCommand(cmd)).output)
  for (const cmd of plan.backups) logs.push((await runCommand(cmd)).output)
  for (const cmd of plan.syncs) logs.push((await runCommand(cmd)).output)
  for (const cmd of plan.restarts) logs.push((await runCommand(cmd)).output)
  return `${logs.join('\n')}\nbackup=${plan.backupArchivePath}`.slice(-MAX_LOG_CHARS)
}

/**
 * 从已部署补丁推导回滚文件路径；解析失败返回空数组。
 *
 * 回滚不受当前 core API 准入开关影响，否则开关关闭后会失去恢复既有发布的能力。
 * 认证、资金、数据库等永久红线仍由 inspectUnifiedDiff 拒绝。
 */
export function changedPathsForRollback(diffPatch: string | null | undefined): string[] {
  if (!diffPatch) return []
  // 回滚必须能恢复此前已获批准并部署的核心 API，即使准入开关后来已关闭。
  // 这里仅放宽 core_business 路径解析；认证、资金、数据库等永久红线仍会被拒绝。
  const inspection = inspectUnifiedDiff(diffPatch, { allowCoreBusinessApi: true })
  if (!inspection.ok) return []
  return inspection.files.map((file) => file.path)
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
    if (run.feedback) {
      await tx.feedback.update({ where: { id: run.feedback.id }, data: { status: 'RESOLVED' } })
      await tx.feedbackMessage.create({
        data: {
          tenantId: run.tenantId,
          feedbackId: run.feedback.id,
          role: 'assistant',
          content: '该反馈已由管理员批准，系统完成自动修复和生产验证，问题已标记为解决。如仍有异常请继续留言。',
        },
      })
    }
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

  if (result.feedback) {
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
      refId: result.feedback.id,
      dedupeKey: `AUTOFIX_RESULT:${result.id}:resolved`,
    }).catch((error) => console.error('[autofix] 提报人通知失败:', error))
  } else if (result.decidedById) {
    // 超管聊天任务: 部署结果回写到聊天记录
    await prisma.bossChatMessage.create({
      data: {
        tenantId: result.tenantId,
        userId: result.decidedById,
        role: 'assistant',
        runId: result.id,
        content: '已部署上线并通过生产健康检查。',
      },
    }).catch((error) => console.error('[boss-chat] 部署结果回写失败:', error))
  }

  notify({
    tenantId: result.tenantId,
    event: 'AUTOFIX_RESOLVED',
    eventKey: `AUTOFIX:${result.id}:RESOLVED`,
    payload: { runId: result.id, feedbackId: result.feedbackId ?? undefined, commitSha, health },
    bypassFrequency: true,
  })
}

function sourceRemote(): string {
  return process.env.AUTO_FIX_GIT_REMOTE || 'git@github-dianjie:somnusyi/dianjie-V4.git'
}

export function autoFixCandidateRef(runId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error('自动修复任务 ID 不能用于远程引用')
  return `refs/heads/autofix/candidates/${runId}`
}

/**
 * 在触碰生产前把不可变候选提交持久化到远程专用分支。
 * 远程不可写时直接失败，生产不会开始部署。
 */
async function persistCandidateSource(
  repo: string,
  runId: string,
  tenantId: string,
  commitSha: string,
): Promise<void> {
  const remote = sourceRemote()
  const ref = autoFixCandidateRef(runId)
  await run(repo, 'git', ['push', remote, `${commitSha}:${ref}`], 60_000)
  await prisma.opLog.create({
    data: {
      tenantId,
      role: 'AI',
      action: `AI 自动修复 ${runId} 候选源码已持久化，允许进入生产发布`,
      entityType: 'AutoFixRun',
      targetId: runId,
      isAi: true,
      metadata: { reason: 'remote_candidate_persisted', commitSha, ref } as any,
    },
  })
}

/**
 * 生产验证通过后，以显式 lease 把候选提交晋升为远程 main。
 * 若 main 已被其他发布推进，晋升失败并触发生产回滚，避免生产领先源码主线。
 */
async function promoteCandidateMain(
  repo: string,
  runId: string,
  tenantId: string,
  expectedBase: string,
  commitSha: string,
): Promise<void> {
  const remote = sourceRemote()
  const ref = autoFixCandidateRef(runId)
  await run(repo, 'git', [
    'push',
    `--force-with-lease=refs/heads/main:${expectedBase}`,
    remote,
    `${commitSha}:refs/heads/main`,
  ], 60_000)
  await prisma.opLog.create({
    data: {
      tenantId,
      role: 'AI',
      action: `AI 自动修复 ${runId} 已晋升远程 main`,
      entityType: 'AutoFixRun',
      targetId: runId,
      isAi: true,
      metadata: { reason: 'remote_main_promoted', commitSha, expectedBase } as any,
    },
  })
  await run(repo, 'git', ['push', remote, '--delete', ref], 60_000)
    .catch((error) => console.error('[autofix] 清理远程候选分支失败:', error))
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

async function markPostPromotionFailure(runId: string, error: unknown, log: string) {
  const message = error instanceof Error ? error.message : String(error)
  const run = await prisma.autoFixRun.update({
    where: { id: runId },
    data: {
      status: 'ESCALATED' as any,
      error: `生产与远程源码已更新，但发布收尾失败：${message}`.slice(0, 20_000),
      deployLog: log.slice(-MAX_LOG_CHARS),
    },
  })
  await prisma.opLog.create({
    data: {
      tenantId: run.tenantId,
      role: 'AI',
      action: `AI 自动修复 ${run.id} 生产与远程源码已更新，但发布收尾失败，已转人工`,
      entityType: 'AutoFixRun',
      targetId: run.id,
      isAi: true,
      metadata: {
        status: 'ESCALATED',
        reason: 'post_promotion_finalize_failed',
        error: message.slice(0, 500),
      } as any,
    },
  })
}

export async function executeApprovedRun(runId: string) {
  const repo = sourceDir()
  const target = productionDir()
  let commitSha = ''
  let log = ''
  let changedPaths: string[] = []
  let candidate: DeploymentCandidate | null = null
  let deploymentStarted = false
  let recovery: DeploymentRecoveryState = 'NOT_REQUIRED'
  let recoveryError = ''
  let remotePromoted = false
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
    // 部署前重新检查同一开关：开关关闭时，即使补丁此前已生成也必须拒绝部署。
    // 永久红线（认证/权限/资金/schema/迁移等）不受开关影响，始终拒绝。
    const inspection = reviewDeploymentPatch(runRecord.diffPatch)
    if (!inspection.ok) throw new Error(inspection.errors.join('；'))
    // 原始变更路径：正常发布与失败恢复共用，保证恢复相同组件。
    changedPaths = inspection.files.map((file) => file.path)
    const effectiveBase = await resolveDeployBaseline({
      repo,
      target,
      runId: runRecord.id,
      tenantId: runRecord.tenantId,
      baseCommitSha: runRecord.baseCommitSha,
      diffPatch: runRecord.diffPatch,
    })
    await requireCleanPinnedRepo(repo, effectiveBase)

    candidate = await preparePatchedDeploymentCandidate({
      repo,
      baseCommitSha: effectiveBase,
      diffPatch: runRecord.diffPatch,
      files: changedPaths,
      runId: runRecord.id,
    })
    commitSha = candidate.commitSha
    await run(repo, 'git', ['tag', `autofix-${runRecord.id}`, commitSha], 30_000)
    await persistCandidateSource(repo, runRecord.id, runRecord.tenantId, commitSha)

    deploymentStarted = true
    const deployPlan = planDeployment({
      repo: candidate.worktreeDir,
      target,
      runId: runRecord.id,
      changedPaths,
    })
    log = await executeDeploymentPlan(deployPlan)
    await prisma.autoFixRun.update({
      where: { id: runRecord.id },
      data: { status: 'VERIFY_PROD' as any, commitSha, deployLog: log, nextRetryAt: null },
    })
    const contextPath = String((runRecord.feedback?.context as any)?.path || '/v2/login')
    const health = await verifyProduction(contextPath)
    await writeFile(path.join(target, '.deployed-commit'), `${commitSha}\n`, { mode: 0o600 })
    await promoteCandidateMain(
      repo,
      runRecord.id,
      runRecord.tenantId,
      effectiveBase,
      commitSha,
    )
    remotePromoted = true
    await requireCleanPinnedRepo(repo, effectiveBase)
    await run(repo, 'git', ['merge', '--ff-only', commitSha], 30_000)
    await resolveFeedback(runRecord.id, commitSha, health, log)
  } catch (error) {
    if (remotePromoted) {
      await markPostPromotionFailure(runId, error, log)
      return
    }
    // 部署锁冲突且尚未开始部署：排队等待自动重试（每 5 分钟），不转人工、无需回滚
    if (isDeployLockBusyError(error) && !deploymentStarted) {
      const scheduled = await scheduleLockRetry(runId).catch((retryError) => {
        console.error('[autofix] 部署锁重试排队失败:', retryError)
        return false
      })
      if (scheduled) return
      await markDeploymentFailure(
        runId,
        new Error(`部署锁冲突重试 ${LOCK_RETRY_MAX} 次后仍被占用，转人工处理`),
        log,
        'NOT_REQUIRED',
        '',
      )
      return
    }
    try {
      if (deploymentStarted) {
        recovery = 'FAILED'
        const baseCommitSha = candidate
          ? await gitOutput(candidate.worktreeDir, ['rev-parse', 'HEAD^'])
          : ''
        await requireCleanPinnedRepo(repo, baseCommitSha)
        // 恢复使用与正常发布相同的 changedPaths，保证回滚相同组件，不退化为只恢复 Web。
        const recoveryPlan = planDeployment({
          repo,
          target,
          runId: `${runId}-rollback`,
          changedPaths,
        })
        log = `${log}\n${(await executeDeploymentPlan(recoveryPlan)).slice(-20_000)}`
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
  let changedPaths: string[] = []
  let recovery: DeploymentRecoveryState = 'NOT_REQUIRED'
  let recoveryError = ''
  let candidate: DeploymentCandidate | null = null
  let deploymentStarted = false
  let remotePromoted = false
  let releaseLock: (() => Promise<void>) | null = null
  try {
    if (!deploymentEnabled()) throw new Error('自动修复部署开关未启用')
    releaseLock = await acquireDeployLock(target, `${runId}-rollback`)
    const runRecord = await prisma.autoFixRun.findUnique({ where: { id: runId } })
    if (!runRecord?.commitSha || runRecord.status !== ('DEPLOYING' as any)) {
      throw new Error('当前记录不可回滚')
    }
    // 原始变更路径：与原部署一致，保证回滚相同组件，不退化为只恢复 Web。
    changedPaths = changedPathsForRollback(runRecord.diffPatch)
    if (changedPaths.length === 0) {
      // 兜底：补丁不可用时从已部署提交反推改动文件。
      const names = await gitOutput(repo, [
        'diff-tree', '--no-commit-id', '--name-only', '-r', runRecord.commitSha,
      ])
      changedPaths = names.split('\n').map((line) => line.trim()).filter(Boolean)
    }
    await requireProductionBaseline(target, runRecord.commitSha)
    await requireCleanPinnedRepo(repo, runRecord.commitSha)
    candidate = await prepareRevertedDeploymentCandidate({
      repo,
      deployedCommitSha: runRecord.commitSha,
      runId: runRecord.id,
    })
    const rollbackSha = candidate.commitSha
    await run(repo, 'git', ['tag', `autofix-rollback-${runRecord.id}`, rollbackSha], 30_000)
    await persistCandidateSource(repo, `${runRecord.id}-rollback`, runRecord.tenantId, rollbackSha)

    deploymentStarted = true
    const rollbackPlan = planDeployment({
      repo: candidate.worktreeDir,
      target,
      runId: `${runId}-manual-rollback`,
      changedPaths,
    })
    log = await executeDeploymentPlan(rollbackPlan)
    const health = await verifyProduction('/v2/login')
    await writeFile(path.join(target, '.deployed-commit'), `${rollbackSha}\n`, { mode: 0o600 })
    await promoteCandidateMain(
      repo,
      `${runRecord.id}-rollback`,
      runRecord.tenantId,
      runRecord.commitSha,
      rollbackSha,
    )
    remotePromoted = true
    await requireCleanPinnedRepo(repo, runRecord.commitSha)
    await run(repo, 'git', ['merge', '--ff-only', rollbackSha], 30_000)
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
    if (remotePromoted) {
      await markPostPromotionFailure(runId, error, log)
      return
    }
    try {
      if (deploymentStarted) {
        recovery = 'FAILED'
        const deployedCommitSha = candidate
          ? await gitOutput(candidate.worktreeDir, ['rev-parse', 'HEAD^'])
          : ''
        await requireCleanPinnedRepo(repo, deployedCommitSha)
        // 恢复使用与回滚相同的 changedPaths，保证恢复相同组件。
        const restorePlan = planDeployment({
          repo,
          target,
          runId: `${runId}-manual-rollback-restore`,
          changedPaths,
        })
        log = `${log}\n${(await executeDeploymentPlan(restorePlan)).slice(-20_000)}`
        await verifyProduction('/v2/login')
        await writeFile(path.join(target, '.deployed-commit'), `${deployedCommitSha}\n`, { mode: 0o600 })
        recovery = 'COMPLETED'
      }
    } catch (restoreError: any) {
      recoveryError = restoreError.message || String(restoreError)
      log = `${log}\nROLLBACK_ERROR=${recoveryError}`
    }
    await markDeploymentFailure(runId, error, log, recovery, recoveryError)
  } finally {
    if (candidate) {
      await removeDeploymentCandidate(repo, candidate).catch((error) => {
        console.error('[autofix] 清理回滚 worktree 失败:', error)
      })
    }
    if (releaseLock) await releaseLock().catch((error) => console.error('[autofix] 释放部署锁失败:', error))
  }
}
