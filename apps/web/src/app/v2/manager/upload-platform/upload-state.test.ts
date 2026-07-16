import { describe, expect, it } from 'vitest'
import { canConfirmDailyImport, formatUploadFileSize, IMPORT_STATUS } from './upload-state'

describe('daily business import presentation', () => {
  it('only allows an unblocked preview to be confirmed', () => {
    expect(canConfirmDailyImport('PREVIEWED', 0)).toBe(true)
    expect(canConfirmDailyImport('PREVIEWED', 1)).toBe(false)
    expect(canConfirmDailyImport('CONFIRMING', 0)).toBe(false)
    expect(canConfirmDailyImport('CONFIRMED', 0)).toBe(false)
    expect(canConfirmDailyImport('SUPERSEDED', 0)).toBe(false)
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
