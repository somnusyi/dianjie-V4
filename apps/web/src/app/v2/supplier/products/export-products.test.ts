import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildProductExportSearch,
  downloadProductExport,
  productExportFilename,
  saveBlob,
} from './export-products'

describe('product export helpers', () => {
  describe('buildProductExportSearch', () => {
    it('returns empty string when no filters are active', () => {
      expect(buildProductExportSearch('', '', '')).toBe('')
    })

    it('encodes search keyword', () => {
      expect(buildProductExportSearch('鲜虾 白菜', '', '')).toBe('q=%E9%B2%9C%E8%99%BE+%E7%99%BD%E8%8F%9C')
    })

    it('passes category and status', () => {
      expect(buildProductExportSearch('', '蔬菜', 'ENABLED')).toBe('category=%E8%94%AC%E8%8F%9C&status=ENABLED')
    })

    it('prefers categoryId over category when both are provided', () => {
      expect(buildProductExportSearch('', '蔬菜', '', 'cat-123')).toBe('categoryId=cat-123')
    })

    it('combines q, categoryId and status', () => {
      const search = buildProductExportSearch('虾', '冻品', 'PENDING_APPROVAL', 'cat-1')
      expect(search).toContain('q=%E8%99%BE')
      expect(search).toContain('categoryId=cat-1')
      expect(search).toContain('status=PENDING_APPROVAL')
      expect(search).not.toContain('category=%E5%86%BB%E5%93%81')
    })

    it('combines q, category and status', () => {
      const search = buildProductExportSearch('虾', '冻品', 'PENDING_APPROVAL')
      expect(search).toContain('q=%E8%99%BE')
      expect(search).toContain('category=%E5%86%BB%E5%93%81')
      expect(search).toContain('status=PENDING_APPROVAL')
    })

    it('trims whitespace from q', () => {
      expect(buildProductExportSearch('  白菜  ', '', '')).toBe('q=%E7%99%BD%E8%8F%9C')
    })

    it('ignores empty category and status', () => {
      expect(buildProductExportSearch('test', '', '')).toBe('q=test')
    })
  })

  describe('productExportFilename', () => {
    it('uses China business date suffix (Asia/Shanghai)', () => {
      expect(productExportFilename(new Date('2026-07-25T10:38:55.883Z'))).toBe('商品报价表_2026-07-25.csv')
      expect(productExportFilename(new Date('2026-07-25T16:00:00.000Z'))).toBe('商品报价表_2026-07-26.csv')
    })
  })

  describe('saveBlob', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    })

    it('clicks an anchor and delays revokeObjectURL for Safari compatibility', () => {
      const click = vi.fn()
      const remove = vi.fn()
      const appendChild = vi.fn()
      const anchor: any = { click, remove }
      const createObjectURL = vi.fn().mockReturnValue('blob:test-url')
      const revokeObjectURL = vi.fn()

      vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
      vi.stubGlobal('document', {
        createElement: vi.fn().mockReturnValue(anchor),
        body: { appendChild },
      })

      const blob = new Blob(['csv'])
      saveBlob(blob, '报价表.csv')

      expect(createObjectURL).toHaveBeenCalledWith(blob)
      expect(anchor.href).toBe('blob:test-url')
      expect(anchor.download).toBe('报价表.csv')
      expect(appendChild).toHaveBeenCalledWith(anchor)
      expect(click).toHaveBeenCalled()
      expect(remove).toHaveBeenCalled()
      expect(revokeObjectURL).not.toHaveBeenCalled()

      vi.advanceTimersByTime(999)
      expect(revokeObjectURL).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:test-url')
    })
  })

  describe('downloadProductExport', () => {
    it('calls apiDownload with encoded query and saves returned filename', async () => {
      const apiDownload = vi.fn().mockResolvedValue({ blob: new Blob(['a']), filename: 'server-name.csv' })
      const save = vi.fn()
      await downloadProductExport(apiDownload, save, '虾', '冻品', 'ENABLED', new Date('2026-07-25'))
      expect(apiDownload).toHaveBeenCalledTimes(1)
      expect(apiDownload.mock.calls[0][0]).toContain('/api/products/export.csv?')
      expect(apiDownload.mock.calls[0][0]).toContain('q=%E8%99%BE')
      expect(apiDownload.mock.calls[0][0]).toContain('category=%E5%86%BB%E5%93%81')
      expect(apiDownload.mock.calls[0][0]).toContain('status=ENABLED')
      expect(apiDownload.mock.calls[0][1]).toBe('商品报价表_2026-07-25.csv')
      expect(save).toHaveBeenCalledWith(expect.any(Blob), 'server-name.csv')
    })

    it('passes categoryId when provided', async () => {
      const apiDownload = vi.fn().mockResolvedValue({ blob: new Blob(['a']), filename: 'f.csv' })
      const save = vi.fn()
      await downloadProductExport(apiDownload, save, '', '', 'ENABLED', new Date('2026-07-25'), 'cat-1')
      expect(apiDownload.mock.calls[0][0]).toContain('categoryId=cat-1')
      expect(apiDownload.mock.calls[0][0]).not.toContain('category=')
    })

    it('omits query string when no filters are active', async () => {
      const apiDownload = vi.fn().mockResolvedValue({ blob: new Blob(['a']), filename: 'fallback.csv' })
      const save = vi.fn()
      await downloadProductExport(apiDownload, save, '', '', '', new Date('2026-07-25'))
      expect(apiDownload).toHaveBeenCalledWith('/api/products/export.csv', '商品报价表_2026-07-25.csv')
    })

    it('bubbles apiDownload failures', async () => {
      const apiDownload = vi.fn().mockRejectedValue(new Error('网络错误'))
      const save = vi.fn()
      await expect(downloadProductExport(apiDownload, save, '', '', '')).rejects.toThrow('网络错误')
      expect(save).not.toHaveBeenCalled()
    })
  })
})
