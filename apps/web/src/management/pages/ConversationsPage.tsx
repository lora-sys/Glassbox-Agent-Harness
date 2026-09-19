/**
 * @file apps/web/src/management/pages/ConversationsPage.tsx
 * Page 2: 会话 (Conversations) — MasterDetail Layout
 */
import React, { useState } from 'react';
import { PageHeader } from '../primitives/PageHeader';
import { FilterBar } from '../primitives/FilterBar';
import { DataTable, type Column } from '../primitives/DataTable';
import { MasterDetail } from '../primitives/Tabs';
import { DetailRail, DetailSection, PairRow } from '../primitives/DetailRail';
import { StatusBadge } from '../primitives/StatusBadge';
import { useManagementConversations, usePreferences } from '../adapter';
import type { ConversationProjection } from '../types';

interface ConversationsPageProps {
  onNavigate: (pageId: string, extraSearch?: Record<string, unknown>) => void;
  selectedId?: string;
  onSelectId?: (id: string | null) => void;
}

export const ConversationsPage: React.FC<ConversationsPageProps> = ({
  onNavigate,
  selectedId: propSelectedId,
  onSelectId,
}) => {
  const { data: res, isLoading, isError, error } = useManagementConversations();
  const { settings } = usePreferences();
  const conversations = res?.data || [];
  const [localSelectedId, setLocalSelectedId] = useState<string | null>(
    propSelectedId !== undefined ? propSelectedId : (conversations[0]?.id || 'conv_owner_main')
  );
  const [search, setSearch] = useState('');
  const [channelFilter, setChannelFilter] = useState('all');
  const [visibilityFilter, setVisibilityFilter] = useState('all');
  const [taskFilter, setTaskFilter] = useState('all');

  React.useEffect(() => {
    if (propSelectedId !== undefined) {
      setLocalSelectedId(propSelectedId);
    }
  }, [propSelectedId]);

  const effectiveId = propSelectedId !== undefined ? propSelectedId : localSelectedId;

  // Safe selection: if an ID is provided, ONLY match if found; otherwise null.
  const selectedConv = React.useMemo(() => {
    if (propSelectedId !== undefined) {
      if (!propSelectedId) return null;
      return conversations.find((c) => c.id === propSelectedId) ?? null;
    }
    if (!effectiveId) return null;
    return conversations.find((c) => c.id === effectiveId) ?? null;
  }, [conversations, propSelectedId, effectiveId]);

  const handleSelectConv = (id: string | null) => {
    setLocalSelectedId(id);
    onSelectId?.(id);
  };

  const filtered = conversations.filter((c) => {
    const matchesSearch =
      c.title.toLowerCase().includes(search.toLowerCase()) ||
      c.id.toLowerCase().includes(search.toLowerCase()) ||
      c.principalId.toLowerCase().includes(search.toLowerCase());
    const matchesChannel = channelFilter === 'all' || c.channel === channelFilter;
    const matchesVisibility =
      visibilityFilter === 'all' ||
      (visibilityFilter === 'private' && (c.visibility === 'private' || c.scope === 'private')) ||
      (visibilityFilter === 'shared' && (c.visibility === 'shared' || c.scope === 'group'));
    const matchesTask =
      taskFilter === 'all' ||
      (taskFilter === 'has_tasks' && c.tasksCount > 0) ||
      (taskFilter === 'no_tasks' && c.tasksCount === 0);
    return matchesSearch && matchesChannel && matchesVisibility && matchesTask;
  });

  if (isLoading) {
    return (
      <div className="pageContainer">
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--metadata)' }}>
          加载会话数据中...
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="pageContainer">
        <PageHeader
          title="会话"
          description="持久化会话清单。在此审查主体身份、渠道绑定、关联的 Run/Task 执行谱系及清洗后的会话投影。"
          capabilityState="已实现"
        />
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--danger)' }} role="alert">
          <strong>会话数据加载失败</strong>: {error instanceof Error ? error.message : '无法获取会话列表'}
        </div>
      </div>
    );
  }

  const columns: Column<ConversationProjection>[] = [
    {
      key: 'title',
      header: '会话标题 / 标识',
      render: (c) => (
        <div>
          <div style={{ fontWeight: 600, color: 'var(--ink)' }}>{c.title}</div>
          <div className="mono" style={{ fontSize: 11, color: 'var(--metadata)' }}>{c.id}</div>
        </div>
      ),
    },
    {
      key: 'principal',
      header: '主体 / 渠道',
      render: (c) => (
        <div>
          <span style={{ fontWeight: 500 }}>{c.principalId}</span>
          <div style={{ fontSize: 11, color: 'var(--metadata)' }}>
            {c.channel} · {c.scope === 'private' ? '私聊' : '群聊'}
          </div>
        </div>
      ),
    },
    {
      key: 'work',
      header: '关联工作',
      render: (c) => (
        <span style={{ fontSize: 12 }}>
          {c.runsCount} 次运行 · {c.tasksCount} 项任务
        </span>
      ),
    },
    {
      key: 'tokens',
      header: 'Token 消耗',
      render: (c) => <span className="mono">{c.totalTokens.toLocaleString()}</span>,
    },
    {
      key: 'lastActive',
      header: '最后活跃',
      render: (c) => <span style={{ color: 'var(--metadata)', fontSize: 12 }}>{c.lastActivityAt}</span>,
    },
  ];

  return (
    <div className="pageContainer">
      <PageHeader
        title="会话"
        description="持久化会话清单。在此审查主体身份、渠道绑定、关联的 Run/Task 执行谱系及清洗后的会话投影。"
        capabilityState="已实现"
        customPill={{
          text: res?.source === 'api' ? '实时接口' : '设计数据',
          variant: res?.source === 'api' ? 'ok' : 'neutral',
        }}
      />

      <FilterBar
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="搜索会话标题、ID 或主体..."
        selectOptions={[
          {
            id: 'channel',
            value: channelFilter,
            onChange: setChannelFilter,
            options: [
              { value: 'all', label: '全部渠道' },
              { value: 'web', label: 'Web Workbench' },
              { value: 'onebot_qq', label: 'OneBot 11 (QQ)' },
              { value: 'api', label: 'API 委派' },
            ],
          },
        ]}
        actions={
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button
              type="button"
              className={`btn sm ${visibilityFilter !== 'all' ? 'active' : 'secondary'}`}
              style={{ fontSize: 11, padding: '2px 8px' }}
              onClick={() =>
                setVisibilityFilter((prev) => (prev === 'all' ? 'private' : prev === 'private' ? 'shared' : 'all'))
              }
              title="切换可见性过滤 (全部 / 私聊 / 群聊)"
            >
              范围: {visibilityFilter === 'all' ? '全部' : visibilityFilter === 'private' ? '私聊' : '群聊'}
            </button>
            <button
              type="button"
              className={`btn sm ${taskFilter !== 'all' ? 'active' : 'secondary'}`}
              style={{ fontSize: 11, padding: '2px 8px' }}
              onClick={() =>
                setTaskFilter((prev) => (prev === 'all' ? 'has_tasks' : prev === 'has_tasks' ? 'no_tasks' : 'all'))
              }
              title="切换任务状态过滤 (全部 / 有派生任务 / 仅直接运行)"
            >
              任务: {taskFilter === 'all' ? '全部' : taskFilter === 'has_tasks' ? '有任务' : '无任务'}
            </button>
          </div>
        }
        resultCount={filtered.length}
      />

      <MasterDetail
        master={
          <DataTable
            data={filtered}
            columns={columns}
            keyExtractor={(c) => c.id}
            selectedId={selectedConv?.id}
            onRowClick={(c) => handleSelectConv(c.id)}
          />
        }
        detail={
          <DetailRail
            isOpen={!!selectedConv}
            title={selectedConv?.title || '会话详情'}
            subtitle={selectedConv?.id}
            onClose={() => handleSelectConv(null)}
            actions={
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  className="btn primary sm"
                  onClick={() => onNavigate('runs')}
                >
                  查看关联运行
                </button>
                <button
                  type="button"
                  className="btn secondary sm"
                  onClick={() => onNavigate('ops')}
                >
                  查看任务
                </button>
              </div>
            }
          >
            {selectedConv && (
              <>
                <DetailSection title="会话上下文">
                  <PairRow label="主体 ID" value={selectedConv.principalId} mono />
                  <PairRow label="接入渠道" value={selectedConv.channel} />
                  <PairRow label="渠道身份" value={selectedConv.channelIdentity} mono />
                  <PairRow label="会话范围" value={selectedConv.scope === 'private' ? '私聊' : '群聊'} />
                  <PairRow label="可见性" value={selectedConv.visibility} />
                  <PairRow label="PI 执行会话" value={selectedConv.piSessionId} mono />
                </DetailSection>

                <DetailSection title="执行谱系 (Execution Lineage)">
                  <div
                    style={{
                      background: 'var(--sidebar)',
                      padding: 10,
                      borderRadius: 'var(--radius-sm)',
                      fontSize: 11,
                      fontFamily: 'var(--font-mono)',
                      border: '1px solid var(--line)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4,
                    }}
                  >
                    <div>会话: <strong>{selectedConv.id}</strong></div>
                    <div style={{ color: 'var(--metadata)' }}>↓ 派生执行会话</div>
                    <div>PI 会话: <strong>{selectedConv.piSessionId}</strong></div>
                    <div style={{ color: 'var(--metadata)' }}>↓ 关联执行与工作</div>
                    <div>运行记录: <strong>{selectedConv.runsCount} 次运行</strong></div>
                    <div>派生任务: <strong>{selectedConv.tasksCount} 项任务</strong></div>
                  </div>
                </DetailSection>

                <DetailSection title="资源计量与真值">
                  <PairRow label="统计时间范围" value="未知（接口未上报）" />
                  <PairRow label="执行运行数" value={`${selectedConv.runsCount} 次`} />
                  <PairRow label="派生任务数" value={`${selectedConv.tasksCount} 项`} />
                  <PairRow label="Token 消耗" value={selectedConv.totalTokens.toLocaleString()} mono />
                  <PairRow label="Input Token" value="未知（接口未上报）" />
                  <PairRow label="Cache Read" value="未知（接口未上报）" />
                  <PairRow label="工具调用" value="未知（接口未上报）" />
                  {!(
                    settings?.unknownPricingDisplay === 'hide_cost' &&
                    (selectedConv.costStatus !== 'priced' || selectedConv.costUsd === null)
                  ) && (
                    <PairRow
                      label="费用预估"
                      value={
                        selectedConv.costStatus === 'priced' && selectedConv.costUsd !== null
                          ? `$${selectedConv.costUsd.toFixed(2)}`
                          : selectedConv.costStatus === 'unpriced'
                          ? '成本不可用'
                          : '未知'
                      }
                    />
                  )}
                  <PairRow label="24h Cost" value="未知（接口未提供时间分桶）" />
                  <PairRow label="最后活跃时间" value={selectedConv.lastActivityAt} />
                </DetailSection>

                <DetailSection title="安全脱敏会话投影">
                  <div
                    style={{
                      background: 'var(--sidebar)',
                      padding: 10,
                      borderRadius: 'var(--radius-sm)',
                      fontSize: 12,
                      color: 'var(--body)',
                      lineHeight: 1.5,
                      border: '1px solid var(--line)',
                    }}
                  >
                    {selectedConv.sanitizedSnippet}
                  </div>
                  {selectedConv.recentMessages.length > 0 && (
                    <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {selectedConv.recentMessages.map((msg) => (
                        <div
                          key={msg.id}
                          style={{
                            padding: '6px 8px',
                            background: msg.role === 'user' ? '#fff' : 'var(--sidebar)',
                            borderRadius: 'var(--radius-sm)',
                            border: '1px solid var(--line)',
                            fontSize: 11,
                          }}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--metadata)', marginBottom: 2 }}>
                            <strong>{msg.sender}</strong>
                            <span>{msg.timestamp}</span>
                          </div>
                          <div>{msg.text}</div>
                        </div>
                      ))}
                    </div>
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
