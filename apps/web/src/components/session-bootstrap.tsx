'use client'
import { useEffect, useState } from 'react'
import { bootstrapSession, setMemoryToken } from '@/lib/v2-auth'
/** Prevent child role guards/API effects from racing the HttpOnly refresh bootstrap. */
export function SessionBootstrap({children}:{children:React.ReactNode}) {
 const [ready,setReady]=useState(false)
 useEffect(()=>{let active=true;const changed=(event:StorageEvent)=>{if(event.key==='dj:session-event'){setMemoryToken(null);location.reload()}};window.addEventListener('storage',changed);bootstrapSession().finally(()=>{if(active)setReady(true)});return()=>{active=false;window.removeEventListener('storage',changed)}},[])
 return ready ? <>{children}</> : <div className="min-h-screen flex items-center justify-center">加载中…</div>
}
