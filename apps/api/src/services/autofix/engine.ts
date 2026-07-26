import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { prisma } from '@dianjie/db'
import { fireAndForget as notify } from '../notify'
import { qwenChat, QWEN_BUSY_FALLBACK, QWEN_NOT_CONFIGURED } from '../qwenChat'
import { executeApprovedRun } from './deployment'
import {
  inspectUnifiedDiff,
  isApprovedAutoMode,
  isAutoDeploymentEnabled,
  isAutoFixModeEnabled,
} from './policy'
import {
  buildAnalysisPrompt,
  buildPatchPrompt,
  extractUnifiedDiff,
  parseAnalysisResult,
} from './prompts'
import { collectCandidateSources, verifyPatch } from './repository'

const execFileAsync = promisify(execFile)
const ACTIVE_STATUSES = ['ANALYZING', 'PATCHING', 'VERIFYING', 'DEPLOYING', 'VERIFY_PROD'] as const
let draining = false

export interface EnqueueAutoFixInput {
  tenantId: string
  feedbackId: string
  approvedById?: string
}

function dailyCap(): number {
  const parsed = Number(process.env.AUTO_FIX_DAILY_CAP || '3')
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 20) : 3
}

function repoDir(): string {
  return process.env.AUTO_FIX_REPO_DIR || '/app/dianjie-src'
}

function staleMinutes(): number {
  const parsed = Number(process.env.AUTO_FIX_STALE_MINUTES || '60')
  return Number.isFinite(parsed) && parsed >= 15 ? Math.min(parsed, 24 * 60) : 60
}

async function audit(run: { id: string; tenantId: string }, status: string, detail?: string) {
  await prisma.opLog.create({
    data: {
      tenantId: run.tenantId,
      role: 'AI',
      action: `AI 自动修复 ${run.id} → ${status}${detail ? `: ${detail}` : ''}`.slice(0, 500),
      entityType: 'AutoFixRun',
      targetId: run.id,
      isAi: true,
      metadata: { status } as any,
    },
  })
}

async function transition(
  run: { id: string; tenantId: string },
  status: string,
  data: Record<string, unknown> = {},
  detail?: string,
) {
  await prisma.autoFixRun.update({
    where: { id: run.id },
    data: { status: status as any, ...data },
  })
  await audit(run, status, detail)
}

async function escalate(run: { id: string; tenantId: string; feedbackId?: string }, error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  await transition(run, 'ESCALATED', { error: message.slice(0, 20_000) }, message.slice(0, 300))
  notify({
    tenantId: run.tenantId,
    event: 'AUTOFIX_ESCALATED',
    eventKey: `AUTOFIX:${run.id}:ESCALATED`,
    payload: { runId: run.id, feedbackId: run.feedbackId, error: message.slice(0, 500) },
    bypassFrequency: true,
    bypassSilent: true,
  })
}

type ClaimResult =
  | { kind: 'claimed'; id: string; tenantId: string; feedbackId: string }
  | { kind: 'skipped' }

