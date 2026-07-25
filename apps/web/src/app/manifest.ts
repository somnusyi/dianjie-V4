import type { MetadataRoute } from 'next'

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: '滇界云管',
    short_name: '滇界',
    description: '连锁餐饮数字化管理平台',
    start_url: '/v2/login',
    display: 'standalone',
    background_color: '#F8F5F1',
    theme_color: '#E07A3C',
    icons: [
      {
        src: '/icon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any',
      },
    ],
  }
}
