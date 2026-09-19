/**
 * @file apps/web/src/management/fixtures/channels.ts
 */
import type {
  ChannelProjection,
  ChannelContractProjection,
  ChannelIdentityMappingProjection,
  ChannelActivityProjection,
} from '../types';

export const mockChannelsData: ChannelProjection[] = [
  {
    id: 'chan_onebot_qq',
    name: 'OneBot 11 (QQ 渠道网关 / NapCat)',
    type: 'onebot',
    status: 'connected',
    targetAgent: 'Glassbox Personal Agent (Main)',
    ingressPolicy: 'Strict allowlist for group / Owner direct pass',
    deliveryPolicy: 'Redact protected context before reply to group',
    totalEventsProcessed: 1420,
    blockedDeliveriesCount: 3,
    lastEventAt: '12 秒前',
    recentAuditLogs: [
      {
        id: 'aud_101',
        direction: 'ingress',
        identity: 'qq_3526039967',
        action: 'Direct Message',
        decision: 'ALLOW',
        timestamp: '15:18:22',
      },
      {
        id: 'aud_102',
        direction: 'delivery',
        identity: 'qq_group_member_441',
        action: 'Group Message Reply',
        decision: 'ALLOW',
        timestamp: '15:12:05',
      },
      {
        id: 'aud_103',
        direction: 'delivery',
        identity: 'qq_group_untrusted',
        action: 'Attempt to leak private diff',
        decision: 'DENY',
        timestamp: '14:20:11',
      },
    ],
  },
  {
    id: 'chan_web_admin',
    name: 'Web Workbench (本地与管理端交互)',
    type: 'web',
    status: 'connected',
    targetAgent: 'Glassbox Personal Agent (Main)',
    ingressPolicy: 'Authenticated Owner Session',
    deliveryPolicy: 'Full raw payload inspection allowed',
    totalEventsProcessed: 5120,
    blockedDeliveriesCount: 0,
    lastEventAt: '刚刚',
    recentAuditLogs: [
      {
        id: 'aud_201',
        direction: 'ingress',
        identity: 'web_session_8819',
        action: 'Open Management Console',
        decision: 'ALLOW',
        timestamp: '15:19:00',
      },
    ],
  },
  {
    id: 'chan_email_bridge',
    name: 'Email Integration (后续扩展)',
    type: 'email',
    status: 'disconnected',
    targetAgent: 'Glassbox Personal Agent',
    ingressPolicy: 'DKIM/SPF verification required',
    deliveryPolicy: 'PGP encryption optional',
    totalEventsProcessed: 0,
    blockedDeliveriesCount: 0,
    lastEventAt: '—',
    recentAuditLogs: [],
  },
];

export const mockChannelContracts: ChannelContractProjection[] = [
  {
    id: 'contract-qq',
    channel: 'OneBot 11 QQ (NapCat)',
    kind: 'Messaging Gateway',
    ingressRule: 'Strict allowlist for group / Owner direct pass',
    deliveryGate: 'Redact protected context before reply to group',
    activation: 'explicit @ mention or configured activation rule',
    state: 'active',
  },
  {
    id: 'contract-web',
    channel: 'Workbench Web',
    kind: 'Interactive UI',
    ingressRule: 'Authenticated Owner Session',
    deliveryGate: 'Full raw payload inspection allowed',
    activation: 'Direct user action',
    state: 'active',
  },
  {
    id: 'contract-email',
    channel: 'Email Integration',
    kind: 'Async Mailbox',
    ingressRule: 'DKIM/SPF verification required',
    deliveryGate: 'PGP encryption optional',
    activation: 'Inbox polling trigger',
    state: 'disconnected',
  },
];

export const mockChannelIdentityMappings: ChannelIdentityMappingProjection[] = [
  {
    id: 'map-qq-owner',
    channel: 'OneBot 11 QQ',
    externalIdentity: 'qq_3526039967',
    mappedPrincipal: 'owner_primary',
    verified: true,
    boundAt: '2026-03-10 10:00:00',
  },
  {
    id: 'map-qq-member',
    channel: 'OneBot 11 QQ',
    externalIdentity: 'qq_group_member_441',
    mappedPrincipal: 'visitor_guest_99',
    verified: true,
    boundAt: '2026-03-14 14:22:10',
  },
  {
    id: 'map-qq-untrusted',
    channel: 'OneBot 11 QQ',
    externalIdentity: 'qq_group_untrusted',
    mappedPrincipal: 'untrusted_anonymous',
    verified: false,
    boundAt: '2026-03-16 09:15:40',
  },
  {
    id: 'map-web-owner',
    channel: 'Workbench Web',
    externalIdentity: 'web_session_8819',
    mappedPrincipal: 'owner_primary',
    verified: true,
    boundAt: '2026-03-17 11:30:00',
  },
];

export const mockChannelActivities: ChannelActivityProjection[] = [
  {
    id: 'act-101',
    channel: 'OneBot 11 QQ',
    direction: 'ingress',
    identity: 'qq_3526039967',
    action: 'Direct Message',
    decision: 'ALLOW',
    timestamp: '15:18:22',
  },
  {
    id: 'act-102',
    channel: 'OneBot 11 QQ',
    direction: 'delivery',
    identity: 'qq_group_member_441',
    action: 'Group Message Reply',
    decision: 'ALLOW',
    timestamp: '15:12:05',
  },
  {
    id: 'act-103',
    channel: 'OneBot 11 QQ',
    direction: 'delivery',
    identity: 'qq_group_untrusted',
    action: 'Attempt to leak private diff',
    decision: 'DENY',
    timestamp: '14:20:11',
  },
  {
    id: 'act-104',
    channel: 'Workbench Web',
    direction: 'ingress',
    identity: 'web_session_8819',
    action: 'Open Management Console',
    decision: 'ALLOW',
    timestamp: '15:19:00',
  },
];
