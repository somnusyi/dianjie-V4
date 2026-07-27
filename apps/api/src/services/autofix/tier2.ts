/**
 * 档2: Qwen Code 服务器侧开发管线（白名单拒绝后的升级通道）
 *
 * 档1 引擎判定需求超出前端白名单（需后端/数据等变更）时, 不再直接转人工:
 *   prepareTier2TaskBook  生成开发任务书 → 反馈回到待审批(方案卡片)
 *   老板手机批准 → runTier2Dev  隔离 worktree 里跑 Qwen Code → 独立复验 → DEPLOY_REVIEW
 *   老板二次批准 → 既有 executeApprovedRun(diffPatch) 安全发布
 *
 * v1 范围: 只允许 apps/web 改动（部署机只构建 Web）。需要 API/schema 的任务书
 * 生成阶段就会被要求拒绝, 落在 DEPLOY_REVIEW 前还有 diff 白名单二次把关。
 */
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { prisma } from '@dianjie/db'
import { fireAndForget as notify } from '../notify'
import { qwenChat, QWEN_BUSY_FALLBACK, QWEN_NOT_CONFIGURED } from '../qwenChat'
import { inspectUnifiedDiff } from './policy'
import { requireCleanRepoHead } from './repository'

const execFileAsync = promisify(execFile)
const QWEN_DEV_TIMEOUT_MS = Number(process.env.TIER2_QWEN_TIMEOUT_MS || 20 * 60_000)
const MAX_TASKBOOK_CHARS = 12_000

function repoDir(): string {
  return process.env.AUTO_FIX_REPO_DIR || '/app/dianjie-src'
}

function qwenBin(): string {
  return process.env.TIER2_QWEN_BIN || 'qwen'
}

function qwenEnvFile(): string {
  return process.env.TIER2_QWEN_ENV_FILE || '/root/.qwen/.env'
}

async function loadQwenEnv(): Promise<Record<string, string>> {
  try {
    const raw = await readFile(qwenEnvFile(), 'utf8')
    const env: Record<string, string> = {}
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
    return env
  } catch {
    return {}
  }
}

/** 从 git status --porcelain 输出提取变更路径（过滤 node_modules 链接）。 */
export function parseChangedPaths(porcelain: string): string[] {
  const paths: string[] = []
  for (const line of porcelain.split('\n')) {
    if (!line.trim()) continue
    const raw = line.slice(3).trim()
    const renamed = raw.includes(' -> ') ? raw.split(' -> ')[1] : raw
    const p = renamed.replace(/^"|"$/g, '')
    if (p && p !== 'node_modules' && !p.startsWith('node_modules/')) paths.push(p)
  }
  return [...new Set(paths)]
}

/** 档2 v1 白名单: 只允许 apps/web 内的改动。返回越界文件列表（空数组=通过）。 */
export function findOutOfScopeFiles(paths: string[]): string[] {
  return paths.filter((p) => !p.startsWith('apps/web/'))
}

/** 从 porcelain 输出提取未跟踪文件（新建文件走不进 diff 补丁，必须显式拒绝）。 */
export function findUntrackedFiles(porcelain: string): string[] {
  const paths: string[] = []
  for (const line of porcelain.split('\n')) {
    if (!line.startsWith('??')) continue
    const p = line.slice(3).trim().replace(/^"|"$/g, '')
    if (p && p !== 'node_modules' && !p.startsWith('node_modules/')) paths.push(p)
  }
  return paths
}

export function buildTaskBookPrompt(input: {
  title?: string | null
  summary?: string | null
  contextPath: string
  messages: Array<{ role: string; content: string }>
  rootCause: string
  candidateFiles: string[]
}): string {
  return `你是滇界系统的开发任务书撰写员。一个用户反馈已被管理员批准，但档1自动修复判定它超出前端小修复白名单。现在要把需求整理成一份给服务器端 AI 编程代理（Qwen Code）执行的开发任务书。

反馈标题: ${input.title || '未命名'}
反馈摘要: ${input.summary || '无'}
页面路径: ${input.contextPath}
反馈对话:
${input.messages.map((m) => `[${m.role}] ${m.content}`).join('\n')}

档1定位结论: ${input.rootCause}
档1候选文件: ${input.candidateFiles.join(', ') || '无'}

写一份 Markdown 任务书，结构固定为:
# 任务: <一句话标题>
## 背景与问题
<用户场景、真实卡点、涉及的现有机制（点名文件/函数/接口）>
## 要求（全部必须满足）
<逐条编号的具体实现要求，含交互细节、错误处理、复用哪些现有接口/纯函数/组件>
## 禁区
<列出不得修改的文件/机制>
## 验收
<必须运行通过的命令，统一为: pnpm --filter @dianjie/web test 和 pnpm exec tsc -p apps/web/tsconfig.json --noEmit>

硬约束:
- 只允许修改 apps/web 内的**现有**文件；不得新建、删除、重命名任何文件（部署以 diff 补丁发布，新文件会丢失）
- 凡需要改 API、数据库 schema、库存/资金/权限 的需求，不要写任务书，直接输出一行: REJECT: <原因>
- 优先复用既有 API 端点与纯函数，任务书中要点名可复用的接口路径和函数名
- 要求必须具体到可验收，禁止"优化一下""完善体验"这类模糊表述
- 改动总量控制在 5 个文件、200 行以内，超出就说明拆分建议
- 全文不超过 2000 字，直接输出任务书正文，不要解释`
}

