import path from 'node:path'

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

const MAX_FILES = 5
const MAX_CHANGED_LINES = 200

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

function isAllowedP1aPath(file: string): boolean {
  if (file === 'apps/web/src/components/AppLayout.tsx') return false
  if (/^apps\/web\/src\/app\/.+\.(?:ts|tsx|css)$/.test(file)) return true
  if (/^apps\/web\/src\/components\/.+\.(?:ts|tsx|css)$/.test(file)) return true
  if (/^apps\/web\/src\/.+\.(?:test|spec)\.(?:ts|tsx)$/.test(file)) return true
  return false
}

/**
 * P1a intentionally limits automatic patches to Web presentation code.
 * Read-only API changes remain a later rollout because path-only validation
 * cannot prove that a route is GET-only or that its SQL semantics are intact.
 */
export function inspectUnifiedDiff(diff: string): DiffInspection {
  const errors: string[] = []
  const files = new Map<string, DiffFileSummary>()
  const lines = diff.replace(/\r\n/g, '\n').split('\n')

  if (!diff.trim()) errors.push('补丁为空')
  if (/\nGIT binary patch(?:\n|$)/.test(`\n${diff}`) || /\nBinary files .+ differ(?:\n|$)/.test(`\n${diff}`)) {
    errors.push('禁止二进制补丁')
  }
  if (/^deleted file mode /m.test(diff) || /^rename (?:from|to) /m.test(diff)) {
    errors.push('禁止删除或重命名文件')
  }

  let current: DiffFileSummary | null = null
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
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
        current = files.get(file) ?? { path: file, added: 0, deleted: 0 }
        files.set(file, current)
      } catch (error: any) {
        errors.push(error.message)
        current = null
      }
      continue
    }
    if (line.startsWith('+++ /dev/null')) {
      errors.push('禁止删除文件')
      continue
    }
    if (!current || line.startsWith('+++ ') || line.startsWith('--- ')) continue
    if (line.startsWith('+')) current.added += 1
    if (line.startsWith('-')) current.deleted += 1
  }

  const summaries = [...files.values()]
  if (summaries.length === 0) errors.push('未识别到标准 unified diff 文件')
  if (summaries.length > MAX_FILES) errors.push(`补丁文件数超过 ${MAX_FILES}`)

  for (const file of summaries) {
    if (HARD_DENY_PATTERNS.some((pattern) => pattern.test(file.path))) {
      errors.push(`触碰硬红线路径: ${file.path}`)
    } else if (!isAllowedP1aPath(file.path)) {
      errors.push(`P1a 白名单外路径: ${file.path}`)
    }
  }

  const changedLines = summaries.reduce((sum, file) => sum + file.added + file.deleted, 0)
  if (changedLines > MAX_CHANGED_LINES) errors.push(`补丁变更行数超过 ${MAX_CHANGED_LINES}`)

  return {
    ok: errors.length === 0,
    files: summaries,
    changedLines,
    errors: [...new Set(errors)],
  }
}

export function isAutoFixModeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AUTO_FIX_MODE === 'suggest'
}
