import { describe, expect, it } from 'vitest'
import { extractUnifiedDiff, parseAnalysisResult } from '../../src/services/autofix/prompts'

describe('auto-fix AI output parsing', () => {
  it('parses a fenced analysis JSON and clamps confidence', () => {
    expect(parseAnalysisResult('```json\n{"rootCause":"空值未兜底","candidateFiles":["a.tsx"],"inWhitelist":true,"confidence":1.2}\n```'))
      .toEqual({
        rootCause: '空值未兜底',
        candidateFiles: ['a.tsx'],
        inWhitelist: true,
        confidence: 1,
      })
  })

  it('rejects incomplete analysis output', () => {
    expect(() => parseAnalysisResult('{"rootCause":"x"}')).toThrow('字段不完整')
  })

  it('extracts only the unified diff', () => {
    const diff = extractUnifiedDiff('```diff\ndiff --git a/a.tsx b/a.tsx\n--- a/a.tsx\n+++ b/a.tsx\n@@ -1 +1 @@\n-a\n+b\n```')
    expect(diff.startsWith('diff --git')).toBe(true)
    expect(diff.endsWith('\n')).toBe(true)
  })
})
