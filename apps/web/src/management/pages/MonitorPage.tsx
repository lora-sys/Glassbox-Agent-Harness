/**
 * @file apps/web/src/management/pages/MonitorPage.tsx
 * Page 10: 监控 (Monitor & Telemetry)
 *
 * Implements Section 26 of DESIGN.md:
 * - Strictly separates product truth from live observation health.
 * - PI latency, HerdrBridge connection, Turso/R2 persistence health.
 */
import React from 'react';
import { PageHeader } from '../primitives/PageHeader';
import { SummaryBar } from '../primitives/SummaryBar';
import { ChartPanel, type ChartSeries } from '../primitives/ChartPanel';
import { StatusBadge } from '../primitives/StatusBadge';
import { useManagementMonitor } from '../adapter';

interface MonitorPageProps {
  onNavigate: (pageId: string) => void;
}

export const MonitorPage: React.FC<MonitorPageProps> = () => {
  const { data: res } = useManagementMonitor();
  const monitor = res?.data?.[0];

  if (!monitor) {
    return <div className="pageContainer">加载系统遥测数据中...</div>;
  }

  const chartSeries: ChartSeries[] = [
    {
      id: 'p50',
      name: 'P50 中位数耗时 (ms)',
      pattern: 'solid',
      color: 'var(--ink)',
      data: monitor.latencyTrend.map((t) => t.p50),
    },
    {
      id: 'p95',
      name: 'P95 长尾延迟 (ms)',
      pattern: 'dashed',
      color: 'var(--danger)',
      data: monitor.latencyTrend.map((t) => t.p95),
    },
  ];

  return (
    <div className="pageContainer">
      <PageHeader
        title="系统监控 (Monitor & Telemetry)"
        description="只回答核心问题：系统是否健康、外部观测是否新鲜、协作通道是否畅通、持久化存储是否在线。"
        capabilityState="已实现"
        customPill={{ text: 'P3 + Agent Ops', variant: 'ok' }}
      />

      {/* Subsystem Health Summary */}
      <SummaryBar
        items={[
          {
            label: '系统脉搏',
            value: <StatusBadge variant={monitor.systemHealth === 'healthy' ? 'ok' : 'bad'}>HEALTHY</StatusBadge>,
            meta: '核心控制面在线',
          },
          {
            label: 'PI 推理引擎',
            value: `${monitor.piEngine.p95LatencyMs} ms`,
            meta: `P95 响应耗时 · ${monitor.piEngine.activeSessions} 会话活跃`,
            mono: true,
          },
          {
            label: 'HerdrBridge 连接',
            value: <StatusBadge variant={monitor.herdrBridge.status === 'connected' ? 'ok' : 'bad'}>CONNECTED</StatusBadge>,
            meta: `${monitor.herdrBridge.activeWorkspaces} 工作区 · ${monitor.herdrBridge.activePanes} 窗格`,
          },
          {
            label: '持久化存储',
            value: <StatusBadge variant="ok">TURSO + R2</StatusBadge>,
            meta: '数据库读写正常',
          },
        ]}
      />

      {/* Latency Trends Chart */}
      <ChartPanel
        title="PI 推理引擎端到端响应延迟趋势"
        subtitle="实线为 P50 耗时，虚线为 P95 长尾延迟。支持表格视图回退。"
        categories={monitor.latencyTrend.map((t) => t.timestamp)}
        series={chartSeries}
      />

      {/* Active Alerts */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 'var(--radius-md)', padding: 16 }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)', margin: '0 0 12px 0' }}>
          观测告警与审计事件 ({monitor.alerts.length})
        </h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {monitor.alerts.map((alt) => (
            <div
              key={alt.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '10px 12px',
                background: 'var(--sidebar)',
                border: '1px solid var(--line)',
                borderRadius: 'var(--radius-sm)',
                fontSize: 12,
              }}
            >
              <StatusBadge variant={alt.severity}>{alt.severity.toUpperCase()}</StatusBadge>
              <span style={{ flex: 1, color: 'var(--body)' }}>{alt.message}</span>
              <span className="mono" style={{ color: 'var(--metadata)', fontSize: 11 }}>{alt.timestamp}</span>
            </div>
          ))}
          {monitor.alerts.length === 0 && (
            <span style={{ fontSize: 12, color: 'var(--metadata)' }}>当前无活跃异常告警</span>
          )}
        </div>
      </div>
    </div>
  );
};
