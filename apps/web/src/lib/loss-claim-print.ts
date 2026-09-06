export const MAX_PRINTABLE_EVIDENCE_IMAGES = 4

export function isLossClaimVideo(url: string) {
  return /\.(mp4|mov|webm|m4v|3gp|3gpp)(?:\?|$)/i.test(url)
}

export function printableEvidenceImages(urls: string[]) {
  return urls.filter(url => !isLossClaimVideo(url)).slice(0, MAX_PRINTABLE_EVIDENCE_IMAGES)
}

export function evidenceImagePages(urls: string[]) {
  const images = printableEvidenceImages(urls)
  if (images.length === 0) return []
  return images.length === MAX_PRINTABLE_EVIDENCE_IMAGES
    ? [images.slice(2, 4)]
    : []
}

export function inlineEvidenceImages(urls: string[]) {
  const images = printableEvidenceImages(urls)
  return images.length === MAX_PRINTABLE_EVIDENCE_IMAGES
    ? images.slice(0, 2)
    : images
}

export function evidenceImageSrc(url: string) {
  return `/loss-claim-image?url=${encodeURIComponent(url)}`
}