/**
 * 统一 agent 简报：老板批准后直接交给 Qwen Code，自己定位/设计/开发/自测。
 * 取代档1的单轮 diff 生成（大页面必超时、hunk 脆弱）。
 */
export function buildAgentBrief(input: {
  title?: string | null
  summary?: string | null
  contextPath: string
  messages: Array<{ role: string; content: string }>
}): string {
  return `# 任务: 处理一条已获管理员批准的用户反馈

## 反馈内容
标题: ${input.title || '未命名'}
摘要: ${input.summary || '无'}
页面路径: ${input.contextPath}
对话记录:
${input.messages.map((m) => `[${m.role}] ${m.content}`).join('\n')}

## 工作方式（你是 agent，自己动手）
1. 先阅读页面路径对应的路由组件与相关代码，定位问题/需求点，自行设计最小方案
2. 修改代码，然后运行 \`pnpm --filter @dianjie/web test\` 和 \`pnpm exec tsc -p apps/web/tsconfig.json --noEmit\`，有失败就修到全部通过

## 硬约束（违反将被拒绝发布）
- 只允许修改 apps/web 内的**现有**文件；不得新建、删除、重命名文件
- 总改动不超过 5 个文件、200 行
- 不得修改认证、权限、资金、库存、数据库 schema、依赖、部署配置
- 若需求必须触碰以上禁区: 不要改任何代码，直接回复 REJECT: <原因> 并停止

## 交付
最后输出: 修改文件清单（相对路径）、每个文件的改动说明、两条验证命令的结果。`
}

