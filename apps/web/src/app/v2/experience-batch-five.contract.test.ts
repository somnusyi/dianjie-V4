import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function source(relativePath: string) {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
}

const confirmSheetPages = [
  './supply-chain/procurement/page.tsx',
  './supplier/upstream/page.tsx',
  './supply-chain/inventory/page.tsx',
  './supply-chain/inventory/import/page.tsx',
  './manager/inventory/page.tsx',
  './finance-pc/review/page.tsx',
]

const inlineFeedbackPages = [
  './chef/check/new/page.tsx',
  './chef/purchase/[id]/ack/page.tsx',
  './chef/purchase/[id]/report-loss/page.tsx',
  './chef/purchase/[id]/receive/page.tsx',
]

const nativeDialog = /\b(?:window\.)?(?:alert|prompt|confirm)\s*\(/

describe('2026-09-28 原生弹窗迁移', () => {
  it('removes browser-native dialogs from every O-2 target page', () => {
    for (const page of [...confirmSheetPages, ...inlineFeedbackPages]) {
      expect(source(page), page).not.toMatch(nativeDialog)
    }
  })

  it('uses the shared ConfirmSheet for confirmations and required reasons', () => {
    for (const page of confirmSheetPages) {
      const code = source(page)
      expect(code, page).toContain('useConfirmSheet')
      expect(code, page).toContain('<ConfirmSheet')
    }
    expect(source('./supply-chain/procurement/page.tsx')).toContain('inputRequired: true')
    expect(source('./supplier/upstream/page.tsx')).toContain('inputRequired: true')
  })

  it('uses accessible inline feedback in the chef workflow', () => {
    for (const page of inlineFeedbackPages) {
      const code = source(page)
      expect(code, page).toContain('role="alert"')
    }
  })
})
