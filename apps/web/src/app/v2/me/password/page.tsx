/**
 * 修改密码 · 通用 (供应商 / 财务 / 店长 等所有角色)
 * 接 POST /api/auth/change-password { oldPassword, newPassword }
 */
'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { apiFetch } from '@/lib/v2-auth'

export default function ChangePasswordPage() {
  const router = useRouter()
  const [oldPassword, setOld] = useState('')
  const [newPassword, setNew] = useState('')
  const [confirm, setConfirm] = useState('')
  const [show, setShow] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const canSubmit = oldPassword.length > 0 && newPassword.length >= 6 && confirm.length > 0 && !submitting

  async function submit() {
    setError(null)
    if (newPassword.length < 6) { setError('新密码至少 6 位'); return }
    if (newPassword !== confirm) { setError('两次输入的新密码不一致'); return }
    if (newPassword === oldPassword) { setError('新密码不能与原密码相同'); return }
    setSubmitting(true)
    try {
      await apiFetch('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ oldPassword, newPassword }),
      })
      setDone(true)
    } catch (e: any) {
      setError(e?.message || '修改失败')
      setSubmitting(false)
    }
  }

  if (done) {
    return (
      <div className="min-h-screen bg-bg flex flex-col items-center justify-center px-6 text-center">
        <div className="w-16 h-16 rounded-full bg-green-bg text-green-fg flex items-center justify-center text-h1 mb-4">✓</div>
        <h1 className="text-h1">密码已修改</h1>
        <p className="text-caption text-gray3 mt-2">下次登录请使用新密码</p>
        <button onClick={() => router.replace('/v2/me')}
                className="mt-6 px-6 py-3 bg-ink text-white rounded-cta text-button">返回我的</button>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-bg pb-12">
      <header className="px-4 pt-4 pb-2 flex items-center gap-3">
        <button onClick={() => router.back()} className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center">‹</button>
        <h1 className="text-h1">修改密码</h1>
      </header>

      <div className="px-4 mt-2 space-y-3">
        {error && <div className="bg-red-bg text-red-fg rounded-card p-3 text-caption">{error}</div>}

        <div className="bg-white rounded-card border border-border divide-y divide-border">
          <Field label="原密码">
            <input type={show ? 'text' : 'password'} value={oldPassword} onChange={e => setOld(e.target.value)}
                   placeholder="请输入当前密码" autoComplete="current-password"
                   className="w-full bg-transparent text-body outline-none placeholder:text-gray3" />
          </Field>
          <Field label="新密码">
            <input type={show ? 'text' : 'password'} value={newPassword} onChange={e => setNew(e.target.value)}
                   placeholder="至少 6 位" autoComplete="new-password"
                   className="w-full bg-transparent text-body outline-none placeholder:text-gray3" />
          </Field>
          <Field label="确认新密码">
            <input type={show ? 'text' : 'password'} value={confirm} onChange={e => setConfirm(e.target.value)}
                   placeholder="再次输入新密码" autoComplete="new-password"
                   className="w-full bg-transparent text-body outline-none placeholder:text-gray3" />
          </Field>
        </div>

        <label className="flex items-center gap-2 px-1 text-caption text-gray3">
          <input type="checkbox" checked={show} onChange={e => setShow(e.target.checked)} />
          显示密码
        </label>

        <button onClick={submit} disabled={!canSubmit}
                className="w-full py-3 bg-ink text-white rounded-cta text-button disabled:opacity-40">
          {submitting ? '提交中…' : '确认修改'}
        </button>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="px-3 py-3">
      <div className="text-micro text-gray3 mb-1">{label}</div>
      {children}
    </div>
  )
}
