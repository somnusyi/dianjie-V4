import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { inspectUnifiedDiff } from './policy'

const execFileAsync = promisify(execFile)
const MAX_SOURCE_CHARS = 32_000

export interface SourceFile {
  path: string
  content: string
}

async function assertInsideRepo(repoDir: string, file: string): Promise<string> {
  const repoReal = await realpath(repoDir)
  const fileReal = await realpath(path.join(repoDir, file))
  if (fileReal !== repoReal && !fileReal.startsWith(`${repoReal}${path.sep}`)) {
    throw new Error('候选文件越出源码目录')
  }
  return fileReal
}

async function resolveRouteDirectory(appRoot: string, routePath: string): Promise<string | null> {
  const segments = routePath.split('?')[0].split('#')[0].split('/').filter(Boolean)
  let current = appRoot
  for (const segment of segments) {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => [])
    const exact = entries.find((entry) => entry.isDirectory() && entry.name === segment)
    const dynamic = entries.find((entry) => entry.isDirectory() && /^\[.+\]$/.test(entry.name))
    const next = exact ?? dynamic
    if (!next) return null
    current = path.join(current, next.name)
  }
  return current
}

export async function collectCandidateSources(repoDir: string, contextPath: string): Promise<SourceFile[]> {
  if (!contextPath.startsWith('/')) throw new Error('反馈缺少可定位页面路径')
  const appRoot = path.join(repoDir, 'apps/web/src/app')
  let routeDir = await resolveRouteDirectory(appRoot, contextPath)
  const candidates: string[] = []

  while (routeDir && routeDir.startsWith(appRoot)) {
    for (const name of ['page.tsx', 'page.ts', 'layout.tsx']) {
      const absolute = path.join(routeDir, name)
      try {
        const relative = path.relative(repoDir, await assertInsideRepo(repoDir, path.relative(repoDir, absolute)))
        candidates.push(relative.split(path.sep).join('/'))
      } catch {
        // Keep walking to the nearest parent route.
      }
    }
    if (routeDir === appRoot || candidates.length >= 4) break
    routeDir = path.dirname(routeDir)
  }

  const unique = [...new Set(candidates)].slice(0, 4)
  if (unique.length === 0) throw new Error(`无法从页面路径定位源码: ${contextPath}`)

  const sources: SourceFile[] = []
  let remaining = MAX_SOURCE_CHARS
  for (const file of unique) {
    const content = await readFile(await assertInsideRepo(repoDir, file), 'utf8')
    const clipped = content.slice(0, remaining)
    if (!clipped) break
    sources.push({ path: file, content: clipped })
    remaining -= clipped.length
  }
  return sources
}

async function run(repoDir: string, command: string, args: string[], timeout = 120_000): Promise<string> {
  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd: repoDir,
    timeout,
    maxBuffer: 2 * 1024 * 1024,
    env: {
      ...process.env,
      PATH: process.env.PATH,
      CI: '1',
    },
  })
  return `${stdout || ''}${stderr || ''}`.slice(-20_000)
}

export async function requireCleanRepoHead(
  repoDir: string,
  expectedHead?: string,
): Promise<string> {
  const status = await run(repoDir, 'git', ['status', '--porcelain'], 30_000)
  if (status.trim()) throw new Error('自动修复源码副本不是干净状态')

  const head = (await run(repoDir, 'git', ['rev-parse', 'HEAD'], 30_000)).trim()
  if (expectedHead && head !== expectedHead) {
    throw new Error(`源码基线已变化，预期 ${expectedHead}，实际 ${head}`)
  }
  return head
}

export async function validatePatchApplicable(
  repoDir: string,
  diffPatch: string,
  expectedBaseSha: string,
): Promise<void> {
  const inspection = inspectUnifiedDiff(diffPatch)
  if (!inspection.ok) throw new Error(inspection.errors.join('；'))

  await requireCleanRepoHead(repoDir, expectedBaseSha)
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'dianjie-autofix-check-'))
  const patchFile = path.join(tempRoot, 'candidate.patch')
  await writeFile(patchFile, diffPatch, { mode: 0o600 })
  try {
    await run(repoDir, 'git', ['apply', '--check', patchFile], 30_000)
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

/**
 * Applies the AI diff only in a disposable git worktree. The production source
 * and application directory remain untouched before a human approval.
 */
export async function verifyPatch(
  repoDir: string,
  diffPatch: string,
  expectedBaseSha: string,
): Promise<string> {
  const inspection = inspectUnifiedDiff(diffPatch)
  if (!inspection.ok) throw new Error(inspection.errors.join('；'))

  await requireCleanRepoHead(repoDir, expectedBaseSha)
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'dianjie-autofix-'))
  const patchFile = path.join(tempRoot, 'candidate.patch')
  const worktreeDir = path.join(tempRoot, 'worktree')
  await writeFile(patchFile, diffPatch, { mode: 0o600 })

  try {
    await run(repoDir, 'git', ['apply', '--check', patchFile], 30_000)
    await run(repoDir, 'git', ['worktree', 'add', '--detach', worktreeDir, expectedBaseSha], 30_000)
    await symlink(path.join(repoDir, 'node_modules'), path.join(worktreeDir, 'node_modules'), 'dir').catch(() => undefined)
    await run(worktreeDir, 'git', ['apply', '--whitespace=error-all', patchFile], 30_000)
    const testLog = await run(worktreeDir, 'pnpm', ['--filter', '@dianjie/web', 'test'], 180_000)
    const typeLog = await run(
      worktreeDir,
      'pnpm',
      ['exec', 'tsc', '-p', 'apps/web/tsconfig.json', '--noEmit'],
      180_000,
    )
    await requireCleanRepoHead(repoDir, expectedBaseSha)
    return `${testLog}\n${typeLog}`.slice(-20_000)
  } finally {
    await run(repoDir, 'git', ['worktree', 'remove', '--force', worktreeDir], 30_000).catch(() => undefined)
    await rm(tempRoot, { recursive: true, force: true })
  }
}
