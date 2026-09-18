/**
 * @file apps/web/src/management/pages/RunsPage.tsx
 * Page 5: 运行记录 (Runs)
 */
import React, { useState } from 'react';
import { PageHeader } from '../primitives/PageHeader';
import { FilterBar } from '../primitives/FilterBar';
import { DataTable, type Column } from '../primitives/DataTable';
import { MasterDetail } from '../primitives/Tabs';
import { DetailRail, DetailSection, PairRow } from '../primitives/DetailRail';
import { StatusBadge } from '../primitives/StatusBadge';
import { EntityMark } from '../primitives/EntityMark';
import { useManagementRuns } from '../adapter';
import type { RunProjection } from '../types';

interface RunsPageProps {
  onNavigate: (pageId: string) => void;
}

export const RunsPage: React.FC<RunsPageProps> = ({ onNavigate }) => {
  const { data: res, isLoading, isError, error } = useManagementRuns();
  const runs = res?.data || [];
  const [selectedId, setSelectedId] = useState<string | null>('run_A83');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  const selectedRun = runs.find((r) => r.id === selectedId);

  const filtered = runs.filter((r) => {
    const matchesSearch = r.id.toLowerCase().includes(search.toLowerCase()) || r.summary.toLowerCase().includes(search.toLowerCase());
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

  return (
    <div className="pageContainer">
      <PageHeader
        title="运行记录 (Runs)"
        description="检索具体 Agent 运行实例。审查执行耗时、工具调用、产生交付物及关联任务绑定。"
        capabilityState="已实现"
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

      <MasterDetail
        master={
          <DataTable
            data={filtered}
            columns={columns}
            keyExtractor={(r) => r.id}
            selectedId={selectedId || undefined}
            onRowClick={(r) => setSelectedId(r.id)}
          />
        }
        detail={
          <DetailRail
            isOpen={!!selectedRun}
            title={selectedRun?.id || '运行详情'}
            subtitle={selectedRun?.summary}
            onClose={() => setSelectedId(null)}
            actions={
              <button
                type="button"
                className="btn primary sm"
                style={{ width: '100%' }}
                onClick={() => onNavigate('trace')}
              >
                跳转查看执行追踪 (Trace)
              </button>
            }
          >
            {selectedRun && (
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
                  <PairRow
                    label="预估费用"
                    value={selectedRun.costStatus === 'unpriced' ? '成本不可用' : '未知'}
                  />
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
                      <div style={{ fontWeight: 600, color: 'var(--ink)' }}>{art.name}</div>
                      <div className="mono" style={{ color: 'var(--metadata)', fontSize: 10, marginTop: 2 }}>
                        {art.uri} ({(art.sizeBytes / 1024).toFixed(1)} KB)
                      </div>
                    </div>
                  ))}
                  {selectedRun.artifacts.length === 0 && (
                    <span style={{ fontSize: 12, color: 'var(--metadata)' }}>无文件或补丁产物</span>
                  )}
                </DetailSection>
              </>
            )}
          </DetailRail>
        }
      />
    </div>
  );
};
