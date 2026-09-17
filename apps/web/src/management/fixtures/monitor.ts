/**
 * @file apps/web/src/management/fixtures/monitor.ts
 */
import type { MonitorTelemetryProjection } from '../types';

export const mockMonitorData: MonitorTelemetryProjection = {
  systemHealth: 'healthy',
  piEngine: {
    status: 'healthy',
    p95LatencyMs: 1420,
    activeSessions: 5,
  },
  herdrBridge: {
    status: 'connected',
    activeWorkspaces: 2,
    activePanes: 4,
    lastHeartbeat: '4 秒前',
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
      message: 'DeepSeek Chat (V3) 模型在 13:42 出现一次暂态超时，已自动降级至 Claude 3.5 Sonnet',
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
