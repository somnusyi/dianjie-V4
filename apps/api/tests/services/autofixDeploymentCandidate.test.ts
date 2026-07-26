import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  preparePatchedDeploymentCandidate,
  prepareRevertedDeploymentCandidate,
  removeDeploymentCandidate,
  type DeploymentCandidate,
} from '../../src/services/autofix/deploymentCandidate'

const execFileAsync = promisify(execFile)
let tempRoot = ''
let repo = ''
let candidate: DeploymentCandidate | null = null

async function git(args: string[], cwd = repo): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd })
  return stdout.trim()
}

async function makeRepo(): Promise<string> {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'dianjie-autofix-candidate-test-'))
  repo = path.join(tempRoot, 'repo')
  await execFileAsync('git', ['init', '-q', repo])
  await writeFile(path.join(repo, 'page.tsx'), 'export const label = "before"\n')
  await git(['add', 'page.tsx'])
  await git(['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-qm', 'base'])
  return git(['rev-parse', 'HEAD'])
}

afterEach(async () => {
  if (candidate) await removeDeploymentCandidate(repo, candidate)
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
  candidate = null
  tempRoot = ''
  repo = ''
})

describe('AutoFix isolated deployment candidate', () => {
  it('commits the approved patch without advancing or dirtying the source branch', async () => {
    const baseCommitSha = await makeRepo()
    const diffPatch = `diff --git a/page.tsx b/page.tsx
index 6a7c58d..3d5f2aa 100644
--- a/page.tsx
+++ b/page.tsx
@@ -1 +1 @@
-export const label = "before"
+export const label = "after"
`
    candidate = await preparePatchedDeploymentCandidate({
      repo,
      baseCommitSha,
      diffPatch,
      files: ['page.tsx'],
      runId: 'run-isolated',
    })

    expect(await git(['rev-parse', 'HEAD'])).toBe(baseCommitSha)
    expect(await git(['status', '--porcelain'])).toBe('')
    expect(await readFile(path.join(repo, 'page.tsx'), 'utf8')).toContain('"before"')
    expect(await git(['rev-parse', 'HEAD^'], candidate.worktreeDir)).toBe(baseCommitSha)
    expect(await readFile(path.join(candidate.worktreeDir, 'page.tsx'), 'utf8')).toContain('"after"')
  })

  it('cleans a rejected candidate without changing the source branch', async () => {
    const baseCommitSha = await makeRepo()
    await expect(preparePatchedDeploymentCandidate({
      repo,
      baseCommitSha,
      diffPatch: 'not a patch\n',
      files: ['page.tsx'],
      runId: 'run-invalid',
    })).rejects.toThrow()

    expect(await git(['rev-parse', 'HEAD'])).toBe(baseCommitSha)
    expect(await git(['status', '--porcelain'])).toBe('')
    expect((await git(['worktree', 'list', '--porcelain'])).match(/^worktree /gm)).toHaveLength(1)
  })
})

describe('AutoFix isolated rollback candidate', () => {
  it('reverts the deployed commit without advancing or dirtying the source branch', async () => {
    const baseCommitSha = await makeRepo()
    await writeFile(path.join(repo, 'page.tsx'), 'export const label = "after"\n')
    await git(['add', 'page.tsx'])
    await git([
      '-c', 'user.name=Test',
      '-c', 'user.email=test@localhost',
      'commit', '-qm', 'deployed autofix',
    ])
    const deployedCommitSha = await git(['rev-parse', 'HEAD'])

    candidate = await prepareRevertedDeploymentCandidate({
      repo,
      deployedCommitSha,
      runId: 'run-rollback-isolated',
    })

    expect(await git(['rev-parse', 'HEAD'])).toBe(deployedCommitSha)
    expect(await git(['status', '--porcelain'])).toBe('')
    expect(await readFile(path.join(repo, 'page.tsx'), 'utf8')).toContain('"after"')
    expect(await git(['rev-parse', 'HEAD^'], candidate.worktreeDir)).toBe(deployedCommitSha)
    expect(await readFile(path.join(candidate.worktreeDir, 'page.tsx'), 'utf8')).toContain('"before"')
    expect(await git(['diff', '--name-only', baseCommitSha, candidate.commitSha], candidate.worktreeDir))
      .toBe('')
  })

  it('cleans a rejected rollback candidate without changing the source branch', async () => {
    const rootCommitSha = await makeRepo()
    await expect(prepareRevertedDeploymentCandidate({
      repo,
      deployedCommitSha: rootCommitSha,
      runId: 'run-rollback-invalid',
    })).rejects.toThrow()

    expect(await git(['rev-parse', 'HEAD'])).toBe(rootCommitSha)
    expect(await git(['status', '--porcelain'])).toBe('')
    expect((await git(['worktree', 'list', '--porcelain'])).match(/^worktree /gm)).toHaveLength(1)
  })
})
