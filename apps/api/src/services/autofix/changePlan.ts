/**
 * Phase 1 验证规划底座：把一组变更文件路径确定性地分类，并推导出一份验证计划。
 *
 * 设计目标（与任务书一致）:
 * - 只做"规划"，绝不执行任何部署/迁移；数据库相关只输出"需隔离 CI 库跑 migrate deploy"的标志。
 * - 确定性: 相同输入恒得相同输出（去重 + 稳定排序，不依赖 Map/Set 迭代顺序之外的东西）。
 * - 红线定义与 policy.ts 的 HARD_DENY_PATTERNS 对齐（认证/权限/资金/库存成本/部署/schema/迁移），
 *   但本模块自包含、不 import policy，避免规划逻辑与补丁白名单逻辑互相耦合。
 * - runVerificationSteps 是唯一例外: 它只执行 test/tsc/build 这类"非部署"独立复验命令
 *   （command+args 数组，绝不拼 shell），任何部署/迁移仍由专门模块在人工批准后执行。
 *
 * 两个正交维度:
 * - category: 变更落在哪个工程区域（web/api/database/workspace/unknown）
 * - risk:     变更有多危险（low < medium < high < blocked），混合改动取最高
 */
import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type ChangeCategory = 'web' | 'api' | 'database' | 'workspace' | 'unknown'
export type ChangeRisk = 'low' | 'medium' | 'high' | 'blocked'

export interface FileClassification {
  /** 规范化后的相对路径；非法路径保留原始输入以便排查 */
  path: string
  category: ChangeCategory
  risk: ChangeRisk
  /** 命中红线/高危规则时的原因；普通低风险为空 */
  redline?: string
}

export interface WebVerification {
  test: string
  typecheck: string
  build: string
}

export interface ApiVerification {
  test: string
  typecheck: string
  build: string
}

export interface DatabaseVerification {
  /** 恒为 true：出现 database 变更即要求隔离 CI 数据库 */
  requiresIsolatedCiDb: true
  /** 仅供隔离 CI 库使用的命令字符串；本模块从不执行它 */
  migrateDeployCommand: string
  note: string
}

export interface VerificationPlan {
  web?: WebVerification
  api?: ApiVerification
  database?: DatabaseVerification
}

export interface ChangePlan {
  /** 去重 + 按路径稳定排序后的逐文件分类 */
  files: FileClassification[]
  /** 出现过的类别，按固定规范顺序排列 */
  categories: ChangeCategory[]
  /** 全体文件风险的最大值；空输入为 low */
  risk: ChangeRisk
  /** risk === 'blocked' 的便捷布尔量 */
  blocked: boolean
  /** 命中的红线/高危清单，格式 "path: reason"，稳定排序 */
  redlines: string[]
  verification: VerificationPlan
}

/** 规范类别顺序：决定 categories 输出顺序，保证确定性。 */
const CATEGORY_ORDER: ChangeCategory[] = ['web', 'api', 'database', 'workspace', 'unknown']

const RISK_RANK: Record<ChangeRisk, number> = { low: 0, medium: 1, high: 2, blocked: 3 }

