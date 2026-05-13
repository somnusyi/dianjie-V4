// 显式自定义 404, 避免 next 默认 _error 页 prerender 与 monorepo 多 react 实例冲突
'use client'
export const dynamic = 'force-dynamic'
export default function NotFound() {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#F1EFE8', color: '#1A1815', fontFamily: 'system-ui' }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 48, marginBottom: 12 }}>🤔</div>
        <h2 style={{ fontSize: 18, fontWeight: 600 }}>页面不存在</h2>
        <p style={{ fontSize: 13, color: '#5F5E5A', marginTop: 4 }}>请检查地址或返回首页</p>
        <a href="/" style={{ display: 'inline-block', marginTop: 16, padding: '8px 20px', background: '#1A1815', color: '#fff', borderRadius: 12, textDecoration: 'none', fontSize: 14 }}>返回首页</a>
      </div>
    </div>
  )
}
