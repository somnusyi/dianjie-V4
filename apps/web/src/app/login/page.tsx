'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import api from '@/lib/api'
import { useAuthStore } from '@/store/auth'
import styles from './page.module.css'

export default function LoginPage() {
  const router = useRouter()
  const { setUser, setToken } = useAuthStore()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleLogin = async () => {
    if (!email || !password) return setError('请填写账号和密码')
    setLoading(true); setError('')
    try {
      const res = await api.post('/api/auth/login', { email, password })
      setToken(res.data.token)
      setUser(res.data.user)
      if (res.data.refreshToken) localStorage.setItem('dj_refresh', res.data.refreshToken)
      router.push('/dashboard')
    } catch (err: any) {
      setError(err.response?.data?.error || '登录失败，请重试')
    } finally { setLoading(false) }
  }

  return (
    <div className={styles.page} style={{ minHeight: '100vh', display: 'flex', background: '#f4f6f9' }}>
      <div className={styles.brand} style={{ width: 420, background: '#0c1a12', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 48 }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>🍄</div>
        <div style={{ fontSize: 26, fontWeight: 700, color: '#fff', letterSpacing: 4, marginBottom: 6 }}>滇界云管</div>
        <div style={{ fontSize: 13, color: '#4a7a5e', marginBottom: 48 }}>连锁餐饮数字化管理平台</div>
        {['多门店统一管理', '采购到付款全链路', '账期自动倒计时付款', 'AI 智能经营分析'].map(f => (
          <div key={f} style={{ color: '#7db898', fontSize: 13, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 10, width: '100%' }}>
            <span style={{ color: '#2daa72', fontSize: 16 }}>✓</span>{f}
          </div>
        ))}
      </div>

      <div className={styles.formShell} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div className={styles.formCard} style={{ width: 380 }}>
          <div style={{ fontSize: 22, fontWeight: 700, marginBottom: 6 }}>欢迎回来</div>
          <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 28 }}>登录滇界云管管理平台</div>

          <div style={{ marginBottom: 14 }}>
            <label style={{ fontSize: 12, fontWeight: 500, display: 'block', marginBottom: 5 }}>邮箱</label>
            <input value={email} onChange={e => setEmail(e.target.value)} placeholder="请输入邮箱"
              style={{ width: '100%', border: '1.5px solid #e5e7eb', borderRadius: 8, padding: '9px 12px', fontSize: 13, outline: 'none' }} />
          </div>
          <div style={{ marginBottom: 20 }}>
            <label style={{ fontSize: 12, fontWeight: 500, display: 'block', marginBottom: 5 }}>密码</label>
            <input value={password} onChange={e => setPassword(e.target.value)} type="password" placeholder="请输入密码"
              onKeyDown={e => e.key === 'Enter' && handleLogin()}
              style={{ width: '100%', border: '1.5px solid #e5e7eb', borderRadius: 8, padding: '9px 12px', fontSize: 13, outline: 'none' }} />
          </div>

          {error && <div style={{ color: '#dc2626', fontSize: 12, marginBottom: 14, background: '#fef2f2', padding: '8px 12px', borderRadius: 6 }}>{error}</div>}

          <button onClick={handleLogin} disabled={loading}
            style={{ width: '100%', background: '#156b43', color: '#fff', border: 'none', borderRadius: 8, padding: 11, fontSize: 14, fontWeight: 600, cursor: loading ? 'wait' : 'pointer' }}>
            {loading ? '登录中...' : '登 录'}
          </button>

          <div style={{ marginTop: 24, fontSize: 11, color: '#9ca3af', textAlign: 'center' }}>© 2024 滇界云管</div>
        </div>
      </div>
    </div>
  )
}
