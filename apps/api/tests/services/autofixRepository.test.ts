import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { collectCandidateSources } from '../../src/services/autofix/repository'

const repoDir = path.resolve(process.cwd(), '../..')

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
