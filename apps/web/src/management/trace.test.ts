/**
 * @file apps/web/src/management/trace.test.ts
 *
 * Trace scale and type coverage tests according to Section 15 & 16 of DESIGN_EVAL.md.
 */
import { describe, it, expect } from 'vitest';
import { generateTraceEvents, getTraceEventsForRun } from './fixtures/trace';
import type { TraceEventType } from './types';

describe('Trace Scale Tiers & Type Coverage', () => {
  it('supports the 28 semantic events minimal tier', () => {
    const events = getTraceEventsForRun('run_A79');
    expect(events.length).toBe(28);
    expect(events[0].sequence).toBe(1);
    expect(events[27].sequence).toBe(28);
  });

  it('supports the 100 semantic events standard tier', () => {
    const events = getTraceEventsForRun('run_A81');
    expect(events.length).toBe(100);
  });

  it('supports the 500 semantic events heavy tier', () => {
    const events = getTraceEventsForRun('run_A83');
    expect(events.length).toBe(500);
  });

  it('supports the >500 semantic events stress tier (650 events)', () => {
    const events = getTraceEventsForRun('run_A70');
    expect(events.length).toBe(650);
    expect(events[649].sequence).toBe(650);
  });

  it('covers all 14 mandatory trace types across generated events', () => {
    const events = generateTraceEvents(140, 'run_test_coverage');
    const coveredTypes = new Set<TraceEventType>(events.map((e) => e.type));

    const requiredTypes: TraceEventType[] = [
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

    for (const reqType of requiredTypes) {
      expect(coveredTypes.has(reqType), `Missing trace type: ${reqType}`).toBe(true);
    }
  });

  it('preserves immutable raw trace excerpts with valid JSON formatting', () => {
    const events = generateTraceEvents(50, 'run_raw_check');
    for (const ev of events) {
      expect(ev.rawTraceExcerpt).toBeDefined();
      const parsed = JSON.parse(ev.rawTraceExcerpt!);
      expect(parsed.seq).toBe(ev.sequence);
      expect(parsed.type).toBe(ev.type);
    }
  });
});
