import axios from 'axios'
import { bootstrapSession, getToken, refreshAccessOnce, clearSession, getSessionGeneration, assertSessionGeneration } from './v2-auth'
const api=axios.create({baseURL:process.env.NEXT_PUBLIC_API_URL||'',timeout:10000})
api.interceptors.request.use(async config=>{
 if(typeof window!=='undefined') {
  const generation = (config as any).__djSessionGeneration ?? getSessionGeneration()
  ;(config as any).__djSessionGeneration = generation
  assertSessionGeneration(generation)
  if(config.url?.startsWith('/api/auth/'))config.headers['X-Dianjie-Session']='cookie-v1'
  const token=getToken()||await bootstrapSession()
  assertSessionGeneration(generation)
  if(token)config.headers.Authorization=`Bearer ${token}`
 }
 return config
})
api.interceptors.response.use(res=>{
 if(typeof window!=='undefined'&&(res.config as any).__djSessionGeneration!==undefined)assertSessionGeneration((res.config as any).__djSessionGeneration)
 return res
},async err=>{
 const original=err.config
 if(typeof window!=='undefined'&&original?.__djSessionGeneration!==undefined)assertSessionGeneration(original.__djSessionGeneration)
 if(err.response?.status===401&&typeof window!=='undefined'&&original&&!original._retry&&!original.url?.startsWith('/api/auth/')) {
  original._retry=true
  const token=await refreshAccessOnce()
  assertSessionGeneration(original.__djSessionGeneration)
  if(token){original.headers.Authorization=`Bearer ${token}`;return api(original)}
  clearSession();window.location.href='/v2/login'
 }
 return Promise.reject(err)
})
export default api
