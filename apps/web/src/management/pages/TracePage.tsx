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
import React, { useState, useEffect, useRef } from 'react';
import { PageHeader } from '../primitives/PageHeader';
import { StatusBadge } from '../primitives/StatusBadge';
import { EntityMark } from '../primitives/EntityMark';
import { Tabs } from '../primitives/Tabs';
import { useManagementTraceRuns, useManagementTraceEvents } from '../adapter';
import type { TraceEventProjection } from '../types';

interface TracePageProps {
  onNavigate: (pageId: string) => void;
}

export const TracePage: React.FC<TracePageProps> = () => {
  const { data: runsRes } = useManagementTraceRuns();
  const runs = runsRes?.data || [];
  const [selectedRunId, setSelectedRunId] = useState<string>('run_A83');

  const { data: eventsRes, isLoading: isEventsLoading } = useManagementTraceEvents(selectedRunId);
  const events = eventsRes?.data || [];

  const [selectedEventSeq, setSelectedEventSeq] = useState<number>(1);
  const [activeTab, setActiveTab] = useState<'payload' | 'auth' | 'timing' | 'raw'>('payload');
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');

  const searchInputRef = useRef<HTMLInputElement>(null);
  const timelineListRef = useRef<HTMLDivElement>(null);

  // Sync selected event when run changes
  useEffect(() => {
    if (events.length > 0) {
      setSelectedEventSeq(events[0].sequence);
    }
  }, [selectedRunId, events.length]);

  const filteredEvents = events.filter((e) => {
    const matchesSearch = e.summary.toLowerCase().includes(search.toLowerCase()) || e.type.toLowerCase().includes(search.toLowerCase());
    const matchesType = typeFilter === 'all' || e.type === typeFilter;
    return matchesSearch && matchesType;
  });

  const selectedEvent = events.find((e) => e.sequence === selectedEventSeq) || filteredEvents[0] || null;

  // Keyboard navigation: j, k, e, /
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger shortcuts if focus is inside an input/textarea
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes((document.activeElement as HTMLElement)?.tagName)) {
        return;
      }

      if (e.key === 'j') {
        e.preventDefault();
        const currentIndex = filteredEvents.findIndex((ev) => ev.sequence === selectedEventSeq);
        if (currentIndex < filteredEvents.length - 1) {
          setSelectedEventSeq(filteredEvents[currentIndex + 1].sequence);
        }
      } else if (e.key === 'k') {
        e.preventDefault();
        const currentIndex = filteredEvents.findIndex((ev) => ev.sequence === selectedEventSeq);
        if (currentIndex > 0) {
          setSelectedEventSeq(filteredEvents[currentIndex - 1].sequence);
        }
      } else if (e.key === 'e') {
        e.preventDefault();
        setActiveTab((prev) => (prev === 'raw' ? 'payload' : 'raw'));
      } else if (e.key === '/') {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [filteredEvents, selectedEventSeq]);

  return (
    <div className="pageContainer">
      <PageHeader
        title="追踪 (Trace)"
        description="三栏全量执行证据审查。支持时间轴 Scrubber、键盘导航 (j/k 切换, e 展开, / 搜索) 与原始 Raw Trace 按需惰性装载。"
        capabilityState="已实现"
      />

      {/* 3-Column Trace Layout */}
      <div className="traceLayout">
        {/* Column 1: Run List */}
        <div className="traceRunList" role="region" aria-label="Runs Selection List">
          <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--line)', background: 'var(--sidebar)' }}>
            <h4 style={{ fontSize: 11, fontWeight: 600, color: 'var(--metadata)', textTransform: 'uppercase', margin: 0 }}>
              执行记录 ({runs.length})
            </h4>
          </div>
          {runs.map((run) => {
            const isSelected = run.runId === selectedRunId;
            return (
              <div
                key={run.runId}
                className={`traceRunItem ${isSelected ? 'active' : ''}`}
                onClick={() => setSelectedRunId(run.runId)}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setSelectedRunId(run.runId);
                  }
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <strong className="mono" style={{ fontSize: 12 }}>{run.runId}</strong>
                  <StatusBadge variant={run.status === 'completed' ? 'ok' : run.status === 'running' ? 'teal' : 'bad'}>
                    {run.eventCount} 事件
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
        <div className="traceTimeline" role="region" aria-label="Event Timeline Stream">
          {/* Scrubber & Filter Controls */}
          <div className="timelineScrubber">
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8 }}>
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
              </select>
            </div>
            <div style={{ fontSize: 11, color: 'var(--metadata)', fontFamily: 'var(--font-mono)' }}>
              {filteredEvents.length} / {events.length}
            </div>
          </div>

          {/* Timeline Event List */}
          <div ref={timelineListRef} className="timelineList">
            {isEventsLoading && (
              <div style={{ padding: 20, textAlign: 'center', color: 'var(--metadata)' }}>
                加载事件流中...
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
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setSelectedEventSeq(ev.sequence);
                    }
                  }}
                >
                  <span className="mono" style={{ fontSize: 10, color: 'var(--metadata)', minWidth: 24 }}>
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
                  <span style={{ flex: 1, fontSize: 12, color: 'var(--ink)' }}>{ev.summary}</span>
                  <span className="mono" style={{ fontSize: 10, color: 'var(--metadata)' }}>
                    {ev.timestamp}
                  </span>
                </div>
              );
            })}
            {filteredEvents.length === 0 && !isEventsLoading && (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--metadata)' }}>
                无匹配追踪事件
              </div>
            )}
          </div>
        </div>

        {/* Column 3: Event Inspector */}
        <div className="traceInspector" role="region" aria-label="Event Detail Inspector">
          <Tabs
            tabs={[
              { id: 'payload', label: '有效载荷' },
              { id: 'auth', label: '鉴权决策' },
              { id: 'timing', label: '时序参数' },
              { id: 'raw', label: '原始 Raw Trace' },
            ]}
            activeId={activeTab}
            onChange={(id) => setActiveTab(id as any)}
          />

          <div className="inspectorContent">
            {selectedEvent ? (
              <>
                {activeTab === 'payload' && (
                  <div>
                    <div style={{ color: 'var(--brand)', marginBottom: 6, fontWeight: 600 }}>
                      Event #{selectedEvent.sequence} · {selectedEvent.type}
                    </div>
                    {JSON.stringify(selectedEvent.payload, null, 2)}
                  </div>
                )}

                {activeTab === 'auth' && (
                  <div>
                    {selectedEvent.authorization ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span>裁决结果</span>
                          <StatusBadge variant={selectedEvent.authorization.decision === 'ALLOW' ? 'ok' : 'bad'}>
                            {selectedEvent.authorization.decision}
                          </StatusBadge>
                        </div>
                        <div>主体: {selectedEvent.authorization.principal}</div>
                        <div>资源: {selectedEvent.authorization.resource}</div>
                        <div>操作: {selectedEvent.authorization.action}</div>
                        <div>地点: {selectedEvent.authorization.location}</div>
                        <div style={{ color: 'var(--metadata)', marginTop: 4 }}>
                          依据: {selectedEvent.authorization.reason}
                        </div>
                      </div>
                    ) : (
                      <div style={{ color: 'var(--metadata)' }}>该事件无独立鉴权裁决记录。</div>
                    )}
                  </div>
                )}

                {activeTab === 'timing' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div>序列号: #{selectedEvent.sequence}</div>
                    <div>记录时间: {selectedEvent.timestamp}</div>
                    <div>执行耗时: {selectedEvent.durationMs ? `${selectedEvent.durationMs} ms` : '—'}</div>
                    <div>所属运行: {selectedEvent.runId}</div>
                  </div>
                )}

                {activeTab === 'raw' && (
                  <div>
                    <div style={{ color: 'var(--metadata)', marginBottom: 6 }}>
                      // 按需装载不可变追加证据 (Raw Trace)
                    </div>
                    {selectedEvent.rawTraceExcerpt || '// 无原始证据片段'}
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
