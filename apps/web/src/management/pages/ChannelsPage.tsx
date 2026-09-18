/**
 * @file apps/web/src/management/pages/ChannelsPage.tsx
 * Page 8: 渠道与集成 (Channels & Integrations)
 *
 * Implements Section 23 of DESIGN.md:
 * - Channels are entry points to the Personal Agent, not separate agents.
 * - Ingress and Delivery gates enforcement.
 */
import React, { useState } from 'react';
import { PageHeader } from '../primitives/PageHeader';
import { DataTable, type Column } from '../primitives/DataTable';
import { MasterDetail } from '../primitives/Tabs';
import { DetailRail, DetailSection, PairRow } from '../primitives/DetailRail';
import { StatusBadge } from '../primitives/StatusBadge';
import { EntityMark } from '../primitives/EntityMark';
import { useManagementChannels } from '../adapter';
import type { ChannelProjection } from '../types';

interface ChannelsPageProps {
  onNavigate: (pageId: string) => void;
}

export const ChannelsPage: React.FC<ChannelsPageProps> = () => {
  const { data: res, isLoading, isError, error } = useManagementChannels();
  const channels = res?.data || [];
  const [selectedId, setSelectedId] = useState<string | null>('chan_onebot_qq');

  const selectedChannel = channels.find((c) => c.id === selectedId);

  if (isLoading) {
    return (
      <div className="pageContainer">
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--metadata)' }}>
          加载渠道数据中...
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="pageContainer">
        <PageHeader
          title="渠道与集成 (Channels & Integrations)"
          description="渠道是同一 Personal Agent 的外部触点。审查 NapCat/OneBot 11 QQ 渠道入站策略与投递门禁审计。"
          capabilityState="已实现"
        />
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--danger)' }} role="alert">
          <strong>渠道数据加载失败</strong>: {error instanceof Error ? error.message : '无法获取渠道列表'}
        </div>
      </div>
    );
  }

  const columns: Column<ChannelProjection>[] = [
    {
      key: 'name',
      header: '渠道名称与适配器',
      render: (c) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <EntityMark kind="channel" size="sm" />
          <div>
            <div style={{ fontWeight: 600, color: 'var(--ink)' }}>{c.name}</div>
            <div className="mono" style={{ fontSize: 11, color: 'var(--metadata)' }}>{c.id}</div>
          </div>
        </div>
      ),
    },
    {
      key: 'status',
      header: '连接状态',
      render: (c) => (
        <StatusBadge variant={c.status === 'connected' ? 'ok' : c.status === 'reconnecting' ? 'warn' : 'neutral'}>
          {c.status === 'connected' ? '已连接' : c.status === 'reconnecting' ? '重连中' : '未连接'}
        </StatusBadge>
      ),
    },
    {
      key: 'target',
      header: '接入目标 Agent',
      render: (c) => <span style={{ fontSize: 12 }}>{c.targetAgent}</span>,
    },
    {
      key: 'events',
      header: '已处理消息',
      render: (c) => <span className="mono">{c.totalEventsProcessed.toLocaleString()} 次</span>,
    },
    {
      key: 'blocked',
      header: '拦截投递',
      render: (c) => (
        <span style={{ color: c.blockedDeliveriesCount > 0 ? 'var(--danger)' : 'var(--metadata)' }}>
          {c.blockedDeliveriesCount} 次
        </span>
      ),
    },
  ];

  return (
    <div className="pageContainer">
      <PageHeader
        title="渠道与集成 (Channels & Integrations)"
        description="渠道是同一 Personal Agent 的外部触点。审查 NapCat/OneBot 11 QQ 渠道入站策略与投递门禁审计。"
        capabilityState="已实现"
        customPill={{ text: 'QQ 渠道为 P3 核心', variant: 'warn' }}
      />

      <MasterDetail
        master={
          <DataTable
            data={channels}
            columns={columns}
            keyExtractor={(c) => c.id}
            selectedId={selectedId || undefined}
            onRowClick={(c) => setSelectedId(c.id)}
          />
        }
        detail={
          <DetailRail
            isOpen={!!selectedChannel}
            title={selectedChannel?.name || '渠道详情'}
            subtitle={selectedChannel?.id}
            onClose={() => setSelectedId(null)}
          >
            {selectedChannel && (
              <>
                <DetailSection title="门禁策略配置">
                  <PairRow label="入站策略" value={selectedChannel.ingressPolicy} />
                  <PairRow label="投递策略" value={selectedChannel.deliveryPolicy} />
                  <PairRow label="最后活跃事件" value={selectedChannel.lastEventAt} />
                </DetailSection>

                <DetailSection title={`近期门禁审计事件 (${selectedChannel.recentAuditLogs.length})`}>
                  {selectedChannel.recentAuditLogs.map((log) => (
                    <div
                      key={log.id}
                      style={{
                        padding: '8px 10px',
                        background: 'var(--sidebar)',
                        borderRadius: 'var(--radius-sm)',
                        border: '1px solid var(--line)',
                        marginBottom: 6,
                        fontSize: 11,
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                        <strong>{log.direction.toUpperCase()} · {log.action}</strong>
                        <StatusBadge variant={log.decision === 'ALLOW' ? 'ok' : 'bad'}>
                          {log.decision}
                        </StatusBadge>
                      </div>
                      <div className="mono" style={{ color: 'var(--metadata)' }}>
                        身份: {log.identity} · {log.timestamp}
                      </div>
                    </div>
                  ))}
                  {selectedChannel.recentAuditLogs.length === 0 && (
                    <span style={{ fontSize: 12, color: 'var(--metadata)' }}>无审计事件</span>
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
