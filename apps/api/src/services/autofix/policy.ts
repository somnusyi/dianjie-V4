import path from 'node:path'
import { planChanges } from './changePlan'

export interface DiffFileSummary {
  path: string
  added: number
  deleted: number
}

export interface DiffInspection {
  ok: boolean
  files: DiffFileSummary[]
  changedLines: number
  errors: string[]
}

// 防失控刹车已按老板要求放开：默认不限文件数与行数（env AUTO_FIX_MAX_FILES / AUTO_FIX_MAX_LINES 可重新启用）。
function maxFiles(): number {
  return Math.max(1, Number(process.env.AUTO_FIX_MAX_FILES) || Number.MAX_SAFE_INTEGER)
}
function maxChangedLines(): number {
  return Math.max(50, Number(process.env.AUTO_FIX_MAX_LINES) || Number.MAX_SAFE_INTEGER)
}

const HARD_DENY_PATTERNS: RegExp[] = [
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)prisma\/schema\.prisma$/i,
  /(^|\/)prisma\/migrations\//i,
  /(^|\/)(?:package\.json|pnpm-lock\.yaml)$/i,
  /(^|\/)(?:ecosystem|pm2|nginx)[^/]*$/i,
  /(^|\/)scripts\/deploy-[^/]*$/i,
  /(^|\/)(?:auth[^/]*|authTokens|auth-scope)\.ts$/i,
  /^apps\/api\/src\/routes\/(?:payments|finance|cashbook|reconciliations|approval)[^/]*\.ts$/i,
  /^apps\/api\/src\/services\/(?:payments|finance|cashbook|reconciliations|approval)\//i,
  /^apps\/api\/src\/services\/notify\//i,
  /(^|\/)(?:storeInventory|receiptSettlement|receiptDerivatives|inventoryCosting)\.ts$/i,
  /^apps\/web\/src\/app\/(?:.+\/)?layout\.(?:ts|tsx)$/i,
  /^apps\/web\/src\/app\/globals\.css$/i,
  /^apps\/web\/src\/components\/AppLayout\.tsx$/i,
  /^apps\/web\/src\/components\/.+-shell\.(?:ts|tsx)$/i,
  /^apps\/web\/src\/components\/v2\/feedback-fab\.tsx$/i,
  /(^|\/)(?:auth[^/]*|[^/]*permission[^/]*|[^/]*guard[^/]*)\.(?:ts|tsx)$/i,
]

