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
import { useManagementOverview } from '../adapter';

interface OverviewPageProps {
  onNavigate: (pageId: string) => void;
}

export const OverviewPage: React.FC<OverviewPageProps> = ({ onNavigate }) => {
  const { data: res, isLoading } = useManagementOverview();
  const overview = res?.data;

  if (isLoading || !overview) {
    return (
      <div className="pageContainer">
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--metadata)' }}>
          加载概览数据中...
        </div>
      </div>
    );
  }

  const modelColumns: Column<(typeof overview.piModelUsage)[0]>[] = [
    {
      key: 'name',
      header: '模型名称',
      render: (m) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <EntityMark kind="pi" size="sm" />
          <span style={{ fontWeight: 500, color: 'var(--ink)' }}>{m.modelName}</span>
        </div>
      ),
    },
    {
      key: 'calls',
      header: '今日调用',
      render: (m) => <span className="mono">{m.callsToday} 次</span>,
    },
    {
      key: 'tokens',
      header: 'Token 消耗',
      render: (m) => <span className="mono">{m.tokensToday.toLocaleString()}</span>,
    },
    {
      key: 'cost',
      header: '预估费用',
      render: (m) => (
        <span style={{ color: 'var(--metadata)' }}>
          {m.costStatus === 'unpriced' ? '成本不可用' : m.costUsd !== null ? `$${m.costUsd.toFixed(2)}` : '未知'}
        </span>
      ),
    },
    {
      key: 'p95',
      header: 'P95 响应耗时',
      render: (m) => <span className="mono">{m.p95LatencyMs} ms</span>,
    },
  ];

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
      color: 'var(--brand)',
      data: overview.usageTrend.map((t) => t.runs * 1000),
    },
  ];

  return (
    <div className="pageContainer">
      <PageHeader
        title="概览"
        description="直截了当呈现当前 Agent 的关键状态与重要待办。工作台与 PI 引擎保留最关键事实，避免臃肿。"
        capabilityState="P3 目标"
        customPill={{ text: res.source === 'fixture' ? '设计数据' : '实时接口', variant: 'neutral' }}
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
            label: '活跃会话',
            value: overview.summary.activeConversations,
            meta: '包含 Owner 私聊与群聊',
          },
          {
            label: '待处理关注',
            value: overview.summary.pendingAttentionCount,
            meta: '1 项待人工验收',
          },
          {
            label: '运行中任务',
            value: overview.summary.runningTasksCount,
            meta: 'Herdr 工作区活跃',
          },
          {
            label: '今日 Token',
            value: `${(overview.summary.todayTotalTokens / 1000).toFixed(1)}k`,
            meta: '成本不可用 (未配置计价模型)',
            mono: true,
          },
        ]}
      />

      {/* Needs Attention & Current Run Panels */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
        {/* Needs Attention Panel */}
        <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 'var(--radius-md)', padding: 16 }}>
          <SectionHeader title="重要关注" subtitle="只列出确实需要 Owner 介入决策的待办项" />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
            {overview.attentionQueue.map((item) => (
              <div
                key={item.id}
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
                  onClick={() => onNavigate(item.targetSection)}
                >
                  前往
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* Current Run Panel */}
        {overview.currentRun && (
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
            </div>
            <div style={{ marginTop: 14 }}>
              <button
                type="button"
                className="btn secondary sm"
                style={{ width: '100%' }}
                onClick={() => onNavigate('trace')}
              >
                查看完整执行追踪 (Trace)
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Usage Trend Chart */}
      <ChartPanel
        title="今日使用趋势 (Token 消耗与调用频次)"
        subtitle="实线表示 Token 消耗，虚线表示调用频次。支持切换至表格回退视图。"
        categories={overview.usageTrend.map((t) => t.label)}
        series={chartSeries}
      />

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
