import { readFile } from 'node:fs/promises'
import path from 'node:path'

const FULL_GIT_SHA = /^[0-9a-f]{40}$/

/** 读取生产部署基线（.deployed-commit），缺失/无效即拒绝。 */
export async function readProductionBaseline(target: string): Promise<string> {
  let deployedCommit: string
  try {
    deployedCommit = (await readFile(path.join(target, '.deployed-commit'), 'utf8')).trim()
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new Error('生产部署提交标记缺失，拒绝自动覆盖')
    }
    throw error
  }
  if (!FULL_GIT_SHA.test(deployedCommit)) {
    throw new Error('生产部署提交标记无效，拒绝自动覆盖')
  }
  return deployedCommit
}

export async function requireProductionBaseline(
  target: string,
  expectedCommitSha: string,
): Promise<string> {
  if (!FULL_GIT_SHA.test(expectedCommitSha)) {
    throw new Error('自动修复记录缺少有效的完整源码基线 SHA')
  }

  let deployedCommit: string
  try {
    deployedCommit = (await readFile(path.join(target, '.deployed-commit'), 'utf8')).trim()
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new Error('生产部署提交标记缺失，拒绝自动覆盖')
    }
    throw error
  }

  if (!FULL_GIT_SHA.test(deployedCommit)) {
    throw new Error('生产部署提交标记无效，拒绝自动覆盖')
  }
  if (deployedCommit !== expectedCommitSha) {
    throw new Error(
      `生产基线已变化，预期 ${expectedCommitSha}，实际 ${deployedCommit}，请重新分析并审批`,
    )
  }
  return deployedCommit
}

export type BaselineResolution = 'same' | 'rebase' | 'reject_diverged' | 'reject_conflict'

/**
 * 基线不一致时的处置决策（纯函数，便于测试）：
 * - 相同 → 直接放行
 * - 生产基线不是开发基线的后代（分叉或回退）→ 拒绝，需重新开发
 * - 基线前移但补丁无法干净应用到新基线 → 拒绝，需重新开发
 * - 基线前移且补丁可干净应用 → 自动重基线放行
 */
export function planBaselineResolution(input: {
  base: string
  deployed: string
  isAncestor: boolean
  appliesClean: boolean
}): BaselineResolution {
  if (input.base === input.deployed) return 'same'
  if (!input.isAncestor) return 'reject_diverged'
  if (!input.appliesClean) return 'reject_conflict'
  return 'rebase'
}
