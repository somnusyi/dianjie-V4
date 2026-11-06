import { buildDeliveryNotePages } from './delivery-note-print'
import { waitForDeliveryNoteFonts } from './delivery-note-layout'

/** Generate a local file only; upload and business events remain with the caller. */
export async function renderDeliveryNotePdf(source: HTMLElement) {
  await waitForDeliveryNoteFonts()
  const [{ default: html2canvas }, { default: jsPDF }] = await Promise.all([import('html2canvas'), import('jspdf')])
  const root = buildDeliveryNotePages(source)
  root.setAttribute('data-delivery-note-pdf-root', '')
  root.style.cssText = 'position:absolute;left:-100000px;top:0;display:block;width:186mm'
  document.body.appendChild(root)
  const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true })
  try {
    const pages = Array.from(root.children) as HTMLElement[]
    for (let index = 0; index < pages.length; index++) {
      // Capture each page at the same origin; stacked page offsets can clip later-page headers.
      root.replaceChildren(pages[index])
      const canvas = await html2canvas(pages[index], { scale: 3, backgroundColor: '#fff', useCORS: true })
      if (index) pdf.addPage()
      const height = canvas.height * 186 / canvas.width
      if (height > 273.5) throw new Error('送货单内容超出纸面，请检查长备注或商品规格')
      pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 12, 12, 186, height, undefined, 'FAST')
    }
    return { blob: pdf.output('blob') as Blob, dataUrl: pdf.output('datauristring') as string }
  } finally { root.remove() }
}
