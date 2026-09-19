/**
 * @file apps/web/src/management/pages/TracePage.tsx
 * Page 6: 追踪 (Trace) — 3-Column Execution Evidence Inspector
 *
 * Implements:
 * - 3-column layout: Run List, Timeline with Scrubber, Inspector
 * - Scale tiers: 28, 100, 500, and 650+ events handling
 * - Keyboard shortcuts: 'j' (next), 'k' (prev), 'e' (expand/collapse), '/' (search)
 * - Raw Trace vs Timeline strict separation
 */
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { PageHeader } from '../primitives/PageHeader';
import { StatusBadge } from '../primitives/StatusBadge';
import { Tabs } from '../primitives/Tabs';
import {
  useManagementTraceRuns,
  useManagementTraceEvents,
  usePreferences,
  useManagementData,
} from '../adapter';
import type { TraceEventProjection } from '../types';

interface TracePageProps {
  onNavigate: (pageId: string, extra?: Record<string, unknown>) => void;
  selectedRunId?: string;
  onSelectRunId?: (runId?: string) => void;
}

export function isTraceKeyboardShortcutsGuarded(
  e: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean },
  activeEl: { tagName?: string; isContentEditable?: boolean } | null = null,
): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey) return true;
  if (
    activeEl &&
    (['INPUT', 'TEXTAREA', 'SELECT'].includes(activeEl.tagName || '') ||
      Boolean(activeEl.isContentEditable))
  ) {
    return true;
  }
  return false;
}

