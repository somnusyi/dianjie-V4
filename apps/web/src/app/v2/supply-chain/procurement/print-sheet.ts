export function printSheet(printId: string) {
  const sheet = document.getElementById(printId)
  if (!sheet) return
  document.querySelectorAll('[data-print-clone="true"]').forEach((item) => item.remove())
  const clone = sheet.cloneNode(true) as HTMLElement
  clone.removeAttribute('id')
  clone.setAttribute('data-print-clone', 'true')
  document.body.appendChild(clone)
  document.body.setAttribute('data-procurement-printing', 'true')
  const clear = () => {
    clone.remove()
    document.body.removeAttribute('data-procurement-printing')
  }
  window.addEventListener('afterprint', clear, { once: true })
  try {
    window.print()
  } catch (error) {
    window.removeEventListener('afterprint', clear)
    clear()
    throw error
  }
}
