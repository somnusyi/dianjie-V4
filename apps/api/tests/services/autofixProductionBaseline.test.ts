import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { requireProductionBaseline } from '../../src/services/autofix/productionBaseline'

const BASE_SHA = '1'.repeat(40)
const NEWER_SHA = '2'.repeat(40)
let tempDir = ''

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true })
  tempDir = ''
})

async function makeTarget(marker?: string): Promise<string> {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'dianjie-autofix-production-baseline-'))
  if (marker !== undefined) {
    await writeFile(path.join(tempDir, '.deployed-commit'), marker, { mode: 0o600 })
  }
  return tempDir
}

describe('AutoFix production baseline pinning', () => {
  it('accepts only the exact full commit that was verified', async () => {
    const target = await makeTarget(`${BASE_SHA}\n`)
    await expect(requireProductionBaseline(target, BASE_SHA)).resolves.toBe(BASE_SHA)
  })

  it('rejects a production commit advanced by another release', async () => {
    const target = await makeTarget(`${NEWER_SHA}\n`)
    await expect(requireProductionBaseline(target, BASE_SHA))
      .rejects.toThrow(`生产基线已变化，预期 ${BASE_SHA}，实际 ${NEWER_SHA}`)
  })

  it.each([
    { marker: undefined, message: '生产部署提交标记缺失' },
    { marker: 'main\n', message: '生产部署提交标记无效' },
  ])('fails closed for a missing or invalid marker', async ({ marker, message }) => {
    const target = await makeTarget(marker)
    await expect(requireProductionBaseline(target, BASE_SHA)).rejects.toThrow(message)
  })

  it('rejects an incomplete baseline stored on the run', async () => {
    const target = await makeTarget(`${BASE_SHA}\n`)
    await expect(requireProductionBaseline(target, BASE_SHA.slice(0, 8)))
      .rejects.toThrow('自动修复记录缺少有效的完整源码基线 SHA')
  })
})
