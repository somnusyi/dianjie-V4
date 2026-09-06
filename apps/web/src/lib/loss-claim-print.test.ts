import { describe, expect, it } from 'vitest'
import {
  evidenceImagePages,
  evidenceImageSrc,
  inlineEvidenceImages,
  printableEvidenceImages,
} from './loss-claim-print'

const images = Array.from({ length: 5 }, (_, index) => `https://example.test/${index + 1}.jpg`)

describe('loss claim print image layout', () => {
  it('keeps one to three images on the arrival-difference report page', () => {
    expect(evidenceImagePages(images.slice(0, 1))).toEqual([])
    expect(evidenceImagePages(images.slice(0, 2))).toEqual([])
    expect(evidenceImagePages(images.slice(0, 3))).toEqual([])
    expect(inlineEvidenceImages(images.slice(0, 1))).toEqual(images.slice(0, 1))
    expect(inlineEvidenceImages(images.slice(0, 2))).toEqual(images.slice(0, 2))
    expect(inlineEvidenceImages(images.slice(0, 3))).toEqual(images.slice(0, 3))
  })

  it('keeps the first pair on the report and moves only the second pair to a new page', () => {
    expect(inlineEvidenceImages(images)).toEqual(images.slice(0, 2))
    expect(evidenceImagePages(images)).toEqual([images.slice(2, 4)])
  })

  it('does not count videos toward the four printable images', () => {
    expect(printableEvidenceImages([images[0], 'https://example.test/proof.mp4', ...images.slice(1)]))
      .toEqual(images.slice(0, 4))
  })

  it('uses a same-origin route for PDF-safe image loading', () => {
    expect(evidenceImageSrc(images[0])).toBe(`/loss-claim-image?url=${encodeURIComponent(images[0])}`)
  })
})
