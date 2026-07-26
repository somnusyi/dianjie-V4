import { readFile } from 'node:fs/promises'
import path from 'node:path'

const FULL_GIT_SHA = /^[0-9a-f]{40}$/

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
