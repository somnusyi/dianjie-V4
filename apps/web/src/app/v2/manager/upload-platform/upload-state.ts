export type DailyImportStatus = 'PREVIEWED' | 'CONFIRMING' | 'CONFIRMED' | 'SUPERSEDED'

export const IMPORT_STATUS: Record<DailyImportStatus, { label: string; badge: string }> = {
  PREVIEWED: { label: '待确认', badge: 'bg-orange-bg text-orange-fg' },
  CONFIRMING: { label: '确认处理中', badge: 'bg-blue/10 text-blue-fg' },
  CONFIRMED: { label: '已确认', badge: 'bg-green-bg text-green-fg' },
  SUPERSEDED: { label: '已被新版替代', badge: 'bg-bg text-gray3' },
}

export type DailyImportIssue = { code: string }

const DEFERRABLE_CODES = new Set(['DISH_UNMATCHED', 'BOM_MISSING'])

export function splitDailyImportIssues(issues: DailyImportIssue[]) {
  return {
    deferred: issues.filter(issue => DEFERRABLE_CODES.has(issue.code)),
    hard: issues.filter(issue => !DEFERRABLE_CODES.has(issue.code)),
  }
}

export function canConfirmDailyImport(status: DailyImportStatus, issues: DailyImportIssue[]) {
  return status === 'PREVIEWED' && splitDailyImportIssues(issues).hard.length === 0
}

export function formatUploadFileSize(value: number) {
  return value < 1024 * 1024
    ? `${Math.max(1, Math.round(value / 1024))} KB`
    : `${(value / 1024 / 1024).toFixed(1)} MB`
}
