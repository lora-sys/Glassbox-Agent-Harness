/**
 * @file apps/web/src/management/fixtures/monitor.ts
 */
import type {
  MonitorTelemetryProjection,
  ServiceHealthProjection,
  StorageProjection,
} from '../types';

export const mockMonitorData: MonitorTelemetryProjection = {
  systemHealth: 'healthy',
  piEngine: {
    status: 'healthy',
    p95LatencyMs: 1420,
    activeSessions: 5,
  },
  herdrBridge: {
    status: 'stale',
    activeWorkspaces: 2,
    activePanes: 4,
    lastHeartbeat: '45 秒前 (心跳逾期)',
  },
  persistence: {
    tursoStatus: 'healthy',
    r2Status: 'healthy',
  },
  webSocketConnected: true,
  alerts: [
    {
      id: 'alt-01',
      severity: 'warn',
      message:
        'DeepSeek Chat (V3) 模型在 13:42:15 出现一次暂态超时与网络重试失败异常，监控系统已触发自动熔断保护机制并降级路由至 Claude 3.5 Sonnet 核心执行环境，历史上下文与审计跟踪证据已完整留存并同步至远端存储。',
      timestamp: '13:42:15',
    },
    {
      id: 'alt-02',
      severity: 'warn',
      message: 'QQ 测试群 (8839210) 命中 1 次敏感投递拦截，阻止了私有补丁摘要外发',
      timestamp: '14:20:11',
    },
  ],
  latencyTrend: [
    { timestamp: '14:00', p50: 620, p95: 1200 },
    { timestamp: '14:15', p50: 680, p95: 1350 },
    { timestamp: '14:30', p50: 710, p95: 1420 },
    { timestamp: '14:45', p50: 640, p95: 1290 },
    { timestamp: '15:00', p50: 690, p95: 1450 },
    { timestamp: '15:15', p50: 670, p95: 1420 },
  ],
};

export const mockServiceHealthData: ServiceHealthProjection[] = [
  {
    id: 'svc_pi',
    name: 'PI Engine (执行核心)',
    status: 'healthy',
    latencyMs: 670,
    errorRate: '0.2%',
    lastSuccess: '刚刚 (15:19:22)',
    notes: 'v0.8.4 · 核心模型调度与推理正常',
  },
  {
    id: 'svc_herdr',
    name: 'HerdrBridge (工作区与编码宿主)',
    status: 'stale',
    latencyMs: '—',
    errorRate: '0.0%',
    lastSuccess: '45 秒前',
    lastError: '心跳逾期 (STALE): 事实暂态滞后',
    notes: '外部宿主事实非产品真理，断线走隔离降级',
  },
  {
    id: 'svc_ws',
    name: 'WebSocket Event Stream (全双工事件流)',
    status: 'healthy',
    latencyMs: 12,
    errorRate: '0.0%',
    lastSuccess: '在线 (心跳 1s)',
    notes: '实时推送连接正常',
  },
  {
    id: 'svc_turso',
    name: 'Turso SQLite (产品持久化真理库)',
    status: 'healthy',
    latencyMs: 18,
    errorRate: '0.0%',
    lastSuccess: '刚刚',
    notes: '持久化会话、任务真理、授权 Grant 与 Taste',
  },
  {
    id: 'svc_r2',
    name: 'Cloudflare R2 (不可变证据与工件存储)',
    status: 'healthy',
    latencyMs: 85,
    errorRate: '0.0%',
    lastSuccess: '2 分钟前',
    notes: '不可变 Raw Trace、执行产物与任务工件',
  },
  {
    id: 'svc_onebot',
    name: 'OneBot 11 / NapCat (QQ 渠道网关)',
    status: 'healthy',
    latencyMs: 42,
    errorRate: '0.5%',
    lastSuccess: '12 秒前',
    notes: 'P3 外部消息网关与投递门禁通道',
  },
];

export const mockStorageData: StorageProjection[] = [
  {
    id: 'store_turso',
    tier: '核心真理层 (Truth)',
    engine: 'Turso SQLite (libsql)',
    usage: '48.2 MB',
    retention: '永久保存 (Soft Delete 30天软归档)',
    contents: 'Principals, Conversations, Tasks, Grants, Taste, Preferences',
    role: '产品状态唯一真理 (Product Truth)',
  },
  {
    id: 'store_r2',
    tier: '不可变证据层 (Evidence)',
    engine: 'Cloudflare R2 Object Storage',
    usage: '1.42 GB',
    retention: '90天可配置归档 (不可篡改 Raw Trace)',
    contents: 'Raw Traces, TaskAttempt Diffs, Execution Artifacts',
    role: '不可变执行审计证据 (Append-Only Evidence)',
  },
  {
    id: 'store_buffers',
    tier: '暂态观测层 (Ephemeral)',
    engine: 'In-Memory Ring Buffers & Panes',
    usage: '12.8 MB',
    retention: '滚动覆盖 / 随进程重启清空',
    contents: 'HerdrBridge Panes, Terminal Screen, WebSocket Event Queue',
    role: '实时事实观测 (Observation Facts Only)',
  },
];
