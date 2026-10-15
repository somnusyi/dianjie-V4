/** Build independent A4 pages because WebKit may split table row groups. */
export function partitionDeliveryNoteRows(heights: number[], capacity: number): number[][] {
  if (!Number.isFinite(capacity) || capacity <= 0) throw new Error('送货单抬头或备注过长，请缩短后打印')
  const pages: number[][] = [[]]
  let used = 0
  heights.forEach((height, index) => {
    if (pages[pages.length - 1].length && used + height > capacity) { pages.push([]); used = 0 }
    pages[pages.length - 1].push(index)
    used += height
  })
  return pages
}

export function prepareDeliveryNotePrint(source: HTMLElement): () => void {
  document.querySelector('[data-delivery-note-print-root]')?.remove()
  const measure = source.cloneNode(true) as HTMLElement
  measure.removeAttribute('id')
  measure.setAttribute('data-delivery-note-print-measure', '')
  Object.assign(measure.style, { position: 'fixed', left: '-100000px', top: '0', visibility: 'hidden', width: '186mm', minHeight: '0', height: 'auto', padding: '0', margin: '0', boxShadow: 'none' })
  measure.style.setProperty('width', '186mm', 'important')
  document.body.appendChild(measure)
  let groups: number[][]
  try {
    const rows = Array.from(measure.querySelectorAll<HTMLElement>('[data-delivery-note-row]'))
    const first = rows[0]?.getBoundingClientRect()
    const last = rows[rows.length - 1]?.getBoundingClientRect()
    const bounds = measure.getBoundingClientRect()
    const header = first ? first.top - bounds.top : 0
    const tail = last ? bounds.bottom - last.bottom : 0
    const heights = rows.map(row => row.getBoundingClientRect().height)
    const capacity = 273 * 96 / 25.4 - header - 24
    groups = partitionDeliveryNoteRows(heights, capacity)
    const lastPage = groups[groups.length - 1]
    if (lastPage.reduce((sum, index) => sum + heights[index], 0) + tail > capacity) {
      if (lastPage.length > 1 && heights[lastPage[lastPage.length - 1]] + tail <= capacity) {
        groups.push([lastPage.pop()!])
      } else {
        groups.push([])
      }
    }
  } finally { measure.remove() }
  const root = document.createElement('div')
  root.setAttribute('data-delivery-note-print-root', '')
  groups.forEach((indexes, pageIndex) => {
    const page = source.cloneNode(true) as HTMLElement
    page.removeAttribute('id')
    page.classList.add('delivery-note-print-page')
    const keep = new Set(indexes)
    page.querySelectorAll('[data-delivery-note-row]').forEach((row, index) => { if (!keep.has(index)) row.remove() })
    if (pageIndex !== groups.length - 1) {
      page.querySelector('[data-delivery-note-totals]')?.remove()
      page.querySelector('[data-delivery-note-footer]')?.remove()
    }
    const number = document.createElement('div')
    number.textContent = `第 ${pageIndex + 1} 页 / 共 ${groups.length} 页`
    number.style.cssText = 'font-size:10px;text-align:right;margin-top:8px;color:#666'
    page.appendChild(number)
    root.appendChild(page)
  })
  document.body.appendChild(root)
  return () => root.remove()
}
