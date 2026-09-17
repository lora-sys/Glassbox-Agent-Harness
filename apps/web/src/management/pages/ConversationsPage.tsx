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
import { useManagementConversations } from '../adapter';
import type { ConversationProjection } from '../types';

interface ConversationsPageProps {
  onNavigate: (pageId: string) => void;
}

export const ConversationsPage: React.FC<ConversationsPageProps> = ({ onNavigate }) => {
  const { data: res, isLoading } = useManagementConversations();
  const conversations = res?.data || [];
  const [selectedId, setSelectedId] = useState<string | null>(conversations[0]?.id || 'conv_owner_main');
  const [search, setSearch] = useState('');
  const [channelFilter, setChannelFilter] = useState('all');

  const selectedConv = conversations.find((c) => c.id === selectedId);

  const filtered = conversations.filter((c) => {
    const matchesSearch = c.title.toLowerCase().includes(search.toLowerCase()) || c.id.toLowerCase().includes(search.toLowerCase());
    const matchesChannel = channelFilter === 'all' || c.channel === channelFilter;
    return matchesSearch && matchesChannel;
  });

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
        resultCount={filtered.length}
      />

      <MasterDetail
        master={
          <DataTable
            data={filtered}
            columns={columns}
            keyExtractor={(c) => c.id}
            selectedId={selectedId || undefined}
            onRowClick={(c) => setSelectedId(c.id)}
          />
        }
        detail={
          <DetailRail
            isOpen={!!selectedConv}
            title={selectedConv?.title || '会话详情'}
            subtitle={selectedConv?.id}
            onClose={() => setSelectedId(null)}
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

                <DetailSection title="资源计量与真值">
                  <PairRow label="执行运行数" value={`${selectedConv.runsCount} 次`} />
                  <PairRow label="派生任务数" value={`${selectedConv.tasksCount} 项`} />
                  <PairRow label="Token 消耗" value={selectedConv.totalTokens.toLocaleString()} mono />
                  <PairRow
                    label="费用预估"
                    value={selectedConv.costStatus === 'unpriced' ? '成本不可用' : '—'}
                  />
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
