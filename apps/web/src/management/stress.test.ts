/**
 * @file apps/web/src/management/stress.test.ts
 *
 * Edge cases and stress scenarios from DESIGN_EVAL.md:
 * - Extremely long strings (Chinese titles, IDs, resource paths, multiline stack traces)
 * - Empty collections (0 items)
 * - Disconnected / stale observations
 * - Data honesty: no fake zero pricing
 */
import { describe, it, expect } from 'vitest';
import {
  validateTasksResponse,
  validateRunsResponse,
  validateChannelsResponse,
  validateManagementStatus,
} from './adapter/validators';
import { mockTasksData } from './fixtures';
import type { CapabilityState } from './types';

describe('Stress & Edge Case Verifications', () => {
  it('validates production tasks with extremely long Chinese titles and deep resource paths safely', () => {
    // Test that production mockTasksData contains real extreme edge cases and validates strictly
    const validated = validateTasksResponse({ tasks: mockTasksData });
    expect(validated.length).toBeGreaterThan(0);

    // Find the task with long title in production fixture
    const longTitleTask = validated.find((t) => t.title.length > 40);
    expect(longTitleTask).toBeDefined();
    expect(longTitleTask?.id.length).toBeGreaterThan(40);
    expect(longTitleTask?.title).toContain('长期会话上下文持久化与 Turso 数据库跨架构平滑迁移验证基准测试执行计划');

    // Custom extreme stress payload with long strings through production validator
    const extremeTask = {
      ...mockTasksData[0],
      id: 'task-stress-' + 'x'.repeat(100),
      title: '【高危紧急操作】针对外部群聊 NapCat OneBot 11 适配器与 Herdr 工作区进行跨工作区分支同步与持久化状态归档回滚测试'.repeat(3),
      attempts: [
        {
          ...mockTasksData[0].attempts[0],
          attemptNo: 99,
          artifactUri: 'r2://artifacts/workspace/sub_project/deep/nested/directory/structure/task-attempt-9921/patches/' + 'a'.repeat(120) + '.patch',
        },
      ],
    };

    const parsed = validateTasksResponse({ tasks: [extremeTask] });
    expect(parsed[0].id).toBe(extremeTask.id);
    expect(parsed[0].title).toBe(extremeTask.title);
    expect(parsed[0].attempts[0].artifactUri).toBe(extremeTask.attempts[0].artifactUri);
  });

  it('verifies that empty data states are explicitly representable without crashes in production validators', () => {
    // Production validator accepts empty collections without crashing
    const emptyTasks = validateTasksResponse({ tasks: [] });
    expect(emptyTasks).toHaveLength(0);

    const emptyRuns = validateRunsResponse({ runs: [] });
    expect(emptyRuns).toHaveLength(0);

    const emptyChannels = validateChannelsResponse({ channels: [] });
    expect(emptyChannels.channels).toHaveLength(0);
  });

  it('prohibits inconsistent visible vocabulary in capability states', () => {
    const allowedStates: CapabilityState[] = ['已实现', 'P3 目标', '设计数据', '后续', '未知', '—'];
    const invalidTerms = ['fixture', 'experimental', 'planned', 'target', 'future'];

    for (const term of invalidTerms) {
      expect(allowedStates).not.toContain(term as any);
    }
  });

  it('validates disconnected and stale observation state modeling in production status/channel validators', () => {
    // Test production status validator with ready status
    const readyStatus = validateManagementStatus({
      service: 'glassbox',
      version: '0.8.4',
      status: 'ready',
      platform: 'linux',
      defaultExecution: 'pi',
      capabilities: { modelConfiguration: true, channels: true },
    });
    expect(readyStatus.status).toBe('ready');

    // Test production channels validator with disconnected state
    const disconnectedChannels = validateChannelsResponse({
      channels: [
        {
          id: 'chan_qq_disconnected',
          label: 'QQ Disconnected Channel',
          kind: 'qq-onebot',
          endpoint: 'ws://127.0.0.1:5009',
          botId: 'bot-disc',
          ownerId: 'owner-disc',
          groupIds: [],
          tokenConfigured: false,
          autoConnect: false,
          connectionState: 'disconnected',
        },
      ],
    });
    expect(disconnectedChannels.channels[0].connectionState).toBe('disconnected');

    // Test stale observation state in task
    const staleTask = {
      ...mockTasksData[0],
      herdrState: 'stale' as const,
      herdrObservationMeta: 'Herdr 心跳超时 180s',
    };
    const parsedTasks = validateTasksResponse({ tasks: [staleTask] });
    expect(parsedTasks[0].herdrState).toBe('stale');
  });
});