/** 老板批准后统一入口: 直接创建 agent 开发任务并立即开工。 */
export async function enqueueAgentDev(input: {
  tenantId: string
  feedbackId: string
  approvedById?: string
}): Promise<string | null> {
  try {
    const run = await prisma.autoFixRun.create({
      data: {
        tenantId: input.tenantId,
        feedbackId: input.feedbackId,
        status: 'QWEN_DEV' as any,
        decidedById: input.approvedById,
        decidedAt: input.approvedById ? new Date() : undefined,
      },
      select: { id: true },
    })
    await prisma.opLog.create({
      data: {
        tenantId: input.tenantId,
        role: 'AI',
        action: `AI agent 开发 ${run.id} → QWEN_DEV（批准后直接开工）`.slice(0, 500),
        entityType: 'AutoFixRun',
        targetId: run.id,
        isAi: true,
        metadata: { status: 'QWEN_DEV', mode: 'unified_agent' } as any,
      },
    })
    setImmediate(() => void runTier2Dev(run.id).catch((e) => console.error('[agent] 开发执行异常:', e)))
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

interface Tier2Analysis {
  rootCause: string
  candidateFiles: string[]
  inWhitelist: boolean
  confidence: number
  taskBook?: string
}

async function transitionRun(
  run: { id: string; tenantId: string },
  status: string,
  data: Record<string, unknown> = {},
  detail?: string,
) {
  await prisma.autoFixRun.update({ where: { id: run.id }, data: { status: status as any, ...data } })
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

async function escalateTier2(run: { id: string; tenantId: string; feedbackId: string }, error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  await transitionRun(run, 'ESCALATED', { error: message.slice(0, 20_000) }, message.slice(0, 300))
  notify({
    tenantId: run.tenantId,
    event: 'AUTOFIX_ESCALATED',
    eventKey: `AUTOFIX:${run.id}:ESCALATED:TIER2`,
    payload: { runId: run.id, feedbackId: run.feedbackId, error: message.slice(0, 500) },
    bypassFrequency: true,
    bypassSilent: true,
  })
}

/** 白名单拒绝后的入口: 生成任务书并把反馈送回老板手机待审批。 */
export async function prepareTier2TaskBook(input: {
  run: { id: string; tenantId: string; feedbackId: string }
  feedback: {
    id: string
    title: string | null
    summary: string | null
    context: unknown
    messages: Array<{ role: string; content: string }>
  }
  analysis: Tier2Analysis
}): Promise<'prepared' | 'rejected'> {
  const { run, feedback, analysis } = input
  const contextPath = String((feedback.context as any)?.path || '')
  const raw = await qwenChat([
    { role: 'system', content: '你是开发任务书撰写员，只做文档，不改代码。拿不准范围就选拒绝。' },
    {
      role: 'user',
      content: buildTaskBookPrompt({
        title: feedback.title,
        summary: feedback.summary,
        contextPath,
        messages: feedback.messages,
        rootCause: analysis.rootCause,
        candidateFiles: analysis.candidateFiles,
      }),
    },
  ])
  if (raw === QWEN_BUSY_FALLBACK || raw === QWEN_NOT_CONFIGURED) throw new Error(raw)

  const trimmed = raw.trim()
  if (/^REJECT[:：]/i.test(trimmed)) {
    const reason = trimmed.replace(/^REJECT[:：]\s*/i, '').slice(0, 500)
    await prisma.feedbackMessage.create({
      data: {
        tenantId: run.tenantId,
        feedbackId: run.feedbackId,
        role: 'assistant',
        content: `该需求经评估涉及核心数据或超出自动开发安全范围（${reason || '原因见审批详情'}），已转人工评估处理。`,
      },
    })
    throw new Error(`档2任务书评估拒绝: ${reason || '涉及核心数据或超出安全范围'}`)
  }

  const taskBook = trimmed.slice(0, MAX_TASKBOOK_CHARS)
  const storedAnalysis: Tier2Analysis = { ...analysis, taskBook }
  await transitionRun(run, 'TASKBOOK_READY', {
    analysis: JSON.stringify(storedAnalysis),
    error: null,
    planSummary: taskBook.split('\n')[0].slice(0, 300),
  })
  await prisma.feedback.update({
    where: { id: run.feedbackId },
    data: {
      status: 'AWAITING_APPROVAL' as any,
      proposal: `【自动开发方案】\n${taskBook}`.slice(0, 10_000),
    },
  })
  await prisma.feedbackMessage.create({
    data: {
      tenantId: run.tenantId,
      feedbackId: run.feedbackId,
      role: 'assistant',
      content: '已生成自动开发方案并提交管理员审批，批准后将由服务器 AI 在隔离环境开发、测试，进展会在消息中心通知你。',
    },
  })
  notify({
    tenantId: run.tenantId,
    event: 'FEEDBACK_APPROVAL_PENDING',
    eventKey: `FEEDBACK:${run.feedbackId}:TIER2_PLAN`,
    payload: {
      feedbackId: run.feedbackId,
      category: 'IMPROVEMENT',
      title: feedback.title || '自动开发方案待审批',
      summary: `档2方案已生成，待批准开发: ${taskBook.split('\n')[0].slice(0, 120)}`,
    },
  })
  return 'prepared'
}

/** 老板批准方案后: 隔离 worktree 里跑 Qwen Code，独立复验，产出可部署 diff。 */
export async function runTier2Dev(runId: string): Promise<void> {
  const run = await prisma.autoFixRun.findUnique({
    where: { id: runId },
    include: { feedback: { include: { messages: { orderBy: { createdAt: 'asc' }, take: 40 } } } },
  })
  if (!run || run.status !== ('QWEN_DEV' as any)) return
  const repo = repoDir()
  const worktreeDir = `/tmp/qwen-tier2-${run.id}`
  try {
    const analysis = JSON.parse(run.analysis || '{}') as Tier2Analysis
    // 统一 agent 模式没有档1分析，直接由反馈内容构建简报
    const brief = analysis.taskBook || buildAgentBrief({
      title: run.feedback.title,
      summary: run.feedback.summary,
      contextPath: String((run.feedback.context as any)?.path || ''),
      messages: run.feedback.messages,
    })
    const baseCommitSha = await requireCleanRepoHead(repo)

    await git(repo, ['worktree', 'remove', '--force', worktreeDir]).catch(() => undefined)
    await git(repo, ['worktree', 'add', '--detach', worktreeDir, baseCommitSha])
    await execFileAsync('ln', ['-sfn', `${repo}/node_modules`, `${worktreeDir}/node_modules`], { timeout: 30_000 })

    const qwenEnv = await loadQwenEnv()
    let qwenLog = ''
    try {
      const { stdout, stderr } = await execFileAsync(
        qwenBin(),
        ['-p', brief, '--yolo'],
        {
          cwd: worktreeDir,
          timeout: QWEN_DEV_TIMEOUT_MS,
          maxBuffer: 4 * 1024 * 1024,
          env: { ...process.env, ...qwenEnv, CI: '1' },
        },
      )
      qwenLog = `${stdout || ''}${stderr || ''}`.slice(-20_000)
    } catch (error: any) {
      const partial = `${error?.stdout || ''}${error?.stderr || ''}`.slice(-4_000)
      throw new Error(`Qwen Code 开发失败或超时: ${error?.message || error}${partial ? `\n${partial}` : ''}`)
    }

    // 核定改动范围：新建文件走不进 diff 补丁（部署会丢），显式拒绝；
    // 同时 policy 层也禁止 new file mode，双保险。
    const porcelain = await git(worktreeDir, ['status', '--porcelain'])
    const untracked = findUntrackedFiles(porcelain)
    if (untracked.length > 0) {
      throw new Error(`档2禁止新建文件（补丁会丢失）: ${untracked.join(', ')}`)
    }
    const changed = parseChangedPaths(porcelain)
    if (changed.length === 0) {
      const rejectMatch = /REJECT[:：]\s*(.+)/.exec(qwenLog)
      if (rejectMatch) throw new Error(`agent 评估拒绝开发: ${rejectMatch[1].slice(0, 300)}`)
      throw new Error(`Qwen Code 未产生任何改动\n${qwenLog.slice(-2_000)}`)
    }
    const outOfScope = findOutOfScopeFiles(changed)
    if (outOfScope.length > 0) {
      throw new Error(`档2改动越出 apps/web 白名单: ${outOfScope.join(', ')}`)
    }

    // 独立复验：不信 AI 自报
    await execFileAsync('pnpm', ['--filter', '@dianjie/web', 'test'], {
      cwd: worktreeDir, timeout: 300_000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, CI: '1', NODE_ENV: 'test' },
    })
    await execFileAsync('pnpm', ['exec', 'tsc', '-p', 'apps/web/tsconfig.json', '--noEmit'], {
      cwd: worktreeDir, timeout: 300_000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, CI: '1', NODE_ENV: 'test' },
    })

    const diffPatch = await git(worktreeDir, ['diff'])
    const inspection = inspectUnifiedDiff(`${diffPatch}\n`)
    if (!inspection.ok) throw new Error(inspection.errors.join('；'))

    await transitionRun(run, 'DEPLOY_REVIEW', {
      diffPatch: `${diffPatch}\n`,
      diffFiles: inspection.files as any,
      baseCommitSha,
      planSummary: `Qwen Code 开发完成: 修改 ${inspection.files.length} 个文件、${inspection.changedLines} 行；Web 测试与类型检查独立复验通过。`,
      deployLog: qwenLog,
      error: null,
    })
    await prisma.feedback.update({
      where: { id: run.feedbackId },
      data: {
        status: 'AWAITING_APPROVAL' as any,
        proposal: `【开发完成·待批准上线】\n修改 ${inspection.files.length} 个文件、${inspection.changedLines} 行:\n${inspection.files.map((f) => `- ${f.path} (+${f.added}/-${f.deleted})`).join('\n')}\n\nWeb 测试与类型检查已独立复验通过。批准后自动安全发布（含回滚兜底）。`,
      },
    })
    await prisma.feedbackMessage.create({
      data: {
        tenantId: run.tenantId,
        feedbackId: run.feedbackId,
        role: 'assistant',
        content: `自动开发完成并通过测试（${inspection.files.length} 个文件、${inspection.changedLines} 行），已提交管理员做上线审批。`,
      },
    })
    notify({
      tenantId: run.tenantId,
      event: 'FEEDBACK_APPROVAL_PENDING',
      eventKey: `FEEDBACK:${run.feedbackId}:TIER2_DEPLOY`,
      payload: {
        feedbackId: run.feedbackId,
        category: 'IMPROVEMENT',
        title: run.feedback.title || '开发完成·待批准上线',
        summary: `Qwen Code 开发完成并复验通过，待批准上线: ${inspection.files.length} 文件 ${inspection.changedLines} 行`,
      },
    })
  } catch (error) {
    await prisma.feedbackMessage.create({
      data: {
        tenantId: run.tenantId,
        feedbackId: run.feedbackId,
        role: 'assistant',
        content: '自动开发未能完成（详见管理端记录），已转人工评估处理。',
      },
    }).catch(() => undefined)
    await escalateTier2(run, error)
  } finally {
    await git(repo, ['worktree', 'remove', '--force', worktreeDir]).catch(() => undefined)
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync('git', args, { cwd, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 })
  return `${stdout || ''}${stderr || ''}`.trim()
}
