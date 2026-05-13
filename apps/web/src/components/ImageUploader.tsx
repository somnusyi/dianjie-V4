'use client'
import { useState, useRef } from 'react'

interface ImageUploaderProps {
  images: string[]
  onChange: (images: string[]) => void
  maxCount?: number
  disabled?: boolean
}

export default function ImageUploader({ images, onChange, maxCount = 6, disabled = false }: ImageUploaderProps) {
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const handleFiles = async (files: FileList) => {
    if (!files.length) return
    setError('')
    const remaining = maxCount - images.length
    if (remaining <= 0) { setError(`最多上传 ${maxCount} 张`); return }
    const toUpload = Array.from(files).slice(0, remaining)
    setUploading(true)
    try {
      const uploaded: string[] = []
      for (const file of toUpload) {
        const formData = new FormData()
        formData.append('file', file)
        const token = localStorage.getItem('dj_token')
        const res = await fetch('/api/upload/image', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: formData,
        })
        if (!res.ok) { const e = await res.json(); throw new Error(e.error || '上传失败') }
        uploaded.push((await res.json()).url)
      }
      onChange([...images, ...uploaded])
    } catch (err: any) {
      setError(err.message || '上传失败，请重试')
    } finally {
      setUploading(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-start' }}>
      {images.map((url, i) => (
        <div key={i} style={{ position: 'relative', width: 72, height: 72, flexShrink: 0 }}>
          <img src={url} style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 8, border: '1px solid #e5e7eb', display: 'block' }} />
          {!disabled && (
            <button onClick={() => onChange(images.filter((_, idx) => idx !== i))}
              style={{ position: 'absolute', top: -6, right: -6, width: 18, height: 18, background: '#dc2626', color: '#fff', border: 'none', borderRadius: '50%', fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1 }}>
              ×
            </button>
          )}
        </div>
      ))}

      {!disabled && images.length < maxCount && (
        <label style={{
          width: 72, height: 72, flexShrink: 0,
          border: `2px dashed ${uploading ? '#d1d5db' : '#fca5a5'}`,
          borderRadius: 8, cursor: uploading ? 'not-allowed' : 'pointer',
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          background: uploading ? '#f9fafb' : '#fff9f9', gap: 4,
        }}>
          <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif"
            multiple className="hidden" style={{ display: 'none' }} disabled={uploading}
            onChange={e => e.target.files && handleFiles(e.target.files)} />
          {uploading
            ? <span style={{ fontSize: 18, color: '#9ca3af' }}>⏳</span>
            : <span style={{ fontSize: 22, color: '#dc2626', lineHeight: 1 }}>📷</span>
          }
          <span style={{ fontSize: 10, color: uploading ? '#9ca3af' : '#dc2626', fontWeight: 500 }}>
            {uploading ? '上传中' : `${images.length}/${maxCount}`}
          </span>
        </label>
      )}

      {error && <div style={{ width: '100%', fontSize: 11, color: '#dc2626', marginTop: 2 }}>{error}</div>}
    </div>
  )
}