export const TracePage: React.FC<TracePageProps> = ({
  selectedRunId,
  onSelectRunId,
}) => {
  const { mode } = useManagementData();
  const {
    data: runsRes,
    isLoading: isRunsLoading,
    isError: isRunsError,
    error: runsError,
  } = useManagementTraceRuns();
  const { settings } = usePreferences();
  const isLive = mode === 'live' || runsRes?.source === 'api';
  const runs = runsRes?.data || [];

  const [localRunId, setLocalRunId] = useState<string | undefined>(selectedRunId);

  useEffect(() => {
    setLocalRunId(selectedRunId);
  }, [selectedRunId]);

  const effectiveRunId = selectedRunId !== undefined ? selectedRunId : localRunId;

  // Derive active run safely:
  // - If effectiveRunId is provided: ONLY select it if it exists in runs. Never select a wrong/unrelated entity on invalid id!
  // - If no effectiveRunId is provided: default to first available run if any.
  const activeRun = useMemo(() => {
    if (effectiveRunId !== undefined && effectiveRunId !== '') {
      return runs.find((r) => r.runId === effectiveRunId) ?? null;
    }
    return runs.length > 0 ? runs[0] : null;
  }, [runs, effectiveRunId]);

  const activeRunId = activeRun?.runId || '';

  const {
    data: eventsRes,
    isLoading: isEventsLoading,
    isError: isEventsError,
    error: eventsError,
  } = useManagementTraceEvents(activeRunId);
  const events = eventsRes?.data || [];

  const [selectedEventSeq, setSelectedEventSeq] = useState<number>(1);
  const [activeTab, setActiveTab] = useState<'summary' | 'usage' | 'raw'>('summary');
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [expandedEventSeq, setExpandedEventSeq] = useState<number | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<string>('');

  const searchInputRef = useRef<HTMLInputElement>(null);
  const timelineListRef = useRef<HTMLDivElement>(null);

  // Sync selected event when run changes
  useEffect(() => {
    if (events.length > 0) {
      setSelectedEventSeq(events[0].sequence);
    }
  }, [activeRunId, events.length]);

  const filteredEvents = useMemo(() => {
    const normalizedSearch = search.toLowerCase();
    return events.filter((event) => {
      const matchesSearch =
        event.summary.toLowerCase().includes(normalizedSearch) ||
        event.type.toLowerCase().includes(normalizedSearch);
      const matchesType = typeFilter === 'all' || event.type === typeFilter;
      return matchesSearch && matchesType;
    });
  }, [events, search, typeFilter]);

  const selectedEvent =
    filteredEvents.find((e) => e.sequence === selectedEventSeq) || filteredEvents[0] || null;

  useEffect(() => {
    if (filteredEvents.length > 0 && !filteredEvents.some((event) => event.sequence === selectedEventSeq)) {
      setSelectedEventSeq(filteredEvents[0].sequence);
    }
  }, [filteredEvents, selectedEventSeq]);

  // Scroll active event into the nearest visible part of .timelineList respecting prefers-reduced-motion
  useEffect(() => {
    if (!timelineListRef.current) return;
    const activeEl = timelineListRef.current.querySelector(
      '.timelineEventItem.active'
    ) as HTMLElement | null;
    if (activeEl) {
      const prefersReducedMotion =
        typeof window !== 'undefined' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      activeEl.scrollIntoView({
        block: 'nearest',
        behavior: prefersReducedMotion ? 'auto' : 'smooth',
      });
    }
  }, [selectedEventSeq]);

  // Keyboard navigation: j/k, arrows, Home/End, e, / (disabled when settings.enableTraceKeyboardShortcuts is false)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!settings?.enableTraceKeyboardShortcuts) {
        return;
      }

      // Guard modifiers and focused form elements
      if (isTraceKeyboardShortcutsGuarded(e, document.activeElement as HTMLElement | null)) {
        return;
      }

      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        const currentIndex = filteredEvents.findIndex((ev) => ev.sequence === selectedEventSeq);
        if (currentIndex < filteredEvents.length - 1) {
          setSelectedEventSeq(filteredEvents[currentIndex + 1].sequence);
        }
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        const currentIndex = filteredEvents.findIndex((ev) => ev.sequence === selectedEventSeq);
        if (currentIndex > 0) {
          setSelectedEventSeq(filteredEvents[currentIndex - 1].sequence);
        }
      } else if (e.key === 'Home') {
        if (filteredEvents.length > 0) {
          e.preventDefault();
          setSelectedEventSeq(filteredEvents[0].sequence);
        }
      } else if (e.key === 'End') {
        if (filteredEvents.length > 0) {
          e.preventDefault();
          setSelectedEventSeq(filteredEvents[filteredEvents.length - 1].sequence);
        }
      } else if (e.key === 'e') {
        e.preventDefault();
        if (selectedEvent) {
          setExpandedEventSeq((prev) => (prev === selectedEvent.sequence ? null : selectedEvent.sequence));
        }
      } else if (e.key === '/') {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [filteredEvents, selectedEvent, selectedEventSeq, settings?.enableTraceKeyboardShortcuts]);

  const selectedIndex = selectedEvent
    ? filteredEvents.findIndex((event) => event.sequence === selectedEvent.sequence)
    : -1;

  const getScreenedEvent = (event: TraceEventProjection) => ({
    id: event.id,
    runId: event.runId,
    sequence: event.sequence,
    timestamp: event.timestamp,
    type: event.type,
    summary: event.summary,
    durationMs: event.durationMs ?? null,
    authorization: event.authorization ?? null,
    payload: event.payload,
  });

  const copySelectedJson = async () => {
    if (!selectedEvent) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(getScreenedEvent(selectedEvent), null, 2));
      setCopyFeedback('已复制筛选后的事件 JSON');
    } catch {
      setCopyFeedback('复制失败');
    }
  };

  const exportScreenedJson = () => {
    const blob = new Blob(
      [JSON.stringify(filteredEvents.map(getScreenedEvent), null, 2)],
      { type: 'application/json' },
    );
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${activeRunId || 'trace'}-screened-events.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setCopyFeedback(`已导出 ${filteredEvents.length} 条筛选事件`);
  };

  const handleSelectRun = (runId: string) => {
    setLocalRunId(runId);
    onSelectRunId?.(runId);
  };

  if (isRunsLoading) {
    return (
      <div className="pageContainer">
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--metadata)' }}>
          加载执行追踪数据中...
        </div>
      </div>
    );
  }

  if (isRunsError) {
    return (
      <div className="pageContainer">
        <PageHeader
          title="追踪 (Trace)"
          description="三栏全量执行证据审查。支持时间轴 Scrubber、键盘导航 (j/k 切换, e 展开, / 搜索) 与原始 Raw Trace 按需惰性装载。"
          capabilityState="P3 目标"
          customPill={{ text: isLive ? '实时接口' : '设计数据', variant: isLive ? 'ok' : 'neutral' }}
        />
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--danger)' }} role="alert">
          <strong>追踪数据加载失败</strong>: {runsError instanceof Error ? runsError.message : '无法获取执行追踪数据'}
        </div>
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <div className="pageContainer">
        <PageHeader
          title="追踪 (Trace)"
          description="三栏全量执行证据审查。支持时间轴 Scrubber、键盘导航 (j/k 切换, e 展开, / 搜索) 与原始 Raw Trace 按需惰性装载。"
          capabilityState="已实现"
          customPill={{ text: isLive ? '实时接口' : '设计数据', variant: isLive ? 'ok' : 'neutral' }}
        />
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--metadata)' }}>
          暂无执行追踪记录 (No Trace Runs Available)
        </div>
      </div>
    );
  }

  return (
    <div className="pageContainer">
      <PageHeader
        title="追踪 (Trace)"
        description="三栏全量执行证据审查。支持时间轴 Scrubber、键盘导航 (j/k 切换, e 展开, / 搜索) 与原始 Raw Trace 按需惰性装载。"
        capabilityState="已实现"
        customPill={{ text: isLive ? '实时接口' : '设计数据', variant: isLive ? 'ok' : 'neutral' }}
      />

      {/* 3-Column Trace Layout */}
      <div className="traceLayout">
        {/* Column 1: Run List */}
        <div className="traceRunList" role="listbox" aria-label="Runs Selection List">
          <div
            style={{
              padding: '10px 12px',
              borderBottom: '1px solid var(--line)',
              background: 'var(--sidebar)',
            }}
          >
            <h4
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: 'var(--metadata)',
                textTransform: 'uppercase',
                margin: 0,
              }}
            >
              执行记录 ({runs.length})
            </h4>
          </div>
          {runs.map((run) => {
            const isSelected = run.runId === activeRunId;
            return (
              <div
                key={run.runId}
                className={`traceRunItem ${isSelected ? 'active' : ''}`}
                onClick={() => handleSelectRun(run.runId)}
                tabIndex={0}
                role="option"
                aria-selected={isSelected}
                aria-label={`选择运行 ${run.runId}`}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    handleSelectRun(run.runId);
                  }
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                >
                  <strong className="mono" style={{ fontSize: 12 }}>
                    {run.runId}
                  </strong>
                  <StatusBadge
                    variant={
                      run.status === 'completed'
                        ? 'ok'
                        : run.status === 'running'
                        ? 'teal'
                        : 'bad'
                    }
                  >
                    {run.eventCount != null ? `${run.eventCount} 事件` : '未知'}
                  </StatusBadge>
                </div>
                <div style={{ fontSize: 11, color: 'var(--secondary)' }}>
                  {run.model} · {(run.durationMs / 1000).toFixed(1)}s
                </div>
              </div>
            );
          })}
        </div>

        {/* Column 2: Timeline Stream & Scrubber */}
        <div className="traceTimeline" role="region" aria-label="Event Timeline Container">
          {/* Scrubber & Filter Controls */}
          <div className="timelineScrubber">
            <div style={{ flex: '1 1 320px', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 }}>
              <input
                ref={searchInputRef}
                type="search"
                className="filterInput"
                placeholder="搜索事件摘要或类型... (按 / 聚焦)"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                style={{ minHeight: 28, fontSize: 12, minWidth: 160 }}
              />
              <select
                className="filterSelect"
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value)}
                style={{ minHeight: 28, fontSize: 11 }}
                aria-label="Filter trace event types"
              >
                <option value="all">全部类型</option>
                <option value="authorization">鉴权 (authorization)</option>
                <option value="tool">工具 (tool)</option>
                <option value="ops">协作 (ops)</option>
                <option value="user">用户 (user)</option>
                <option value="assistant">回答 (assistant)</option>
                <option value="error">异常 (error)</option>
                <option value="system">系统 (system)</option>
                <option value="context">上下文 (context)</option>
                <option value="memory">记忆 (memory)</option>
                <option value="skill">技能 (skill)</option>
                <option value="thinking">思考 (thinking)</option>
                <option value="file">文件 (file)</option>
                <option value="test">测试 (test)</option>
                <option value="delivery">投递 (delivery)</option>
              </select>
            </div>
            <div className="timelineActions">
              <label className="timelineRangeLabel" htmlFor="trace-event-scrubber">
                事件 {selectedIndex >= 0 ? selectedIndex + 1 : 0} / {filteredEvents.length}
              </label>
              <input
                id="trace-event-scrubber"
                className="eventScrubber"
                type="range"
                min={1}
                max={Math.max(filteredEvents.length, 1)}
                value={Math.max(selectedIndex + 1, 1)}
                disabled={filteredEvents.length === 0}
                onChange={(event) => {
                  const next = filteredEvents[Number(event.target.value) - 1];
                  if (next) setSelectedEventSeq(next.sequence);
                }}
                aria-label="追踪事件 Scrubber"
              />
              <span className="timelineCount">{filteredEvents.length} / {events.length}</span>
              <button type="button" className="btn secondary sm" onClick={() => {
                const latest = filteredEvents[filteredEvents.length - 1];
                if (latest) setSelectedEventSeq(latest.sequence);
              }} disabled={filteredEvents.length === 0}>跳到最新</button>
              <button type="button" className="btn secondary sm" onClick={copySelectedJson} disabled={!selectedEvent}>复制 JSON</button>
              <button type="button" className="btn secondary sm" onClick={exportScreenedJson} disabled={filteredEvents.length === 0}>导出筛选 JSON</button>
            </div>
            {copyFeedback && <div className="timelineFeedback" role="status">{copyFeedback}</div>}
          </div>

          {/* Timeline Event List */}
          <div ref={timelineListRef} className="timelineList" role="listbox" aria-label="Event Timeline Stream">
            {isEventsLoading && (
              <div style={{ padding: 20, textAlign: 'center', color: 'var(--metadata)' }}>
                加载事件流中...
              </div>
            )}
            {isEventsError && (
              <div style={{ padding: 20, textAlign: 'center', color: 'var(--danger)' }} role="alert">
                <strong>事件流加载失败</strong>: {eventsError instanceof Error ? eventsError.message : '无法获取事件流数据'}
              </div>
            )}
            {filteredEvents.map((ev) => {
              const isSelected = selectedEvent?.sequence === ev.sequence;
              return (
                <div
                  key={ev.id}
                  className={`timelineEventItem ${isSelected ? 'active' : ''}`}
                  onClick={() => setSelectedEventSeq(ev.sequence)}
                  tabIndex={0}
                  role="option"
                  aria-selected={isSelected}
                  aria-expanded={expandedEventSeq === ev.sequence}
                  aria-label={`事件 #${ev.sequence} ${ev.type}`}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setSelectedEventSeq(ev.sequence);
                    }
                  }}
                >
                  <span
                    className="mono"
                    style={{ fontSize: 10, color: 'var(--metadata)', minWidth: 24 }}
                  >
                    #{ev.sequence}
                  </span>
                  <StatusBadge
                    variant={
                      ev.type === 'authorization'
                        ? 'warn'
                        : ev.type === 'error'
                        ? 'bad'
                        : ev.type === 'tool'
                        ? 'teal'
                        : 'neutral'
                    }
                  >
                    {ev.type}
                  </StatusBadge>
                  <span style={{ flex: 1, fontSize: 12, color: 'var(--ink)' }}>
                    {ev.summary}
                  </span>
                  <span className="mono" style={{ fontSize: 10, color: 'var(--metadata)' }}>
                    {ev.timestamp}
                  </span>
                  {expandedEventSeq === ev.sequence && (
                    <pre className="timelineEventExpanded">
                      {JSON.stringify(getScreenedEvent(ev).payload, null, 2)}
                    </pre>
                  )}
                </div>
              );
            })}
            {filteredEvents.length === 0 && !isEventsLoading && !isEventsError && (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--metadata)' }}>
                {!activeRun ? (effectiveRunId ? `未找到指定的运行记录 [${effectiveRunId}]` : '暂未选择任何运行记录') : '无匹配追踪事件'}
              </div>
            )}
          </div>
        </div>

        {/* Column 3: Event Inspector */}
        <div className="traceInspector" role="region" aria-label="Event Detail Inspector">
          <Tabs
            tabs={[
              { id: 'summary', label: '摘要' },
              { id: 'usage', label: '用量' },
              { id: 'raw', label: '原始' },
            ]}
            activeId={activeTab}
            onChange={(id) => setActiveTab(id as any)}
          />

          <div className="inspectorContent">
            {selectedEvent ? (
              <>
                {activeTab === 'summary' && (
                  <div className="traceSummaryGrid">
                    <div><span>事件</span><strong>#{selectedEvent.sequence} · {selectedEvent.type}</strong></div>
                    <div><span>Method</span><strong>{typeof selectedEvent.payload.method === 'string' ? selectedEvent.payload.method : '未知'}</strong></div>
                    <div><span>Kind</span><strong>{selectedEvent.type}</strong></div>
                    <div><span>说明</span><strong>{selectedEvent.summary}</strong></div>
                    <div><span>Conversation</span><strong>{activeRun?.conversationId || '未知'}</strong></div>
                    <div><span>Task</span><strong>{typeof selectedEvent.payload.taskId === 'string' ? selectedEvent.payload.taskId : '未知'}</strong></div>
                    <div><span>Run</span><strong>{selectedEvent.runId}</strong></div>
                    <div><span>Principal</span><strong>{selectedEvent.authorization?.principal || (typeof selectedEvent.payload.principal === 'string' ? selectedEvent.payload.principal : '未知')}</strong></div>
                    <div><span>Provenance</span><strong>{typeof selectedEvent.payload.provenance === 'string' ? selectedEvent.payload.provenance : '未知'}</strong></div>
                    <div><span>Screening</span><strong>{typeof selectedEvent.payload.screeningState === 'string' ? selectedEvent.payload.screeningState : '未知'}</strong></div>
                    <div><span>时间</span><strong>{selectedEvent.timestamp}</strong></div>
                    <div><span>耗时</span><strong>{selectedEvent.durationMs != null ? `${selectedEvent.durationMs} ms` : '未知'}</strong></div>
                  </div>
                )}

                {activeTab === 'usage' && (
                  <div className="traceSummaryGrid">
                    <div><span>Input Token</span><strong>{typeof selectedEvent.payload.inputTokens === 'number' ? selectedEvent.payload.inputTokens.toLocaleString() : '未知'}</strong></div>
                    <div><span>Output Token</span><strong>{typeof selectedEvent.payload.outputTokens === 'number' ? selectedEvent.payload.outputTokens.toLocaleString() : '未知'}</strong></div>
                    <div><span>Cache Read</span><strong>{typeof selectedEvent.payload.cacheReadTokens === 'number' ? selectedEvent.payload.cacheReadTokens.toLocaleString() : '未知'}</strong></div>
                    <div><span>Total Token</span><strong>{typeof selectedEvent.payload.totalTokens === 'number' ? selectedEvent.payload.totalTokens.toLocaleString() : '未知'}</strong></div>
                    <div><span>Cost</span><strong>{typeof selectedEvent.payload.costUsd === 'number' ? `$${selectedEvent.payload.costUsd.toFixed(4)}` : '成本不可用'}</strong></div>
                  </div>
                )}

                {activeTab === 'raw' && (
                  <div>
                    <div style={{ color: 'var(--metadata)', marginBottom: 6 }}>
                      {selectedEvent.rawTraceExcerpt
                        ? '// 按需装载的不可变追加原始证据 (Raw Trace)'
                        : '// 原始证据未由接口上报；以下为已筛选的 Timeline 事件载荷'}
                    </div>
                    {selectedEvent.rawTraceExcerpt || JSON.stringify(selectedEvent.payload, null, 2)}
                  </div>
                )}
              </>
            ) : (
              <div style={{ color: 'var(--metadata)' }}>选择左侧事件查看详细载荷</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
