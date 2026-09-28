import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8')

describe('门店调拨确认交互', () => {
  it('发货、收货和撤回都由应用内确认层承载', () => {
    expect(source).toContain('useConfirmSheet')
    expect(source).toContain('<ConfirmSheet {...confirmState} />')
    expect(source).toContain("tone: nextStatus === 'REVOKED' ? 'danger' : 'primary'")
    expect(source).not.toContain('window.confirm')
  })

  it('接口失败会保留确认层并显示真实错误', () => {
    expect(source).toContain('onConfirm: () => changeStatus')
    expect(source).toContain('setStoreError(message)')
    expect(source).toContain('throw new Error(message)')
  })
})
