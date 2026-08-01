/**
 * 档2: Qwen Code 服务器侧开发管线（白名单拒绝后的升级通道）
 *
 * 档1 引擎判定需求超出前端白名单（需后端/数据等变更）时, 不再直接转人工:
 *   prepareTier2TaskBook  生成开发任务书 → 反馈回到待审批(方案卡片)
 *   老板手机批准 → runTier2Dev 隔离 worktree 里跑 Qwen Code → 独立复验
 *   approved_auto 模式直接安全发布；suggest 模式进入 DEPLOY_REVIEW 等待二次批准
 *
 * 范围: 允许 apps/web/src 前端源码，以及 apps/api/src、apps/api/tests 的非核心 TypeScript。
 * 核心库存写入、资金、认证/权限、数据库 schema、依赖、部署配置在任务书生成与 diff 白名单
 * 两道关卡都会被拒绝（见 policy.denyPatchFile / changePlan.planChanges）。
 * 独立复验按实际改动范围执行: Web 测试+类型检查；API 测试+generate+类型检查+构建；混合两套都跑。
 */
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { prisma } from '@dianjie/db'
import { fireAndForget as notify } from '../notify'
import { qwenChat, QWEN_BUSY_FALLBACK, QWEN_NOT_CONFIGURED } from '../qwenChat'
import { planChanges, planVerificationSteps, resolveIntegrationTestEnv, runVerificationSteps } from './changePlan'
import { executeApprovedRun } from './deployment'
import {
  denyPatchFile,
  inspectUnifiedDiff,
  isApprovedAutoMode,
  isAutoDeploymentEnabled,
  isAutoFixModeEnabled,
  isCoreApiEnabled,
  type PolicyOptions,
} from './policy'
import { requireCleanRepoHead } from './repository'

const execFileAsync = promisify(execFile)
const QWEN_DEV_TIMEOUT_MS = Number(process.env.TIER2_QWEN_TIMEOUT_MS || 20 * 60_000)
const QWEN_TRANSIENT_RETRY_DELAY_MS = Number(process.env.TIER2_QWEN_RETRY_DELAY_MS || 5_000)
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

/**
 * 从 `git diff --name-only -z HEAD` 输出提取变更路径（过滤 node_modules 链接）。
 * 用 NUL 分隔的 diff 输出而非 porcelain：porcelain 的 3 字符前缀格式不契约化，
 * 曾出现 `? ` 单问号前缀导致 slice(3) 把 apps/... 啃成 pps/... 误判越界。
 */
export function parseChangedPaths(nameOnlyZ: string): string[] {
  const paths = nameOnlyZ
    .split('\0')
    .map((p) => p.replace(/^"|"$/g, ''))
    .filter((p) => p && p !== 'node_modules' && !p.startsWith('node_modules/'))
  return [...new Set(paths)]
}

/**
 * agent 明确判断“当前代码已满足/只是咨询”时，不应把零 diff 当成失败。
 * 必须有显式 NO_CHANGE 或明确的中英文结论；空日志和含糊输出仍按异常处理。
 */
export function isVerifiedNoChangeOutput(output: string): boolean {
  return /(?:^|\n)\s*NO_CHANGE[:：]/i.test(output)
    || /(?:无需|不需要|不必)(?:再)?(?:修改|改动|变更)(?:代码)?/i.test(output)
    || /(?:已经|当前)(?:完整)?(?:实现|修复|满足)(?:了|该需求|要求)/i.test(output)
    || /(?:already (?:implemented|fixed|satisfied)|no (?:code )?changes? (?:needed|required|necessary))/i.test(output)
}

export function isTransientAgentError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /TRANSIENT_QWEN|ETIMEDOUT|EAI_AGAIN|ECONNRESET|ECONNREFUSED|socket hang up|\b429\b|rate limit|temporarily unavailable/i.test(message)
}

/**
 * 档2 范围检查: 与 policy.denyPatchFile 共用同一闸门，允许 Web 源码与非核心 API 源码/测试，
 * 拒绝核心库存写入/资金/认证/数据库/未知。返回越界文件列表（空数组=通过）。
 * options.allowCoreBusinessApi=true 时，核心经营 API 文件放行（仍受永久红线约束）。
 */
