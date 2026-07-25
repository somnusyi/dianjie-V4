'use client'
import React from 'react'

export type OrderProductImageSize = 'compact' | 'picker'

const SIZE_MAP: Record<OrderProductImageSize, { box: string; placeholderText: string }> = {
  compact: { box: 'h-10 w-10', placeholderText: 'text-caption' },
  picker:  { box: 'h-12 w-12', placeholderText: 'text-body' },
}

export type OrderProductImageProps = {
  src: string | null | undefined
  name: string
  code?: string | null
  size?: OrderProductImageSize
}

function safeSrc(s: string | null | undefined): string | null {
  if (s == null) return null
  const t = s.trim()
  return t.length > 0 ? t : null
}

export function OrderProductImage({ src, name, code, size = 'compact' }: OrderProductImageProps) {
  const resolved = safeSrc(src)
  const dim = SIZE_MAP[size]
  const altText = code ? `${name} #${code}` : name

  if (!resolved) {
    return (
      <span
        aria-hidden="true"
        className={`${dim.box} shrink-0 rounded-chip border border-border bg-bg inline-flex items-center justify-center ${dim.placeholderText} text-gray4 select-none pointer-events-none`}
      >
        —
      </span>
    )
  }

  return (
    <img
      src={resolved}
      alt={altText}
      loading="lazy"
      decoding="async"
      className={`${dim.box} shrink-0 rounded-chip border border-border object-cover`}
    />
  )
}
