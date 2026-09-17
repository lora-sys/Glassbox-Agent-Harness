/**
 * @file apps/web/src/management/fixtures/channels.ts
 */
import type { ChannelProjection } from '../types';

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
