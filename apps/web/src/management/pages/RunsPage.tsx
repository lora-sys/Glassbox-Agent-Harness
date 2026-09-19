/**
 * @file apps/web/src/management/pages/RunsPage.tsx
 * Page 5: 运行记录 (Runs)
 */
import React, { useState, useMemo } from 'react';
import { PageHeader } from '../primitives/PageHeader';
import { SummaryBar } from '../primitives/SummaryBar';
import { FilterBar } from '../primitives/FilterBar';
import { DataTable, type Column } from '../primitives/DataTable';
import { MasterDetail, Tabs, Notice } from '../primitives/Tabs';
import { DetailRail, DetailSection, PairRow } from '../primitives/DetailRail';
import { StatusBadge } from '../primitives/StatusBadge';
import { EntityMark } from '../primitives/EntityMark';
import { useManagementRuns, usePreferences } from '../adapter';
import type { RunProjection } from '../types';

interface RunsPageProps {
  onNavigate: (pageId: string, extra?: Record<string, unknown>) => void;
  selectedRunId?: string;
  onSelectRunId?: (runId?: string) => void;
}

export const RunsPage: React.FC<RunsPageProps> = ({
  onNavigate,
  selectedRunId,
  onSelectRunId,
}) => {
  const { data: res, isLoading, isError, error } = useManagementRuns();
  const { settings } = usePreferences();
  const runs = res?.data || [];

  const [localSelectedId, setLocalSelectedId] = useState<string | undefined>(selectedRunId);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [detailTab, setDetailTab] = useState<'summary' | 'files' | 'evidence'>('summary');

  React.useEffect(() => {
    setLocalSelectedId(selectedRunId);
  }, [selectedRunId]);

  const effectiveId = selectedRunId !== undefined ? selectedRunId : localSelectedId;

  const selectedRun = useMemo(() => {
    if (!effectiveId) return null;
    return runs.find((r) => r.id === effectiveId) ?? null;
  }, [runs, effectiveId]);

  const handleRowClick = (r: RunProjection) => {
    setLocalSelectedId(r.id);
    onSelectRunId?.(r.id);
  };

  const handleCloseDetail = () => {
    setLocalSelectedId(undefined);
    onSelectRunId?.(undefined);
  };

  const filtered = runs.filter((r) => {
    const matchesSearch =
      r.id.toLowerCase().includes(search.toLowerCase()) ||
      r.summary.toLowerCase().includes(search.toLowerCase());
    const matchesStatus = statusFilter === 'all' || r.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  if (isLoading) {
    return (
      <div className="pageContainer">
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--metadata)' }}>
          加载运行记录数据中...
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="pageContainer">
        <PageHeader
          title="运行记录 (Runs)"
          description="检索具体 Agent 运行实例。审查执行耗时、工具调用、产生交付物及关联任务绑定。"
          capabilityState="已实现"
        />
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--danger)' }} role="alert">
          <strong>运行数据加载失败</strong>: {error instanceof Error ? error.message : '无法获取运行记录'}
        </div>
      </div>
    );
  }

  const columns: Column<RunProjection>[] = [
    {
      key: 'id',
      header: '运行标识与摘要',
      render: (r) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <EntityMark kind="run" size="sm" />
          <div>
            <div style={{ fontWeight: 600, color: 'var(--ink)' }}>{r.id}</div>
            <div style={{ fontSize: 11, color: 'var(--metadata)' }}>{r.summary}</div>
          </div>
        </div>
      ),
    },
    {
      key: 'status',
      header: '运行状态',
      render: (r) => {
        let variant: 'ok' | 'warn' | 'bad' | 'neutral' | 'teal' = 'neutral';
        if (r.status === 'completed') variant = 'ok';
        else if (r.status === 'running') variant = 'teal';
        else if (r.status === 'failed') variant = 'bad';
        return <StatusBadge variant={variant}>{r.status.toUpperCase()}</StatusBadge>;
      },
    },
    {
      key: 'model',
      header: '模型核心',
      render: (r) => <span className="mono" style={{ fontSize: 12 }}>{r.modelId}</span>,
    },
    {
      key: 'duration',
      header: '耗时',
      render: (r) => <span className="mono">{(r.durationMs / 1000).toFixed(1)}s</span>,
    },
    {
      key: 'tools',
      header: '工具调用',
      render: (r) => <span>{r.toolsExecutedCount} 次</span>,
    },
    {
      key: 'tokens',
      header: 'Tokens',
      render: (r) => <span className="mono">{r.tokens.total.toLocaleString()}</span>,
    },
  ];

  const shouldHideCost =
    settings?.unknownPricingDisplay === 'hide_cost' &&
    selectedRun &&
    (selectedRun.costStatus === 'unpriced' || selectedRun.costStatus === 'unknown');

  return (
    <div className="pageContainer">
      <PageHeader
        title="运行记录 (Runs)"
        description="检索具体 Agent 运行实例。审查执行耗时、工具调用、产生交付物及关联任务绑定。"
        capabilityState="已实现"
        customPill={{
          text: res?.source === 'api' ? '实时接口' : '设计数据',
          variant: res?.source === 'api' ? 'ok' : 'neutral',
        }}
      />

      {/* Summary Bar */}
      <SummaryBar
        items={[
          {
            label: '当前列表运行数',
            value: runs.length,
            meta: '接口返回的运行实例条数（非 24 小时聚合指标）',
            mono: true,
          },
          {
            label: '执行成功率',
            value: runs.length > 0 ? `${Math.round((runs.filter((r) => r.status === 'completed').length / runs.length) * 100)}%` : '—',
            meta: `${runs.filter((r) => r.status === 'completed').length} 次成功 / ${runs.filter((r) => r.status === 'failed').length} 次失败`,
          },
          {
            label: '总 Token 消耗',
            value: `${(runs.reduce((sum, r) => sum + r.tokens.total, 0) / 1000).toFixed(1)}k`,
            meta: '提示词与补全总消耗',
            mono: true,
          },
          {
            label: '关联任务运行',
            value: runs.filter((r) => !!r.taskAttemptId).length,
            meta: '受托 TaskAttempt 绑定',
          },
        ]}
      />

      <FilterBar
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="搜索运行 ID、摘要或模型..."
        selectOptions={[
          {
            id: 'status',
            value: statusFilter,
            onChange: setStatusFilter,
            options: [
              { value: 'all', label: '全部状态' },
              { value: 'running', label: '运行中 (Running)' },
              { value: 'completed', label: '已完成 (Completed)' },
              { value: 'failed', label: '失败 (Failed)' },
            ],
          },
        ]}
        resultCount={filtered.length}
      />

      {effectiveId && !selectedRun && (
        <div style={{ marginBottom: 12 }}>
          <Notice variant="info">
            未找到指定运行 [{effectiveId}]
          </Notice>
        </div>
      )}

      <MasterDetail
        master={
          <DataTable
            data={filtered}
            columns={columns}
            keyExtractor={(r) => r.id}
            selectedId={selectedRun?.id || undefined}
            onRowClick={handleRowClick}
          />
        }
        detail={
          <DetailRail
            isOpen={!!selectedRun}
            title={selectedRun?.id || '运行详情'}
            subtitle={selectedRun?.summary}
            onClose={handleCloseDetail}
            actions={
              <button
                type="button"
                className="btn primary sm"
                style={{ width: '100%' }}
                onClick={() => {
                  if (selectedRun) {
                    onNavigate('trace', { runId: selectedRun.id });
                  } else {
                    onNavigate('trace');
                  }
                }}
              >
                跳转查看执行追踪 (Trace)
              </button>
            }
          >
            {selectedRun && (
              <>
                <Tabs
                  tabs={[
                    { id: 'summary', label: '摘要' },
                    { id: 'files', label: '文件与测试', badge: selectedRun.artifacts.length },
                    { id: 'evidence', label: '证据' },
                  ]}
                  activeId={detailTab}
                  onChange={(id) => setDetailTab(id as any)}
                />

                {detailTab === 'summary' && (
                  <>
                    <DetailSection title="运行元数据">
                      <PairRow label="所属会话" value={selectedRun.conversationId} mono />
                      <PairRow label="执行主体" value={selectedRun.principalId} mono />
                      <PairRow label="执行模型" value={selectedRun.modelId} />
                      <PairRow label="耗时" value={`${(selectedRun.durationMs / 1000).toFixed(1)}s`} mono />
                      <PairRow label="关联任务尝试" value={selectedRun.taskAttemptId || '—'} mono />
                    </DetailSection>

                    <DetailSection title="Token 计量与计费">
                      <PairRow label="提示词 Token" value={selectedRun.tokens.prompt.toLocaleString()} mono />
                      <PairRow label="补全 Token" value={selectedRun.tokens.completion.toLocaleString()} mono />
                      <PairRow label="总计 Token" value={selectedRun.tokens.total.toLocaleString()} mono />
                      {!shouldHideCost && (
                        <PairRow
                          label="预估费用"
                          value={
                            selectedRun.costStatus === 'priced' && selectedRun.costUsd !== null
                              ? `$${selectedRun.costUsd.toFixed(2)}`
                              : selectedRun.costStatus === 'unpriced'
                              ? '成本不可用'
                              : '未知'
                          }
                        />
                      )}
                    </DetailSection>

                    <DetailSection title={`生成交付物 (${selectedRun.artifacts.length})`}>
                      {selectedRun.artifacts.map((art, idx) => (
                        <div
                          key={idx}
                          style={{
                            padding: '6px 8px',
                            background: 'var(--sidebar)',
                            borderRadius: 'var(--radius-sm)',
                            border: '1px solid var(--line)',
                            marginBottom: 6,
                            fontSize: 11,
                          }}
                        >
                          <div style={{ fontWeight: 600, color: 'var(--ink)', marginBottom: 4 }}>{art.name}</div>
                          <PairRow label="产物 URI" value={art.uri} mono />
                          <PairRow label="大小" value={`${(art.sizeBytes / 1024).toFixed(1)} KB`} mono />
                        </div>
                      ))}
                      {selectedRun.artifacts.length === 0 && (
                        <span style={{ fontSize: 12, color: 'var(--metadata)' }}>无文件或补丁产物</span>
                      )}
                    </DetailSection>
                  </>
                )}

                {detailTab === 'files' && (
                  <DetailSection title={`交付物与测试验证 (${selectedRun.artifacts.length})`}>
                    {selectedRun.artifacts.map((art, idx) => (
                      <div
                        key={idx}
                        style={{
                          padding: '8px 10px',
                          background: 'var(--sidebar)',
                          borderRadius: 'var(--radius-sm)',
                          border: '1px solid var(--line)',
                          marginBottom: 8,
                          fontSize: 11,
                        }}
                      >
                        <div style={{ fontWeight: 600, color: 'var(--ink)', marginBottom: 4 }}>{art.name}</div>
                        <PairRow label="存储 URI" value={art.uri} mono />
                        <PairRow label="产物大小" value={`${(art.sizeBytes / 1024).toFixed(1)} KB`} mono />
                        <PairRow label="校验状态" value="未知（产物契约未上报校验和）" />
                      </div>
                    ))}
                    {selectedRun.artifacts.length === 0 && (
                      <span style={{ fontSize: 12, color: 'var(--metadata)' }}>无关联文件生成</span>
                    )}
                  </DetailSection>
                )}

                {detailTab === 'evidence' && (
                  <DetailSection title="原始追踪证据 (Raw Trace)">
                    <PairRow label="运行 ID" value={selectedRun.id} mono />
                    <PairRow
                      label="追踪状态"
                      value={selectedRun.traceId ? `Trace ID ${selectedRun.traceId}` : '未知'}
                      mono
                    />
                    <div style={{ fontSize: 11, color: 'var(--metadata)', marginTop: 4 }}>
                      Raw Trace 的存取位置由服务端证据存储决定，接口未上报持久化目的地。
                    </div>
                    <PairRow label="工具调用次数" value={`${selectedRun.toolsExecutedCount} 次`} />
                    <div style={{ marginTop: 12 }}>
                      <button
                        type="button"
                        className="btn secondary sm"
                        style={{ width: '100%' }}
                        onClick={() => onNavigate('trace', { runId: selectedRun.id })}
                      >
                        跳转查看事件时间轴与原始报文 (Trace)
                      </button>
                    </div>
                  </DetailSection>
                )}
              </>
            )}
          </DetailRail>
        }
      />
    </div>
  );
};
