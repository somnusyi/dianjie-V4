import type { MetadataRoute } from 'next'

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: '滇界云管',
    short_name: '滇界',
    description: '连锁餐饮数字化管理平台',
    start_url: '/',
    display: 'standalone',
    background_color: '#F1EFE8',
    theme_color: '#E07A3C',
    icons: [
      {
        src: '/icon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any',
      },
      {
        src: '/icon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'maskable',
      },
    ],
  }
}
