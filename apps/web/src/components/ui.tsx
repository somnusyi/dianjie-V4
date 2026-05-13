import React, { ReactNode, useState } from 'react'

// ── 页面头部 ──────────────────────────────────────────
export function PageHeader({ title, sub, action }: { title: string; sub?: string; action?: ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 22 }}>
      <div>
        <h1 style={{ fontSize: 18, fontWeight: 700, margin: 0, color: '#0a0f0c' }}>{title}</h1>
        {sub && <p style={{ fontSize: 12, color: '#6b7280', margin: '3px 0 0' }}>{sub}</p>}
      </div>
      {action && <div>{action}</div>}
    </div>
  )
}

// ── 状态徽章 ──────────────────────────────────────────
const BADGE_STYLES: Record<string, { bg: string; color: string }> = {
  // 入库单
  DRAFT:      { bg: '#f3f4f6', color: '#6b7280' },
  PENDING:    { bg: '#fffbeb', color: '#d97706' },
  CONFIRMED:  { bg: '#edfaf3', color: '#156b43' },
  ACCOUNTED:  { bg: '#eff6ff', color: '#2563eb' },
  VOID:       { bg: '#fef2f2', color: '#dc2626' },
  // 账期
  NOTIFIED:   { bg: '#fffbeb', color: '#d97706' },
  PROCESSING: { bg: '#eff6ff', color: '#2563eb' },
  PAID:       { bg: '#edfaf3', color: '#156b43' },
  OVERDUE:    { bg: '#fef2f2', color: '#dc2626' },
  CANCELLED:  { bg: '#f3f4f6', color: '#6b7280' },
  // 对账/付款
  APPROVED:         { bg: '#edfaf3', color: '#156b43' },
  REJECTED:         { bg: '#fef2f2', color: '#dc2626' },
  PAYMENT_GENERATED:{ bg: '#eff6ff', color: '#2563eb' },
  DONE:             { bg: '#edfaf3', color: '#156b43' },
  UNPAID:           { bg: '#fffbeb', color: '#d97706' },
  PAYING:           { bg: '#eff6ff', color: '#2563eb' },
  FAILED:           { bg: '#fef2f2', color: '#dc2626' },
  // 门店/供应商
  ENABLED:    { bg: '#edfaf3', color: '#156b43' },
  DISABLED:   { bg: '#f3f4f6', color: '#6b7280' },
}

const STATUS_LABELS: Record<string, string> = {
  DRAFT:'草稿', PENDING:'待确认', CONFIRMED:'已确认', ACCOUNTED:'已对账', VOID:'已作废',
  NOTIFIED:'已提醒', PROCESSING:'处理中', PAID:'已付款', OVERDUE:'已逾期', CANCELLED:'已取消',
  APPROVED:'已审核', REJECTED:'已驳回', PAYMENT_GENERATED:'已生成付款', DONE:'已完成',
  UNPAID:'待付款', PAYING:'付款中', FAILED:'付款失败',
  ENABLED:'启用', DISABLED:'停用',
}

export function Badge({ status }: { status: string }) {
  const s = BADGE_STYLES[status] || { bg: '#f3f4f6', color: '#6b7280' }
  return (
    <span style={{ padding: '2px 9px', borderRadius: 4, fontSize: 11, fontWeight: 600, background: s.bg, color: s.color }}>
      {STATUS_LABELS[status] || status}
    </span>
  )
}

// ── 按钮 ──────────────────────────────────────────────
type BtnVariant = 'primary' | 'danger' | 'ghost' | 'warning'
export function Btn({ children, onClick, variant = 'ghost', disabled, size = 'md', style: extraStyle }: {
  children: ReactNode; onClick?: () => void; variant?: BtnVariant; disabled?: boolean; size?: 'sm' | 'md'; style?: React.CSSProperties
}) {
  const styles: Record<BtnVariant, { background: string; color: string; border: string }> = {
    primary: { background: '#156b43', color: '#fff', border: '1px solid #156b43' },
    danger:  { background: '#dc2626', color: '#fff', border: '1px solid #dc2626' },
    warning: { background: '#d97706', color: '#fff', border: '1px solid #d97706' },
    ghost:   { background: '#fff', color: '#374151', border: '1px solid #e5e7eb' },
  }
  const s = styles[variant]
  return (
    <button onClick={onClick} disabled={disabled}
      style={{
        ...s, borderRadius: 7, cursor: disabled ? 'not-allowed' : 'pointer',
        padding: size === 'sm' ? '4px 10px' : '7px 14px',
        fontSize: size === 'sm' ? 11 : 12, fontWeight: 600,
        opacity: disabled ? .5 : 1, transition: 'all .15s',
        ...extraStyle,
      }}>
      {children}
    </button>
  )
}