function normalizeDiffPath(raw: string): string | null {
  const value = raw.trim().split('\t')[0]
  if (value === '/dev/null') return null
  const withoutPrefix = value.replace(/^[ab]\//, '')
  const normalized = path.posix.normalize(withoutPrefix)
  if (
    normalized === '.'
    || normalized.startsWith('../')
    || path.posix.isAbsolute(normalized)
    || normalized.includes('\0')
  ) {
    throw new Error(`非法文件路径: ${raw}`)
  }
  return normalized
}

/**
 * 自动修复白名单（正向清单）：
 * - apps/web/src 下的源码与样式；
 * - apps/api/src 下的非核心源码（核心库存写入/资金/认证等由 planChanges 风险闸与 HARD_DENY 先行拦截）；
 * - apps/api/tests 下的测试。
 * 删除/重命名/禁区路径由 diff 元信息禁令与 HARD_DENY_PATTERNS 把关。
 */
function isAllowedAutofixPath(file: string): boolean {
  if (/^apps\/web\/src\/.+\.(?:ts|tsx|css)$/.test(file)) return true
  if (/^apps\/api\/src\/.+\.(?:ts|tsx)$/.test(file)) return true
  if (/^apps\/api\/tests\/.+\.(?:ts|tsx)$/.test(file)) return true
  return false
}

/**
 * 单文件准入闸门（policy 与 tier2 范围检查共用，保证两处判定一致）。
 * 返回拒绝原因（含"红线"/"白名单"关键字）或 null（放行）。
 * 判定顺序: 硬红线 > planChanges 风险/类别闸（risk high/blocked 或 unknown/database/workspace 一律拒绝）> 正向白名单。
 */
export function denyPatchFile(filePath: string): string | null {
  const plan = planChanges([filePath])
  const file = plan.files[0]
  const normalized = file?.path ?? filePath
  if (HARD_DENY_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return `触碰硬红线路径: ${filePath}`
  }
  if (
    !file
    || file.risk === 'blocked'
    || file.risk === 'high'
    || file.category === 'unknown'
    || file.category === 'database'
    || file.category === 'workspace'
  ) {
    const reason = file?.redline ? `（${file.redline}）` : ''
    return `触碰硬红线路径: ${filePath}${reason}`
  }
  if (!isAllowedAutofixPath(normalized)) {
    return `P1a 白名单外路径: ${filePath}`
  }
  return null
}

/**
 * 自动修复补丁准入：结构校验（二进制/删除/重命名/模式/hunk 一致性/路径穿越）+ 逐文件闸门。
 * 允许 Web 源码与非核心 API 源码/测试；核心库存写入、资金、认证、数据库、依赖等一律拒绝。
 */
export function inspectUnifiedDiff(diff: string): DiffInspection {
  const errors: string[] = []
  const files = new Map<string, DiffFileSummary>()
  const lines = diff.replace(/\r\n/g, '\n').split('\n')

  if (!diff.trim()) errors.push('补丁为空')
  if (/\nGIT binary patch(?:\n|$)/.test(`\n${diff}`) || /\nBinary files .+ differ(?:\n|$)/.test(`\n${diff}`)) {
    errors.push('禁止二进制补丁')
  }
  // 新建文件允许（限 apps/web/src 下，见下方路径校验）；删除/重命名/复制/改模式仍禁止。
  if (/^(?:deleted file mode|old mode|new mode|rename (?:from|to)|copy (?:from|to)) /m.test(diff)) {
    errors.push('禁止删除、重命名、复制或修改文件模式')
  }

  let current: {
    summary: DiffFileSummary
    oldHeaderSeen: boolean
    newHeaderSeen: boolean
    inHunk: boolean
    expectedOld: number
    expectedNew: number
    actualOld: number
    actualNew: number
  } | null = null

  const verifyHunkCounts = () => {
    if (!current?.inHunk) return
    if (current.actualOld !== current.expectedOld || current.actualNew !== current.expectedNew) {
      errors.push(
        `hunk 行数与声明不符: ${current.summary.path}（声明 -${current.expectedOld}/+${current.expectedNew}，实际 -${current.actualOld}/+${current.actualNew}）`,
      )
    }
  }

  const finishCurrent = () => {
    if (!current) return
    verifyHunkCounts()
    if (!current.oldHeaderSeen || !current.newHeaderSeen) {
      errors.push(`补丁文件头不完整: ${current.summary.path}`)
    }
  }

  const validatePatchPath = (raw: string, prefix: 'a' | 'b', label: '旧' | '新') => {
    if (!current) {
      errors.push(`补丁${label}路径缺少对应 diff --git 声明`)
      return
    }
    const declared = raw.trim().split('\t')[0]
    // 新建文件的旧端恒为 /dev/null，合法
    if (label === '旧' && declared === '/dev/null') {
      current.oldHeaderSeen = true
      return
    }
    const expected = `${prefix}/${current.summary.path}`
    if (declared !== expected) {
      errors.push(`补丁${label}路径与 diff 声明不一致: ${declared}`)
    }
    if (label === '旧') current.oldHeaderSeen = true
    else current.newHeaderSeen = true
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('diff --git ')) {
      finishCurrent()
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
      if (!match || match[1] !== match[2]) {
        errors.push(`不支持的 diff 头: ${line.slice(0, 160)}`)
        current = null
        continue
      }
      try {
        const file = normalizeDiffPath(`a/${match[1]}`)
        if (!file) {
          errors.push('补丁缺少目标文件')
          current = null
          continue
        }
        const summary = files.get(file) ?? { path: file, added: 0, deleted: 0 }
        files.set(file, summary)
        current = {
          summary,
          oldHeaderSeen: false,
          newHeaderSeen: false,
          inHunk: false,
          expectedOld: 0,
          expectedNew: 0,
          actualOld: 0,
          actualNew: 0,
        }
      } catch (error: any) {
        errors.push(error.message)
        current = null
      }
      continue
    }
    if (line.startsWith('@@ ')) {
      if (current) {
        verifyHunkCounts()
        const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line)
        if (!hunk) {
          errors.push(`无法解析 hunk 头: ${line.slice(0, 80)}`)
          current.inHunk = false
          continue
        }
        current.expectedOld = hunk[1] === undefined ? 1 : Number(hunk[1])
        current.expectedNew = hunk[2] === undefined ? 1 : Number(hunk[2])
        current.actualOld = 0
        current.actualNew = 0
        current.inHunk = true
      }
      continue
    }
    if (!current?.inHunk && line.startsWith('--- ')) {
      validatePatchPath(line.slice(4), 'a', '旧')
      continue
    }
    if (!current?.inHunk && line.startsWith('+++ ')) {
      validatePatchPath(line.slice(4), 'b', '新')
      continue
    }
    if (!current?.inHunk) continue
    // 末尾换行符产生的空串元素不是真实行；"\ No newline" 标记行不计数
    if (line === '' && i === lines.length - 1) continue
    if (line.startsWith('\\')) continue
    if (line.startsWith('+')) {
      current.summary.added += 1
      current.actualNew += 1
    } else if (line.startsWith('-')) {
      current.summary.deleted += 1
      current.actualOld += 1
    } else {
      current.actualOld += 1
      current.actualNew += 1
    }
  }
  finishCurrent()

  const summaries = [...files.values()]
  if (summaries.length === 0) errors.push('未识别到标准 unified diff 文件')
  const fileCap = maxFiles()
  if (summaries.length > fileCap) errors.push(`补丁文件数超过 ${fileCap}`)

  for (const file of summaries) {
    const denial = denyPatchFile(file.path)
    if (denial) errors.push(denial)
  }

  const changedLines = summaries.reduce((sum, file) => sum + file.added + file.deleted, 0)
  const lineCap = maxChangedLines()
  if (changedLines > lineCap) errors.push(`补丁变更行数超过 ${lineCap}`)

  return {
    ok: errors.length === 0,
    files: summaries,
    changedLines,
    errors: [...new Set(errors)],
  }
}

export function isAutoFixModeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AUTO_FIX_MODE === 'suggest' || env.AUTO_FIX_MODE === 'approved_auto'
}

export function isApprovedAutoMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AUTO_FIX_MODE === 'approved_auto'
}

export function isAutoDeploymentEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isAutoFixModeEnabled(env) && env.AUTO_FIX_DEPLOY_ENABLED === 'true'
}
