import { describe, expect, it } from 'vitest'
import { autoFixCandidateRef } from '../../src/services/autofix/deployment'

describe('AutoFix remote source persistence', () => {
  it('uses an isolated remote branch for each immutable candidate', () => {
    expect(autoFixCandidateRef('run-20260729_01'))
      .toBe('refs/heads/autofix/candidates/run-20260729_01')
  })

  it('rejects values that could escape the candidate namespace', () => {
    expect(() => autoFixCandidateRef('../main')).toThrow('任务 ID')
    expect(() => autoFixCandidateRef('run/other')).toThrow('任务 ID')
    expect(() => autoFixCandidateRef('')).toThrow('任务 ID')
  })
})