export function findOutOfScopeFiles(paths: string[], options: PolicyOptions = {}): string[] {
  return paths.filter((p) => denyPatchFile(p, options) !== null)
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

/** 按实际改动范围生成"已独立复验"的可读描述，供方案卡片/总结准确展示验证范围。 */
export function verificationSummary(paths: string[], options: PolicyOptions = {}): string {
  const plan = planChanges(paths, options)
  const parts: string[] = []
  if (plan.verification.web) parts.push('Web 测试与类型检查')
  if (plan.verification.api) parts.push('API 测试、类型检查与构建')
  if (plan.files.some((f) => f.risk === 'core_business')) parts.push('隔离数据库集成测试')
  return parts.join('、') || '无可验证改动'
}

export function buildTaskBookPrompt(input: {
  title?: string | null
  summary?: string | null
  contextPath: string
  messages: Array<{ role: string; content: string }>
  rootCause: string
  candidateFiles: string[]
  allowCoreBusinessApi?: boolean
}): string {
  const coreApiConstraint = input.allowCoreBusinessApi
    ? `- 本次已开启核心经营 API 准入（AUTO_FIX_CORE_API_ENABLED=true）：允许修改 apps/api/src 与 apps/api/tests 下的核心经营 TypeScript（库存、订单、采购、收货、实发、盘点、报损、BOM 消耗、结算、成本）；认证、权限、资金/支付/财务、环境变量、依赖、部署配置、Prisma schema 与 migrations 仍为永久禁区，不得触碰`
    : `- 凡需要改 数据库 schema/迁移、核心库存写入（订货/接单实发/验收入库/库存/盘点报损/BOM 消耗/结算）、资金、认证/权限、依赖、部署配置 的需求，不要写任务书，直接输出一行: REJECT: <原因>`
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
<必须运行通过的命令。改 Web 跑: pnpm --filter @dianjie/web test 和 pnpm exec tsc -p apps/web/tsconfig.json --noEmit；改 API 跑: pnpm --filter @dianjie/api test、pnpm --filter @dianjie/db generate、pnpm exec tsc -p apps/api/tsconfig.json --noEmit、pnpm --filter @dianjie/api build；两者都改则两套都跑>

硬约束:
- 只允许修改或新建 apps/web/src 的前端源码，以及 apps/api/src、apps/api/tests 下的 TypeScript；不得删除、重命名文件
${coreApiConstraint}
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
  allowCoreBusinessApi?: boolean
}): string {
  const coreApiConstraint = input.allowCoreBusinessApi
    ? `- 本次已开启核心经营 API 准入（AUTO_FIX_CORE_API_ENABLED=true）：允许修改 apps/api/src 与 apps/api/tests 下的核心经营 TypeScript（库存、订单、采购、收货、实发、盘点、报损、BOM 消耗、结算、成本）；认证、权限、资金/支付/财务、环境变量、依赖、部署配置、Prisma schema 与 migrations 仍为永久禁区，不得触碰`
    : `- 不得修改认证、权限、资金、核心库存写入（订货/接单/验收/库存/盘点报损/BOM 消耗/结算）、数据库 schema、依赖、部署配置`
  return `# 任务: 处理一条已获管理员批准的用户反馈

## 反馈内容
标题: ${input.title || '未命名'}
摘要: ${input.summary || '无'}
页面路径: ${input.contextPath}
对话记录:
${input.messages.map((m) => `[${m.role}] ${m.content}`).join('\n')}

## 工作方式（你是 agent，自己动手）
1. 先阅读页面路径对应的路由组件与相关代码，定位问题/需求点，自行设计最小方案
2. 修改代码，然后按改动范围独立自测: 改 Web 跑 \`pnpm --filter @dianjie/web test\` 和 \`pnpm exec tsc -p apps/web/tsconfig.json --noEmit\`；改 API 跑 \`pnpm --filter @dianjie/api test\`、\`pnpm --filter @dianjie/db generate\`、\`pnpm exec tsc -p apps/api/tsconfig.json --noEmit\`、\`pnpm --filter @dianjie/api build\`；两者都改则两套都跑。有失败就修到全部通过

## 硬约束（违反将被拒绝发布）
- 只允许修改或新建 apps/web/src 的前端源码，以及 apps/api/src、apps/api/tests 下的 TypeScript；不得删除、重命名文件
${coreApiConstraint}
- 若需求必须触碰以上禁区: 不要改任何代码，直接回复 REJECT: <原因> 并停止
- 若检查确认当前代码已经满足需求、不需要修改: 不要制造无意义改动，回复 NO_CHANGE: <核验依据>

## 交付
最后输出: 修改文件清单（相对路径）、每个文件的改动说明、所跑验证命令的结果。`
}

