import { describe, expect, it, vi } from 'vitest'
import { buildProductExportSearch, downloadProductExport, productExportFilename } from './export-products'

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
    it('uses YYYY-MM-DD suffix', () => {
      expect(productExportFilename(new Date('2026-07-25T10:38:55.883Z'))).toBe('商品报价表_2026-07-25.csv')
    })
  })

  describe('downloadProductExport', () => {
    it('calls apiDownload with encoded query and saves returned filename', async () => {
      const apiDownload = vi.fn().mockResolvedValue({ blob: new Blob(['a']), filename: 'server-name.csv' })
      const saveBlob = vi.fn()
      await downloadProductExport(apiDownload, saveBlob, '虾', '冻品', 'ENABLED', new Date('2026-07-25'))
      expect(apiDownload).toHaveBeenCalledTimes(1)
      expect(apiDownload.mock.calls[0][0]).toContain('/api/products/export.csv?')
      expect(apiDownload.mock.calls[0][0]).toContain('q=%E8%99%BE')
      expect(apiDownload.mock.calls[0][0]).toContain('category=%E5%86%BB%E5%93%81')
      expect(apiDownload.mock.calls[0][0]).toContain('status=ENABLED')
      expect(apiDownload.mock.calls[0][1]).toBe('商品报价表_2026-07-25.csv')
      expect(saveBlob).toHaveBeenCalledWith(expect.any(Blob), 'server-name.csv')
    })

    it('omits query string when no filters are active', async () => {
      const apiDownload = vi.fn().mockResolvedValue({ blob: new Blob(['a']), filename: 'fallback.csv' })
      const saveBlob = vi.fn()
      await downloadProductExport(apiDownload, saveBlob, '', '', '', new Date('2026-07-25'))
      expect(apiDownload).toHaveBeenCalledWith('/api/products/export.csv', '商品报价表_2026-07-25.csv')
    })

    it('bubbles apiDownload failures', async () => {
      const apiDownload = vi.fn().mockRejectedValue(new Error('网络错误'))
      const saveBlob = vi.fn()
      await expect(downloadProductExport(apiDownload, saveBlob, '', '', '')).rejects.toThrow('网络错误')
      expect(saveBlob).not.toHaveBeenCalled()
    })
  })
})
