/**
 * @file apps/web/src/management/fixtures/ops.ts
 *
 * Implements the core invariant:
 * Herdr worker 'done' ≠ Glassbox Task 'DONE'.
 * When worker finishes, Task enters REVIEW state, requiring explicit human Accept / Rework.
 */
import type { TaskProjection, LiveWorkerProjection } from '../types';

export const mockLiveWorkersData: LiveWorkerProjection[] = [
  {
    id: 'worker-01',
    herdrSession: 'default',
    workspaceName: 'glassbox-adapter',
    paneName: 'pane-1',
    state: 'blocked',
    lastHeartbeat: '25 秒前',
  },
  {
    id: 'worker-04',
    herdrSession: 'default',
    workspaceName: 'glassbox',
    paneName: 'pane-3',
    state: 'done',
    lastHeartbeat: '14 分钟前',
  },
  {
    id: 'worker-07',
    herdrSession: 'secondary',
    workspaceName: 'glassbox-evals',
    paneName: 'pane-2',
    state: 'working',
    lastHeartbeat: '5 秒前',
  },
];

export const mockTasksData: TaskProjection[] = [
  {
    id: 'task-218',
    title: 'QQ 权限回归测试与规则验证 (P3.3 交付)',
    state: 'REVIEW', // CRITICAL: Glassbox Task truth is REVIEW, not DONE!
    priority: 'high',
    creatorPrincipal: 'owner_primary',
    conversationId: 'conv_owner_main',
    currentAttemptNo: 2,
    herdrState: 'done', // Herdr external execution fact
    herdrObservationMeta: 'worker-04 · pane-3 · 14 分钟前阶段结算',
    requiresReview: true,
    attentionReason: 'Herdr 工作完成，等待 Owner 验收或返工决策',
    createdAt: '2026-09-17T14:30:00Z',
    updatedAt: '2026-09-17T15:02:00Z',
    attempts: [
      {
        attemptNo: 1,
        status: 'FAILED',
        runId: 'run_A81',
        workerBinding: {
          herdrSession: 'default',
          workspaceName: 'glassbox',
          paneName: 'pane-2',
          workerType: 'PI worker',
          branch: 'codex/fix-auth-cache',
          lastObservedAt: '2026-09-17T14:45:00Z',
        },
        testResults: { passed: 39, total: 42 },
        durationMs: 38200,
        settledAt: '2026-09-17T14:45:00Z',
      },
      {
        attemptNo: 2,
        status: 'COMPLETED',
        runId: 'run_A83',
        workerBinding: {
          herdrSession: 'default',
          workspaceName: 'glassbox',
          paneName: 'pane-3',
          workerType: 'PI worker',
          branch: 'codex/fix-auth-cache-v2',
          lastObservedAt: '2026-09-17T15:02:00Z',
        },
        testResults: { passed: 42, total: 42 },
        artifactUri: 'r2://artifacts/task-218/attempt-2-patch.diff',
        durationMs: 42300,
        settledAt: '2026-09-17T15:02:00Z',
      },
    ],
  },
  {
    id: 'task-221',
    title: 'NapCat OneBot 11 适配器重连容错验证',
    state: 'WAITING_INPUT',
    priority: 'normal',
    creatorPrincipal: 'owner_primary',
    conversationId: 'conv_qq_private_owner',
    currentAttemptNo: 1,
    herdrState: 'blocked',
    herdrObservationMeta: 'worker-02 · pane-1 · 25 分钟前阻塞',
    requiresReview: false,
    attentionReason: '等待群配置参数确认，当前处于阻塞状态',
    createdAt: '2026-09-17T14:15:00Z',
    updatedAt: '2026-09-17T14:50:00Z',
    attempts: [
      {
        attemptNo: 1,
        status: 'RUNNING',
        runId: 'run_A79',
        workerBinding: {
          herdrSession: 'default',
          workspaceName: 'glassbox-adapter',
          paneName: 'pane-1',
          workerType: 'PI worker',
          branch: 'codex/napcat-reconnect',
          lastObservedAt: '2026-09-17T14:50:00Z',
        },
        testResults: { passed: 12, total: 18 },
        durationMs: 21500,
      },
    ],
  },
  {
    id: 'task-224',
    title: '临时工作区破坏性重置与测试依赖清理',
    state: 'QUEUED',
    priority: 'critical',
    creatorPrincipal: 'owner_primary',
    conversationId: 'conv_owner_main',
    currentAttemptNo: 1,
    herdrState: 'idle',
    herdrObservationMeta: '等待授权门禁确认',
    requiresReview: false,
    attentionReason: '命中破坏性操作门禁 (Hard Gate 4)，需要显式审批',
    createdAt: '2026-09-17T14:55:00Z',
    updatedAt: '2026-09-17T14:55:00Z',
    attempts: [],
  },
  {
    id: 'task-215-long-identifier-for-resilience-testing-against-truncation-and-overflow',
    title: '长期会话上下文持久化与 Turso 数据库跨架构平滑迁移验证基准测试执行计划（第四阶段全量边界覆盖）',
    state: 'DONE',
    priority: 'normal',
    creatorPrincipal: 'owner_primary',
    conversationId: 'conv_owner_main',
    currentAttemptNo: 1,
    herdrState: 'idle',
    herdrObservationMeta: '已验收并归档',
    requiresReview: false,
    createdAt: '2026-09-17T12:00:00Z',
    updatedAt: '2026-09-17T13:45:00Z',
    attempts: [
      {
        attemptNo: 1,
        status: 'COMPLETED',
        runId: 'run_A70',
        workerBinding: {
          herdrSession: 'default',
          workspaceName: 'glassbox-db',
          paneName: 'pane-0',
          workerType: 'PI worker',
          branch: 'codex/turso-migration-benchmark',
          lastObservedAt: '2026-09-17T13:45:00Z',
        },
        testResults: { passed: 100, total: 100 },
        artifactUri:
          'r2://artifacts/glassbox/workspaces/storage/runs/task-215/benchmark-long-execution-report-with-verified-provenance-data.json',
        durationMs: 105000,
        settledAt: '2026-09-17T13:45:00Z',
      },
    ],
  },
];
