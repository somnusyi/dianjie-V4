import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8')
const helperSource = readFileSync(new URL('../../../../../lib/loss-claim-print.ts', import.meta.url), 'utf8')

describe('loss claim PDF layout contract', () => {
  it('uses the requested store arrival-difference title without brand or kind subtitle', () => {
    expect(source).toContain("claim.isManual ? ' · 内部报损单' : '到货差异单'")
    expect(source).toContain('claim.isManual && <p className="brand">')
    expect(source).toContain('claim.isManual && <p className="subtitle">')
    expect(source).not.toContain('<p className="subtitle">{KIND_LABEL[claim.kind] || \'供应商到货差异\'}</p>')
  })

  it('keeps the existing internal-loss title, kind label, spacing, and evidence flow', () => {
    expect(source).toContain("arrivalDifference ? 'arrival-difference-report' : 'manual-loss-report'")
    expect(source).toContain("ARRIVAL_SHORTAGE: '到货短缺'")
    expect(source).toContain("{KIND_LABEL[claim.kind] || '店内自有损耗'}")
    expect(source).toContain('.manual-loss-report { min-height: 297mm; aspect-ratio: auto; padding: 14mm 13mm 12mm; }')
    expect(source).toContain('.manual-loss-report .doc-header { padding-bottom: 4mm; }')
    expect(source).toContain('.manual-loss-report h1 { margin: 2mm 0 1mm; }')
    expect(source).toContain('.manual-loss-report .meta-grid { margin: 5mm 0; }')
    expect(source).toContain('arrivalDifference && printableImages.length === 0')
  })

  it('keeps the existing single-canvas PDF export for internal-loss reports', () => {
    expect(source).toContain('if (!arrivalDifference) {')
    expect(source).toContain("querySelector<HTMLElement>('.manual-loss-report')")
    expect(source).toContain('const margin = 8')
    expect(source).toContain('const width = 210 - margin * 2')
    expect(source).toContain("pdf.addImage(canvas.toDataURL('image/png'), 'PNG', margin, margin, width, height)")
  })

  it('keeps one to three images with the report and splits four as two plus two', () => {
    expect(helperSource).toContain('MAX_PRINTABLE_EVIDENCE_IMAGES = 4')
    expect(helperSource).toContain('.slice(0, MAX_PRINTABLE_EVIDENCE_IMAGES)')
    expect(helperSource).toContain('? [images.slice(2, 4)]')
    expect(helperSource).toContain('? images.slice(0, 2)')
    expect(source).toContain('inlineArrivalImages.length > 0')
    expect(source).toContain('inlineEvidenceImages(allPrintableImages)')
    expect(source).toContain('.arrival-evidence.evidence-count-3 { grid-template-columns: repeat(3')
  })

  it('renders each PDF page separately and keeps images fully visible in a 3:4 frame', () => {
    expect(source).toContain("querySelectorAll<HTMLElement>('.pdf-page')")
    expect(source).toContain("if (index > 0) pdf.addPage('a4', 'portrait')")
    expect(source).toContain('object-fit: contain')
    expect(source).toContain('aspect-ratio: 3 / 4')
    expect(source).toContain('max-width: 100%; max-height: 100%; width: auto; height: auto;')
    expect(source).toContain('aspect-ratio: 210 / 297')
    expect(source).toContain('.arrival-evidence.evidence-count-3 .evidence-card { width: 100%;')
  })

  it('loads evidence through the same-origin image endpoint for reliable PDF export', () => {
    expect(helperSource).toContain('/loss-claim-image?url=')
    expect(source).not.toContain('crossOrigin="anonymous"')
    expect(source).toContain('arrivalDifference && imageLoadFailed')
    expect(source).toContain('image.naturalWidth === 0')
  })

  it('keeps the arrival-difference table and signatures on one A4-width preview', () => {
    expect(source).toContain("arrivalDifference ? 'arrival-difference-report' : 'manual-loss-report'")
    expect(source).toContain('.arrival-difference-report table { min-width: 0;')
    expect(source).toContain('.arrival-difference-report .signatures { grid-template-columns: repeat(3')
    expect(source).toContain('{claim.isManual && (')
  })
})
