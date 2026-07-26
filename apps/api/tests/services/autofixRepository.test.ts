import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
  collectCandidateSources,
  requireCleanRepoHead,
  verifyPatch,
} from '../../src/services/autofix/repository'

const repoDir = path.resolve(process.cwd(), '../..')
const execFileAsync = promisify(execFile)

describe('auto-fix source candidate resolver', () => {
  it('maps a dynamic production URL to the bracket route source', async () => {
    const files = await collectCandidateSources(repoDir, '/v2/boss/feedback/example-id?from=notice')
    expect(files[0].path).toBe('apps/web/src/app/v2/boss/feedback/[id]/page.tsx')
    expect(files[0].content).toContain('BossFeedbackDetailPage')
  })

  it('fails closed when the page cannot be mapped', async () => {
    await expect(collectCandidateSources(repoDir, '/not-a-real-route/deep/path'))
      .rejects.toThrow('无法从页面路径定位源码')
  })

  it('rejects non-path context', async () => {
    await expect(collectCandidateSources(repoDir, 'https://evil.example/path'))
      .rejects.toThrow('反馈缺少可定位页面路径')
  })
})

describe('auto-fix source baseline pinning', () => {
  it('fails closed when the pinned source becomes dirty or advances', async () => {
    const tempRepo = await mkdtemp(path.join(os.tmpdir(), 'dianjie-autofix-repo-'))
    try {
      await execFileAsync('git', ['init', '-q'], { cwd: tempRepo })
      await execFileAsync('git', ['config', 'user.name', 'AutoFix Test'], { cwd: tempRepo })
      await execFileAsync('git', ['config', 'user.email', 'autofix-test@localhost'], { cwd: tempRepo })
      await writeFile(path.join(tempRepo, 'page.tsx'), 'export const label = "first"\n')
      await execFileAsync('git', ['add', 'page.tsx'], { cwd: tempRepo })
      await execFileAsync('git', ['commit', '-qm', 'first'], { cwd: tempRepo })

      const pinned = await requireCleanRepoHead(tempRepo)
      expect(pinned).toMatch(/^[0-9a-f]{40}$/)
      await expect(requireCleanRepoHead(tempRepo, pinned)).resolves.toBe(pinned)

      await writeFile(path.join(tempRepo, 'page.tsx'), 'export const label = "dirty"\n')
      await expect(requireCleanRepoHead(tempRepo, pinned))
        .rejects.toThrow('自动修复源码副本不是干净状态')

      await execFileAsync('git', ['restore', 'page.tsx'], { cwd: tempRepo })
      await writeFile(path.join(tempRepo, 'page.tsx'), 'export const label = "second"\n')
      await execFileAsync('git', ['add', 'page.tsx'], { cwd: tempRepo })
      await execFileAsync('git', ['commit', '-qm', 'second'], { cwd: tempRepo })
      await expect(requireCleanRepoHead(tempRepo, pinned))
        .rejects.toThrow(`源码基线已变化，预期 ${pinned}`)
    } finally {
      await rm(tempRepo, { recursive: true, force: true })
    }
  })

  it('rejects a source advance that happens during isolated verification', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'dianjie-autofix-race-'))
    const tempRepo = path.join(tempRoot, 'repo')
    const fakeBin = path.join(tempRoot, 'bin')
    const marker = path.join(tempRoot, 'advanced')
    const originalPath = process.env.PATH
    try {
      await mkdir(path.join(tempRepo, 'apps/web/src/app/example'), { recursive: true })
      await mkdir(fakeBin)
      await execFileAsync('git', ['init', '-q'], { cwd: tempRepo })
      await execFileAsync('git', ['config', 'user.name', 'AutoFix Test'], { cwd: tempRepo })
      await execFileAsync('git', ['config', 'user.email', 'autofix-test@localhost'], { cwd: tempRepo })
      await writeFile(
        path.join(tempRepo, 'apps/web/src/app/example/page.tsx'),
        'export const label = "before"\n',
      )
      await writeFile(path.join(tempRepo, 'source-only.txt'), 'first\n')
      await execFileAsync('git', ['add', '.'], { cwd: tempRepo })
      await execFileAsync('git', ['commit', '-qm', 'first'], { cwd: tempRepo })
      const pinned = await requireCleanRepoHead(tempRepo)

      await writeFile(
        path.join(fakeBin, 'pnpm'),
        `#!/bin/sh
set -eu
if [ ! -e "$AUTOFIX_TEST_ADVANCE_MARKER" ]; then
  : > "$AUTOFIX_TEST_ADVANCE_MARKER"
  printf 'second\\n' >> "$AUTOFIX_TEST_SOURCE_REPO/source-only.txt"
  git -C "$AUTOFIX_TEST_SOURCE_REPO" add source-only.txt
  git -C "$AUTOFIX_TEST_SOURCE_REPO" commit -qm advance
fi
`,
        { mode: 0o755 },
      )
      process.env.PATH = `${fakeBin}:${originalPath || ''}`
      process.env.AUTOFIX_TEST_ADVANCE_MARKER = marker
      process.env.AUTOFIX_TEST_SOURCE_REPO = tempRepo

      const diff = `diff --git a/apps/web/src/app/example/page.tsx b/apps/web/src/app/example/page.tsx
index 1111111..2222222 100644
--- a/apps/web/src/app/example/page.tsx
+++ b/apps/web/src/app/example/page.tsx
@@ -1 +1 @@
-export const label = "before"
+export const label = "after"
`
      await expect(verifyPatch(tempRepo, diff, pinned))
        .rejects.toThrow(`源码基线已变化，预期 ${pinned}`)
    } finally {
      process.env.PATH = originalPath
      delete process.env.AUTOFIX_TEST_ADVANCE_MARKER
      delete process.env.AUTOFIX_TEST_SOURCE_REPO
      await rm(tempRoot, { recursive: true, force: true })
    }
  })
})