// ── 卡片 ──────────────────────────────────────────────
export function Card({ children, style }: { children: ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20, boxShadow: '0 1px 3px rgba(0,0,0,.05)', ...style }}>
      {children}
    </div>
  )
}

// ── KPI 卡片 ──────────────────────────────────────────
export function KpiCard({ label, value, sub, color = '#156b43' }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <Card>
      <div style={{ fontSize: 26, fontWeight: 700, color, marginBottom: 4 }}>{value}</div>
      <div style={{ fontSize: 12.5, color: '#374151', fontWeight: 500 }}>{label}</div>
      {sub && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 3 }}>{sub}</div>}
    </Card>
  )
}

// ── 空状态 ────────────────────────────────────────────
export function Empty({ text = '暂无数据' }: { text?: string }) {
  return (
    <div style={{ textAlign: 'center', padding: '48px 0', color: '#9ca3af', fontSize: 13 }}>
      <div style={{ fontSize: 32, marginBottom: 10 }}>📭</div>
      {text}
    </div>
  )
}

// ── 骨架屏 ────────────────────────────────────────────
export function TableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div style={{ padding: '8px 0' }}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} style={{
          height: 40, background: 'linear-gradient(90deg,#f3f4f6 25%,#e9eaec 50%,#f3f4f6 75%)',
          backgroundSize: '200% 100%', borderRadius: 6, marginBottom: 8,
          animation: 'shimmer 1.4s infinite',
        }} />
      ))}
      <style>{`@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}`}</style>
    </div>
  )
}

// ── 表格 ──────────────────────────────────────────────
export function Table({ columns, data, loading }: {
  columns: { key: string; title: string; render?: (v: any, row: any) => ReactNode; width?: number }[]
  data: any[]; loading?: boolean
}) {
  if (loading) return <div style={{ padding: '8px 0' }}><TableSkeleton rows={6} /></div>
  if (!data.length) return <Empty />
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
        <thead>
          <tr style={{ background: '#f9fafb' }}>
            {columns.map(c => (
              <th key={c.key} style={{ textAlign: 'left', padding: '9px 14px', color: '#6b7280', fontWeight: 600, fontSize: 11, letterSpacing: .5, whiteSpace: 'nowrap', width: c.width }}>
                {c.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row, i) => (
            <tr key={row.id || i} style={{ borderBottom: '1px solid #f3f4f6' }}
              onMouseOver={e => e.currentTarget.style.background = '#fafafa'}
              onMouseOut={e => e.currentTarget.style.background = ''}>
              {columns.map(c => (
                <td key={c.key} style={{ padding: '11px 14px', color: '#374151', verticalAlign: 'middle' }}>
                  {c.render ? c.render(row[c.key], row) : row[c.key] ?? '-'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── 模态框 ────────────────────────────────────────────
export function Modal({ open, title, onClose, children, width = 520 }: {
  open: boolean; title: string; onClose: () => void; children: ReactNode; width?: number
}) {
  if (!open) return null
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background: '#fff', borderRadius: 14, width, maxHeight: '85vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px', borderBottom: '1px solid #e5e7eb' }}>
          <span style={{ fontSize: 15, fontWeight: 700 }}>{title}</span>
          <span onClick={onClose} style={{ cursor: 'pointer', color: '#9ca3af', fontSize: 20, lineHeight: 1 }}>×</span>
        </div>
        <div style={{ padding: '20px' }}>{children}</div>
      </div>
    </div>
  )
}

// ── 表单字段 ──────────────────────────────────────────
export function Field({ label, children, required, error }: { label: string; children: ReactNode; required?: boolean; error?: string }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: error ? '#dc2626' : '#374151', marginBottom: 5 }}>
        {label}{required && <span style={{ color: '#dc2626', marginLeft: 2 }}>*</span>}
      </label>
      {children}
      {error && <div style={{ fontSize: 11, color: '#dc2626', marginTop: 4 }}>{error}</div>}
    </div>
  )
}

export function Input({ value, onChange, placeholder, type = 'text', disabled, error }: {
  value: string | number; onChange: (v: string) => void; placeholder?: string; type?: string; disabled?: boolean; error?: boolean
}) {
  return (
    <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} type={type} disabled={disabled}
      style={{ width: '100%', border: `1.5px solid ${error ? '#dc2626' : '#e5e7eb'}`, borderRadius: 7, padding: '8px 10px', fontSize: 13, outline: 'none', boxSizing: 'border-box', background: disabled ? '#f9fafb' : '#fff' }} />
  )
}

export function Select({ value, onChange, options, placeholder }: {
  value: string; onChange: (v: string) => void;
  options: { label: string; value: string }[]; placeholder?: string
}) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)}
      style={{ width: '100%', border: '1.5px solid #e5e7eb', borderRadius: 7, padding: '8px 10px', fontSize: 13, outline: 'none', background: '#fff', boxSizing: 'border-box' }}>
      {placeholder && <option value="">{placeholder}</option>}
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}

