'use client'
import React, { useState } from 'react'
import {
  BlackHero, PeriodPills, TodoCard, MetricTile, StackedBar, ProgressDots,
  ApprovalRouting, BottomNav, ActionButtonPair, ActionButton, StoreAvatar, Chip,
} from './index'

export default function DesignSystemPage() {
  const [period, setPeriod] = useState('month')
  const [tab, setTab] = useState('home')

  return (
    <div className="min-h-screen bg-bg text-ink p-6 pb-24">
      <h1 className="text-h1 mb-1">滇界 v2 · 设计系统验收页</h1>
      <p className="text-caption text-gray2 mb-8">PDF v1.1 · 10 核心组件 · Mobile + Desktop 双形态</p>

      <Section title="01 · BlackHero（移动形态）">
        <div className="max-w-sm">
          <BlackHero
            label="今日集团营业额 ● 实时"
            value="¥168,500"
            delta={{ text: '↑ 8.2% 较昨日', trend: 'up' }}
            meta="预估全日 ¥220K · 完成 76% · 8 家店全开"
            stats={[
              { label: '待我审批', value: '7 项', tone: 'red' },
              { label: '异常店', value: '1 家', tone: 'orange' },
              { label: '月净利预估', value: '¥158K', tone: 'green' },
            ]}
            rightSlot={<span className="text-micro">14:23</span>}
          />
        </div>
      </Section>

      <Section title="01 · BlackHero（桌面形态）">
        <BlackHero
          density="desktop"
          label="今日集团营业额 ● 实时"
          value="¥168,500"
          delta={{ text: '↑ 8.2% 较昨日', trend: 'up' }}
          meta="预估全日 ¥220K · 完成 76% · 8 家店全开"
          stats={[
            { label: '待我审批', value: '7 项 · ¥86K', tone: 'red' },
            { label: '异常店', value: '1 家', tone: 'orange' },
            { label: '月净利预估', value: '+¥158K', tone: 'green' },
          ]}
          rightSlot={<span className="text-micro">04/29 · 14:23</span>}
        />
      </Section>

      <Section title="02 · PeriodPills">
        <PeriodPills
          value={period}
          onChange={setPeriod}
          options={[
            { label: '本周', value: 'week' },
            { label: '本月', value: 'month' },
            { label: 'YTD',  value: 'ytd' },
          ]}
        />
        <p className="text-caption text-gray3 mt-2">已选：{period}</p>
      </Section>

      <Section title="03 · TodoCard（三色三态）">
        <div className="space-y-2 max-w-md">
          <TodoCard
            tone="immediate"
            chips={[{ label: '差评', tone: 'red' }, { label: '12分钟前', tone: 'gray' }]}
            title="1 星差评 · 等位 50 分钟"
            sub="客户·刘女士 · 已加微信 · 优先回复"
            primary={{ label: '去回复', onClick: () => alert('去回复') }}
          />
          <TodoCard
            tone="today"
            chips={[{ label: '员工请假', tone: 'orange' }, { label: '今早 7:00', tone: 'gray' }]}
            title="王师傅 · 突发事假"
            sub="晚班缺岗位 · 需立即指派替工"
          />
          <TodoCard
            tone="routine"
            chips={[{ label: '调班申请', tone: 'gray' }, { label: '3 小时前', tone: 'gray' }]}
            title="小赵申请调班 · 周六 → 周日"
            sub="影响周末晚班 · 已找到顶岗"
            primary={{ label: '批准', onClick: () => {} }}
            secondary={{ label: '驳回', onClick: () => {} }}
          />
        </div>
      </Section>

      <Section title="04 · MetricTile (2x2 grid)">
        <div className="grid grid-cols-2 gap-3 max-w-md">
          <MetricTile label="月营收" value="¥285K" delta="↑ 8% 较上月" tone="default" />
          <MetricTile label="净利率" value="7.2%" delta="成本 64% 偏高" tone="red" hint="集团均 7.7%" />
          <MetricTile label="食材成本" value="¥85K" delta="占 30% 可控" tone="default" />
          <MetricTile label="人工成本" value="¥72K" delta="占 25% 不可控" tone="default" />
        </div>
      </Section>

      <Section title="05 · StackedBar (5 阶灰 + 净利绿)">
        <div className="bg-white rounded-card p-4 max-w-2xl">
          <h3 className="text-h2 mb-3">集团成本结构（本月）</h3>
          <StackedBar
            segments={[
              { label: '食材', pct: 28, deltaPp: -1 },
              { label: '人工', pct: 24, deltaPp: 1 },
              { label: '租金', pct: 18, deltaPp: 0 },
              { label: '其他', pct: 14, deltaPp: 1 },
              { label: '水电营销', pct: 8, deltaPp: 0 },
            ]}
            showProfit={{ label: '净利', pct: 7.7, deltaPp: 0.3 }}
          />
        </div>
      </Section>

      <Section title="06 · ProgressDots (采购 5 段)">
        <div className="bg-white rounded-card p-4 max-w-2xl">
          <ProgressDots
            steps={[
              { label: '财务' },
              { label: '老板' },
              { label: '已批' },
              { label: '在途' },
              { label: '验收' },
            ]}
            currentIndex={3}
          />
        </div>
      </Section>

      <Section title="07 · ApprovalRouting (跨角色头像链)">
        <div className="bg-white rounded-card p-4 max-w-xl">
          <ApprovalRouting
            steps={[
              { name: '张店长', role: '店长',   status: 'done',    meta: '8 分钟前' },
              { name: '刘财务', role: '财务',   status: 'done',    meta: '12 分钟前' },
              { name: '王老板', role: '老板·我', status: 'current', meta: '待我审' },
            ]}
          />
        </div>
      </Section>

      <Section title="08 · BottomNav (店长 5 Tab + ⊕ FAB)">
        <div className="relative bg-bg w-72 h-32 rounded-card overflow-hidden border border-border">
          <BottomNav
            tabs={[
              { key: 'home',     label: '工作台' },
              { key: 'ops',      label: '营业' },
              { key: 'fab',      label: '' },
              { key: 'customer', label: '客户' },
              { key: 'team',     label: '团队' },
            ]}
            activeKey={tab}
            onChange={setTab}
            fabKey="fab"
            onFab={() => alert('打开中央抽屉')}
          />
        </div>
      </Section>

      <Section title="09 · ActionButtonPair (审批底部双按钮·主按钮带金额)">
        <ActionButtonPair
          secondary={{ label: '驳回', onClick: () => {}, danger: true }}
          primary={{ label: '批准', onClick: () => {}, amount: '¥18,000' }}
        />
      </Section>

      <Section title="10 · StoreAvatar (单字头像 + 异常染红)">
        <div className="flex gap-3 items-center">
          <StoreAvatar name="国贸店" />
          <StoreAvatar name="望京 SOHO 店" />
          <StoreAvatar name="朝阳大悦城店" anomaly />
          <StoreAvatar name="三里屯店" size="lg" />
          <StoreAvatar name="五道口店" size="sm" />
        </div>
      </Section>

      <Section title="附 · Chip 5 色">
        <div className="flex gap-2 flex-wrap">
          <Chip tone="red">异常 · 急办</Chip>
          <Chip tone="orange">临期 · 待审</Chip>
          <Chip tone="green">健康 · 完成</Chip>
          <Chip tone="blue">在途</Chip>
          <Chip tone="gray">例行</Chip>
        </div>
      </Section>

      <p className="text-caption text-gray3 mt-12">
        说明：本页面仅用于设计系统验收。Phase 4 起 6 角色 37 屏 UI 全部基于此组件库。
      </p>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-10">
      <h2 className="text-h2 mb-3 text-gray2">{title}</h2>
      {children}
    </section>
  )
}
