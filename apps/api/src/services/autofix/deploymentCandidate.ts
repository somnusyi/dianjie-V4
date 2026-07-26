import { execFile } from 'node:child_process'
import { access, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface DeploymentCandidate {
  tempRoot: string
  worktreeDir: string
  commitSha: string
}

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync('git', args, {
    cwd: repo,
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, CI: '1' },
  })
  return `${stdout || ''}${stderr || ''}`.trim()
}

export async function removeDeploymentCandidate(
  repo: string,
  candidate: Pick<DeploymentCandidate, 'tempRoot' | 'worktreeDir'>,
): Promise<void> {
  await git(repo, ['worktree', 'remove', '--force', candidate.worktreeDir]).catch(() => undefined)
  await rm(candidate.tempRoot, { recursive: true, force: true })
}

export async function preparePatchedDeploymentCandidate(input: {
  repo: string
  baseCommitSha: string
  diffPatch: string
  files: string[]
  runId: string
}): Promise<DeploymentCandidate> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'dianjie-autofix-deploy-'))
  const worktreeDir = path.join(tempRoot, 'worktree')
  const patchFile = path.join(tempRoot, 'approved.patch')
  const partial = { tempRoot, worktreeDir }

  try {
    await writeFile(patchFile, input.diffPatch, { mode: 0o600 })
    await git(input.repo, ['worktree', 'add', '--detach', worktreeDir, input.baseCommitSha])
    const sourceNodeModules = path.join(input.repo, 'node_modules')
    await access(sourceNodeModules)
      .then(() => symlink(sourceNodeModules, path.join(worktreeDir, 'node_modules'), 'dir'))
      .catch(() => undefined)
    await git(worktreeDir, ['apply', '--check', patchFile])
    await git(worktreeDir, ['apply', '--whitespace=error-all', patchFile])
    await git(worktreeDir, ['add', '--', ...input.files])
    await git(worktreeDir, [
      '-c', 'user.name=Dianjie AutoFix',
      '-c', 'user.email=autofix@localhost',
      'commit', '-m', `fix(autofix): approved run ${input.runId}`,
    ])

    const commitSha = await git(worktreeDir, ['rev-parse', 'HEAD'])
    const parentSha = await git(worktreeDir, ['rev-parse', 'HEAD^'])
    if (parentSha !== input.baseCommitSha) {
      throw new Error(`自动修复候选父提交异常，预期 ${input.baseCommitSha}，实际 ${parentSha}`)
    }
    if (await git(worktreeDir, ['status', '--porcelain'])) {
      throw new Error('自动修复候选提交后工作树不干净')
    }
    for (const file of input.files) {
      await readFile(path.join(worktreeDir, file))
    }
    return { ...partial, commitSha }
  } catch (error) {
    await removeDeploymentCandidate(input.repo, partial)
    throw error
  }
}

export async function prepareRevertedDeploymentCandidate(input: {
  repo: string
  deployedCommitSha: string
  runId: string
}): Promise<DeploymentCandidate> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'dianjie-autofix-rollback-'))
  const worktreeDir = path.join(tempRoot, 'worktree')
  const partial = { tempRoot, worktreeDir }

  try {
    await git(input.repo, ['worktree', 'add', '--detach', worktreeDir, input.deployedCommitSha])
    const sourceNodeModules = path.join(input.repo, 'node_modules')
    await access(sourceNodeModules)
      .then(() => symlink(sourceNodeModules, path.join(worktreeDir, 'node_modules'), 'dir'))
      .catch(() => undefined)
    await git(worktreeDir, [
      '-c', 'user.name=Dianjie AutoFix',
      '-c', 'user.email=autofix@localhost',
      'revert', '--no-edit', input.deployedCommitSha,
    ])

    const commitSha = await git(worktreeDir, ['rev-parse', 'HEAD'])
    const parentSha = await git(worktreeDir, ['rev-parse', 'HEAD^'])
    if (parentSha !== input.deployedCommitSha) {
      throw new Error(`自动回滚候选父提交异常，预期 ${input.deployedCommitSha}，实际 ${parentSha}`)
    }
    if (await git(worktreeDir, ['status', '--porcelain'])) {
      throw new Error('自动回滚候选提交后工作树不干净')
    }
    await git(worktreeDir, [
      'diff', '--exit-code', `${input.deployedCommitSha}^`, commitSha, '--',
    ])
    return { ...partial, commitSha }
  } catch (error) {
    await removeDeploymentCandidate(input.repo, partial)
    throw error
  }
}
