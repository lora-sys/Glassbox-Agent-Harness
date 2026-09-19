/**
 * @file apps/web/src/management/pages/MonitorPage.tsx
 * Page 10: 监控 (Monitor & Telemetry)
 *
 * Implements Section 26 of DESIGN.md & Section 20 of DESIGN_EVAL.md:
 * - Strictly separates product truth from live observation health.
 * - Primary hierarchy: Service Health Table → Latency Trend → Agent Ops Health → Storage → Alerts.
 * - Observation freshness and required disconnected / stale / unavailable cases.
 */
import React from 'react';
import { PageHeader, SectionHeader } from '../primitives/PageHeader';
import { SummaryBar } from '../primitives/SummaryBar';
import { DataTable, type Column } from '../primitives/DataTable';
import { ChartPanel, type ChartSeries } from '../primitives/ChartPanel';
import { StatusBadge } from '../primitives/StatusBadge';
import { useManagementMonitor, useManagementData } from '../adapter';
import { mockServiceHealthData, mockStorageData } from '../fixtures/monitor';
import { mockTasksData } from '../fixtures/ops';
import type { ServiceHealthProjection, StorageProjection } from '../types';

interface MonitorPageProps {
  onNavigate: (pageId: string) => void;
}

export const MonitorPage: React.FC<MonitorPageProps> = () => {
  const { mode } = useManagementData();
  const { data: res, isLoading, isError, error } = useManagementMonitor();
  const isLive = mode === 'live' || res?.source === 'api';
  const monitor = res?.data?.[0];

  if (isLoading) {
    return (
      <div className="pageContainer">
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--metadata)' }}>
          加载系统遥测数据中...
        </div>
      </div>
    );
  }

  if (isError || !monitor) {
    return (
      <div className="pageContainer">
        <PageHeader
          title="系统监控 (Monitor & Telemetry)"
          description="只回答核心问题：系统是否健康、外部观测是否新鲜、协作通道是否畅通、持久化存储是否在线。"
          capabilityState="已实现"
        />
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--danger)' }} role="alert">
          <strong>遥测数据加载失败</strong>: {error instanceof Error ? error.message : '无法获取系统遥测数据'}
        </div>
      </div>
    );
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
      color: 'var(--secondary)',
      data: monitor.latencyTrend.map((t) => t.p95),
    },
  ];

  const herdrVariant: 'ok' | 'warn' | 'bad' =
    monitor.herdrBridge.status === 'connected'
      ? 'ok'
      : monitor.herdrBridge.status === 'stale'
      ? 'warn'
      : 'bad';

  const herdrLabel =
    monitor.herdrBridge.status === 'connected'
      ? 'CONNECTED'
      : monitor.herdrBridge.status === 'stale'
      ? 'STALE'
      : 'DISCONNECTED';

  const systemVariant: 'ok' | 'warn' | 'bad' =
    monitor.systemHealth === 'healthy'
      ? 'ok'
      : monitor.systemHealth === 'degraded'
      ? 'warn'
      : 'bad';

  const systemLabel =
    monitor.systemHealth === 'healthy'
      ? 'HEALTHY'
      : monitor.systemHealth === 'degraded'
      ? 'DEGRADED'
      : 'CRITICAL';

  const tursoOnline = monitor.persistence.tursoStatus === 'healthy';

  // Agent Ops health figures are derived from the same design data set the Task page renders,
  // so the two surfaces can never disagree about how many tasks are blocked or awaiting review.
  const reviewTaskCount = mockTasksData.filter(
    (t) => t.state === 'REVIEW' || t.requiresReview,
  ).length;
  const blockedTaskCount = mockTasksData.filter(
    (t) => t.state === 'WAITING_INPUT' || t.herdrState === 'blocked',
  ).length;
  const designAttempts = mockTasksData.flatMap((t) => t.attempts);
  const reworkAttemptCount = designAttempts.filter((a) => a.status === 'REWORKED').length;
  const reworkRate =
    designAttempts.length > 0
      ? `${((reworkAttemptCount / designAttempts.length) * 100).toFixed(1)}%`
      : '未知';

  const serviceColumns: Column<ServiceHealthProjection>[] = [
    {
      key: 'name',
      header: '子系统 / 服务名称',
      render: (s) => (
        <div>
          <div style={{ fontWeight: 600, color: 'var(--ink)' }}>{s.name}</div>
          <div className="mono" style={{ fontSize: 11, color: 'var(--metadata)' }}>{s.id}</div>
        </div>
      ),
    },
    {
      key: 'status',
      header: '运行状态',
      render: (s) => {
        const variant =
          s.status === 'healthy'
            ? 'ok'
            : s.status === 'slow' || s.status === 'stale'
            ? 'warn'
            : 'bad';
        return <StatusBadge variant={variant}>{s.status.toUpperCase()}</StatusBadge>;
      },
    },
    {
      key: 'latency',
      header: '耗时 / 观测时延',
      render: (s) => (
        <span className="mono">
          {typeof s.latencyMs === 'number' ? `${s.latencyMs} ms` : s.latencyMs ?? '—'}
        </span>
      ),
    },
    {
      key: 'errorRate',
      header: '错误率',
      render: (s) => <span className="mono">{s.errorRate}</span>,
    },
    {
      key: 'lastSuccess',
      header: '最后正常',
      render: (s) => <span style={{ fontSize: 12, color: 'var(--metadata)' }}>{s.lastSuccess}</span>,
    },
    {
      key: 'notes',
      header: '观测说明与判定依据',
      render: (s) => (
        <div style={{ fontSize: 12, color: 'var(--secondary)' }}>
          {s.notes}
          {s.lastError && (
            <div style={{ color: 'var(--danger)', fontSize: 11, marginTop: 2 }}>{s.lastError}</div>
          )}
        </div>
      ),
    },
  ];

  const storageColumns: Column<StorageProjection>[] = [
    {
      key: 'tier',
      header: '存储分层',
      render: (st) => <span style={{ fontWeight: 600 }}>{st.tier}</span>,
    },
    {
      key: 'engine',
      header: '存储引擎',
      render: (st) => <span className="mono" style={{ fontSize: 12 }}>{st.engine}</span>,
    },
    {
      key: 'usage',
      header: '当前容量',
      render: (st) => <span className="mono" style={{ fontWeight: 600 }}>{st.usage}</span>,
    },
    {
      key: 'retention',
      header: '留存与归档策略',
      render: (st) => <span style={{ fontSize: 12 }}>{st.retention}</span>,
    },
    {
      key: 'contents',
      header: '主要承载内容',
      render: (st) => <span style={{ fontSize: 12, color: 'var(--metadata)' }}>{st.contents}</span>,
    },
    {
      key: 'role',
      header: '架构真理角色',
      render: (st) => {
        const variant = st.role.includes('Product Truth')
          ? 'ok'
          : st.role.includes('Evidence')
          ? 'teal'
          : 'neutral';
        return <StatusBadge variant={variant}>{st.role}</StatusBadge>;
      },
    },
  ];

  return (
    <div className="pageContainer">
      <PageHeader
        title="系统监控 (Monitor & Telemetry)"
        description="只回答核心问题：系统是否健康、外部观测是否新鲜、协作通道是否畅通、持久化存储是否在线。"
        capabilityState="已实现"
        customPill={{
          text: isLive ? '实时接口' : '设计数据',
          variant: isLive ? 'ok' : 'neutral',
        }}
      />

      {/* Subsystem Health SummaryBar */}
      <SummaryBar
        items={[
          {
            label: '系统脉搏',
            value: <StatusBadge variant={systemVariant}>{systemLabel}</StatusBadge>,
            meta: monitor.systemHealth === 'healthy' ? '核心控制面在线' : '控制面状态异常',
          },
          {
            label: 'PI 推理引擎',
            value: `${monitor.piEngine.p95LatencyMs} ms`,
            meta: `P95 响应耗时 · ${monitor.piEngine.activeSessions} 会话活跃`,
            mono: true,
          },
          {
            label: 'HerdrBridge 连接',
            value: <StatusBadge variant={herdrVariant}>{herdrLabel}</StatusBadge>,
            meta: `${monitor.herdrBridge.status === 'connected' ? '当前' : '最近观测'}：${monitor.herdrBridge.activeWorkspaces} 工作区 · ${monitor.herdrBridge.activePanes} 窗格`,
          },
          {
            label: '持久化存储',
            value: (
              <StatusBadge variant={tursoOnline ? 'ok' : 'bad'}>
                {tursoOnline ? 'TURSO ONLINE' : 'TURSO UNREACHABLE'}
              </StatusBadge>
            ),
            meta: tursoOnline ? '数据库读写正常' : '数据库连接异常',
          },
        ]}
      />

      <div>
        <SectionHeader
          title="观测新鲜度 (Observation Freshness)"
          subtitle="缺少服务端字段时保持未知，不把外部观测改写为产品真值"
          capabilityState={isLive ? 'P3 目标' : '设计数据'}
        />
        <SummaryBar
          items={[
            { label: 'Last snapshot', value: '未知', meta: '接口未上报快照时间' },
            { label: 'Last reconcile', value: '未知', meta: '接口未上报协调时间' },
            { label: 'Unknown workers', value: '未知', meta: '接口未上报未知 Worker 数' },
            { label: 'Stale bindings', value: '未知', meta: '接口未上报过期绑定数' },
            { label: 'Stale threshold', value: '未知', meta: '接口未上报判定阈值' },
            { label: 'Last lifecycle', value: '未知', meta: '接口未上报最近成功生命周期事件' },
            { label: 'Connection state', value: herdrLabel, meta: `最近心跳：${monitor.herdrBridge.lastHeartbeat || '未知'}` },
          ]}
        />
      </div>

      {/* 1. Service Health Table */}
      <div>
        <SectionHeader
          title="核心子系统服务健康表 (Service Health)"
          subtitle="严格区分产品真理服务与外部观测服务状态"
          capabilityState={isLive ? 'P3 目标' : '设计数据'}
        />
        {isLive ? (
          <div
            style={{
              padding: 24,
              background: 'var(--surface)',
              border: '1px solid var(--line)',
              borderRadius: 'var(--radius-sm)',
              textAlign: 'center',
              color: 'var(--metadata)',
              marginTop: 8,
              fontSize: 12,
            }}
          >
            子系统健康度明细接口暂不可用 (P3 目标：需要微服务探针注册表)
          </div>
        ) : (
          <div style={{ marginTop: 8 }}>
            <DataTable
              data={mockServiceHealthData}
              columns={serviceColumns}
              keyExtractor={(s) => s.id}
            />
          </div>
        )}
      </div>

      {/* 2. Latency Trends Chart */}
      <ChartPanel
        title="PI 推理引擎端到端响应延迟趋势"
        subtitle="实线为 P50 耗时，虚线为 P95 长尾延迟。支持表格视图回退。"
        categories={monitor.latencyTrend.map((t) => t.timestamp)}
        series={chartSeries}
      />

      {/* 3. Agent Operations Health Summary */}
      <div>
        <SectionHeader
          title="Agent Ops 运行指标 (Product Operations Health)"
          subtitle="评估任务吞吐、人工验收负荷与外部执行宿主弹性"
          capabilityState={isLive ? 'P3 目标' : '设计数据'}
        />
        {isLive ? (
          <div
            style={{
              padding: 24,
              background: 'var(--surface)',
              border: '1px solid var(--line)',
              borderRadius: 'var(--radius-sm)',
              textAlign: 'center',
              color: 'var(--metadata)',
              marginTop: 8,
              fontSize: 12,
            }}
          >
            Agent Ops 聚合指标管道暂不可用 (P3 目标：需要运营指标聚合服务)
          </div>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 200px), 1fr))',
              gap: 12,
              marginTop: 8,
            }}
          >
            <div className="summaryItem">
              <span className="summaryItemLabel">待人工验收任务</span>
              <strong style={{ fontSize: 16, color: 'var(--brand)' }}>{reviewTaskCount} 项</strong>
              <span className="summaryItemMeta">已由 Worker 提交，等待 Owner 验收</span>
            </div>
            <div className="summaryItem">
              <span className="summaryItemLabel">阻塞中的任务</span>
              <strong style={{ fontSize: 16, color: blockedTaskCount > 0 ? 'var(--danger)' : 'var(--success)' }}>
                {blockedTaskCount} 项
              </strong>
              <span className="summaryItemMeta">
                {blockedTaskCount > 0 ? '存在等待输入或被 Herdr 标记阻塞的任务' : '无长时间停滞或死锁任务'}
              </span>
            </div>
            <div className="summaryItem">
              <span className="summaryItemLabel">任务返工率</span>
              <strong style={{ fontSize: 16, color: 'var(--ink)' }}>{reworkRate}</strong>
              <span className="summaryItemMeta">按 TaskAttempt 统计，共 {reworkAttemptCount} 次要求返工</span>
            </div>
            <div className="summaryItem">
              <span className="summaryItemLabel">HerdrBridge 事实新鲜度</span>
              <strong
                style={{
                  fontSize: 16,
                  color:
                    monitor.herdrBridge.status === 'connected'
                      ? 'var(--success)'
                      : monitor.herdrBridge.status === 'stale'
                        ? 'var(--brand)'
                        : 'var(--danger)',
                }}
              >
                {herdrLabel} ({monitor.herdrBridge.lastHeartbeat || '未知'})
              </strong>
              <span className="summaryItemMeta">
                {monitor.herdrBridge.status === 'connected'
                  ? '最近心跳由观测接口上报'
                  : monitor.herdrBridge.status === 'stale'
                    ? '外部观测已过期，不替代 Glassbox 产品真值'
                    : '外部执行宿主当前断开连接'}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* 4. Storage Tiers Table */}
      <div>
        <SectionHeader
          title="持久化与存储分层 (Persistence & Storage Tiers)"
          subtitle="Turso SQLite (产品真理) · Cloudflare R2 (不可变证据) · Live Buffers (暂态观测)"
          capabilityState={isLive ? 'P3 目标' : '设计数据'}
        />
        {isLive ? (
          <div
            style={{
              padding: 24,
              background: 'var(--surface)',
              border: '1px solid var(--line)',
              borderRadius: 'var(--radius-sm)',
              textAlign: 'center',
              color: 'var(--metadata)',
              marginTop: 8,
              fontSize: 12,
            }}
          >
            存储分层统计接口暂不可用 (P3 目标：需要存储引擎遥测探针)
          </div>
        ) : (
          <div style={{ marginTop: 8 }}>
            <DataTable
              data={mockStorageData}
              columns={storageColumns}
              keyExtractor={(st) => st.id}
            />
          </div>
        )}
      </div>

      {/* 5. Observation Freshness & Resilience Reference */}
      <div>
        <SectionHeader
          title="观测隔离与故障自愈规范 (Observation & Resilience)"
          subtitle="遵循 DESIGN_EVAL.md 第 20 节：事实非真理，连接断开绝不影响已持久化的 Task/Conversation 状态"
        />
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))',
            gap: 10,
            marginTop: 8,
          }}
        >
          <div
            style={{
              padding: 10,
              background: 'var(--surface)',
              border: '1px solid var(--line)',
              borderRadius: 'var(--radius-sm)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <strong>Herdr 断线与重连 (Disconnected / Stale)</strong>
              <StatusBadge variant="warn" className="sm">ISOLATED</StatusBadge>
            </div>
            <div style={{ fontSize: 11, color: 'var(--metadata)', marginTop: 4 }}>
              Herdr 宿主崩溃或网络中断时，Glassbox Task 状态冻结在最后持久化快照，重连时显式通过 HerdrBridge 四步对账。
            </div>
          </div>
          <div
            style={{
              padding: 10,
              background: 'var(--surface)',
              border: '1px solid var(--line)',
              borderRadius: 'var(--radius-sm)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <strong>未知 Worker 与陈旧绑定 (Unknown / Stale Bindings)</strong>
              <StatusBadge variant="bad" className="sm">RESTRICTED</StatusBadge>
            </div>
            <div style={{ fontSize: 11, color: 'var(--metadata)', marginTop: 4 }}>
              未在 Glassbox TaskAttempt 登记的孤儿 Worker 进程不具备任何读写特权，无法越权修改系统工作区。
            </div>
          </div>
          <div
            style={{
              padding: 10,
              background: 'var(--surface)',
              border: '1px solid var(--line)',
              borderRadius: 'var(--radius-sm)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <strong>持久化存储熔断 (Turso / R2 Unavailable)</strong>
              <StatusBadge variant="bad" className="sm">FAIL_CLOSED</StatusBadge>
            </div>
            <div style={{ fontSize: 11, color: 'var(--metadata)', marginTop: 4 }}>
              若 Turso 或 R2 存储不可用，系统立即进入 Fail-Closed 只读受保护模式，严禁伪造零值或静默丢失 Trace。
            </div>
          </div>
        </div>
      </div>

      {/* 6. Active Alerts & Audit Events */}
      <div
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--line)',
          borderRadius: 'var(--radius-md)',
          padding: 16,
        }}
      >
        <h3
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: 'var(--ink)',
            margin: '0 0 12px 0',
          }}
        >
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
              <span className="mono" style={{ color: 'var(--metadata)', fontSize: 11 }}>
                {alt.timestamp}
              </span>
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
