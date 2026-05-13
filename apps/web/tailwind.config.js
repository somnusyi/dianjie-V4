/** @type {import('tailwindcss').Config} */
// PDF v1.1 设计 token 注入。颜色系统：5 阶灰 + 9 语义色。
// 同源：dianjie-v2/packages/ui/tokens/index.ts（如改动需双向同步）
module.exports = {
  content: ['./src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // ── 主深色 / 边框 / 背景（v2 重构：去黑色为辅助，整体走"奶咖暖现代"）──
        // ink 改成墨褐：远看像黑、近看带温度，做文字主色
        ink:     '#2A2218',
        // 页面底色：奶米
        bg:      '#FAF6EF',
        // 卡片底色：米白，比 bg 略亮，浮感来自色差不靠重边框
        'bg-card':'#FFFDF8',
        // 二级提醒/暖卡 (PROGRESS 提示用)
        'bg-warm':'#F8EFD9',
        // 暖灰边框
        border:  '#E8E2D5',
        // ── 品牌主色 · 柿色 (persimmon) ──
        // 主 CTA / Tab active / 关键数字强调 / 品牌锚点
        accent:     '#E07A3C',
        'accent-fg':'#A24F1B',
        'accent-bg':'#FCE9D9',
        // ── 旧 amber (琥珀金)：保留为辅助点缀（金色品牌徽记位）──
        amber:      '#B8853D',
        'amber-fg': '#7A5520',
        'amber-bg': '#F5E8CD',
        // 语义色 9 个（fg=深色文字版，bg=浅色背景版）
        red:        '#E24B4A',
        'red-fg':   '#A32D2D',
        'red-bg':   '#FCEBEB',
        orange:     '#EF9F27',
        'orange-fg':'#854F0B',
        'orange-bg':'#FAEEDA',
        green:      '#1D9E75',
        'green-fg': '#3B6D11',
        'green-bg': '#EAF3DE',
        blue:       '#185FA5',
        // 5 阶灰（stacked bar 全部用）
        gray1: '#2C2C2A',
        gray2: '#5F5E5A',
        gray3: '#888780',
        gray4: '#B4B2A9',
        gray5: '#D3D1C7',
      },
      fontSize: {
        // PDF 7 阶字号
        hero:    ['32px', { lineHeight: '40px', fontWeight: 500 }],
        h1:      ['22px', { lineHeight: '30px', fontWeight: 500 }],
        h2:      ['17px', { lineHeight: '24px', fontWeight: 500 }],
        body:    ['15px', { lineHeight: '22px', fontWeight: 400 }],
        button:  ['15px', { lineHeight: '22px', fontWeight: 500 }],
        caption: ['13px', { lineHeight: '18px', fontWeight: 400 }],
        micro:   ['11px', { lineHeight: '14px', fontWeight: 500 }],
      },
      borderRadius: {
        chip: '4px',
        card: '8px',
        cta:  '12px',
      },
      boxShadow: {
        fab:    '0 6px 16px rgba(17,17,17,0.18)',
        drawer: '0 -8px 24px rgba(17,17,17,0.10)',
      },
      fontFamily: {
        sans: ['"Noto Sans SC"', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
