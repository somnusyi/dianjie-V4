/**
 * 商品图片大图预览
 *
 * 点击遮罩或关闭按钮关闭；支持 ESC 键退出。
 * 与供应商商品工作台配套使用，保持移动端现有交互不变。
 */
'use client'
import React, { useEffect } from 'react'

export type ProductImagePreviewProps = {
  /** 图片 URL；为 null 或空时不渲染 */
  src: string | null
  /** 关闭按钮/图片的 alt 文本 */
  alt?: string
  /** 是否显示预览层 */
  isOpen: boolean
  /** 关闭回调 */
  onClose: () => void
}

export function ProductImagePreview({ src, alt = '', isOpen, onClose }: ProductImagePreviewProps) {
  useEffect(() => {
    if (!isOpen) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [isOpen, onClose])

  if (!isOpen || !src) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/80 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`${alt || '商品'} 大图预览`}
      data-testid="image-preview-overlay"
    >
      <button
        type="button"
        onClick={e => { e.stopPropagation(); onClose() }}
        className="absolute top-4 right-4 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white text-h2 hover:bg-white/20 transition"
        aria-label="关闭预览"
        data-testid="image-preview-close"
      >
        ×
      </button>
      <img
        src={src}
        alt={alt}
        className="max-h-[90vh] max-w-[90vw] object-contain rounded-card shadow-lg"
        onClick={e => e.stopPropagation()}
        data-testid="image-preview-img"
      />
    </div>
  )
}
