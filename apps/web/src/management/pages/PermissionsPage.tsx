/**
 * @file apps/web/src/management/pages/PermissionsPage.tsx
 * Page 9: 权限 (Permissions & Hard Gates)
 *
 * Implements Section 24 & 25 of DESIGN.md:
 * - Decision-first architecture (ALLOW, DENY, REQUIRES_APPROVAL)
 * - Four Hard Gates
 * - Interactive Decision Tester (explicit simulation only)
 */
import React, { useState } from 'react';
import { PageHeader } from '../primitives/PageHeader';
import { DataTable, type Column } from '../primitives/DataTable';
import { MasterDetail } from '../primitives/Tabs';
import { DetailRail, DetailSection } from '../primitives/DetailRail';
import { StatusBadge } from '../primitives/StatusBadge';
import { EntityMark } from '../primitives/EntityMark';
import { useManagementPermissions } from '../adapter';
import { evaluateMockDecision } from '../fixtures/permissions';
import type { PermissionRuleProjection, DecisionTesterResult } from '../types';

interface PermissionsPageProps {
  onNavigate: (pageId: string) => void;
}

export const PermissionsPage: React.FC<PermissionsPageProps> = () => {
  const { data: res } = useManagementPermissions();
  const rules = res?.data || [];

  // Decision Tester Interactive Form State
  const [testerPrincipal, setTesterPrincipal] = useState('owner_primary');
  const [testerResource, setTesterResource] = useState('workspace:clean_reset');
  const [testerAction, setTesterAction] = useState('execute');
  const [testerChannel, setTesterChannel] = useState('web');
  const [simResult, setSimResult] = useState<DecisionTesterResult | null>(null);

  const handleRunSimulation = () => {
    const result = evaluateMockDecision({
      principal: testerPrincipal,
      resource: testerResource,
      action: testerAction,
      channel: testerChannel,
      location: 'local:workbench',
    });
    setSimResult(result);
  };

  const columns: Column<PermissionRuleProjection>[] = [
    {
      key: 'rule',
      header: '门禁 / 规则说明',
      render: (r) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <EntityMark kind="permission" size="sm" />
          <div>
            <div style={{ fontWeight: 600, color: 'var(--ink)' }}>{r.explanation}</div>
            <div className="mono" style={{ fontSize: 11, color: 'var(--metadata)' }}>{r.id}</div>
          </div>
        </div>
      ),
    },
    {
      key: 'decision',
      header: '裁决结果',
      render: (r) => {
        let variant: 'ok' | 'warn' | 'bad' = 'bad';
        if (r.decision === 'ALLOW') variant = 'ok';
        else if (r.decision === 'REQUIRES_APPROVAL') variant = 'warn';
        return <StatusBadge variant={variant}>{r.decision}</StatusBadge>;
      },
    },
    {
      key: 'principal',
      header: '主体模式',
      render: (r) => <span className="mono" style={{ fontSize: 11 }}>{r.principalPattern}</span>,
    },
    {
      key: 'resource',
      header: '资源模式',
      render: (r) => <span className="mono" style={{ fontSize: 11 }}>{r.resourcePattern}</span>,
    },
    {
      key: 'action',
      header: '动作',
      render: (r) => <span className="mono" style={{ fontSize: 11 }}>{r.action}</span>,
    },
  ];

  return (
    <div className="pageContainer">
      <PageHeader
        title="权限控制面 (Permissions)"
        description="判定优先 (Decision-First) 授权控制面。严格在代码层面执行 ALLOW / DENY / REQUIRES_APPROVAL 三值判定。"
        capabilityState="已实现"
        customPill={{ text: '未授权即拒绝 (Deny by Default)', variant: 'neutral' }}
      />

      {/* Four Hard Gates Display */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
        <div className="summaryItem">
          <span className="summaryItemLabel">硬门禁 1 · 默认拒绝</span>
          <strong style={{ fontSize: 14, color: 'var(--danger)' }}>DENY</strong>
          <span className="summaryItemMeta">无匹配 Grant 统一拒绝，防止误授权</span>
        </div>
        <div className="summaryItem">
          <span className="summaryItemLabel">硬门禁 2 · 破坏性操作</span>
          <strong style={{ fontSize: 14, color: 'var(--brand)' }}>REQUIRES_APPROVAL</strong>
          <span className="summaryItemMeta">删除工作区或重置分支必须经 Owner 显式批准</span>
        </div>
        <div className="summaryItem">
          <span className="summaryItemLabel">硬门禁 3 · 投递边界隔离</span>
          <strong style={{ fontSize: 14, color: 'var(--ink)' }}>STRICT DELIVERY</strong>
          <span className="summaryItemMeta">主体具备读取权限不代表允许投递至外部群聊</span>
        </div>
        <div className="summaryItem">
          <span className="summaryItemLabel">硬门禁 4 · 代码强制边界</span>
          <strong style={{ fontSize: 14, color: 'var(--success)' }}>CODE ENFORCED</strong>
          <span className="summaryItemMeta">安全边界必须在代码中硬性判定，严禁依赖 Prompt</span>
        </div>
      </div>

      <MasterDetail
        master={
          <div>
            <div style={{ marginBottom: 8, fontWeight: 600, fontSize: 14 }}>权限规则与系统门禁清单</div>
            <DataTable
              data={rules}
              columns={columns}
              keyExtractor={(r) => r.id}
            />
          </div>
        }
        detail={
          <DetailRail
            isOpen={true}
            title="决策模拟器 (Decision Tester)"
            subtitle="仅模拟判定，不修改真实系统规则"
            onClose={() => {}}
            actions={
              <button
                type="button"
                className="btn primary sm"
                style={{ width: '100%' }}
                onClick={handleRunSimulation}
              >
                执行裁决模拟计算
              </button>
            }
          >
            <DetailSection title="模拟输入参数">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div>
                  <label htmlFor="test-principal" style={{ fontSize: 11, color: 'var(--metadata)', display: 'block' }}>主体 (Principal)</label>
                  <input
                    id="test-principal"
                    type="text"
                    className="filterInput"
                    style={{ width: '100%' }}
                    value={testerPrincipal}
                    onChange={(e) => setTesterPrincipal(e.target.value)}
                  />
                </div>
                <div>
                  <label htmlFor="test-resource" style={{ fontSize: 11, color: 'var(--metadata)', display: 'block' }}>目标资源 (Resource)</label>
                  <input
                    id="test-resource"
                    type="text"
                    className="filterInput"
                    style={{ width: '100%' }}
                    value={testerResource}
                    onChange={(e) => setTesterResource(e.target.value)}
                  />
                </div>
                <div>
                  <label htmlFor="test-action" style={{ fontSize: 11, color: 'var(--metadata)', display: 'block' }}>意图动作 (Action)</label>
                  <input
                    id="test-action"
                    type="text"
                    className="filterInput"
                    style={{ width: '100%' }}
                    value={testerAction}
                    onChange={(e) => setTesterAction(e.target.value)}
                  />
                </div>
                <div>
                  <label htmlFor="test-channel" style={{ fontSize: 11, color: 'var(--metadata)', display: 'block' }}>交互渠道 (Channel)</label>
                  <select
                    id="test-channel"
                    className="filterSelect"
                    style={{ width: '100%' }}
                    value={testerChannel}
                    onChange={(e) => setTesterChannel(e.target.value)}
                  >
                    <option value="web">Web 控制台</option>
                    <option value="onebot_qq_group">QQ 群聊</option>
                    <option value="onebot_qq_private">QQ 私聊</option>
                  </select>
                </div>
              </div>
            </DetailSection>

            {simResult && (
              <DetailSection title="模拟裁决结论 (客户端离线模拟)">
                <div style={{ padding: 10, background: 'var(--sidebar)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--line)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <span style={{ fontSize: 11, color: 'var(--metadata)' }}>判定结果 (模拟推演)</span>
                    <StatusBadge
                      variant={
                        simResult.decision === 'ALLOW'
                          ? 'ok'
                          : simResult.decision === 'REQUIRES_APPROVAL'
                          ? 'warn'
                          : 'bad'
                      }
                    >
                      {simResult.decision}
                    </StatusBadge>
                  </div>
                  {simResult.matchedRuleId && (
                    <div style={{ fontSize: 11, color: 'var(--secondary)', marginBottom: 4 }}>
                      匹配门禁: <strong>{simResult.matchedRuleId}</strong>
                    </div>
                  )}
                  <div style={{ fontSize: 11, color: 'var(--body)', lineHeight: 1.4, marginBottom: 8 }}>
                    {simResult.provenance}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--metadata)', borderTop: '1px dashed var(--line)', paddingTop: 6 }}>
                    [设计模拟] 本结果仅基于前端内置策略矩阵离线推演，不代表服务端实时授权决策，未向服务端持久化任何授权判定记录。
                  </div>
                </div>
              </DetailSection>
            )}
          </DetailRail>
        }
      />
    </div>
  );
};
