/**
 * @file apps/web/src/management/pages/OpsPage.tsx
 * Page 3: 任务协作 (Task Collaboration / Agent Ops)
 *
 * Implements the core collaboration invariant:
 * Herdr worker 'done' ≠ Glassbox Task 'DONE'.
 */
import React, { useState } from 'react';
import { PageHeader } from '../primitives/PageHeader';
import { FilterBar } from '../primitives/FilterBar';
import { DataTable, type Column } from '../primitives/DataTable';
import { MasterDetail } from '../primitives/Tabs';
import { DetailRail, DetailSection, PairRow } from '../primitives/DetailRail';
import { StatusBadge } from '../primitives/StatusBadge';
import { EntityMark } from '../primitives/EntityMark';
import { Notice } from '../primitives/Tabs';
import { useManagementTasks } from '../adapter';
import type { TaskProjection, TaskState } from '../types';

interface OpsPageProps {
  onNavigate: (pageId: string) => void;
}

export const OpsPage: React.FC<OpsPageProps> = ({ onNavigate }) => {
  const { data: res } = useManagementTasks();
  const [tasks, setTasks] = useState<TaskProjection[]>(res?.data || []);
  const [selectedId, setSelectedId] = useState<string | null>('task-218');
  const [search, setSearch] = useState('');
  const [stateFilter, setStateFilter] = useState('all');
  const [feedbackNotice, setFeedbackNotice] = useState<string | null>(null);

  // Sync when query resolves
  React.useEffect(() => {
    if (res?.data) setTasks(res.data);
  }, [res?.data]);

  const selectedTask = tasks.find((t) => t.id === selectedId);

  const filtered = tasks.filter((t) => {
    const matchesSearch = t.title.toLowerCase().includes(search.toLowerCase()) || t.id.toLowerCase().includes(search.toLowerCase());
    const matchesState = stateFilter === 'all' || t.state === stateFilter;
    return matchesSearch && matchesState;
  });

  // Explicit named actions: Accept Task
  const handleAcceptTask = (taskId: string) => {
    setTasks((prev) =>
      prev.map((t) =>
        t.id === taskId ? { ...t, state: 'DONE' as TaskState, requiresReview: false, attentionReason: undefined } : t
      )
    );
    setFeedbackNotice(`已授权接受任务 [${taskId}] 的阶段产物，任务状态流转为 DONE。`);
  };

  // Explicit named actions: Rework Task
  const handleReworkTask = (taskId: string) => {
    setTasks((prev) =>
      prev.map((t) => {
        if (t.id === taskId) {
          const nextAttemptNo = t.currentAttemptNo + 1;
          return {
            ...t,
            state: 'RUNNING' as TaskState,
            currentAttemptNo: nextAttemptNo,
            requiresReview: false,
            attentionReason: 'Owner 已发起返工，执行第 ' + nextAttemptNo + ' 轮迭代',
          };
        }
        return t;
      })
    );
    setFeedbackNotice(`已下发返工指令：保留 [${taskId}] 既往历史，创建第 3 次尝试。`);
  };

  const columns: Column<TaskProjection>[] = [
    {
      key: 'title',
      header: '任务标识与标题',
      render: (t) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <EntityMark kind="task" size="sm" />
          <div>
            <div style={{ fontWeight: 600, color: 'var(--ink)' }}>{t.title}</div>
            <div className="mono" style={{ fontSize: 11, color: 'var(--metadata)' }}>{t.id}</div>
          </div>
        </div>
      ),
    },
    {
      key: 'truth',
      header: 'Glassbox 任务真值',
      render: (t) => {
        let variant: 'ok' | 'warn' | 'bad' | 'neutral' | 'teal' = 'neutral';
        if (t.state === 'DONE') variant = 'ok';
        else if (t.state === 'REVIEW') variant = 'warn';
        else if (t.state === 'RUNNING') variant = 'teal';
        else if (t.state === 'FAILED') variant = 'bad';
        return <StatusBadge variant={variant}>{t.state}</StatusBadge>;
      },
    },
    {
      key: 'herdr',
      header: 'Herdr 现场状态',
      render: (t) => (
        <div>
          <span className="mono" style={{ fontWeight: 500 }}>
            {t.herdrState}
          </span>
          <div style={{ fontSize: 10, color: 'var(--metadata)' }}>{t.herdrObservationMeta}</div>
        </div>
      ),
    },
    {
      key: 'priority',
      header: '优先级',
      render: (t) => <span style={{ textTransform: 'uppercase', fontSize: 11 }}>{t.priority}</span>,
    },
    {
      key: 'attempts',
      header: '尝试次数',
      render: (t) => <span className="mono">#{t.currentAttemptNo}</span>,
    },
  ];

  return (
    <div className="pageContainer">
      <PageHeader
        title="任务协作 (Agent Ops)"
        description="管理 Glassbox 持久化任务真值、审查 Herdr 实时 Coding Worker 的现场执行事实，行使所有者验收或返工裁决权。"
        capabilityState="已实现"
      />

      {feedbackNotice && (
        <Notice variant="warn">
          {feedbackNotice}
          <button
            type="button"
            style={{ marginLeft: 12, background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}
            onClick={() => setFeedbackNotice(null)}
          >
            知道了
          </button>
        </Notice>
      )}

      <FilterBar
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="搜索任务 ID 或标题..."
        selectOptions={[
          {
            id: 'state',
            value: stateFilter,
            onChange: setStateFilter,
            options: [
              { value: 'all', label: '全部状态' },
              { value: 'REVIEW', label: '待验收 (REVIEW)' },
              { value: 'RUNNING', label: '执行中 (RUNNING)' },
              { value: 'WAITING_INPUT', label: '等待输入 (WAITING_INPUT)' },
              { value: 'DONE', label: '已完成 (DONE)' },
              { value: 'QUEUED', label: '排队中 (QUEUED)' },
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
            keyExtractor={(t) => t.id}
            selectedId={selectedId || undefined}
            onRowClick={(t) => setSelectedId(t.id)}
          />
        }
        detail={
          <DetailRail
            isOpen={!!selectedTask}
            title={selectedTask?.title || '任务详情'}
            subtitle={selectedTask?.id}
            onClose={() => setSelectedId(null)}
            actions={
              selectedTask ? (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {selectedTask.state === 'REVIEW' && (
                    <>
                      <button
                        type="button"
                        className="btn primary sm"
                        onClick={() => handleAcceptTask(selectedTask.id)}
                      >
                        接受结果 (Accept)
                      </button>
                      <button
                        type="button"
                        className="btn secondary sm"
                        onClick={() => handleReworkTask(selectedTask.id)}
                      >
                        要求返工 (Rework)
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className="btn secondary sm"
                    onClick={() => onNavigate('trace')}
                  >
                    查看追踪
                  </button>
                  <button
                    type="button"
                    className="btn danger sm"
                    onClick={() => {
                      setTasks((prev) =>
                        prev.map((t) => (t.id === selectedTask.id ? { ...t, state: 'CANCELED' } : t))
                      );
                      setFeedbackNotice(`已取消任务 [${selectedTask.id}]。`);
                    }}
                  >
                    取消任务
                  </button>
                </div>
              ) : null
            }
          >
            {selectedTask && (
              <>
                {/* Core Invariant State Comparison Card */}
                <div className="stateComparison">
                  <div className="stateCompareRow">
                    <label>Glassbox 任务真值 (控制面裁决)</label>
                    <strong style={{ color: selectedTask.state === 'DONE' ? 'var(--success)' : 'var(--brand)' }}>
                      {selectedTask.state}
                    </strong>
                    <span>
                      {selectedTask.state === 'REVIEW'
                        ? 'Herdr 报告已完成，等待 Owner 验收裁决。'
                        : selectedTask.state === 'DONE'
                        ? '已完成人工验收，持久化为完成态。'
                        : '执行协作推进中。'}
                    </span>
                  </div>
                  <div className="stateCompareRow" style={{ borderTop: '1px solid var(--line)', paddingTop: 6 }}>
                    <label>Herdr 实时执行事实 (外部观测)</label>
                    <strong className="mono">{selectedTask.herdrState}</strong>
                    <span>{selectedTask.herdrObservationMeta}</span>
                  </div>
                </div>

                {/* Execution Attempts */}
                <DetailSection title={`执行尝试历史 (${selectedTask.attempts.length} 次)`}>
                  {selectedTask.attempts.map((att) => (
                    <div
                      key={att.attemptNo}
                      style={{
                        padding: '8px 10px',
                        background: 'var(--sidebar)',
                        borderRadius: 'var(--radius-sm)',
                        border: '1px solid var(--line)',
                        marginBottom: 8,
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                        <strong>第 #{att.attemptNo} 次尝试</strong>
                        <StatusBadge variant={att.status === 'COMPLETED' ? 'ok' : 'bad'}>
                          {att.status}
                        </StatusBadge>
                      </div>
                      <PairRow label="关联运行" value={att.runId} mono />
                      <PairRow label="测试通过率" value={`${att.testResults.passed} / ${att.testResults.total}`} />
                      <PairRow label="执行耗时" value={`${(att.durationMs / 1000).toFixed(1)}s`} mono />
                      {att.artifactUri && <PairRow label="产物 URI" value={att.artifactUri} mono />}
                    </div>
                  ))}
                  {selectedTask.attempts.length === 0 && (
                    <span style={{ fontSize: 12, color: 'var(--metadata)' }}>尚无执行尝试记录</span>
                  )}
                </DetailSection>

                {/* Worker Binding */}
                {selectedTask.attempts[0]?.workerBinding && (
                  <DetailSection title="Herdr 物理工作区绑定">
                    <PairRow label="会话" value={selectedTask.attempts[0].workerBinding.herdrSession} />
                    <PairRow label="工作区" value={selectedTask.attempts[0].workerBinding.workspaceName} />
                    <PairRow label="终端窗格" value={selectedTask.attempts[0].workerBinding.paneName} mono />
                    <PairRow label="执行分支" value={selectedTask.attempts[0].workerBinding.branch} mono />
                    <PairRow label="Worker 属性" value={selectedTask.attempts[0].workerBinding.workerType} />
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
