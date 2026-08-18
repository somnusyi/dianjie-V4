import axios from 'axios'

const api = axios.create({
  // 默认同源: /api/* 开发走 Next 代理, 生产走 Nginx 转发. localhost:4000 兜底会让
  // 生产浏览器把请求打到用户自己电脑上, 等于 refresh 永远失败 → 每 2h 被踢回登录.
  baseURL: process.env.NEXT_PUBLIC_API_URL || '',
  timeout: 10000,
})

// 自动带上 token
api.interceptors.request.use((config) => {
  if (typeof window !== 'undefined') {
    const token = sessionStorage.getItem('token') || sessionStorage.getItem('dj_token')
    if (token) config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

// 401 先尝试用 refresh token 续期，再跳登录
let isRefreshing = false
let refreshQueue: Array<(token: string) => void> = []

api.interceptors.response.use(
  (res) => res,
  async (err) => {
    const original = err.config
    if (err.response?.status === 401 && typeof window !== 'undefined' && !original._retry) {
      const refresh = sessionStorage.getItem('refreshToken') || sessionStorage.getItem('dj_refresh')
      if (refresh) {
        original._retry = true
        if (isRefreshing) {
          // 等待正在进行的刷新完成
          return new Promise((resolve) => {
            refreshQueue.push((token) => {
              original.headers.Authorization = `Bearer ${token}`
              resolve(api(original))
            })
          })
        }
        isRefreshing = true
        try {
          const r = await axios.post(
            `${process.env.NEXT_PUBLIC_API_URL || ''}/api/auth/refresh`,
            { token: refresh }
          )
          const newToken = r.data.token
          sessionStorage.setItem('dj_token', newToken)
          sessionStorage.setItem('token', newToken)
          if (r.data.refreshToken) {
            sessionStorage.setItem('dj_refresh', r.data.refreshToken)
            sessionStorage.setItem('refreshToken', r.data.refreshToken)
          }
          refreshQueue.forEach(cb => cb(newToken))
          refreshQueue = []
          original.headers.Authorization = `Bearer ${newToken}`
          return api(original)
        } catch {
          refreshQueue = []
          // 只清自己的 key, 不能 clear() 把 v2 的 token / user 也带走
          sessionStorage.removeItem('dj_token')
          sessionStorage.removeItem('dj_refresh')
          sessionStorage.removeItem('token')
          sessionStorage.removeItem('refreshToken')
          window.location.href = '/v2/login'
        } finally {
          isRefreshing = false
        }
      } else {
        sessionStorage.removeItem('dj_token')
        sessionStorage.removeItem('dj_refresh')
        sessionStorage.removeItem('token')
        sessionStorage.removeItem('refreshToken')
        window.location.href = '/v2/login'
      }
    }
    return Promise.reject(err)
  }
)

export default api
