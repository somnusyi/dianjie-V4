'use client'
import { useEffect, useState } from 'react'
import AppLayout from '@/components/AppLayout'
import { useToast } from '@/components/ui'
import api from '@/lib/api'
import dayjs from 'dayjs'

const ROLES = [
  { value: 'MANAGER',       label: '店长' },
  { value: 'CHEF',          label: '总厨' },
  { value: 'FINANCE',       label: '财务' },

  { value: 'ADMIN',         label: '管理员' },
  { value: 'SUPPLIER_STAFF',label: '供应商' },
]

const ROLE_COLOR: Record<string, string> = {
  SUPER_ADMIN: '#7c3aed', ADMIN: '#2563eb', FINANCE: '#0891b2',
  MANAGER: '#156b43', PURCHASER: '#d97706', SUPPLIER_STAFF: '#9ca3af',
}
const ROLE_LABEL: Record<string, string> = {
  SUPER_ADMIN: '超管', ADMIN: '管理员', FINANCE: '财务',
  MANAGER: '店长', PURCHASER: '采购', SUPPLIER_STAFF: '供应商',
}

const emptyForm = { name: '', email: '', phone: '', password: '', role: 'MANAGER', storeId: '' }

export default function UsersPage() {
  const [users, setUsers] = useState<any[]>([])
  const [stores, setStores] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<any>(null)
  const [form, setForm] = useState({ ...emptyForm })
  const [resetTarget, setResetTarget] = useState<any>(null)
  const [newPwd, setNewPwd] = useState('')
  const [filterRole, setFilterRole] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const { show, ToastEl } = useToast()

  useEffect(() => { load() }, [])

  const load = async () => {
    setLoading(true)
    try {
      const [ur, sr] = await Promise.all([api.get('/api/users'), api.get('/api/stores')])
      setUsers(ur.data || [])
      setStores(sr.data || [])
    } catch { show('加载失败', 'error') }
    setLoading(false)
  }

  const openCreate = () => {
    setEditing(null)
    setForm({ ...emptyForm })
    setShowForm(true)
  }

  const openEdit = (u: any) => {
    setEditing(u)
    setForm({ name: u.name, email: u.email, phone: u.phone || '', password: '', role: u.role, storeId: u.storeId || '' })
    setShowForm(true)
  }

  const submit = async () => {
    if (!form.name || !form.email) return show('姓名和邮箱必填', 'error')
    if (!editing && !form.password) return show('新建用户必须设置密码', 'error')
    try {
      const payload: any = { name: form.name, email: form.email, phone: form.phone, role: form.role, storeId: form.storeId || null }
      if (form.password) payload.password = form.password
      if (editing) {
        await api.patch(`/api/users/${editing.id}`, payload)
        show('更新成功')
      } else {
        await api.post('/api/users', payload)
        show('创建成功')
      }
      setShowForm(false)
      load()
    } catch (e: any) { show(e.response?.data?.error || '操作失败', 'error') }
  }

  const toggle = async (u: any) => {
    try {
      const r = await api.patch(`/api/users/${u.id}/toggle`, {})
      show(r.data.message)
      load()
    } catch (e: any) { show(e.response?.data?.error || '操作失败', 'error') }
  }

  const resetPwd = async () => {
    if (!newPwd || newPwd.length < 6) return show('密码至少6位', 'error')
    try {
      await api.patch(`/api/users/${resetTarget.id}/reset-password`, { password: newPwd })
      show('密码已重置')
      setResetTarget(null)
      setNewPwd('')
    } catch (e: any) { show(e.response?.data?.error || '操作失败', 'error') }
  }

  const filtered = users.filter(u => {
    if (filterRole && u.role !== filterRole) return false
    if (filterStatus && u.status !== filterStatus) return false
    return true
  })

  const inp = (label: string, key: string, props: any = {}) => (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 5, fontWeight: 500 }}>{label}</div>
      <input
        value={(form as any)[key]}
        onChange={e => setForm({ ...form, [key]: e.target.value })}
        style={{ width: '100%', padding: '10px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 14, outline: 'none', boxSizing: 'border-box' }}
        {...props}
      />
    </div>
  )

  return (
    <AppLayout>
      {ToastEl}
      <div style={{ padding: 28, maxWidth: 1100 }}>

        {/* 标题栏 */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 700, color: '#111827', margin: 0 }}>👥 用户管理</h1>
            <p style={{ fontSize: 12, color: '#9ca3af', marginTop: 4 }}>管理系统账号、角色和权限</p>
          </div>
          <button onClick={openCreate} style={{
            background: '#156b43', color: '#fff', border: 'none', borderRadius: 10,
            padding: '10px 20px', fontSize: 14, fontWeight: 600, cursor: 'pointer',
          }}>+ 新建用户</button>
        </div>

        {/* 筛选栏 */}
        <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
          <select value={filterRole} onChange={e => setFilterRole(e.target.value)}
            style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #e5e7eb', fontSize: 13, background: '#fff', cursor: 'pointer' }}>
            <option value="">全部角色</option>
            {ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
          <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
            style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #e5e7eb', fontSize: 13, background: '#fff', cursor: 'pointer' }}>
            <option value="">全部状态</option>
            <option value="ACTIVE">启用</option>
            <option value="INACTIVE">禁用</option>
          </select>
          <span style={{ fontSize: 12, color: '#9ca3af', alignSelf: 'center' }}>共 {filtered.length} 人</span>
        </div>

        {/* 用户列表 */}
        <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #e5e7eb', overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f9fafb' }}>
                {['姓名', '邮箱', '角色', '绑定门店', '状态', '最后登录', '操作'].map(h => (
                  <th key={h} style={{ padding: '12px 16px', textAlign: 'left', fontSize: 11, color: '#6b7280', fontWeight: 600 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7} style={{ padding: 32, textAlign: 'center', color: '#9ca3af' }}>加载中...</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={7} style={{ padding: 32, textAlign: 'center', color: '#9ca3af' }}>暂无用户</td></tr>
              ) : filtered.map(u => (
                <tr key={u.id} style={{ borderTop: '1px solid #f3f4f6', opacity: u.status === 'INACTIVE' ? 0.5 : 1 }}>
                  <td style={{ padding: '12px 16px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ width: 32, height: 32, borderRadius: '50%', background: ROLE_COLOR[u.role] || '#e5e7eb', color: '#fff', fontSize: 13, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        {u.name[0]}
                      </div>
                      <span style={{ fontWeight: 500, color: '#111827' }}>{u.name}</span>
                    </div>
                  </td>
                  <td style={{ padding: '12px 16px', color: '#6b7280' }}>{u.email}</td>
                  <td style={{ padding: '12px 16px' }}>
                    <span style={{ fontSize: 11, fontWeight: 600, color: ROLE_COLOR[u.role] || '#6b7280', background: `${ROLE_COLOR[u.role]}18`, padding: '3px 8px', borderRadius: 6 }}>
                      {ROLE_LABEL[u.role] || u.role}
                    </span>
                  </td>
                  <td style={{ padding: '12px 16px', color: '#374151' }}>
                    {u.store ? <span>{u.store.name?.replace('滇界·', '')} <span style={{ color: '#9ca3af', fontSize: 11 }}>{u.store.no}</span></span> : <span style={{ color: '#d1d5db' }}>—</span>}
                  </td>
                  <td style={{ padding: '12px 16px' }}>
                    <span style={{ fontSize: 11, fontWeight: 600, color: u.status === 'ACTIVE' ? '#156b43' : '#dc2626', background: u.status === 'ACTIVE' ? '#edfaf3' : '#fef2f2', padding: '3px 8px', borderRadius: 6 }}>
                      {u.status === 'ACTIVE' ? '启用' : '禁用'}
                    </span>
                  </td>
                  <td style={{ padding: '12px 16px', color: '#9ca3af', fontSize: 11 }}>
                    {u.lastLoginAt ? dayjs(u.lastLoginAt).format('MM/DD HH:mm') : '从未登录'}
                  </td>
                  <td style={{ padding: '12px 16px' }}>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button onClick={() => openEdit(u)} style={{ fontSize: 11, padding: '4px 10px', border: '1px solid #e5e7eb', borderRadius: 6, cursor: 'pointer', background: '#fff', color: '#374151' }}>编辑</button>
                      <button onClick={() => { setResetTarget(u); setNewPwd('') }} style={{ fontSize: 11, padding: '4px 10px', border: '1px solid #e5e7eb', borderRadius: 6, cursor: 'pointer', background: '#fff', color: '#374151' }}>改密</button>
                      {u.role !== 'SUPER_ADMIN' && (
                        <button onClick={() => toggle(u)} style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6, cursor: 'pointer', border: 'none', background: u.status === 'ACTIVE' ? '#fef2f2' : '#edfaf3', color: u.status === 'ACTIVE' ? '#dc2626' : '#156b43', fontWeight: 600 }}>
                          {u.status === 'ACTIVE' ? '禁用' : '启用'}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* 新建/编辑弹窗 */}
        {showForm && (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={e => e.target === e.currentTarget && setShowForm(false)}>
            <div style={{ background: '#fff', borderRadius: 16, padding: 28, width: 440, boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
              <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 20 }}>{editing ? '编辑用户' : '新建用户'}</h2>
              {inp('姓名 *', 'name', { placeholder: '请输入姓名' })}
              {inp('邮箱 *', 'email', { type: 'email', placeholder: '登录邮箱', disabled: !!editing })}
              {inp('手机号', 'phone', { placeholder: '选填' })}
              {editing ? (
                inp('新密码', 'password', { type: 'password', placeholder: '不修改请留空' })
              ) : (
                inp('密码 *', 'password', { type: 'password', placeholder: '至少6位' })
              )}
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 5, fontWeight: 500 }}>角色 *</div>
                <select value={form.role} onChange={e => setForm({ ...form, role: e.target.value })}
                  style={{ width: '100%', padding: '10px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 14, background: '#fff', outline: 'none' }}>
                  {ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
              </div>
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 5, fontWeight: 500 }}>绑定门店 {form.role === 'MANAGER' ? '*' : '（选填）'}</div>
                <select value={form.storeId} onChange={e => setForm({ ...form, storeId: e.target.value })}
                  style={{ width: '100%', padding: '10px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 14, background: '#fff', outline: 'none' }}>
                  <option value="">不绑定门店</option>
                  {stores.map(s => <option key={s.id} value={s.id}>{s.name?.replace('滇界·', '')} ({s.no})</option>)}
                </select>
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button onClick={() => setShowForm(false)} style={{ flex: 1, padding: 12, border: '1px solid #e5e7eb', borderRadius: 10, background: '#fff', cursor: 'pointer', fontSize: 14 }}>取消</button>
                <button onClick={submit} style={{ flex: 2, padding: 12, background: '#156b43', color: '#fff', border: 'none', borderRadius: 10, cursor: 'pointer', fontSize: 14, fontWeight: 600 }}>
                  {editing ? '保存修改' : '创建用户'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 重置密码弹窗 */}
        {resetTarget && (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={e => e.target === e.currentTarget && setResetTarget(null)}>
            <div style={{ background: '#fff', borderRadius: 16, padding: 28, width: 360, boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
              <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>重置密码</h2>
              <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 20 }}>为 <strong>{resetTarget.name}</strong> 设置新密码</p>
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 5, fontWeight: 500 }}>新密码（至少6位）</div>
                <input type="password" value={newPwd} onChange={e => setNewPwd(e.target.value)} placeholder="输入新密码"
                  style={{ width: '100%', padding: '10px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 14, outline: 'none', boxSizing: 'border-box' }} />
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button onClick={() => setResetTarget(null)} style={{ flex: 1, padding: 12, border: '1px solid #e5e7eb', borderRadius: 10, background: '#fff', cursor: 'pointer', fontSize: 14 }}>取消</button>
                <button onClick={resetPwd} style={{ flex: 2, padding: 12, background: '#156b43', color: '#fff', border: 'none', borderRadius: 10, cursor: 'pointer', fontSize: 14, fontWeight: 600 }}>确认重置</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </AppLayout>
  )
}