/** 老板批准后统一入口: 直接创建 agent 开发任务并立即开工。 */
export async function enqueueAgentDev(input: {
  tenantId: string
  feedbackId: string
  approvedById?: string
}): Promise<string | null> {
  if (!isAutoFixModeEnabled()) return null
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

/** 超管聊天简报：老板在手机上直接下达的开发指令，约束与反馈任务一致。 */
export function buildChatBrief(content: string, allowCoreBusinessApi = false): string {
  const coreApiConstraint = allowCoreBusinessApi
    ? `- 本次已开启核心经营 API 准入（AUTO_FIX_CORE_API_ENABLED=true）：允许修改 apps/api/src 与 apps/api/tests 下的核心经营 TypeScript（库存、订单、采购、收货、实发、盘点、报损、BOM 消耗、结算、成本）；认证、权限、资金/支付/财务、环境变量、依赖、部署配置、Prisma schema 与 migrations 仍为永久禁区，不得触碰`
    : `- 不得修改认证、权限、资金、核心库存写入（订货/接单/验收/库存/盘点报损/BOM 消耗/结算）、数据库 schema、依赖、部署配置`
  return `# 任务: 处理一条超级管理员直接下达的开发指令

## 指令内容
${content}

## 工作方式（你是 agent，自己动手）
1. 先阅读相关路由组件与代码，自行定位并设计最小方案；指令不明确时选择最保守、最贴近字面的实现
2. 修改代码，然后按改动范围独立自测: 改 Web 跑 \`pnpm --filter @dianjie/web test\` 和 \`pnpm exec tsc -p apps/web/tsconfig.json --noEmit\`；改 API 跑 \`pnpm --filter @dianjie/api test\`、\`pnpm --filter @dianjie/db generate\`、\`pnpm exec tsc -p apps/api/tsconfig.json --noEmit\`、\`pnpm --filter @dianjie/api build\`；两者都改则两套都跑。有失败就修到全部通过

## 硬约束（违反将被拒绝发布）
- 只允许修改或新建 apps/web/src 的前端源码，以及 apps/api/src、apps/api/tests 下的 TypeScript；不得删除、重命名文件
${coreApiConstraint}
- 若需求必须触碰以上禁区或指令无法安全执行: 不要改任何代码，直接回复 REJECT: <原因> 并停止
- 若这是咨询问题，或检查确认当前代码已经满足需求、不需要修改: 不要制造无意义改动，回复 NO_CHANGE: <答复或核验依据>

## 交付
最后输出: 修改文件清单（相对路径）、每个文件的改动说明、所跑验证命令的结果。`
}

/** 超管聊天入口: 创建无反馈的 agent 开发任务并立即开工。 */
export async function enqueueBossChatDev(input: {
  tenantId: string
  userId: string
  content: string
}): Promise<string> {
  const allowCore = isCoreApiEnabled()
  const brief = buildChatBrief(input.content, allowCore)
  const run = await prisma.autoFixRun.create({
    data: {
      tenantId: input.tenantId,
      feedbackId: null,
      status: 'QWEN_DEV' as any,
      analysis: JSON.stringify({
        rootCause: 'boss_chat',
        candidateFiles: [],
        inWhitelist: true,
        confidence: 1,
        chatPrompt: brief,
      } satisfies Tier2Analysis),
      decidedById: input.userId,
      decidedAt: new Date(),
    },
    select: { id: true },
  })
  await prisma.opLog.create({
    data: {
      tenantId: input.tenantId,
      role: 'AI',
      action: `AI 助手聊天任务 ${run.id} → QWEN_DEV（超管指令直接开工）`.slice(0, 500),
      entityType: 'AutoFixRun',
      targetId: run.id,
      isAi: true,
      metadata: { status: 'QWEN_DEV', mode: 'boss_chat', userId: input.userId } as any,
    },
  })
  setImmediate(() => void runTier2Dev(run.id).catch((e) => console.error('[boss-chat] 开发执行异常:', e)))
  return run.id
}

interface Tier2Analysis {
  rootCause: string
  candidateFiles: string[]
  inWhitelist: boolean
  confidence: number
  taskBook?: string
  /** 超管聊天任务：老板消息原文构建的开发简报（此时 run.feedbackId 为空） */
  chatPrompt?: string
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

async function escalateTier2(run: { id: string; tenantId: string; feedbackId: string | null }, error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  await transitionRun(run, 'ESCALATED', { error: message.slice(0, 20_000) }, message.slice(0, 300))
  notify({
    tenantId: run.tenantId,
    event: 'AUTOFIX_ESCALATED',
    eventKey: `AUTOFIX:${run.id}:ESCALATED:TIER2`,
    payload: { runId: run.id, feedbackId: run.feedbackId ?? undefined, error: message.slice(0, 500) },
    bypassFrequency: true,
    bypassSilent: true,
  })
}

async function resolveNoChange(
  run: {
    id: string
    tenantId: string
    feedbackId: string | null
    decidedById: string | null
  },
  qwenLog: string,
  verificationLog: string,
) {
  const marker = qwenLog.match(/NO_CHANGE[:：]\s*([^\n]+)/i)?.[1]?.trim()
  const summary = marker || 'AI 检查确认当前版本已满足需求，无需产生代码改动'
  await transitionRun(run, 'RESOLVED', {
    planSummary: `无需代码修改：${summary}`.slice(0, 2_000),
    diffPatch: null,
    diffFiles: [] as any,
    baseCommitSha: null,
    commitSha: null,
    deployLog: `${qwenLog}\n\n--- 独立复验 ---\n${verificationLog}`.slice(-30_000),
    nextRetryAt: null,
    error: null,
  })
  if (run.feedbackId) {
    await prisma.feedback.update({ where: { id: run.feedbackId }, data: { status: 'RESOLVED' as any } })
    await prisma.feedbackMessage.create({
      data: {
        tenantId: run.tenantId,
        feedbackId: run.feedbackId,
        role: 'assistant',
        content: `AI 已基于最新代码复核并通过独立测试：${summary}。该反馈已直接标记为解决。`,
      },
    })
  } else if (run.decidedById) {
    await prisma.bossChatMessage.create({
      data: {
        tenantId: run.tenantId,
        userId: run.decidedById,
        role: 'assistant',
        runId: run.id,
        content: `${summary}\n已完成独立验证，无需发布代码。`,
      },
    })
  }
  notify({
    tenantId: run.tenantId,
    event: 'AUTOFIX_RESOLVED',
    eventKey: `AUTOFIX:${run.id}:RESOLVED:NO_CHANGE`,
    payload: { runId: run.id, feedbackId: run.feedbackId ?? undefined, noChange: true },
    bypassFrequency: true,
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
  const allowCore = isCoreApiEnabled()
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
        allowCoreBusinessApi: allowCore,
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
  const allowCore = isCoreApiEnabled()
  const policyOptions: PolicyOptions = { allowCoreBusinessApi: allowCore }
  try {
    const analysis = JSON.parse(run.analysis || '{}') as Tier2Analysis
    // 简报优先级: 超管聊天指令 > 档2任务书 > 反馈内容直接构建
    const brief = analysis.chatPrompt || analysis.taskBook || buildAgentBrief({
      title: run.feedback?.title,
      summary: run.feedback?.summary,
      contextPath: String((run.feedback?.context as any)?.path || ''),
      messages: run.feedback?.messages ?? [],
      allowCoreBusinessApi: allowCore,
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
      const transient = error?.killed === true
        || Boolean(error?.signal)
        || isTransientAgentError(`${error?.message || error}\n${partial}`)
      throw new Error(`${transient ? 'TRANSIENT_QWEN: ' : ''}Qwen Code 开发失败或超时: ${error?.message || error}${partial ? `\n${partial}` : ''}`)
    }

    // intent-to-add 让新建文件也进入 diff；范围与白名单由下方核查把关。
    // 必须排除 node_modules：worktree 里它是符号链接，.gitignore 的 "node_modules/"
    // 只匹配目录不匹配 symlink，不加排除会被 add -N 收进 diff 触发白名单误杀。
    await git(worktreeDir, ['add', '-N', '--', '.', ':!node_modules'])
    const nameOnlyZ = await git(worktreeDir, ['diff', '--name-only', '-z', 'HEAD', '--', '.', ':!node_modules'])
    const changed = parseChangedPaths(nameOnlyZ)
    if (changed.length === 0) {
      const rejectMatch = /REJECT[:：]\s*(.+)/.exec(qwenLog)
      if (rejectMatch) throw new Error(`agent 评估拒绝开发: ${rejectMatch[1].slice(0, 300)}`)
      if (isVerifiedNoChangeOutput(qwenLog)) {
        // 零 diff 也要独立复验。没有候选文件时同时跑 Web/API 基线，避免只相信 agent 自报。
        const analysisPaths = Array.isArray(analysis.candidateFiles)
          ? analysis.candidateFiles.filter((file) => denyPatchFile(file, policyOptions) === null)
          : []
        const verificationPaths = analysisPaths.length > 0
          ? analysisPaths
          : [
              'apps/web/src/app/v2/boss/autofix/page.tsx',
              'apps/api/src/routes/autofix.ts',
            ]
        const verificationLog = await runVerificationSteps(
          planVerificationSteps(verificationPaths, policyOptions),
          { cwd: worktreeDir },
        )
        await resolveNoChange(run, qwenLog, verificationLog)
        return
      }
      throw new Error(`Qwen Code 未产生任何改动\n${qwenLog.slice(-2_000)}`)
    }
    const outOfScope = findOutOfScopeFiles(changed, policyOptions)
    if (outOfScope.length > 0) {
      throw new Error(`改动越出自动修复白名单（Web 源码/非核心 API）: ${outOfScope.join(', ')}`)
    }

    // 独立复验：不信 AI 自报。按实际改动范围执行（Web/API/混合），命令一律 command+args 数组。
    // 核心经营 API 改动时额外跑集成测试，且只能使用隔离 DATABASE_URL（在碰数据库前校验）。
    const changePlan = planChanges(changed, policyOptions)
    const hasCoreBusiness = changePlan.files.some((f) => f.risk === 'core_business')
    const integrationTestEnv = hasCoreBusiness ? resolveIntegrationTestEnv() : undefined
    const verificationLog = await runVerificationSteps(
      planVerificationSteps(changed, { ...policyOptions, integrationTestEnv }),
      { cwd: worktreeDir },
    )
    const verifiedScope = verificationSummary(changed, policyOptions)

    const diffPatch = await gitRaw(worktreeDir, ['diff', '--', '.', ':!node_modules'])
    const inspection = inspectUnifiedDiff(diffPatch, policyOptions)
    if (!inspection.ok) throw new Error(inspection.errors.join('；'))

    const autoDeploy = isApprovedAutoMode() && isAutoDeploymentEnabled()
    await transitionRun(run, autoDeploy ? 'DEPLOYING' : 'DEPLOY_REVIEW', {
      diffPatch,
      diffFiles: inspection.files as any,
      baseCommitSha,
      planSummary: `Qwen Code 开发完成: 修改 ${inspection.files.length} 个文件、${inspection.changedLines} 行；${verifiedScope}独立复验通过。`,
      deployLog: `${qwenLog}\n\n--- 独立复验 ---\n${verificationLog}`.slice(-30_000),
      nextRetryAt: null,
      error: null,
    })
    const summaryText = `修改 ${inspection.files.length} 个文件、${inspection.changedLines} 行:\n${inspection.files.map((f) => `- ${f.path} (+${f.added}/-${f.deleted})`).join('\n')}\n\n${verifiedScope}已独立复验通过。`
    if (run.feedback) {
      await prisma.feedback.update({
        where: { id: run.feedback.id },
        data: {
          status: (autoDeploy ? 'IN_DEV' : 'AWAITING_APPROVAL') as any,
          proposal: autoDeploy
            ? `【开发完成·自动上线中】\n${summaryText}\n系统正在安全发布（含生产验证与回滚兜底）。`
            : `【开发完成·待批准上线】\n${summaryText}\n批准后自动安全发布（含回滚兜底）。`,
        },
      })
      await prisma.feedbackMessage.create({
        data: {
          tenantId: run.tenantId,
          feedbackId: run.feedback.id,
          role: 'assistant',
          content: autoDeploy
            ? `自动开发完成并通过测试（${inspection.files.length} 个文件、${inspection.changedLines} 行），正在自动安全发布。`
            : `自动开发完成并通过测试（${inspection.files.length} 个文件、${inspection.changedLines} 行），已提交管理员做上线审批。`,
        },
      })
    } else if (run.decidedById) {
      // 超管聊天任务: 结果回写到聊天记录，附 runId 供「批准部署」按钮使用
      await prisma.bossChatMessage.create({
        data: {
          tenantId: run.tenantId,
          userId: run.decidedById,
          role: 'assistant',
          runId: run.id,
          content: autoDeploy
            ? `开发和独立测试已完成，正在自动安全发布。\n${summaryText}`
            : `开发完成，待你批准上线。\n${summaryText}`,
        },
      })
    }
    if (autoDeploy) {
      setImmediate(() => void executeApprovedRun(run.id).catch((error) => console.error('[tier2] 自动发布异常:', error)))
    } else {
      notify({
        tenantId: run.tenantId,
        event: 'FEEDBACK_APPROVAL_PENDING',
        eventKey: `AUTOFIX:${run.id}:TIER2_DEPLOY`,
        payload: {
          feedbackId: run.feedback?.id ?? run.id,
          category: 'IMPROVEMENT',
          title: run.feedback?.title || 'AI 助手开发完成·待批准上线',
          summary: `Qwen Code 开发完成并复验通过，待批准上线: ${inspection.files.length} 文件 ${inspection.changedLines} 行`,
        },
      })
    }
  } catch (error) {
    const errText = error instanceof Error ? error.message : String(error)
    if (isTransientAgentError(error) && run.retryCount < 1) {
      await transitionRun(run, 'QWEN_DEV', {
        retryCount: { increment: 1 },
        nextRetryAt: new Date(Date.now() + QWEN_TRANSIENT_RETRY_DELAY_MS),
        error: `临时故障，系统正在自动重试：${errText}`.slice(0, 20_000),
      }, '临时故障自动重试')
      setTimeout(
        () => void runTier2Dev(run.id).catch((retryError) => console.error('[tier2] 临时故障重试异常:', retryError)),
        QWEN_TRANSIENT_RETRY_DELAY_MS,
      )
      return
    }
    if (run.feedback) {
      await prisma.feedbackMessage.create({
        data: {
          tenantId: run.tenantId,
          feedbackId: run.feedback.id,
          role: 'assistant',
          content: '自动开发未能完成（详见管理端记录），已转人工评估处理。',
        },
      }).catch(() => undefined)
    } else if (run.decidedById) {
      await prisma.bossChatMessage.create({
        data: {
          tenantId: run.tenantId,
          userId: run.decidedById,
          role: 'assistant',
          runId: run.id,
          content: `这次任务没能自动完成，已转人工处理。\n原因: ${errText.slice(0, 500)}`,
        },
      }).catch(() => undefined)
    }
    await escalateTier2(run, error)
  } finally {
    await git(repo, ['worktree', 'remove', '--force', worktreeDir]).catch(() => undefined)
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync('git', args, { cwd, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 })
  return `${stdout || ''}${stderr || ''}`.trim()
}

/**
 * 捕获补丁专用：绝不能 trim。diff 最后一行若是空白上下文行（单个空格），
 * trim 会把它吃掉，hunk 声明行数与实际不符，部署时 git apply --check 报 corrupt patch。
 */
async function gitRaw(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 })
  return stdout || ''
}
