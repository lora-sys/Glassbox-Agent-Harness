/**
 * @file apps/web/src/management/pages/OpsPage.tsx
 * Page 3: 任务协作 (Task Collaboration / Agent Ops)
 *
 * Implements the core collaboration invariant:
 * Herdr worker 'done' ≠ Glassbox Task 'DONE'.
 */
import React, { useState } from 'react';
import { PageHeader, SectionHeader } from '../primitives/PageHeader';
import { SummaryBar } from '../primitives/SummaryBar';
import { FilterBar } from '../primitives/FilterBar';
import { DataTable, type Column } from '../primitives/DataTable';
import { MasterDetail } from '../primitives/Tabs';
import { DetailRail, DetailSection, PairRow } from '../primitives/DetailRail';
import { StatusBadge } from '../primitives/StatusBadge';
import { EntityMark } from '../primitives/EntityMark';
import { Notice } from '../primitives/Tabs';
import { useManagementTasks, useManagementData } from '../adapter';
import { mockLiveWorkersData } from '../fixtures/ops';
import type { TaskProjection, TaskState } from '../types';

interface OpsPageProps {
  onNavigate: (pageId: string, extra?: Record<string, unknown>) => void;
  selectedId?: string;
  onSelectId?: (id: string | null) => void;
}

export const OpsPage: React.FC<OpsPageProps> = ({
  onNavigate,
  selectedId: externalSelectedId,
  onSelectId,
}) => {
  const { data: res, isLoading, isError, error } = useManagementTasks();
  const { mode } = useManagementData();
  const isLive = mode === 'live' || res?.source === 'api';
  const [tasks, setTasks] = useState<TaskProjection[]>(res?.data || []);
  const [localSelectedId, setLocalSelectedId] = useState<string | null>(externalSelectedId || null);
  const [search, setSearch] = useState('');
  const [stateFilter, setStateFilter] = useState('all');
  const [feedbackNotice, setFeedbackNotice] = useState<string | null>(null);

  // Sync when query resolves
  React.useEffect(() => {
    if (res?.data) setTasks(res.data);
  }, [res?.data]);

  // Sync externalSelectedId from router search
  React.useEffect(() => {
    if (externalSelectedId !== undefined) {
      setLocalSelectedId(externalSelectedId);
    }
  }, [externalSelectedId]);

  const effectiveId = externalSelectedId !== undefined ? externalSelectedId : localSelectedId;

  // Derive selected task: ONLY select when ID exists in tasks.
  // Never let a missing or foreign ID select a wrong entity!
  const selectedTask = React.useMemo(() => {
    if (!effectiveId) return null;
    return tasks.find((t) => t.id === effectiveId) ?? null;
  }, [tasks, effectiveId]);

  const handleRowClick = (t: TaskProjection) => {
    setLocalSelectedId(t.id);
    onSelectId?.(t.id);
  };

  const handleCloseDetail = () => {
    setLocalSelectedId(null);
    onSelectId?.(null);
  };

  const filtered = tasks.filter((t) => {
    const matchesSearch = t.title.toLowerCase().includes(search.toLowerCase()) || t.id.toLowerCase().includes(search.toLowerCase());
    const matchesState = stateFilter === 'all' || t.state === stateFilter;
    return matchesSearch && matchesState;
  });

  if (isLoading) {
    return (
      <div className="pageContainer">
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--metadata)' }}>
          加载任务数据中...
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="pageContainer">
        <PageHeader
          title="任务协作 (Agent Ops)"
          description="管理 Glassbox 持久化任务真值、审查 Herdr 实时 Coding Worker 的现场执行事实，行使所有者验收或返工裁决权。"
          capabilityState="已实现"
        />
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--danger)' }} role="alert">
          <strong>任务数据加载失败</strong>: {error instanceof Error ? error.message : '无法获取任务协作数据'}
        </div>
      </div>
    );
  }

  // Explicit named actions: Accept Task
  const handleAcceptTask = (taskId: string) => {
    if (isLive) return;
    setTasks((prev) =>
      prev.map((t) =>
        t.id === taskId ? { ...t, state: 'DONE' as TaskState, requiresReview: false, attentionReason: undefined } : t
      )
    );
    setFeedbackNotice(`[设计模拟] 本地模拟接受任务 [${taskId}] 阶段产物，未连接服务端授权与持久化。`);
  };

  // Explicit named actions: Rework Task
  const handleReworkTask = (taskId: string) => {
    if (isLive) return;
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
    setFeedbackNotice(`[设计模拟] 本地模拟发起返工指令（保留 [${taskId}] 既往历史，本地尝试增加），未连接服务端持久化或 Worker 调度。`);
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
        customPill={{ text: isLive ? '实时接口' : '设计数据', variant: isLive ? 'ok' : 'neutral' }}
      />

      {/* Workload Summary Bar */}
      <SummaryBar
        items={[
          {
            label: '关注事项',
            value: tasks.filter((t) => t.requiresReview || t.herdrState === 'blocked').length,
            meta: '等待 Owner 介入处理',
          },
          {
            label: '运行中任务',
            value: tasks.filter((t) => t.state === 'RUNNING').length,
            meta: '外部 Worker 执行中',
            mono: true,
          },
          {
            label: '待验收任务',
            value: tasks.filter((t) => t.state === 'REVIEW').length,
            meta: 'Worker 已完成 (未验收)',
          },
          {
            label: '活跃 Worker',
            value: isLive ? '未知' : mockLiveWorkersData.length,
            meta: isLive ? 'Herdr 窗格接入暂不可用 (P3 目标)' : 'Herdr 窗格纳管中',
          },
          {
            label: '今日已完成',
            value: tasks.filter((t) => t.state === 'DONE').length,
            meta: '所有者已裁决验收',
            mono: true,
          },
        ]}
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
            selectedId={selectedTask?.id}
            onRowClick={handleRowClick}
          />
        }
        detail={
          <DetailRail
            isOpen={!!selectedTask}
            title={selectedTask?.title || '任务详情'}
            subtitle={selectedTask?.id}
            onClose={handleCloseDetail}
            actions={
              selectedTask ? (
                <div>
                  {isLive && (
                    <div
                      style={{
                        fontSize: 11,
                        color: 'var(--metadata)',
                        marginBottom: 8,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                      }}
                      role="note"
                    >
                      <StatusBadge state="P3 目标" className="sm">P3 目标</StatusBadge>
                      <span>任务变更接口暂不可用 (实时模式下禁止本地模拟变更任务真值)</span>
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {selectedTask.state === 'REVIEW' && (
                      <>
                        <button
                          type="button"
                          className="btn primary sm"
                          disabled={isLive}
                          title={isLive ? '任务接受接口暂不可用 (P3 目标)' : undefined}
                          onClick={() => !isLive && handleAcceptTask(selectedTask.id)}
                        >
                          接受结果 (Accept)
                        </button>
                        <button
                          type="button"
                          className="btn secondary sm"
                          disabled={isLive}
                          title={isLive ? '任务返工接口暂不可用 (P3 目标)' : undefined}
                          onClick={() => !isLive && handleReworkTask(selectedTask.id)}
                        >
                          要求返工 (Rework)
                        </button>
                      </>
                    )}
                    {(() => {
                      const currentAttempt = selectedTask.attempts.find(
                        (att) => att.attemptNo === selectedTask.currentAttemptNo,
                      );
                      const currentRunId = currentAttempt?.runId;
                      return (
                        <button
                          type="button"
                          className="btn secondary sm"
                          disabled={!currentRunId}
                          onClick={() => {
                            if (currentRunId) {
                              onNavigate('trace', { runId: currentRunId });
                            }
                          }}
                          aria-label={currentRunId ? `查看执行追踪 (${currentRunId})` : '无关联执行追踪'}
                        >
                          {currentRunId ? '查看完整执行追踪' : '无执行追踪 (P3 目标)'}
                        </button>
                      );
                    })()}
                    <button
                      type="button"
                      className="btn secondary sm"
                      disabled={isLive}
                      title={isLive ? 'worker_read 服务端执行接口暂不可用 (P3 目标)' : undefined}
                      onClick={() => {
                        if (isLive) return;
                        setFeedbackNotice(`[设计模拟] worker_read 仅读取任务 [${selectedTask.id}] 当前绑定的 Worker 观测，不修改 Task 真值。`);
                      }}
                    >
                      读取 Worker 状态 (worker_read)
                    </button>
                    <button
                      type="button"
                      className="btn secondary sm"
                      disabled={isLive}
                      title={isLive ? 'worker_prompt 服务端执行接口暂不可用 (P3 目标)' : undefined}
                      onClick={() => {
                        if (isLive) return;
                        setFeedbackNotice(`[设计模拟] worker_prompt 已进入本地预览，不会向任务 [${selectedTask.id}] 的 Worker 发送真实指令。`);
                      }}
                    >
                      Prompt Worker (worker_prompt)
                    </button>
                    <button
                      type="button"
                      className="btn danger sm"
                      disabled={isLive}
                      title={isLive ? '任务取消接口暂不可用 (P3 目标)' : undefined}
                      onClick={() => {
                        if (isLive) return;
                        setTasks((prev) =>
                          prev.map((t) => (t.id === selectedTask.id ? { ...t, state: 'CANCELED' } : t))
                        );
                        setFeedbackNotice(`[设计模拟] 本地模拟取消任务 [${selectedTask.id}]，未向服务端下发真实取消指令。`);
                      }}
                    >
                      取消任务
                    </button>
                  </div>
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

                {/* Worker Binding — Honest missing state if absent */}
                <DetailSection title="Herdr 物理工作区绑定">
                  {(() => {
                    const currentAttempt = selectedTask.attempts.find(
                      (att) => att.attemptNo === selectedTask.currentAttemptNo,
                    );
                    const currentBinding = currentAttempt?.workerBinding;
                    return currentBinding ? (
                      <>
                        <PairRow label="会话" value={currentBinding.herdrSession} />
                        <PairRow label="工作区" value={currentBinding.workspaceName} />
                        <PairRow label="终端窗格" value={currentBinding.paneName} mono />
                        <PairRow label="执行分支" value={currentBinding.branch} mono />
                        <PairRow label="Worker 属性" value={currentBinding.workerType} />
                      </>
                    ) : (
                      <span style={{ fontSize: 12, color: 'var(--metadata)' }}>
                        未绑定物理 Worker (无 WorkerBinding 记录)
                      </span>
                    );
                  })()}
                </DetailSection>
              </>
            )}
          </DetailRail>
        }
      />

      {/* Live Herdr Workers Section */}
      <div style={{ marginTop: 24 }}>
        <SectionHeader
          title="Herdr 实时执行 Worker"
          subtitle="外部 Coding Worker 的现场执行事实（核心原则：Worker 'done' ≠ 任务 'DONE'）"
          capabilityState={isLive ? 'P3 目标' : '设计数据'}
        />
        {isLive ? (
          <div
            style={{
              padding: 24,
              background: 'var(--surface)',
              border: '1px solid var(--line)',
              borderRadius: 'var(--radius-sm)',
              textAlign: 'center',
              color: 'var(--metadata)',
              marginTop: 12,
              fontSize: 12,
            }}
          >
            实时 Worker 纳管接口暂不可用 (P3 目标：需要 HerdrBridge 实时连接)
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
            {mockLiveWorkersData.map((w) => (
              <div
                key={w.id}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '10px 14px',
                  background: 'var(--surface)',
                  border: '1px solid var(--line)',
                  borderRadius: 'var(--radius-sm)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <EntityMark kind="worker" size="sm" />
                  <div>
                    <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--ink)' }}>{w.id}</span>
                    <div style={{ fontSize: 11, color: 'var(--metadata)' }}>
                      会话: {w.herdrSession} · 工作区: {w.workspaceName} · 窗格: <span className="mono">{w.paneName}</span>
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{ fontSize: 11, color: 'var(--metadata)' }}>心跳: {w.lastHeartbeat}</span>
                  <StatusBadge variant={w.state === 'working' ? 'teal' : w.state === 'done' ? 'ok' : 'warn'} className="sm">
                    {w.state}
                  </StatusBadge>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* HerdrBridge Reconciliation Flow */}
      <div style={{ marginTop: 24 }}>
        <SectionHeader
          title="HerdrBridge 状态对齐流程"
          subtitle="外部执行事实接入与控制面对齐机制 (4 步幂等闭环)"
          capabilityState={isLive ? 'P3 目标' : '设计数据'}
        />
        {isLive ? (
          <div
            style={{
              padding: 24,
              background: 'var(--surface)',
              border: '1px solid var(--line)',
              borderRadius: 'var(--radius-sm)',
              textAlign: 'center',
              color: 'var(--metadata)',
              marginTop: 12,
              fontSize: 12,
            }}
          >
            外部执行对齐流水线未接入 (P3 目标：待 Herdr 对齐事件总线打通)
          </div>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))',
              gap: 12,
              marginTop: 12,
            }}
          >
            <div style={{ padding: 12, background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 'var(--radius-sm)' }}>
              <div style={{ fontSize: 11, color: 'var(--metadata)', fontWeight: 600 }}>步骤 1</div>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', margin: '4px 0' }}>events.subscribe</div>
              <div style={{ fontSize: 11, color: 'var(--secondary)' }}>订阅 Herdr 生命周期事件与心跳广播</div>
            </div>
            <div style={{ padding: 12, background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 'var(--radius-sm)' }}>
              <div style={{ fontSize: 11, color: 'var(--metadata)', fontWeight: 600 }}>步骤 2</div>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', margin: '4px 0' }}>session.snapshot</div>
              <div style={{ fontSize: 11, color: 'var(--secondary)' }}>拉取工作区与窗格物理快照</div>
            </div>
            <div style={{ padding: 12, background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 'var(--radius-sm)' }}>
              <div style={{ fontSize: 11, color: 'var(--metadata)', fontWeight: 600 }}>步骤 3</div>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', margin: '4px 0' }}>reconcile</div>
              <div style={{ fontSize: 11, color: 'var(--secondary)' }}>对齐 TaskAttempt 与 WorkerBinding，绝不自动将 Task 标记为 DONE</div>
            </div>
            <div style={{ padding: 12, background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 'var(--radius-sm)' }}>
              <div style={{ fontSize: 11, color: 'var(--metadata)', fontWeight: 600 }}>步骤 4</div>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', margin: '4px 0' }}>consume</div>
              <div style={{ fontSize: 11, color: 'var(--secondary)' }}>持久化任务演进事实并投递 Attention 提醒</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