/** 与 policy.ts HARD_DENY 对齐的硬红线（blocked）。顺序即优先级，命中即返回。 */
const BLOCK_RULES: Array<{ test: RegExp; reason: string }> = [
  { test: /(^|\/)\.env(?:\.|$)/i, reason: '环境变量文件' },
  { test: /(^|\/)prisma\/schema\.prisma$/i, reason: 'Prisma schema' },
  { test: /(^|\/)prisma\/migrations\//i, reason: 'Prisma 迁移' },
  { test: /(^|\/)(?:auth[^/]*|authTokens|auth-scope)\.(?:ts|tsx)$/i, reason: '认证' },
  { test: /(^|\/)[^/]*permission[^/]*\.(?:ts|tsx)$/i, reason: '权限' },
  { test: /(^|\/)[^/]*guard[^/]*\.(?:ts|tsx)$/i, reason: '权限守卫' },
  { test: /^apps\/api\/src\/routes\/(?:payments|finance|cashbook|reconciliations|approval)[^/]*\.ts$/i, reason: '资金路由' },
  { test: /^apps\/api\/src\/services\/(?:payments|finance|cashbook|reconciliations|approval)\//i, reason: '资金服务' },
  { test: /(^|\/)(?:storeInventory|receiptSettlement|receiptDerivatives|inventoryCosting)\.ts$/i, reason: '库存成本' },
  // 库存写入/成本核心路径：订货/接单实发/验收入库/库存/盘点报损/BOM 消耗/结算/成本 等领域文件，
  // 无论关键字落在目录还是文件名都拦截。仅作用于 apps/api，避免误伤前端同名页面（如 v2/orders）。
  { test: /^apps\/api\/(?:src|tests)\/.*(?:inventory|receipt|purchase|order|stock|loss|settlement|consumption|deliver|shipment|cost).*\.(?:ts|tsx)$/i, reason: '库存写入/成本核心路径' },
  { test: /(^|\/)scripts\/deploy-[^/]*$/i, reason: '部署脚本' },
  { test: /(^|\/)(?:ecosystem|pm2|nginx)[^/]*$/i, reason: '部署配置' },
]

/**
 * 高危但非"核心数据红线"（high）：依赖/锁文件、容器与 CI 配置。
 * 依赖升级可被人工评审，故定为 high 而非 blocked；仍会拉高整体风险、阻断自动发布。
 */
const HIGH_RULES: Array<{ test: RegExp; reason: string }> = [
  { test: /(^|\/)(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/i, reason: '依赖与锁文件' },
  { test: /(^|\/)\.npmrc$/i, reason: '依赖配置' },
  { test: /(^|\/)docker-compose[^/]*\.ya?ml$/i, reason: '容器编排配置' },
  { test: /(^|\/)\.github\/workflows\//i, reason: 'CI 配置' },
]

/** 验证命令常量：按类别独立组成，供调用方在各自环境执行（本模块不执行）。 */
export const WEB_VERIFICATION: WebVerification = {
  test: 'pnpm --filter @dianjie/web test',
  typecheck: 'pnpm exec tsc -p apps/web/tsconfig.json --noEmit',
  build: 'pnpm --filter @dianjie/web build',
}

export const API_VERIFICATION: ApiVerification = {
  test: 'pnpm --filter @dianjie/api test',
  // 干净 worktree 的 Prisma Client 可能尚未生成（test/build 有 pretest/prebuild 兜底，
  // 裸 tsc 没有），故 typecheck 先跑仓库既有的 generate，再从根目录按 apps/api/tsconfig.json noEmit。
  typecheck: 'pnpm --filter @dianjie/db generate && pnpm exec tsc -p apps/api/tsconfig.json --noEmit',
  build: 'pnpm --filter @dianjie/api build',
}

export const DATABASE_MIGRATE_COMMAND = 'prisma migrate deploy'

type Normalized =
  | { kind: 'ok'; path: string }
  | { kind: 'illegal'; raw: string }
  | { kind: 'skip' }

/**
 * 规范化单个路径。与 policy.normalizeDiffPath 同源逻辑，但非法路径不抛错，
 * 而是标记为 illegal → 后续归入 unknown/blocked（未知/可疑路径一律最严）。
 */
function normalizePath(raw: string): Normalized {
  const value = raw.trim().split('\t')[0].replace(/^"|"$/g, '')
  if (!value || value === '/dev/null') return { kind: 'skip' }
  const withoutPrefix = value.replace(/^[ab]\//, '')
  const normalized = path.posix.normalize(withoutPrefix)
  if (
    normalized === '.'
    || normalized.startsWith('../')
    || path.posix.isAbsolute(normalized)
    || normalized.includes('\0')
  ) {
    return { kind: 'illegal', raw: value }
  }
  return { kind: 'ok', path: normalized }
}

function categoryOf(p: string): ChangeCategory {
  if (p.startsWith('apps/web/')) return 'web'
  if (p.startsWith('apps/api/')) return 'api'
  if (p.startsWith('packages/db/')) return 'database'
  if (isWorkspacePath(p)) return 'workspace'
  return 'unknown'
}

/** 工程区级配置/脚本/共享包：不属于某个 app 源码，改动会影响整体构建或运行环境。 */
function isWorkspacePath(p: string): boolean {
  if (p.startsWith('scripts/')) return true
  if (p.startsWith('.github/')) return true
  if (p.startsWith('packages/')) return true
  if (p.startsWith('infra/') || p.startsWith('docker/')) return true
  // 根级文件（无斜杠）：锁文件、monorepo/构建/部署配置等
  if (!p.includes('/')) {
    return /^(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc|\.nvmrc|\.node-version|tsconfig[^/]*\.json|docker-compose[^/]*\.ya?ml|ecosystem[^/]*\.js|\.gitignore|vitest\.workspace\.ts|\.env(?:\..+)?)$/i.test(p)
  }
  return false
}

/** 逐文件风险判定：红线 > 高危 > 类别默认。 */
function riskOf(p: string, category: ChangeCategory): { risk: ChangeRisk; redline?: string } {
  for (const rule of BLOCK_RULES) {
    if (rule.test.test(p)) return { risk: 'blocked', redline: rule.reason }
  }
  for (const rule of HIGH_RULES) {
    if (rule.test.test(p)) return { risk: 'high', redline: rule.reason }
  }
  switch (category) {
    case 'web':
      // 纯 apps/web/src 的普通源码（ts/tsx/css）为 low；其余（构建配置等）需 build 验证，记 medium。
      if (/^apps\/web\/src\/.+\.(?:ts|tsx|css)$/.test(p)) return { risk: 'low' }
      return { risk: 'medium' }
    case 'api':
      // 普通 apps/api/src 为 medium（路径无法证明只读/SQL 语义，需完整 API 验证）。
      return { risk: 'medium' }
    case 'database':
      // prisma schema/migrations 已在红线 blocked；packages/db 其余（客户端代码）为 high。
      return { risk: 'high', redline: '数据库包代码' }
    case 'workspace':
      return { risk: 'high', redline: '工程区配置' }
    case 'unknown':
    default:
      // 未知路径必须 blocked：无法证明安全即视为最严。
      return { risk: 'blocked', redline: '未知路径' }
  }
}

function classifyFile(p: string, category: ChangeCategory): FileClassification {
  const { risk, redline } = riskOf(p, category)
  const file: FileClassification = { path: p, category, risk }
  if (redline) file.redline = redline
  return file
}

function maxRisk(a: ChangeRisk, b: ChangeRisk): ChangeRisk {
  return RISK_RANK[a] >= RISK_RANK[b] ? a : b
}

/**
 * 由变更文件路径数组生成确定性变更分类与验证计划。
 *
 * - 去重: 同一规范化路径只保留一次。
 * - 稳定排序: files 与 redlines 均按路径升序（字节序比较，不依赖 locale）。
 * - 验证命令按类别独立组成；database 仅给出隔离 CI 标志，绝不含执行生产迁移的代码。
 */
export function planChanges(paths: string[]): ChangePlan {
  const seen = new Map<string, FileClassification>()

  for (const raw of paths) {
    const normalized = normalizePath(raw)
    if (normalized.kind === 'skip') continue

    if (normalized.kind === 'illegal') {
      const key = `\u0000illegal:${normalized.raw}`
      if (!seen.has(key)) {
        seen.set(key, { path: normalized.raw, category: 'unknown', risk: 'blocked', redline: '非法路径' })
      }
      continue
    }

    const key = normalized.path
    if (seen.has(key)) continue
    seen.set(key, classifyFile(normalized.path, categoryOf(normalized.path)))
  }

  const files = [...seen.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  const present = new Set<ChangeCategory>(files.map((f) => f.category))
  const categories = CATEGORY_ORDER.filter((c) => present.has(c))

  const risk = files.reduce<ChangeRisk>((acc, f) => maxRisk(acc, f.risk), 'low')
  const redlines = files
    .filter((f) => f.redline)
    .map((f) => `${f.path}: ${f.redline}`)

  const verification: VerificationPlan = {}
  if (present.has('web')) verification.web = { ...WEB_VERIFICATION }
  if (present.has('api')) verification.api = { ...API_VERIFICATION }
  if (present.has('database')) {
    verification.database = {
      requiresIsolatedCiDb: true,
      migrateDeployCommand: DATABASE_MIGRATE_COMMAND,
      note: '数据库变更必须在隔离 CI 数据库上执行 prisma migrate deploy 验证；严禁对生产库执行任何迁移。',
    }
  }

  return {
    files,
    categories,
    risk,
    blocked: risk === 'blocked',
    redlines,
    verification,
  }
}

export type DeployComponent = 'web' | 'api'

export interface DeploymentComponentPlan {
  /** 需要部署的运行时组件，固定顺序 web → api，保证确定性 */
  components: DeployComponent[]
  web: boolean
  api: boolean
}

/**
 * 由变更文件路径推导需要部署的运行时组件（纯函数，供部署与回滚共用，保证一致性）。
 * - 只有 apps/web/src 的源码改动触发 Web 部署；
 * - 只有 apps/api/src 的源码改动触发 API 部署；
 * - apps/api/tests、web 构建配置等不进入运行产物，不触发部署（避免无谓重启生产进程）。
 */
export function planDeploymentComponents(paths: string[]): DeploymentComponentPlan {
  let web = false
  let api = false
  for (const raw of paths) {
    const normalized = normalizePath(raw)
    if (normalized.kind !== 'ok') continue
    if (normalized.path.startsWith('apps/web/src/')) web = true
    if (normalized.path.startsWith('apps/api/src/')) api = true
  }
  const components: DeployComponent[] = []
  if (web) components.push('web')
  if (api) components.push('api')
  return { components, web, api }
}

export interface VerificationStep {
  label: string
  command: string
  args: string[]
  timeoutMs: number
}

/**
 * 由变更文件路径推导需要执行的独立验证步骤（命令 + 参数数组，绝不拼 shell 字符串）。
 * - Web 改动: 单测 + 类型检查；
 * - API 改动: 单测 + Prisma generate + 类型检查 + 构建；
 * - 混合: 两套都跑（Web 在前，API 在后）。
 * database / 未知 / 红线变更不在此放行，应由上层范围检查先行拒绝。
 */
export function planVerificationSteps(paths: string[]): VerificationStep[] {
  const plan = planChanges(paths)
  const steps: VerificationStep[] = []
  if (plan.verification.web) {
    steps.push({ label: 'Web 单测', command: 'pnpm', args: ['--filter', '@dianjie/web', 'test'], timeoutMs: 300_000 })
    steps.push({ label: 'Web 类型检查', command: 'pnpm', args: ['exec', 'tsc', '-p', 'apps/web/tsconfig.json', '--noEmit'], timeoutMs: 300_000 })
  }
  if (plan.verification.api) {
    steps.push({ label: 'API 单测', command: 'pnpm', args: ['--filter', '@dianjie/api', 'test'], timeoutMs: 600_000 })
    steps.push({ label: 'Prisma 客户端生成', command: 'pnpm', args: ['--filter', '@dianjie/db', 'generate'], timeoutMs: 300_000 })
    steps.push({ label: 'API 类型检查', command: 'pnpm', args: ['exec', 'tsc', '-p', 'apps/api/tsconfig.json', '--noEmit'], timeoutMs: 300_000 })
    steps.push({ label: 'API 构建', command: 'pnpm', args: ['--filter', '@dianjie/api', 'build'], timeoutMs: 600_000 })
  }
  return steps
}

export interface VerificationRunOptions {
  cwd: string
  /** 额外环境变量；CI=1 与 NODE_ENV=test 由运行器强制注入，调用方无需关心 */
  env?: NodeJS.ProcessEnv
}

/**
 * 顺序执行验证步骤（command + args 数组，绝不拼 shell 字符串），返回合并后的尾部日志。
 * tier2 与 repository 共用此运行器，保证"按范围独立复验"的口径一致。
 * 只执行 test/tsc/build 这类非部署验证；任一步骤失败即带上其 stdout/stderr 向上抛出，
 * 由调用方统一升级处理（转人工/ESCALATED）。
 */
export async function runVerificationSteps(
  steps: VerificationStep[],
  options: VerificationRunOptions,
): Promise<string> {
  const logs: string[] = []
  for (const step of steps) {
    try {
      const { stdout, stderr } = await execFileAsync(step.command, step.args, {
        cwd: options.cwd,
        timeout: step.timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, ...options.env, CI: '1', NODE_ENV: 'test' },
      })
      logs.push(`$ ${step.label}\n${`${stdout || ''}${stderr || ''}`.slice(-8_000)}`)
    } catch (error: any) {
      const partial = `${error?.stdout || ''}${error?.stderr || ''}`.slice(-8_000)
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`独立复验失败（${step.label}）: ${message}${partial ? `\n${partial}` : ''}`)
    }
  }
  return logs.join('\n').slice(-20_000)
}
