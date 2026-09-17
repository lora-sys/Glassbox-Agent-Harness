/**
 * @file apps/web/src/management/adapter.test.ts
 */
import { describe, it, expect } from 'vitest';
import { FixtureAdapter } from './adapter';
import { evaluateMockDecision } from './fixtures/permissions';

describe('Management Fixture Adapter & Data Honesty', () => {
  const adapter = new FixtureAdapter();

  it('declares fixture source explicitly with timestamp (no silent fallback)', async () => {
    const overview = await adapter.getOverview();
    expect(overview.source).toBe('fixture');
    expect(overview.fetchedAt).toBeTruthy();
    expect(overview.data.summary.activeConversations).toBe(4);
  });

  it('preserves unknown/unpriced cost without synthesizing fake $0.00', async () => {
    const overview = await adapter.getOverview();
    expect(overview.data.summary.todayCostStatus).toBe('unpriced');
    expect(overview.data.summary.todayCostUsd).toBeNull();

    for (const model of overview.data.piModelUsage) {
      if (model.costStatus === 'unpriced') {
        expect(model.costUsd).toBeNull();
      }
    }
  });

  it('provides comprehensive datasets for all 11 management domains', async () => {
    const [
      overview,
      conversations,
      tasks,
      principals,
      runs,
      traceRuns,
      piModels,
      channels,
      rules,
      monitor,
      settings,
    ] = await Promise.all([
      adapter.getOverview(),
      adapter.getConversations(),
      adapter.getTasks(),
      adapter.getPrincipals(),
      adapter.getRuns(),
      adapter.getTraceRuns(),
      adapter.getPiModels(),
      adapter.getChannels(),
      adapter.getPermissionRules(),
      adapter.getMonitorTelemetry(),
      adapter.getSettings(),
    ]);

    expect(overview.data).toBeDefined();
    expect(conversations.data.length).toBeGreaterThanOrEqual(4);
    expect(tasks.data.length).toBeGreaterThanOrEqual(4);
    expect(principals.data.length).toBeGreaterThanOrEqual(3);
    expect(runs.data.length).toBeGreaterThanOrEqual(4);
    expect(traceRuns.data.length).toBe(4);
    expect(piModels.data.length).toBe(3);
    expect(channels.data.length).toBe(3);
    expect(rules.data.length).toBe(5);
    expect(monitor.data[0].systemHealth).toBe('healthy');
    expect(settings.data.retentionDays).toBe(30);
  });

  it('strictly enforces the collaboration invariant: Herdr worker done ≠ Glassbox Task DONE', async () => {
    const tasksRes = await adapter.getTasks();
    const task218 = tasksRes.data.find((t) => t.id === 'task-218');
    expect(task218).toBeDefined();
    expect(task218?.herdrState).toBe('done'); // Herdr reports done
    expect(task218?.state).toBe('REVIEW');     // Glassbox Task truth remains REVIEW!
    expect(task218?.requiresReview).toBe(true);
  });

  it('evaluates decision-first authorization correctly in simulation mode', () => {
    // Hard Gate 2: Destructive operation
    const destructive = evaluateMockDecision({
      principal: 'owner_primary',
      resource: 'workspace:clean_reset',
      action: 'delete_all',
      channel: 'web',
      location: 'workbench',
    });
    expect(destructive.decision).toBe('REQUIRES_APPROVAL');
    expect(destructive.isSimulationOnly).toBe(true);

    // Hard Gate 3: Leak private context to public channel
    const deliveryLeak = evaluateMockDecision({
      principal: 'owner_primary',
      resource: 'channel:qq_group:8839210',
      action: 'deliver_private_keys',
      channel: 'onebot_qq_group',
      location: 'group',
    });
    expect(deliveryLeak.decision).toBe('DENY');

    // Hard Gate 1: Default Deny for unknown principal
    const unknown = evaluateMockDecision({
      principal: 'untrusted_stranger',
      resource: 'workspace:internal',
      action: 'read',
      channel: 'web',
      location: 'unknown',
    });
    expect(unknown.decision).toBe('DENY');
    expect(unknown.matchedRuleId).toBe('gate-01');

    // Owner unrestricted access
    const ownerNormal = evaluateMockDecision({
      principal: 'owner_primary',
      resource: 'workspace:git',
      action: 'commit',
      channel: 'web',
      location: 'workbench',
    });
    expect(ownerNormal.decision).toBe('ALLOW');
  });
});
