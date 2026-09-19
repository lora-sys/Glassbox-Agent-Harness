/**
 * @file apps/web/src/management/pages/ChannelsPage.tsx
 * Page 8: 渠道与集成 (Channels & Integrations)
 *
 * Implements Section 23 of DESIGN.md & Section 18 of DESIGN_EVAL.md:
 * - Channels are external entry points to the Personal Agent, not separate agents.
 * - Ingress, Identity, Conversation, Tool, Delivery, and Trace gates remain inspectable.
 * - Catalog summary cards, channel contracts, identity mappings, QQ scenarios, and recent activity.
 */
import React, { useState, useEffect } from 'react';
import { PageHeader, SectionHeader } from '../primitives/PageHeader';
import { SummaryBar } from '../primitives/SummaryBar';
import { DataTable, type Column } from '../primitives/DataTable';
import { MasterDetail } from '../primitives/Tabs';
import { DetailRail, DetailSection, PairRow } from '../primitives/DetailRail';
import { StatusBadge } from '../primitives/StatusBadge';
import { EntityMark } from '../primitives/EntityMark';
import { useManagementChannels, useManagementData } from '../adapter';
import {
  mockChannelContracts,
  mockChannelIdentityMappings,
  mockChannelActivities,
} from '../fixtures/channels';
import type {
  ChannelProjection,
  ChannelContractProjection,
  ChannelIdentityMappingProjection,
  ChannelActivityProjection,
} from '../types';

interface ChannelsPageProps {
  onNavigate: (pageId: string, extraSearch?: Record<string, unknown>) => void;
}