async function claimNextRun(): Promise<ClaimResult | null> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('autofix:global'))::text AS locked`
    const active = await tx.autoFixRun.count({
      where: { status: { in: [...ACTIVE_STATUSES] as any } },
    })
    if (active > 0) return null

    const run = await tx.autoFixRun.findFirst({
      where: { status: 'RECEIVED' as any },
      orderBy: { createdAt: 'asc' },
      select: { id: true, tenantId: true, feedbackId: true, createdAt: true },
    })
    if (!run) return null

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const recent = await tx.autoFixRun.count({ where: { createdAt: { gte: since } } })
    if (recent > dailyCap()) {
      await tx.autoFixRun.update({
        where: { id: run.id },
        data: { status: 'ESCALATED' as any, error: `24 小时运行数超过上限 ${dailyCap()}` },
      })
      await tx.opLog.create({
        data: {
          tenantId: run.tenantId,
          role: 'AI',
          action: `AI 自动修复 ${run.id} → ESCALATED: 超过 24 小时上限`,
          entityType: 'AutoFixRun',
          targetId: run.id,
          isAi: true,
          metadata: { status: 'ESCALATED', reason: 'daily_cap' } as any,
        },
      })
      return { kind: 'skipped' }
    }

    await tx.autoFixRun.update({ where: { id: run.id }, data: { status: 'ANALYZING' as any } })
    await tx.opLog.create({
      data: {
        tenantId: run.tenantId,
        role: 'AI',
        action: `AI 自动修复 ${run.id} → ANALYZING`,
        entityType: 'AutoFixRun',
        targetId: run.id,
        isAi: true,
        metadata: { status: 'ANALYZING' } as any,
      },
    })
    return { kind: 'claimed', id: run.id, tenantId: run.tenantId, feedbackId: run.feedbackId }
  })
}

async function currentRepoHead(sourceDir: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
    cwd: sourceDir,
    timeout: 15_000,
  })
  return stdout.trim()
}

async function processRun(run: { id: string; tenantId: string; feedbackId: string }) {
  try {
    if (!isAutoFixModeEnabled()) throw new Error('AUTO_FIX_MODE 已关闭')
    const feedback = await prisma.feedback.findFirst({
      where: { id: run.feedbackId, tenantId: run.tenantId },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
          take: 40,
          select: { role: true, content: true },
        },
      },
    })
    if (
      !feedback
      || feedback.status !== 'IN_DEV'
      || !['BUG_BLOCKING', 'IMPROVEMENT', 'NEW_FEATURE'].includes(String(feedback.category))
    ) {
      throw new Error('反馈不存在、尚未批准或不属于可开发类型')
    }
    const contextPath = String((feedback.context as any)?.path || '')
    if (!contextPath) throw new Error('反馈缺少 context.path，无法安全定位')

    const sourceDir = repoDir()
    const sources = await collectCandidateSources(sourceDir, contextPath)
    const analysisRaw = await qwenChat([
      {
        role: 'system',
        content: '你只做只读故障定位，严格输出指定 JSON，不得生成命令。',
      },
      {
        role: 'user',
        content: buildAnalysisPrompt({
          title: feedback.title,
          summary: feedback.summary,
          contextPath,
          messages: feedback.messages,
          sources,
        }),
      },
    ])
    if (analysisRaw === QWEN_BUSY_FALLBACK || analysisRaw === QWEN_NOT_CONFIGURED) {
      throw new Error(analysisRaw)
    }
    const analysis = parseAnalysisResult(analysisRaw)
    await prisma.autoFixRun.update({
      where: { id: run.id },
      data: { analysis: JSON.stringify(analysis) },
    })
    if (!analysis.inWhitelist || analysis.confidence < 0.65) {
      throw new Error(`AI 定位未通过白名单/置信度门槛 (${analysis.confidence.toFixed(2)})`)
    }

    await transition(run, 'PATCHING')
    let diffPatch = ''
    let inspection = inspectUnifiedDiff('')
    let lastPatchError = ''
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const raw = await qwenChat([
          {
            role: 'system',
            content: '你只生成最小 unified diff，不得输出命令或解释。',
          },
          {
            role: 'user',
            content: buildPatchPrompt({
              analysis: JSON.stringify(analysis),
              contextPath,
              sources,
            }),
          },
        ])
        if (raw === QWEN_BUSY_FALLBACK || raw === QWEN_NOT_CONFIGURED) throw new Error(raw)
        diffPatch = extractUnifiedDiff(raw)
        inspection = inspectUnifiedDiff(diffPatch)
        if (!inspection.ok) throw new Error(inspection.errors.join('；'))
        const candidatePaths = new Set(sources.map((source) => source.path))
        const unexpected = inspection.files.find((file) => !candidatePaths.has(file.path))
        if (unexpected) throw new Error(`补丁触碰未提供给 AI 的文件: ${unexpected.path}`)
        lastPatchError = ''
        break
      } catch (error: any) {
        lastPatchError = `第 ${attempt} 次补丁失败: ${error.message || String(error)}`
      }
    }
    if (lastPatchError) throw new Error(lastPatchError)

    await transition(run, 'VERIFYING', {
      diffPatch,
      diffFiles: inspection.files as any,
    })
    const verificationLog = await verifyPatch(sourceDir, diffPatch)
    const baseCommitSha = await currentRepoHead(sourceDir)
    const planSummary = `${analysis.rootCause}\n修改 ${inspection.files.length} 个文件、${inspection.changedLines} 行；Web 测试与类型检查通过。`

    await transition(run, 'PLAN_READY', {
      planSummary,
      baseCommitSha,
      deployLog: verificationLog,
      error: null,
    })
    if (isApprovedAutoMode()) {
      if (!isAutoDeploymentEnabled()) {
        throw new Error('一次审批自动部署模式已启用，但部署安全锁未开启')
      }
      await transition(run, 'DEPLOYING', {}, '隔离验证通过，按反馈审批授权自动部署')
      await executeApprovedRun(run.id)
      return
    }
    await transition(run, 'AWAITING_APPROVAL')
    notify({
      tenantId: run.tenantId,
      event: 'AUTOFIX_PLAN_READY',
      eventKey: `AUTOFIX:${run.id}:PLAN_READY`,
      payload: {
        runId: run.id,
        feedbackId: run.feedbackId,
        title: feedback.title || '阻断故障',
        summary: planSummary,
        fileCount: inspection.files.length,
        changedLines: inspection.changedLines,
      },
      bypassFrequency: true,
    })
  } catch (error) {
    await escalate(run, error)
  }
}

async function drainQueue() {
  if (draining || !isAutoFixModeEnabled()) return
  draining = true
  try {
    while (true) {
      const run = await claimNextRun()
      if (!run) break
      if (run.kind === 'skipped') continue
      await processRun(run)
    }
  } finally {
    draining = false
  }
}

export async function enqueueAutoFix(input: EnqueueAutoFixInput): Promise<string | null> {
  if (!isAutoFixModeEnabled()) return null
  if (isApprovedAutoMode() && !isAutoDeploymentEnabled()) {
    throw new Error('一次审批自动开发已配置，但自动部署安全锁未启用')
  }
  try {
    const run = await prisma.autoFixRun.create({
      data: {
        tenantId: input.tenantId,
        feedbackId: input.feedbackId,
        status: 'RECEIVED' as any,
        decidedById: input.approvedById,
        decidedAt: input.approvedById ? new Date() : undefined,
      },
      select: { id: true },
    })
    await audit({ id: run.id, tenantId: input.tenantId }, 'RECEIVED')
    setImmediate(() => void drainQueue())
    return run.id
  } catch (error: any) {
    if (error?.code === 'P2002') {
      const existing = await prisma.autoFixRun.findUnique({
        where: { feedbackId: input.feedbackId },
        select: { id: true },
      })
      return existing?.id ?? null
    }
    throw error
  }
}

async function recoverStaleRuns() {
  const cutoff = new Date(Date.now() - staleMinutes() * 60_000)
  const stale = await prisma.autoFixRun.findMany({
    where: {
      status: { in: [...ACTIVE_STATUSES] as any },
      updatedAt: { lt: cutoff },
    },
    select: { id: true, tenantId: true, feedbackId: true },
  })
  for (const run of stale) {
    await escalate(run, `服务重启后发现任务已停滞超过 ${staleMinutes()} 分钟，已转人工`)
  }
}

export function startAutoFixWorker() {
  if (!isAutoFixModeEnabled()) return
  setImmediate(() => {
    void recoverStaleRuns()
      .catch((error) => console.error('[autofix] 恢复停滞任务失败:', error))
      .finally(() => void drainQueue())
  })
}
