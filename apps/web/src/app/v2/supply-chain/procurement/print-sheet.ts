let activeCleanup: (() => void) | null = null

export function printSheet(printId: string) {
  const sheet = document.getElementById(printId)
  if (!sheet) return
  activeCleanup?.()
  document.querySelectorAll('[data-print-clone="true"]').forEach((item) => item.remove())
  const clone = sheet.cloneNode(true) as HTMLElement
  clone.removeAttribute('id')
  clone.setAttribute('data-print-clone', 'true')
  // Print CSS reveals the snapshot; browsers without afterprint must not show a duplicate panel.
  clone.style.display = 'none'
  document.body.appendChild(clone)
  document.body.setAttribute('data-procurement-printing', 'true')
  const onFocus = () => { if (!window.matchMedia?.('print').matches) clear() }
  const clear = () => {
    clone.remove()
    document.body.removeAttribute('data-procurement-printing')
    window.removeEventListener('afterprint', clear)
    window.removeEventListener('focus', onFocus)
    window.removeEventListener('pagehide', clear)
    if (activeCleanup === clear) activeCleanup = null
  }
  activeCleanup = clear
  window.addEventListener('afterprint', clear)
  window.addEventListener('focus', onFocus)
  window.addEventListener('pagehide', clear)
  try { window.print() }
  catch (error) { clear(); throw error }
}