export const ChannelsPage: React.FC<ChannelsPageProps> = ({ onNavigate }) => {
  const { data: res, isLoading, isError, error } = useManagementChannels();
  const { mode } = useManagementData();
  const isLive = mode === 'live' || res?.source === 'api';
  const channels = res?.data || [];
  const [selectedId, setSelectedId] = useState<string | null>('chan_onebot_qq');

  useEffect(() => {
    if (channels.length > 0) {
      setSelectedId((prev) => {
        if (prev && channels.some((c) => c.id === prev)) return prev;
        return channels[0].id;
      });
    } else {
      setSelectedId(null);
    }
  }, [channels]);

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
      render: (c) => (
        <span className="mono">
          {c.totalEventsProcessed != null ? `${c.totalEventsProcessed.toLocaleString()} 次` : '未知'}
        </span>
      ),
    },
    {
      key: 'blocked',
      header: '拦截投递',
      render: (c) => {
        if (c.blockedDeliveriesCount == null) {
          return <span style={{ color: 'var(--metadata)' }}>未知</span>;
        }
        return (
          <span style={{ color: c.blockedDeliveriesCount > 0 ? 'var(--danger)' : 'var(--metadata)' }}>
            {c.blockedDeliveriesCount} 次
          </span>
        );
      },
    },
  ];

  const contractColumns: Column<ChannelContractProjection>[] = [
    {
      key: 'channel',
      header: '渠道集成',
      render: (c) => <span style={{ fontWeight: 600 }}>{c.channel}</span>,
    },
    {
      key: 'kind',
      header: '类型',
      render: (c) => <span style={{ color: 'var(--metadata)', fontSize: 12 }}>{c.kind}</span>,
    },
    {
      key: 'ingress',
      header: '入站授权规则 (Ingress)',
      render: (c) => <span style={{ fontSize: 12 }}>{c.ingressRule}</span>,
    },
    {
      key: 'delivery',
      header: '投递审查门禁 (Delivery)',
      render: (c) => <span style={{ fontSize: 12 }}>{c.deliveryGate}</span>,
    },
    {
      key: 'activation',
      header: '激活规则',
      render: (c) => <span className="mono" style={{ fontSize: 11 }}>{c.activation}</span>,
    },
    {
      key: 'state',
      header: '合约状态',
      render: (c) => (
        <StatusBadge variant={c.state === 'active' ? 'ok' : 'neutral'}>
          {c.state === 'active' ? '生效中' : '未激活'}
        </StatusBadge>
      ),
    },
  ];

  const mappingColumns: Column<ChannelIdentityMappingProjection>[] = [
    {
      key: 'external',
      header: '外部渠道标识 (ChannelIdentity)',
      render: (m) => <span className="mono" style={{ fontWeight: 600 }}>{m.externalIdentity}</span>,
    },
    {
      key: 'channel',
      header: '接入渠道',
      render: (m) => <span style={{ fontSize: 12 }}>{m.channel}</span>,
    },
    {
      key: 'principal',
      header: '映射系统主体 (Principal)',
      render: (m) => <span className="mono" style={{ color: 'var(--brand)', fontSize: 12 }}>{m.mappedPrincipal}</span>,
    },
    {
      key: 'verified',
      header: '绑定认证',
      render: (m) => (
        <StatusBadge variant={m.verified ? 'ok' : 'warn'}>
          {m.verified ? '已认证绑定' : '未验证 (只读受控)'}
        </StatusBadge>
      ),
    },
    {
      key: 'time',
      header: '绑定时间',
      render: (m) => <span className="mono" style={{ fontSize: 11, color: 'var(--metadata)' }}>{m.boundAt}</span>,
    },
  ];

  const activityColumns: Column<ChannelActivityProjection>[] = [
    {
      key: 'channel',
      header: '渠道',
      render: (a) => <span style={{ fontWeight: 600, fontSize: 12 }}>{a.channel}</span>,
    },
    {
      key: 'direction',
      header: '流向',
      render: (a) => (
        <StatusBadge variant={a.direction === 'ingress' ? 'ok' : 'teal'}>
          {a.direction === 'ingress' ? '入站 (INGRESS)' : '投递 (DELIVERY)'}
        </StatusBadge>
      ),
    },
    {
      key: 'identity',
      header: '触发标识',
      render: (a) => <span className="mono" style={{ fontSize: 11 }}>{a.identity}</span>,
    },
    {
      key: 'action',
      header: '交互动作',
      render: (a) => <span style={{ fontSize: 12 }}>{a.action}</span>,
    },
    {
      key: 'decision',
      header: '门禁裁决',
      render: (a) => (
        <StatusBadge variant={a.decision === 'ALLOW' ? 'ok' : 'bad'}>
          {a.decision}
        </StatusBadge>
      ),
    },
    {
      key: 'time',
      header: '时间',
      render: (a) => <span className="mono" style={{ fontSize: 11, color: 'var(--metadata)' }}>{a.timestamp}</span>,
    },
  ];

  // Never collapse an unreported count into a measured 0: only sum known values and
  // disclose how many channels did not report.
  const eventKnownChannels = channels.filter((c) => c.totalEventsProcessed != null);
  const totalEvents = eventKnownChannels.reduce((acc, c) => acc + (c.totalEventsProcessed as number), 0);
  const eventUnknownCount = channels.length - eventKnownChannels.length;
  const blockedKnownChannels = channels.filter((c) => c.blockedDeliveriesCount != null);
  const totalBlocked = blockedKnownChannels.reduce(
    (acc, c) => acc + (c.blockedDeliveriesCount as number),
    0,
  );
  const blockedUnknownCount = channels.length - blockedKnownChannels.length;
  const connectedCount = channels.filter((c) => c.status === 'connected').length;

  return (
    <div className="pageContainer">
      <PageHeader
        title="渠道与集成 (Channels & Integrations)"
        description="渠道是同一 Personal Agent 的外部触点。审查 NapCat/OneBot 11 QQ 渠道入站策略与投递门禁审计。"
        capabilityState="已实现"
        customPill={{ text: isLive ? '实时接口' : '设计数据', variant: isLive ? 'ok' : 'neutral' }}
      />

      {/* SummaryBar */}
      <SummaryBar
        items={[
          {
            label: '已配置渠道',
            value: `${channels.length} 个`,
            meta: '外部协议网关适配器',
          },
          {
            label: '连接状态',
            value: `${connectedCount} 在线 / ${channels.length - connectedCount} 断开`,
            meta: isLive ? '来自 /manage/channels 实时连接状态' : 'NapCat QQ 与 Web 在线',
          },
          {
            label: '已处理消息总量',
            value:
              eventKnownChannels.length === 0
                ? '未知'
                : `${totalEvents.toLocaleString()} 次${eventUnknownCount > 0 ? ` (含 ${eventUnknownCount} 个未上报)` : ''}`,
            meta: '入站与出站交互汇总',
            mono: true,
          },
          {
            label: '投递门禁拦截',
            value:
              blockedKnownChannels.length === 0
                ? '未知'
                : `${totalBlocked} 次${blockedUnknownCount > 0 ? ` (含 ${blockedUnknownCount} 个未上报)` : ''}`,
            meta: '阅读权限不等于投递权限',
          },
        ]}
      />

      {/* Catalog Cards */}
      <div
        data-testid="channel-catalog-cards"
        style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}
      >
        <div
          style={{
            padding: '12px 14px',
            background: 'var(--surface)',
            border: '1px solid var(--line)',
            borderRadius: 'var(--radius-sm)',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--ink)' }}>Workbench Web</span>
            <StatusBadge variant="ok" className="sm">已连接</StatusBadge>
          </div>
          <div style={{ fontSize: 11, color: 'var(--metadata)' }}>本地管理控制台 · 具备完整检查与审计权限</div>
        </div>
        <div
          style={{
            padding: '12px 14px',
            background: 'var(--surface)',
            border: '1px solid var(--line)',
            borderRadius: 'var(--radius-sm)',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--ink)' }}>QQ / NapCat / OneBot 11</span>
            <StatusBadge state="P3 目标" className="sm">P3 目标</StatusBadge>
          </div>
          <div style={{ fontSize: 11, color: 'var(--metadata)' }}>群聊/私聊消息网关 · 强制门禁审查与脱敏投递</div>
        </div>
        <div
          style={{
            padding: '12px 14px',
            background: 'var(--surface)',
            border: '1px solid var(--line)',
            borderRadius: 'var(--radius-sm)',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--ink)' }}>未来扩展渠道 (Future Channels)</span>
            <StatusBadge state="后续" className="sm">后续</StatusBadge>
          </div>
          <div style={{ fontSize: 11, color: 'var(--metadata)' }}>邮件 (Email Bridge)、API 集成等规划渠道 · 保持同一 Personal Agent 触点与严格门禁</div>
        </div>
      </div>

      {/* Main Channel List & MasterDetail Rail */}
      <div>
        <SectionHeader
          title="渠道配置与连接清单"
          subtitle="选择渠道查看入站策略、身份解析链路与门禁审计日志"
        />
        <div style={{ marginTop: 8 }}>
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
                actions={
                  <button
                    type="button"
                    className="btn secondary sm"
                    style={{ width: '100%' }}
                    onClick={() => onNavigate('trace')}
                  >
                    查看该渠道相关 Trace 记录
                  </button>
                }
              >
                {selectedChannel && (
                  <>
                    <DetailSection title="门禁策略配置">
                      <PairRow label="入站策略" value={selectedChannel.ingressPolicy} />
                      <PairRow label="投递策略" value={selectedChannel.deliveryPolicy} />
                      <PairRow label="最后活跃事件" value={selectedChannel.lastEventAt || '—'} />
                      <PairRow
                        label="幂等去重"
                        value={
                          isLive
                            ? '未知（接口未上报去重配置）'
                            : '已启用 (重复消息/事件 ID 自动抑制)'
                        }
                      />
                    </DetailSection>

                    <DetailSection title="身份解析与访问控制">
                      <PairRow label="目标 Agent" value={selectedChannel.targetAgent} />
                      <PairRow
                        label="未知身份策略"
                        value="DENY (未知外部身份绝不继承 Owner 权限)"
                      />
                      <PairRow
                        label="安全不变量"
                        value="actor_can_read ≠ audience_can_receive"
                      />
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
      </div>

      {/* Channel Contracts Table */}
      <div>
        <SectionHeader
          title="渠道合约规范 (Channel Contracts)"
          subtitle="入站验证规则、投递脱敏要求与群组激活语义"
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
              marginTop: 8,
              fontSize: 12,
            }}
          >
            渠道合约注册表接口暂不可用 (P3 目标：需要动态渠道合约配置 API)
          </div>
        ) : (
          <div style={{ marginTop: 8 }}>
            <DataTable
              data={mockChannelContracts}
              columns={contractColumns}
              keyExtractor={(c) => c.id}
            />
          </div>
        )}
      </div>

      {/* Identity Mapping Table */}
      <div>
        <SectionHeader
          title="外部身份映射表 (Channel Identity Mappings)"
          subtitle="外部渠道账号严格解析为系统主体：ChannelIdentity → User → Principal"
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
              marginTop: 8,
              fontSize: 12,
            }}
          >
            外部身份映射接口暂不可用 (P3 目标：需要 ChannelIdentity 映射解析存储)
          </div>
        ) : (
          <div style={{ marginTop: 8 }}>
            <DataTable
              data={mockChannelIdentityMappings}
              columns={mappingColumns}
              keyExtractor={(m) => m.id}
            />
          </div>
        )}
      </div>

      {/* QQ Scenarios Verification Grid */}
      <div>
        <SectionHeader
          title="QQ 渠道场景化门禁规范 (QQ Scenarios Verification)"
          subtitle="根据 DESIGN_EVAL.md 第 18 节验证的 9 项硬门禁测试场景"
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
              marginTop: 8,
              fontSize: 12,
            }}
          >
            QQ 门禁场景裁决结果接口暂不可用 (P3 目标：需要实时入站/投递门禁决策上报)
          </div>
        ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 10, marginTop: 8 }}>
          <div style={{ padding: 10, background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 'var(--radius-sm)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <strong>1. Owner direct</strong>
              <StatusBadge variant="ok" className="sm">ALLOW</StatusBadge>
            </div>
            <div style={{ fontSize: 11, color: 'var(--metadata)', marginTop: 4 }}>所有者私聊，允许访问私有工作区与全量上下文</div>
          </div>
          <div style={{ padding: 10, background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 'var(--radius-sm)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <strong>2. Visitor direct</strong>
              <StatusBadge variant="teal" className="sm">RESTRICTED</StatusBadge>
            </div>
            <div style={{ fontSize: 11, color: 'var(--metadata)', marginTop: 4 }}>访客私聊，限制只读问答，禁止内部工具执行</div>
          </div>
          <div style={{ padding: 10, background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 'var(--radius-sm)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <strong>3. allowed group</strong>
              <StatusBadge variant="ok" className="sm">ALLOW</StatusBadge>
            </div>
            <div style={{ fontSize: 11, color: 'var(--metadata)', marginTop: 4 }}>允许的白名单 QQ 群，提供受控公开交互能力</div>
          </div>
          <div style={{ padding: 10, background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 'var(--radius-sm)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <strong>4. blocked group</strong>
              <StatusBadge variant="bad" className="sm">DENY</StatusBadge>
            </div>
            <div style={{ fontSize: 11, color: 'var(--metadata)', marginTop: 4 }}>非白名单群组，入站门禁主动拒绝，不加载模型上下文</div>
          </div>
          <div style={{ padding: 10, background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 'var(--radius-sm)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <strong>5. mentioned group</strong>
              <StatusBadge variant="ok" className="sm">ACTIVE</StatusBadge>
            </div>
            <div style={{ fontSize: 11, color: 'var(--metadata)', marginTop: 4 }}>群内显式 @Agent，触发正常激活处理流程</div>
          </div>
          <div style={{ padding: 10, background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 'var(--radius-sm)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <strong>6. not-mentioned group</strong>
              <StatusBadge variant="neutral" className="sm">IGNORED</StatusBadge>
            </div>
            <div style={{ fontSize: 11, color: 'var(--metadata)', marginTop: 4 }}>群消息未提及 Agent，静默忽略，不产生推理调用</div>
          </div>
          <div style={{ padding: 10, background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 'var(--radius-sm)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <strong>7. duplicate event</strong>
              <StatusBadge variant="warn" className="sm">SUPPRESSED</StatusBadge>
            </div>
            <div style={{ fontSize: 11, color: 'var(--metadata)', marginTop: 4 }}>重复 message_id 事件，幂等抑制，防止重复执行</div>
          </div>
          <div style={{ padding: 10, background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 'var(--radius-sm)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <strong>8. reconnect</strong>
              <StatusBadge variant="teal" className="sm">EXP_BACKOFF</StatusBadge>
            </div>
            <div style={{ fontSize: 11, color: 'var(--metadata)', marginTop: 4 }}>NapCat 断线后指数退避自动重连，保障服务弹性</div>
          </div>
          <div style={{ padding: 10, background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 'var(--radius-sm)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <strong>9. delivery deny</strong>
              <StatusBadge variant="bad" className="sm">BLOCKED</StatusBadge>
            </div>
            <div style={{ fontSize: 11, color: 'var(--metadata)', marginTop: 4 }}>包含私有差异或机密上下文时，投递门禁强制拦截外发</div>
          </div>
        </div>
        )}
      </div>

      {/* Recent Channel Activity Log */}
      <div>
        <SectionHeader
          title="近期渠道门禁事件审计 (Recent Channel Activity)"
          subtitle="记录各渠道出入站判定证据，保证每一步操作可回溯"
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
              marginTop: 8,
              fontSize: 12,
            }}
          >
            渠道出入站审计事件流暂不可用 (P3 目标：需要集中审计日志上报)
          </div>
        ) : (
          <div style={{ marginTop: 8 }}>
            <DataTable
              data={mockChannelActivities}
              columns={activityColumns}
              keyExtractor={(a) => a.id}
            />
          </div>
        )}
      </div>
    </div>
  );
};
