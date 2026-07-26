'use client'

import { useEffect, useState } from 'react'
import { Chip } from '@/components/v2'
import { ProductToolTabs } from '@/components/v2/product-tool-tabs'
import { apiFetch } from '@/lib/v2-auth'

type ProductLog = {
  id: string
  action: string
  target?: string | null
  targetId?: string | null
  entityType: string
  operator: string
  createdAt: string
}

type UploadBatch = {
  id: string
  filename?: string | null
  totalRows: number
  createdCount: number
  failedCount: number
  revokedAt?: string | null
  createdAt: string
  _count?: { products: number }
}

export default function InternalProductHistoryPage() {
  const [logs, setLogs] = useState<ProductLog[]>([])
  const [batches, setBatches] = useState<UploadBatch[]>([])
  const [tab, setTab] = useState<'operations' | 'uploads'>('operations')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      apiFetch<ProductLog[]>('/api/products/history?limit=100'),
      apiFetch<UploadBatch[]>('/api/products/batches'),
    ])
      .then(([operationRows, batchRows]) => {
        setLogs(operationRows || [])
        setBatches(batchRows || [])
      })
      .catch(reason => setError(String(reason?.message || reason)))
      .finally(() => setLoading(false))
  }, [])

  return (
    <div className="min-h-screen bg-bg px-4 py-5 lg:px-8 lg:py-7">
      <header className="border-b border-border pb-5">
        <div className="mb-2 flex items-center gap-2">
          <Chip tone="green">可追溯</Chip>
          <span className="text-caption text-gray3">操作人、操作时间和批量导入结果</span>
        </div>
        <h1 className="text-h1">商品操作记录</h1>
        <p className="mt-1 text-caption text-gray2">记录商品、分类、批量状态和导入批次，不展示银行或其他模块日志。</p>
      </header>

      <ProductToolTabs />

      <div className="my-4 flex gap-2">
        <button onClick={() => setTab('operations')} className={`rounded-cta px-4 py-2 text-button ${tab === 'operations' ? 'bg-amber text-white' : 'border border-border bg-white'}`}>操作记录 {logs.length}</button>
        <button onClick={() => setTab('uploads')} className={`rounded-cta px-4 py-2 text-button ${tab === 'uploads' ? 'bg-amber text-white' : 'border border-border bg-white'}`}>导入历史 {batches.length}</button>
      </div>

      {error && <div className="mb-4 rounded-card border border-red/30 bg-red-bg p-3 text-caption text-red-fg">{error}</div>}
      {loading && <div className="rounded-card border border-border bg-white py-16 text-center text-caption text-gray3">加载中…</div>}

      {!loading && tab === 'operations' && (
        <div className="overflow-hidden rounded-card border border-border bg-white">
          <table className="w-full text-left text-caption">
            <thead className="bg-bg text-gray3"><tr><th className="px-4 py-3">时间</th><th className="px-4 py-3">操作人</th><th className="px-4 py-3">动作</th><th className="px-4 py-3">对象</th></tr></thead>
            <tbody className="divide-y divide-border">
              {logs.map(log => (
                <tr key={log.id}>
                  <td className="px-4 py-3 font-num text-gray2">{new Date(log.createdAt).toLocaleString('zh-CN', { hour12: false })}</td>
                  <td className="px-4 py-3"><b>{log.operator}</b></td>
                  <td className="px-4 py-3">{log.action}</td>
                  <td className="px-4 py-3 text-gray2">{log.target || log.entityType}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {logs.length === 0 && <div className="py-16 text-center text-caption text-gray3">暂无商品操作记录</div>}
        </div>
      )}

      {!loading && tab === 'uploads' && (
        <div className="overflow-hidden rounded-card border border-border bg-white">
          <table className="w-full text-left text-caption">
            <thead className="bg-bg text-gray3"><tr><th className="px-4 py-3">导入时间</th><th className="px-4 py-3">文件</th><th className="px-4 py-3">总行数</th><th className="px-4 py-3">成功</th><th className="px-4 py-3">失败</th><th className="px-4 py-3">状态</th></tr></thead>
            <tbody className="divide-y divide-border">
              {batches.map(batch => (
                <tr key={batch.id}>
                  <td className="px-4 py-3 font-num text-gray2">{new Date(batch.createdAt).toLocaleString('zh-CN', { hour12: false })}</td>
                  <td className="px-4 py-3"><b>{batch.filename || '未命名导入'}</b></td>
                  <td className="px-4 py-3 font-num">{batch.totalRows}</td>
                  <td className="px-4 py-3 font-num text-green-fg">{batch.createdCount}</td>
                  <td className="px-4 py-3 font-num text-red-fg">{batch.failedCount}</td>
                  <td className="px-4 py-3"><Chip tone={batch.revokedAt ? 'gray' : 'green'}>{batch.revokedAt ? '已撤回' : '有效'}</Chip></td>
                </tr>
              ))}
            </tbody>
          </table>
          {batches.length === 0 && <div className="py-16 text-center text-caption text-gray3">暂无批量导入记录</div>}
        </div>
      )}
    </div>
  )
}
