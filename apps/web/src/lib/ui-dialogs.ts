'use client'
// One application host renders all confirmations through ConfirmSheet, including legacy pages.
type Dialog = { id: number; message: string; kind: 'confirm' | 'prompt'; initialValue?: string; resolve: (value: string | boolean | null) => void }
type Notice = { id: number; message: string }
type Snapshot = { dialog: Dialog | null; notices: Notice[] }
const empty: Snapshot = { dialog: null, notices: [] }
let snapshot = empty
let sequence = 0
const queue: Dialog[] = []
const listeners = new Set<() => void>()
function publish() { snapshot = { ...snapshot, dialog: queue[0] || null }; listeners.forEach(listener => listener()) }
export const subscribeDialogs = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
export const getDialogs = () => snapshot
export const getServerDialogs = () => empty
export function confirmDialog(message: unknown): Promise<boolean> {
  if (queue.some(dialog => dialog.kind === 'confirm' && dialog.message === String(message))) return Promise.resolve(false)
  return new Promise(resolve => { queue.push({ id: ++sequence, message: String(message), kind: 'confirm', resolve: value => resolve(value === true) }); publish() })
}
export function promptDialog(message: unknown, initialValue?: string): Promise<string | null> {
  if (queue.some(dialog => dialog.kind === 'prompt' && dialog.message === String(message))) return Promise.resolve(null)
  return new Promise(resolve => { queue.push({ id: ++sequence, message: String(message), kind: 'prompt', initialValue, resolve: value => resolve(typeof value === 'string' ? value : null) }); publish() })
}
export function finishDialog(id: number, accepted: boolean, input?: string) {
  if (queue[0]?.id !== id) return
  const current = queue.shift()!
  current.resolve(accepted ? current.kind === 'prompt' ? input ?? '' : true : current.kind === 'prompt' ? null : false)
  publish()
}
export function cancelDialogs() {
  while (queue.length) { const current = queue.shift()!; current.resolve(current.kind === 'prompt' ? null : false) }
  publish()
}
export function notifyUser(message: unknown) {
  snapshot = { ...snapshot, notices: [...snapshot.notices.slice(-4), { id: ++sequence, message: String(message) }] }
  publish()
}
export function dismissNotice(id: number) { snapshot = { ...snapshot, notices: snapshot.notices.filter(notice => notice.id !== id) }; publish() }
