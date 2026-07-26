'use client'
import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { apiFetch } from '@/lib/v2-auth'
import { ConfirmSheet, useConfirmSheet } from '@/components/v2/confirm-sheet'

type RunDetail = {
  id: string
  status: string
  analysis: string | null
  planSummary: string | null
  diffPatch: string
  diffFiles: Array<{ path: string; added: number; deleted: number }> | null
  diffTotal: number
  error: string | null
  deployLog: string | null
  commitSha: string | null
  mode: string
  deploymentReady: boolean
  feedback: {
    id: string
    title: string | null
    summary: string | null
    reporter: { id: string; name: string }
  }
}

export default function AutoFixDetailPage() {
  const params = useParams()
  const id = String(params.id)
  const [run, setRun] = useState<RunDetail | null>(null)
  const [error, setError] = useState('')
  const [rejectNote, setRejectNote] = useState('')
  const [acting, setActing] = useState(false)
  const [confirm, openConfirm] = useConfirmSheet()

  const load = useCallback(() => {
    apiFetch<RunDetail>(`/api/autofix/runs/${id}?diffLimit=50000`)
      .then((data) => { setRun(data); setError('') })
      .catch((e) => setError(e.message || '加载失败'))
  }, [id])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    if (!run || ![
      'RECEIVED', 'ANALYZING', 'PATCHING', 'VERIFYING',
      'PLAN_READY', 'DEPLOYING', 'VERIFY_PROD',
    ].includes(run.status)) return
    const timer = window.setInterval(load, 4000)
    return () => window.clearInterval(timer)
  }, [run, load])

  async function action(kind: 'approve' | 'reject' | 'rollback') {
    setActing(true)
    try {
      await apiFetch(`/api/autofix/runs/${id}/${kind}`, {
        method: 'POST',
        body: kind === 'reject' ? JSON.stringify({ note: rejectNote.trim() }) : JSON.stringify({}),
      })
      load()
    } catch (e: any) {
      setError(e.message || '操作失败')
    } finally {
      setActing(false)
    }
  }

  if (!run) {
    return (
      <div className="min-h-screen bg-bg px-4 pt-4">
        <button onClick={() => history.back()} className="w-9 h-9 rounded-full bg-white border border-border">‹</button>
        <div className={`text-caption mt-4 ${error ? 'text-red-fg' : 'text-gray3'}`}>{error || '加载中…'}</div>
      </div>
    )
  }

  const analysis = (() => {
    try { return JSON.parse(run.analysis || '{}') }
    catch { return { rootCause: run.analysis } }
  })()
  const awaiting = run.status === 'AWAITING_APPROVAL' && run.mode === 'suggest'
  const rollbackable = run.status === 'RESOLVED' && !!run.commitSha

  return (
    <div className="min-h-screen bg-bg pb-12">
      <header className="px-4 pt-4 pb-3 flex items-center gap-3 border-b border-border">
        <button
          onClick={() => { location.href = '/v2/boss/autofix' }}
          className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center"
        >
          ‹
        </button>
        <div className="min-w-0">
          <h1 className="text-h2 truncate">{run.feedback.title || 'AI 自动修复详情'}</h1>
          <p className="text-caption text-gray3">{run.feedback.reporter.name} 提出 · {run.status}</p>
        </div>
      </header>

      <div className="px-4 mt-3 space-y-3">
        {!run.deploymentReady && (
          <div className="rounded-card border border-amber-200 bg-amber-50 p-3 text-caption text-amber-800">
            当前自动发布未就绪（{run.mode}）。任务会转人工，不会在半配置状态修改生产。
          </div>
        )}
        {run.mode === 'approved_auto' && run.deploymentReady && (
          <div className="rounded-card border border-green-200 bg-green-50 p-3 text-caption text-green-800">
            本任务已在反馈审批时获得授权；隔离验证通过后会自动发布，失败自动回滚。
          </div>
        )}
        {error && <div className="text-caption text-red-fg">{error}</div>}

        <section className="bg-white rounded-card border border-border p-3">
          <div className="text-caption text-gray3">AI 定位结论</div>
          <div className="text-body mt-1 whitespace-pre-wrap">{analysis.rootCause || '尚未生成'}</div>
          {typeof analysis.confidence === 'number' && (
            <div className="text-micro text-gray3 mt-2">置信度 {(analysis.confidence * 100).toFixed(0)}%</div>
          )}
        </section>

        <section className="bg-white rounded-card border border-border p-3">
          <div className="text-caption text-gray3">修复方案</div>
          <div className="text-body mt-1 whitespace-pre-wrap">{run.planSummary || '尚未生成'}</div>
          {Array.isArray(run.diffFiles) && run.diffFiles.length > 0 && (
            <ul className="mt-2 space-y-1">
              {run.diffFiles.map((file) => (
                <li key={file.path} className="text-micro text-gray2 break-all">
                  {file.path} <span className="text-green-700">+{file.added}</span> <span className="text-red-fg">-{file.deleted}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {run.diffPatch && (
          <details className="bg-white rounded-card border border-border p-3">
            <summary className="text-button cursor-pointer">查看代码差异（{run.diffTotal} 字符）</summary>
            <pre className="mt-2 p-2 bg-ink text-white rounded-md text-[11px] overflow-x-auto whitespace-pre-wrap break-all">
              {run.diffPatch}
            </pre>
          </details>
        )}

        {(run.deployLog || run.error) && (
          <details className="bg-white rounded-card border border-border p-3" open={!!run.error}>
            <summary className="text-button cursor-pointer">验证与部署记录</summary>
            {run.error && <div className="text-caption text-red-fg mt-2 whitespace-pre-wrap">{run.error}</div>}
            {run.deployLog && (
              <pre className="mt-2 p-2 bg-bg rounded-md text-[11px] overflow-x-auto whitespace-pre-wrap break-all">
                {run.deployLog}
              </pre>
            )}
          </details>
        )}

        {awaiting && (
          <section className="bg-white rounded-card border border-border p-3 space-y-2">
            <textarea
              value={rejectNote}
              onChange={(event) => setRejectNote(event.target.value)}
              rows={2}
              maxLength={500}
              placeholder="驳回理由（驳回时必填）"
              className="w-full text-body bg-bg rounded-cta px-3 py-2 outline-none resize-none"
            />
            <div className="flex gap-2">
              <button
                disabled={acting || !run.deploymentReady}
                onClick={() => openConfirm({
                  title: '批准并部署这个 AI 修复?',
                  body: '系统只会应用上方已验证补丁，并执行固定构建、重启和 60 秒健康检查；失败会自动回滚。',
                  confirmLabel: '批准部署',
                  onConfirm: () => action('approve'),
                })}
                className="flex-1 py-3 rounded-cta bg-ink text-white text-button disabled:opacity-40"
              >
                批准部署
              </button>
              <button
                disabled={acting}
                onClick={() => {
                  if (!rejectNote.trim()) { setError('请先填写驳回理由'); return }
                  openConfirm({
                    title: '驳回这个 AI 修复?',
                    body: rejectNote.trim(),
                    confirmLabel: '确认驳回',
                    tone: 'danger',
                    onConfirm: () => action('reject'),
                  })
                }}
                className="flex-1 py-3 rounded-cta bg-white border border-border text-red-fg text-button disabled:opacity-40"
              >
                驳回
              </button>
            </div>
          </section>
        )}

        {rollbackable && (
          <button
            disabled={acting || !run.deploymentReady}
            onClick={() => openConfirm({
              title: '回滚这个 AI 修复?',
              body: '系统将执行固定 git revert、重新构建并验证生产页面。',
              confirmLabel: '确认回滚',
              tone: 'danger',
              onConfirm: () => action('rollback'),
            })}
            className="w-full py-3 rounded-cta bg-white border border-red-200 text-red-fg text-button disabled:opacity-40"
          >
            一键回滚
          </button>
        )}
      </div>
      <ConfirmSheet {...confirm} />
    </div>
  )
}
