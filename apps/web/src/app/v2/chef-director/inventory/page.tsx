/**
 * 总厨 App · 物料 Tab  PDF: chef_director_inventory_tab  Tab 3/4
 * iOS Segmented sub-tab [库存][消耗] · Hero 集团库存 · 异常 SKU 跨店聚合"集团性"红 tag · 各店库存排行 · 类目分布 stacked
 */
'use client'
import { useState } from 'react'
import { BottomNav, StackedBar, StoreAvatar, Chip } from '@/components/v2'
import { GlanceStrip } from '@/components/v2/glance-strip'
import { DemoBanner } from '@/components/v2/demo-banner'

const ANOMALY_SKUS = [
  { name: '鸭血',   tag1: '紧 1', tag2: '紧 2',  meta: '国贸 缺货 · 望京 紧张 · 朝阳 紧张',  collapse: '集团总剩 3.5 kg · 周均消耗 12 kg', tone: 'red' as const, group: true },
  { name: '香菜',   tag1: '紧张 5', tag2: '集团性', meta: '5 家店同时偏紧 · 供应商春季减产', tip: '建议：川蜀食品(待审批)可补',         tone: 'orange' as const, group: true },
  { name: '现切肥牛', tag1: '缺 1', meta: '朝阳大悦城店 · 周末高峰备货不足',     extra: '已下急单 · 草原牧业 16:30 送达', tone: 'red' as const },
]
const STORE_RANK = [
  { rank: 1, name: '朝阳大悦城店', value: 58, status: '紧急 3 项 · 报损率偏高', anomaly: true,  watch: false },
  { rank: 2, name: '国贸店',       value: 48, status: '紧急补货 2 项',         anomaly: false, watch: true },
  { rank: 3, name: '五道口店',     value: 45, status: '健康 · 周转 6 天',      anomaly: false, watch: false },
  { rank: 4, name: '望京 SOHO 店', value: 43, status: '健康 · 周转 8 天',      anomaly: false, watch: false },
]

export default function ChefDirectorInventoryPage() {
  const [tab, setTab] = useState('material')
  const [sub, setSub] = useState<'库存' | '消耗'>('库存')
  return (
    <div className="min-h-screen bg-bg pb-20">
      <header className="px-4 pt-4 pb-2 flex items-center justify-between">
        <div>
          <h1 className="text-h1">物料</h1>
          <p className="text-caption text-gray3">集团 · 8 家店 · 137 SKU</p>
        </div>
        <div className="flex items-center gap-2">
          <button className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center">⌕</button>
          <button className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center">≡</button>
        </div>
      </header>

      <DemoBanner note="集团物料 · 接成本聚合后替换" />
      {/* iOS Segmented */}
      <div className="px-4 mt-2">
        <div className="inline-flex bg-bg rounded-cta p-0.5">
          {(['库存', '消耗'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setSub(s)}
              className={`px-4 py-1 text-button rounded-cta ${sub === s ? 'bg-white' : 'text-gray2'}`}
            >{s}</button>
          ))}
        </div>
      </div>

      <div className="mt-3">
        <GlanceStrip
          label="集团库存 ● 实时"
          value="¥358K"
          delta={{ text: '↑ 3% 较上周', trend: 'up' }}
          meta="137 SKU · 周转 7 天 · 集团均值"
          rightSlot="14:23"
          stats={[
            { label: '紧急补货', value: '5 项',  tone: 'red' },
            { label: '缺货',     value: '2 项',  tone: 'red' },
            { label: '临期(3 日内)', value: '12 项', tone: 'orange' },
          ]}
        />
      </div>

      <Section title="异常 SKU · 跨店聚合" right={`${ANOMALY_SKUS.length} 项需关注`} rightTone="orange">
        <ul className="space-y-2">
          {ANOMALY_SKUS.map((s, i) => (
            <li key={i} className={`relative bg-white rounded-card p-3 pl-4 border border-border before:content-[''] before:absolute before:left-0 before:top-3 before:bottom-3 before:w-[3px] before:rounded-full ${s.tone === 'red' ? 'before:bg-red' : 'before:bg-orange'}`}>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-h2">{s.name}</span>
                {s.tag1 && <Chip tone={s.tone}>{s.tag1}</Chip>}
                {s.tag2 && <Chip tone={s.tone}>{s.tag2}</Chip>}
                {s.group && <Chip tone="red">集团性</Chip>}
              </div>
              <p className="text-caption text-gray2">{s.meta}</p>
              {s.collapse && <p className="text-micro text-gray3 mt-0.5">{s.collapse}</p>}
              {s.extra    && <p className="text-micro text-gray3 mt-0.5">{s.extra}</p>}
              {s.tip      && <p className="text-micro text-orange-fg mt-1">{s.tip}</p>}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="各店库存排行" right="8 家店 · ¥358K">
        <ul className="bg-white rounded-card border border-border divide-y divide-border">
          {STORE_RANK.map((s) => (
            <li key={s.name} className="px-3 py-3 flex items-center gap-3">
              <span className="font-num text-gray3 w-4 text-right text-caption">{s.rank}</span>
              <StoreAvatar name={s.name} anomaly={s.anomaly} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-h2 truncate">{s.name}</span>
                  {s.anomaly && <Chip tone="red">异常</Chip>}
                  {s.watch && <Chip tone="orange">关注</Chip>}
                </div>
                <p className="text-micro text-gray3">{s.status}</p>
              </div>
              <div className="text-right">
                <span className="font-num text-h2">¥{s.value}K</span>
                <span className="text-gray3 ml-1">›</span>
              </div>
            </li>
          ))}
          <li className="px-3 py-3 flex items-center gap-3">
            <div className="flex -space-x-2">
              <StoreAvatar name="三" size="sm" />
              <StoreAvatar name="中" size="sm" />
              <StoreAvatar name="外" size="sm" />
            </div>
            <span className="text-caption flex-1">4 家店 库存正常</span>
            <span className="font-num text-caption">¥164K</span>
            <span className="text-gray3">›</span>
          </li>
        </ul>
      </Section>

      <Section title="类目分布" right="点击下钻 ›">
        <div className="bg-white rounded-card border border-border p-4">
          <StackedBar
            segments={[
              { label: '鲜货', pct: 42 },
              { label: '冻品', pct: 33 },
              { label: '调味', pct: 13 },
              { label: '干货', pct: 8 },
              { label: '包材', pct: 4 },
            ]}
          />
        </div>
      </Section>

      <BottomNav
        tabs={[
          { key: 'home',     label: '工作台', icon: '⌂' },
          { key: 'review',   label: '审批',   icon: '✓' },
          { key: 'material', label: '物料',   icon: '⛁' },
          { key: 'loss',     label: '报损',   icon: '△' },
        ]}
        activeKey={tab}
        onChange={(k) => {
          if (k === 'home')   location.href = '/v2/chef-director/home'
          if (k === 'review') location.href = '/v2/chef-director/approvals'
          if (k === 'loss')   location.href = '/v2/chef-director/loss'
        }}
      />
    </div>
  )
}

function Section({ title, right, rightTone, children }: { title: string; right?: string; rightTone?: 'red' | 'orange'; children: React.ReactNode }) {
  return (
    <section className="px-4 mt-5">
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="text-h2">{title}</h2>
        {right && <span className={`text-caption ${rightTone === 'orange' ? 'text-orange-fg' : rightTone === 'red' ? 'text-red-fg' : 'text-gray3'}`}>{right}</span>}
      </div>
      {children}
    </section>
  )
}
