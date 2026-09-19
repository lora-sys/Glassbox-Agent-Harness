/**
 * @file apps/web/src/management/fixtures/permissions.ts
 *
 * Implements Section 24 & 25 of DESIGN.md:
 * - Decision-first authorization rules (ALLOW, DENY, REQUIRES_APPROVAL)
 * - Four Hard Gates
 * - Interactive Decision Tester simulation
 */
import type { PermissionRuleProjection, DecisionTesterInput, DecisionTesterResult, ApprovalQueueProjection } from '../types';

export const mockApprovalQueueData: ApprovalQueueProjection[] = [
  {
    id: 'appr-001',
    resource: 'workspace:clean_reset',
    principal: 'owner_primary',
    action: 'execute',
    reason: '触发破坏性工作区重置门禁 (Hard Gate 2)',
    requestedAt: '10 分钟前',
    status: 'pending',
  },
  {
    id: 'appr-002',
    resource: 'channel:qq_group:admin_broadcast',
    principal: 'visitor_guest_99',
    action: 'deliver_audit_summary',
    reason: '访客申请向群广播审计摘要，受投递门禁保护',
    requestedAt: '35 分钟前',
    status: 'rejected',
  },
];

export const mockPermissionRules: PermissionRuleProjection[] = [
  {
    id: 'gate-01',
    principalPattern: '*',
    resourcePattern: '*',
    action: '*',
    decision: 'DENY',
    isHardGate: true,
    explanation: '硬门禁 1 (默认拒绝): 无显式 Grant 的任何访问均判定为 DENY。',
  },
  {
    id: 'gate-02',
    principalPattern: 'owner_primary',
    resourcePattern: 'workspace:clean_reset',
    action: 'execute',
    decision: 'REQUIRES_APPROVAL',
    isHardGate: true,
    explanation: '硬门禁 2 (破坏性操作): 涉及工作区重置或删除必须显式确认。',
  },
  {
    id: 'gate-03',
    principalPattern: 'visitor_*',
    resourcePattern: 'channel:qq_group:*',
    action: 'deliver_private_context',
    decision: 'DENY',
    isHardGate: true,
    explanation: '硬门禁 3 (投递隔离): 即使主体具备读取权限，也严禁向公共群投递私有数据。',
  },
  {
    id: 'rule-101',
    principalPattern: 'owner_primary',
    resourcePattern: 'workspace:*',
    action: 'read_write',
    decision: 'ALLOW',
    isHardGate: false,
    explanation: 'Owner 具备个人工作区完全读写权。',
  },
  {
    id: 'rule-102',
    principalPattern: 'worker_herdr_*',
    resourcePattern: 'workspace:designated_worktree',
    action: 'read_write',
    decision: 'ALLOW',
    isHardGate: false,
    explanation: 'Herdr Worker 仅限访问显式委派的独立 worktree。',
  },
];

export function evaluateMockDecision(input: DecisionTesterInput): DecisionTesterResult {
  // Hard Gate 2: Destructive workspace action
  if (
    input.action.includes('reset') ||
    input.action.includes('delete') ||
    input.resource.includes('reset') ||
    input.resource.includes('delete') ||
    input.resource.includes('destructive')
  ) {
    return {
      decision: 'REQUIRES_APPROVAL',
      matchedRuleId: 'gate-02',
      provenance: 'Hit Hard Gate 2 (Destructive Operation). Requires explicit Owner approval.',
      isSimulationOnly: true,
    };
  }

  // Delivery check: public channel delivery of private content
  if (input.channel.includes('group') && (input.resource.includes('private') || input.action.includes('private'))) {
    return {
      decision: 'DENY',
      matchedRuleId: 'gate-03',
      provenance: 'Hit Hard Gate 3 (Delivery Boundary). Actor reading does not permit delivering private data to group.',
      isSimulationOnly: true,
    };
  }

  // Owner unrestricted access
  if (input.principal === 'owner_primary' || input.principal.includes('owner')) {
    return {
      decision: 'ALLOW',
      matchedRuleId: 'rule-101',
      provenance: 'Matched policy rule-101: Owner unrestricted workspace permission.',
      isSimulationOnly: true,
    };
  }

  // Worker scoped access
  if (input.principal.includes('worker') && input.resource.includes('worktree')) {
    return {
      decision: 'ALLOW',
      matchedRuleId: 'rule-102',
      provenance: 'Matched policy rule-102: Scoped worktree access granted to worker.',
      isSimulationOnly: true,
    };
  }

  // Default DENY
  return {
    decision: 'DENY',
    matchedRuleId: 'gate-01',
    provenance: 'Hit Hard Gate 1 (Default Deny). No matching explicit grant found.',
    isSimulationOnly: true,
  };
}
