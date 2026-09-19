/**
 * @file apps/web/src/management/pages/OverviewPage.tsx
 * Page 1: 概览 (Overview)
 */
import React from 'react';
import { PageHeader } from '../primitives/PageHeader';
import { SummaryBar } from '../primitives/SummaryBar';
import { SectionHeader } from '../primitives/PageHeader';
import { StatusBadge } from '../primitives/StatusBadge';
import { EntityMark } from '../primitives/EntityMark';
import { DataTable, type Column } from '../primitives/DataTable';
import { ChartPanel, type ChartSeries } from '../primitives/ChartPanel';
import { useManagementOverview, usePreferences } from '../adapter';

interface OverviewPageProps {
  onNavigate: (pageId: string, extra?: Record<string, unknown>) => void;
}

export const OverviewPage: React.FC<OverviewPageProps> = ({ onNavigate }) => {
  const { data: res, isLoading, isError, error } = useManagementOverview();
  const { settings } = usePreferences();
  const overview = res?.data;

  if (isLoading) {
    return (
      <div className="pageContainer">
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--metadata)' }}>
          加载概览数据中...
        </div>
      </div>
    );
  }

  if (isError || !overview) {
    return (
      <div className="pageContainer">
        <PageHeader
          title="概览 (Overview)"
          description="系统实时态势、关键指标健康度与待处理重要关注。严格区分设计基准事实与动态观测指标。"
          capabilityState="已实现"
        />
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--danger)' }} role="alert">
          <strong>概览数据加载失败</strong>: {error instanceof Error ? error.message : '无法获取系统状态'}
        </div>
      </div>
    );
  }

  const chartSeries: ChartSeries[] = [
    {
      id: 'tokens',
      name: 'Token 消耗量',
      pattern: 'solid',
      color: 'var(--ink)',
      data: overview.usageTrend.map((t) => t.tokens),
    },
    {
      id: 'runs',
      name: '执行调用频次',
      pattern: 'dashed',
      color: 'var(--secondary)',
      data: overview.usageTrend.map((t) => t.runs),
      plotScale: 1000,
    },
  ];

  type ModelUsageItem = (typeof overview.piModelUsage)[0];

  const modelColumns: Column<ModelUsageItem>[] = [
    {
      key: 'name',
      header: '模型名称',
      render: (m) => (
        <span style={{ fontWeight: 600, color: 'var(--ink)' }}>{m.modelName}</span>
      ),
    },
    {
      key: 'calls',
      header: '今日调用',
      render: (m) => (
        <span className="mono">
          {m.callsToday !== null && m.callsToday !== undefined ? `${m.callsToday} 次` : '未知'}
        </span>
      ),
    },
    {
      key: 'tokens',
      header: 'Token 消耗',
      render: (m) => (
        <span className="mono">
          {m.tokensToday !== null && m.tokensToday !== undefined ? m.tokensToday.toLocaleString() : '未知'}
        </span>
      ),
    },
    ...(settings?.unknownPricingDisplay === 'hide_cost'
      ? []
      : [
          {
            key: 'cost',
            header: '预估费用 (USD)',
            render: (m: ModelUsageItem) => {
              if (m.costStatus === 'priced' && m.costUsd !== null && m.costUsd !== undefined) {
                return <span className="mono" style={{ color: 'var(--brand)' }}>${m.costUsd.toFixed(2)}</span>;
              }
              if (m.costStatus === 'unpriced') {
                return <span style={{ color: 'var(--metadata)' }}>成本不可用 (未定价)</span>;
              }
              return <span style={{ color: 'var(--metadata)' }}>成本未知</span>;
            },
          },
        ]),
    {
      key: 'latency',
      header: 'P95 耗时',
      render: (m) => (
        <span className="mono">
          {m.p95LatencyMs !== null && m.p95LatencyMs !== undefined ? `${m.p95LatencyMs} ms` : '未知'}
        </span>
      ),
    },
  ];

  const isLive = res.source === 'api';

  return (
    <div className="pageContainer">
      <PageHeader
        title="概览 (Overview)"
        description="系统实时态势、关键指标健康度与待处理重要关注。严格区分设计基准事实与动态观测指标。"
        capabilityState="已实现"
        customPill={{ text: isLive ? '实时接口' : '设计数据', variant: isLive ? 'ok' : 'neutral' }}
      />

      {/* Capability Legend */}
      <div className="capabilityLegend">
        <StatusBadge state="已实现" />
        <StatusBadge state="P3 目标" />
        <StatusBadge state="设计数据" />
        <StatusBadge state="后续" />
        <StatusBadge state="未知" />
        <span className="legendNote">统一状态词汇：严格区分实现事实与设计数据</span>
      </div>

      {/* Summary Bar */}
      <SummaryBar
        items={[
          {
            label: '24h 执行数',
            value:
              overview.summary.runs24h !== null && overview.summary.runs24h !== undefined
                ? overview.summary.runs24h
                : '未知',
            meta: '过去 24 小时执行总数',
            mono: true,
          },
          {
            label: '今日 Token',
            value:
              overview.summary.todayTotalTokens !== null && overview.summary.todayTotalTokens !== undefined
                ? overview.summary.todayTotalTokens > 0
                  ? `${(overview.summary.todayTotalTokens / 1000).toFixed(1)}k`
                  : '0'
                : '未知',
            meta: 'PI 核心总消耗',
            mono: true,
          },
          {
            label: '预估成本',
            value:
              overview.summary.todayCostStatus === 'priced' && overview.summary.todayCostUsd !== null
                ? `$${overview.summary.todayCostUsd.toFixed(2)}`
                : overview.summary.todayCostStatus === 'unpriced'
                ? '成本不可用'
                : '未知',
            meta:
              overview.summary.todayCostStatus === 'unpriced'
                ? '成本不可用 (未配置计价模型)'
                : overview.summary.todayCostStatus === 'priced'
                ? '按公开单价测算'
                : '成本未知',
          },
          {
            label: '待处理关注',
            value:
              overview.summary.pendingAttentionCount !== null &&
              overview.summary.pendingAttentionCount !== undefined
                ? overview.summary.pendingAttentionCount
                : '未知',
            meta: '需要 Owner 决策介入',
          },
        ]}
      />

      {/* Needs Attention & Current Run Panels */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))', gap: 16 }}>
        {/* Needs Attention Panel */}
        <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 'var(--radius-md)', padding: 16 }}>
          <SectionHeader title="重要关注" subtitle="只列出确实需要 Owner 介入决策的待办项" />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
            {overview.attentionQueue.length === 0 ? (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--metadata)' }}>
                暂无需要 Owner 介入的待办事项
              </div>
            ) : (
              overview.attentionQueue.map((item) => (
                <div
                  key={item.id}
                  className="attentionItem"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '10px 12px',
                    background: 'var(--sidebar)',
                    border: '1px solid var(--line)',
                    borderRadius: 'var(--radius-sm)',
                  }}
                >
                  <EntityMark kind={item.type === 'task_review' ? 'task' : 'attention'} size="sm" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>{item.title}</div>
                    <div style={{ fontSize: 11, color: 'var(--metadata)', marginTop: 2 }}>{item.description}</div>
                  </div>
                  <StatusBadge variant={item.severity} className="sm">
                    {item.severity === 'warn' ? '待验收' : item.severity === 'bad' ? '阻塞' : '关注'}
                  </StatusBadge>
                  <button
                    type="button"
                    className="btn secondary sm"
                    onClick={() => onNavigate(item.targetSection, { selectedId: item.targetId })}
                  >
                    前往
                  </button>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Current Run Panel */}
        {overview.currentRun ? (
          <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 'var(--radius-md)', padding: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <EntityMark kind="run" size="sm" />
                <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0, color: 'var(--ink)' }}>当前运行</h3>
              </div>
              <StatusBadge variant="teal">运行中</StatusBadge>
            </div>
            <p style={{ fontSize: 12, color: 'var(--metadata)', margin: '4px 0 12px 0' }}>
              {overview.currentRun.summary}
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>
              <div className="pairRow">
                <span>运行 ID</span>
                <span className="mono">{overview.currentRun.id}</span>
              </div>
              <div className="pairRow">
                <span>所属会话</span>
                <span>{overview.currentRun.conversationId}</span>
              </div>
              <div className="pairRow">
                <span>执行核心</span>
                <span>{overview.currentRun.modelId}</span>
              </div>
              <div className="pairRow">
                <span>执行耗时</span>
                <span className="mono">{(overview.currentRun.durationMs / 1000).toFixed(1)}s</span>
              </div>
              <div className="pairRow">
                <span>关联任务</span>
                <span className="mono">{overview.currentRun.taskAttemptId || '—'}</span>
              </div>
              <div className="pairRow">
                <span>最近事件</span>
                <span className="mono">未知（接口未上报）</span>
              </div>
              <div className="pairRow">
                <span>Token / Cost</span>
                <span className="mono">
                  {overview.currentRun.tokens.total.toLocaleString()} /{' '}
                  {overview.currentRun.costStatus === 'priced' && overview.currentRun.costUsd !== null
                    ? `$${overview.currentRun.costUsd.toFixed(2)}`
                    : overview.currentRun.costStatus === 'unpriced'
                      ? '成本不可用'
                      : '未知'}
                </span>
              </div>
            </div>
            <div style={{ marginTop: 14 }}>
              <button
                type="button"
                className="btn secondary sm"
                style={{ width: '100%' }}
                onClick={() => onNavigate('trace', { runId: overview.currentRun?.id })}
              >
                查看完整执行追踪 (Trace)
              </button>
            </div>
          </div>
        ) : (
          <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 'var(--radius-md)', padding: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <EntityMark kind="run" size="sm" />
              <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0, color: 'var(--ink)' }}>当前运行</h3>
            </div>
            <p style={{ fontSize: 12, color: 'var(--metadata)', margin: '24px 0', textAlign: 'center' }}>
              当前无活跃执行
            </p>
          </div>
        )}
      </div>

      {/* Usage Trend Chart */}
      {overview.usageTrend.length === 0 ? (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 'var(--radius-md)', padding: 16 }}>
          <SectionHeader
            title="今日使用趋势 (Token 消耗与调用频次)"
            subtitle="暂无实时指标采集数据 (P3 目标)"
            capabilityState="P3 目标"
          />
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--metadata)', fontSize: 12 }}>
            暂无趋势数据 (P3 目标：需要遥测指标导出服务)
          </div>
        </div>
      ) : (
        <ChartPanel
          title="今日使用趋势 (Token 消耗与调用频次)"
          subtitle="实线表示 Token 消耗，虚线表示调用频次。支持切换至表格回退视图。"
          categories={overview.usageTrend.map((t) => t.label)}
          series={chartSeries}
        />
      )}

      {/* PI Model Usage Table */}
      <div>
        <SectionHeader title="PI 模型使用分布" subtitle="按模型归属统计调用次数、耗时与计费状态" />
        <DataTable
          data={overview.piModelUsage}
          columns={modelColumns}
          keyExtractor={(m) => m.modelId}
        />
      </div>
    </div>
  );
};
