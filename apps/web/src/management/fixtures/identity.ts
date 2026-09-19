/**
 * @file apps/web/src/management/fixtures/identity.ts
 */
import type { PrincipalProjection } from '../types';

export const mockIdentityData: PrincipalProjection[] = [
  {
    id: 'owner_primary',
    userDisplayName: 'Owner (系统所有者)',
    role: 'owner',
    isVerified: true,
    channelIdentities: [
      { channel: 'web', channelIdentity: 'web_session_8819', identity: 'web_session_8819', boundAt: '2026-09-01', isVerified: true },
      { channel: 'onebot_qq', channelIdentity: 'qq_3526039967', identity: 'qq_3526039967', boundAt: '2026-09-05', isVerified: true },
    ],
    activeGrants: [
      'grant:system:full_control',
      'grant:ops:task_accept_rework',
      'grant:pi:model_override',
      'grant:workspace:all_access',
    ],
    delegationLimit: 'unrestricted',
    lastActiveAt: '刚刚',
    notes: '核心产品所有者，具备全权操作与最终验收裁决权。',
  },
  {
    id: 'visitor_guest_99',
    userDisplayName: 'QQ 访客 441',
    role: 'visitor',
    isVerified: false,
    channelIdentities: [
      { channel: 'onebot_qq', channelIdentity: 'qq_group_member_441', identity: 'qq_group_member_441', boundAt: '2026-09-17', isVerified: false },
    ],
    activeGrants: [
      'grant:conversation:read_public_response',
      'grant:system:status_query',
    ],
    delegationLimit: 'read_only_public_context',
    lastActiveAt: '1 小时前',
    notes: '公开群聊普通成员，受严格交付门禁隔离，禁止读取任何内部状态。',
  },
  {
    id: 'worker_herdr_04',
    userDisplayName: 'Herdr Worker 04 (Coding Specialist)',
    role: 'worker',
    isVerified: true,
    channelIdentities: [
      { channel: 'api', channelIdentity: 'herdr_pane_3_token', identity: 'herdr_pane_3_token', boundAt: '2026-09-17', isVerified: true },
    ],
    activeGrants: [
      'grant:workspace:read_write_designated_worktree',
      'grant:tests:execute_local_suite',
    ],
    delegationLimit: 'scoped_worktree:codex/fix-auth-cache-v2',
    lastActiveAt: '14 分钟前',
    notes: '受限委派执行 Worker。权限受到最小范围约束，不可访问其他工作区或外发网络。',
  },
];
