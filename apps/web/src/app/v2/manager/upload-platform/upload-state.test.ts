import { describe, expect, it } from 'vitest'
import { canConfirmDailyImport, formatUploadFileSize, IMPORT_STATUS, splitDailyImportIssues } from './upload-state'

describe('daily business import presentation', () => {
  it('only allows an unblocked preview to be confirmed', () => {
    expect(canConfirmDailyImport('PREVIEWED', [])).toBe(true)
    expect(canConfirmDailyImport('PREVIEWED', [{ code: 'BOM_MISSING' }])).toBe(true)
    expect(canConfirmDailyImport('PREVIEWED', [{ code: 'DISH_UNMATCHED' }])).toBe(true)
    expect(canConfirmDailyImport('PREVIEWED', [{ code: 'TARGET_STORE_MISMATCH' }])).toBe(false)
    expect(canConfirmDailyImport('CONFIRMING', [])).toBe(false)
    expect(canConfirmDailyImport('CONFIRMED', [])).toBe(false)
    expect(canConfirmDailyImport('SUPERSEDED', [])).toBe(false)
  })

  it('only classifies missing dish and BOM as deferrable', () => {
    const result = splitDailyImportIssues([
      { code: 'BOM_MISSING' }, { code: 'DISH_UNMATCHED' }, { code: 'DISH_AMBIGUOUS' },
    ])
    expect(result.deferred).toHaveLength(2)
    expect(result.hard).toEqual([{ code: 'DISH_AMBIGUOUS' }])
  })

  it('uses distinct labels for every audit state', () => {
    expect(new Set(Object.values(IMPORT_STATUS).map(item => item.label)).size).toBe(4)
    expect(IMPORT_STATUS.CONFIRMING.label).toBe('确认处理中')
    expect(IMPORT_STATUS.SUPERSEDED.label).toBe('已被新版替代')
  })

  it('formats selected file sizes for review', () => {
    expect(formatUploadFileSize(0)).toBe('1 KB')
    expect(formatUploadFileSize(512 * 1024)).toBe('512 KB')
    expect(formatUploadFileSize(1.25 * 1024 * 1024)).toBe('1.3 MB')
  })
})