// ── Toast 通知 ────────────────────────────────────────
export function useToast() {
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null)
  const show = (msg: string, type: 'success' | 'error' = 'success') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3000)
  }
  const ToastEl = toast ? (
    <div style={{
      position: 'fixed', top: 20, right: 20, zIndex: 9999,
      background: toast.type === 'success' ? '#156b43' : '#dc2626',
      color: '#fff', padding: '10px 18px', borderRadius: 8, fontSize: 13, fontWeight: 500,
      boxShadow: '0 4px 16px rgba(0,0,0,.15)', animation: 'fadeIn .2s ease',
    }}>{toast.type === 'success' ? '✓ ' : '✕ '}{toast.msg}</div>
  ) : null
  return { show, ToastEl }
}

// ── 格式化金额 ────────────────────────────────────────
export const fmt = (n: number | string) => `¥${Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 2 })}`
export const fmtDate = (d: string | Date) => new Date(d).toLocaleDateString('zh-CN')
export const fmtDatetime = (d: string | Date) => new Date(d).toLocaleString('zh-CN', { hour12: false })

// ── 分页 ─────────────────────────────────────────────
export function Pagination({ page, pageSize, total, onChange }: {
  page: number; pageSize: number; total: number; onChange: (page: number) => void
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  if (totalPages <= 1) return null
  const pages = Array.from({ length: Math.min(7, totalPages) }, (_, i) => {
    if (totalPages <= 7) return i + 1
    if (page <= 4) return i + 1
    if (page >= totalPages - 3) return totalPages - 6 + i
    return page - 3 + i
  })
  const btnStyle = (active: boolean): React.CSSProperties => ({
    minWidth: 32, height: 32, padding: '0 8px', margin: '0 2px',
    border: `1.5px solid ${active ? '#2563eb' : '#e5e7eb'}`,
    borderRadius: 6, background: active ? '#2563eb' : '#fff',
    color: active ? '#fff' : '#374151', fontSize: 13, cursor: 'pointer',
    fontWeight: active ? 600 : 400,
  })
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4, marginTop: 16 }}>
      <span style={{ fontSize: 12, color: '#6b7280', marginRight: 8 }}>共 {total} 条</span>
      <button style={btnStyle(false)} onClick={() => onChange(Math.max(1, page - 1))} disabled={page === 1}>‹</button>
      {pages[0] > 1 && <><button style={btnStyle(false)} onClick={() => onChange(1)}>1</button><span style={{ color: '#9ca3af' }}>…</span></>}
      {pages.map(p => <button key={p} style={btnStyle(p === page)} onClick={() => onChange(p)}>{p}</button>)}
      {pages[pages.length - 1] < totalPages && <><span style={{ color: '#9ca3af' }}>…</span><button style={btnStyle(false)} onClick={() => onChange(totalPages)}>{totalPages}</button></>}
      <button style={btnStyle(false)} onClick={() => onChange(Math.min(totalPages, page + 1))} disabled={page === totalPages}>›</button>
    </div>
  )
}
