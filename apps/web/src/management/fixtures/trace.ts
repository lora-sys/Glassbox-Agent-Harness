/**
 * @file apps/web/src/management/fixtures/trace.ts
 *
 * Implements the Trace scale test suites specified in Section 15 of DESIGN_EVAL.md:
 * - 28 semantic events
 * - 100 semantic events
 * - 500 semantic events
 * - >500 semantic events (650 events)
 * - Large Raw Trace payload
 *
 * Covers all 14 trace types:
 * user, authorization, system, context, memory, skill, thinking,
 * tool, file, test, ops, delivery, assistant, error.
 */
import type { TraceEventProjection, TraceEventType, TraceRunSummary } from '../types';

export const mockTraceRuns: TraceRunSummary[] = [
  {
    runId: 'run_A83',
    conversationId: 'conv_owner_main',
    model: 'claude-3-5-sonnet',
    eventCount: 500, // 500 events scale tier
    status: 'running',
    durationMs: 42300,
    timestamp: '15:10:00',
  },
  {
    runId: 'run_A81',
    conversationId: 'conv_owner_main',
    model: 'claude-3-5-sonnet',
    eventCount: 100, // 100 events scale tier
    status: 'failed',
    durationMs: 38200,
    timestamp: '14:40:00',
  },
  {
    runId: 'run_A79',
    conversationId: 'conv_qq_private_owner',
    model: 'gpt-4o',
    eventCount: 28, // 28 events minimal tier
    status: 'running',
    durationMs: 21500,
    timestamp: '14:45:00',
  },
  {
    runId: 'run_A70',
    conversationId: 'conv_owner_main',
    model: 'claude-3-5-sonnet',
    eventCount: 650, // >500 events stress tier
    status: 'completed',
    durationMs: 105000,
    timestamp: '12:00:00',
  },
];

const EVENT_TYPES: TraceEventType[] = [
  'user',
  'authorization',
  'system',
  'context',
  'memory',
  'skill',
  'thinking',
  'tool',
  'file',
  'test',
  'ops',
  'delivery',
  'assistant',
  'error',
];

export function generateTraceEvents(count: number, runId: string): TraceEventProjection[] {
  const events: TraceEventProjection[] = [];

  for (let i = 1; i <= count; i++) {
    const type = EVENT_TYPES[(i - 1) % EVENT_TYPES.length];
    const seq = i;
    const timeOffsetMs = i * 200;
    const date = new Date(Date.now() - (count - i) * 500);
    const timeStr = date.toTimeString().split(' ')[0] + '.' + String(date.getMilliseconds()).padStart(3, '0');

    let summary = `Event #${seq} (${type})`;
    let payload: Record<string, unknown> = {
      sequence: seq,
      type,
      runId,
      timestamp: timeStr,
    };

    let authDetail = undefined;

    switch (type) {
      case 'user':
        summary = `用户指令: "执行回归测试第 ${seq} 项安全门禁验证"`;
        payload = { text: summary, principal: 'owner_primary', channel: 'web' };
        break;
      case 'authorization':
        summary = `鉴权通过: Principal(owner_primary) × Resource(workspace:git) × Action(commit)`;
        authDetail = {
          decision: 'ALLOW' as const,
          principal: 'owner_primary',
          resource: 'workspace:git',
          action: 'commit',
          reason: 'Matched policy grant:system:full_control',
          location: 'web:local',
        };
        payload = { auth: authDetail };
        break;
      case 'system':
        summary = `系统调度: 正在激活 Lora PI Kit profile (p3-closed-loop)`;
        payload = { profile: 'p3-closed-loop', runtime: 'pi-coding-agent' };
        break;
      case 'context':
        summary = `上下文注入: 已装载 12 条持久化会话记忆与 3 个工作区规则`;
        payload = { memoryCount: 12, ruleCount: 3, totalTokens: 4200 };
        break;
      case 'memory':
        summary = `记忆检索: 命中 "QQ 权限历史评审决议 (2026-09-15)"`;
        payload = { query: 'qq permissions rule', similarityScore: 0.94 };
        break;
      case 'skill':
        summary = `技能匹配: 激活 skills/git-worktree-ops`;
        payload = { skillName: 'git-worktree-ops', version: '1.2.0' };
        break;
      case 'thinking':
        summary = `模型思考: 正在推演分支隔离与门禁判定状态...`;
        payload = { thoughtSummary: 'Evaluating authorization boundary before executing child tool.' };
        break;
      case 'tool':
        summary = `调用工具: git_status (工作区 C:/.../Glassbox-Web-Management)`;
        payload = { tool: 'git_status', args: { porcelain: true }, exitCode: 0, durationMs: 45 };
        break;
      case 'file':
        summary = `文件操作: 校验 docs/ui/DESIGN.md SHA-256 指纹一致`;
        payload = { path: 'docs/ui/DESIGN.md', hashVerified: true };
        break;
      case 'test':
        summary = `执行测试: vitest run apps/web/src (42/42 通过)`;
        payload = { suite: 'web-management-eval', passed: 42, failed: 0 };
        break;
      case 'ops':
        summary = `Agent Ops: 收到 Herdr worker-04 阶段结算事件，任务进入 REVIEW`;
        payload = { herdrPane: 'pane-3', workerId: 'worker-04', taskState: 'REVIEW' };
        break;
      case 'delivery':
        summary = `交付门禁: 审核回复内容未包含敏感凭证，允许投递`;
        payload = { deliveryGate: 'PASSED', targetAudience: 'owner_primary' };
        break;
      case 'assistant':
        summary = `Agent 汇报: 阶段任务执行完毕，等待人工验收指令。`;
        payload = { replyText: 'All checks passed. Ready for review.' };
        break;
      case 'error':
        summary = i === count ? `异常捕获: 预期范围内的暂态重试 (seq=${seq})` : `非致命告警: 监测到局部连接延迟`;
        payload = { errorCode: 'ERR_TIMEOUT_RETRY', retriesLeft: 2 };
        break;
    }

    events.push({
      id: `${runId}-ev-${seq}`,
      runId,
      sequence: seq,
      timestamp: timeStr,
      type,
      summary,
      durationMs: timeOffsetMs % 150,
      authorization: authDetail,
      payload,
      rawTraceExcerpt: JSON.stringify(
        {
          timestamp: timeStr,
          seq,
          type,
          level: 'INFO',
          runId,
          details: payload,
          stackTrace: type === 'error' ? 'Error: Mock retryable failure\n  at Reconciler.check (reconcile.ts:142)' : undefined,
        },
        null,
        2
      ),
    });
  }

  return events;
}

export function getTraceEventsForRun(runId: string): TraceEventProjection[] {
  switch (runId) {
    case 'run_A79':
      return generateTraceEvents(28, 'run_A79');
    case 'run_A81':
      return generateTraceEvents(100, 'run_A81');
    case 'run_A70':
      return generateTraceEvents(650, 'run_A70');
    case 'run_A83':
    default:
      return generateTraceEvents(500, 'run_A83');
  }
}
