/**
 * @file apps/web/src/management/pages/PermissionsPage.tsx
 * Page 9: 权限 (Permissions & Hard Gates)
 *
 * Implements Section 24 & 25 of DESIGN.md:
 * - Decision-first architecture (ALLOW, DENY, REQUIRES_APPROVAL)
 * - Four Hard Gates
 * - Interactive Decision Tester (explicit simulation only)
 */
import React, { useState, useEffect } from 'react';
import { useSearch } from '@tanstack/react-router';
import { PageHeader, SectionHeader } from '../primitives/PageHeader';
import { DataTable, type Column } from '../primitives/DataTable';
import { MasterDetail, Notice } from '../primitives/Tabs';
import { DetailRail, DetailSection } from '../primitives/DetailRail';
import { StatusBadge } from '../primitives/StatusBadge';
import { EntityMark } from '../primitives/EntityMark';
import { useManagementPermissions, useManagementData } from '../adapter';
import { evaluateMockDecision, mockApprovalQueueData } from '../fixtures/permissions';
import type { PermissionRuleProjection, DecisionTesterResult } from '../types';

interface PermissionsPageProps {
  onNavigate: (pageId: string, extra?: Record<string, unknown>) => void;
  selectedId?: string;
  testPrincipal?: string;
}

export const PermissionsPage: React.FC<PermissionsPageProps> = ({
  selectedId: propSelectedId,
  testPrincipal: propTestPrincipal,
}) => {
  const routerSearch = useSearch({ strict: false }) as { testPrincipal?: string; selectedId?: string } | undefined;
  const effectiveTestPrincipal = propTestPrincipal || routerSearch?.testPrincipal;
  const effectiveSelectedId = propSelectedId || routerSearch?.selectedId;

  const { mode } = useManagementData();
  const { data: res, isLoading, isError, error } = useManagementPermissions();
  const isLive = mode === 'live' || res?.source === 'api';
  const rules = res?.data || [];

  // Decision Tester Interactive Form State
  const [testerPrincipal, setTesterPrincipal] = useState(effectiveTestPrincipal || 'owner_primary');
  const [testerResource, setTesterResource] = useState('workspace:clean_reset');
  const [testerAction, setTesterAction] = useState('execute');
  const [testerChannel, setTesterChannel] = useState('web');
  const [simResult, setSimResult] = useState<DecisionTesterResult | null>(null);
  const [isTesterOpen, setIsTesterOpen] = useState(true);

  useEffect(() => {
    if (effectiveTestPrincipal) {
      setTesterPrincipal(effectiveTestPrincipal);
    }
  }, [effectiveTestPrincipal]);

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

  if (isLoading) {
    return (
      <div className="pageContainer">
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--metadata)' }}>
          加载权限规则数据中...
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="pageContainer">
        <PageHeader
          title="权限控制面 (Permissions)"
          description="判定优先 (Decision-First) 授权控制面。严格在代码层面执行 ALLOW / DENY / REQUIRES_APPROVAL 三值判定。"
          capabilityState="已实现"
          customPill={{ text: isLive ? '实时接口' : '设计数据', variant: isLive ? 'ok' : 'neutral' }}
        />
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--danger)' }} role="alert">
          <strong>权限规则加载失败</strong>: {error instanceof Error ? error.message : '无法获取权限规则数据'}
        </div>
      </div>
    );
  }

  return (
    <div className="pageContainer">
      <PageHeader
        title="权限控制面 (Permissions)"
        description="判定优先 (Decision-First) 授权控制面。严格在代码层面执行 ALLOW / DENY / REQUIRES_APPROVAL 三值判定。"
        capabilityState="已实现"
        customPill={{ text: isLive ? '实时接口' : '设计数据', variant: isLive ? 'ok' : 'neutral' }}
      />

      {effectiveSelectedId && !isLoading && !rules.some((r) => r.id === effectiveSelectedId) && (
        <Notice variant="warn">
          未找到目标门禁规则 [{effectiveSelectedId}]：该规则可能已被移除、重命名或尚未在当前环境生效。
        </Notice>
      )}

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
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>权限规则与系统门禁清单</div>
              {!isTesterOpen && (
                <button
                  type="button"
                  className="btn secondary sm"
                  onClick={() => setIsTesterOpen(true)}
                  aria-label="打开决策模拟器"
                >
                  打开决策模拟器
                </button>
              )}
            </div>
            <DataTable
              data={rules}
              columns={columns}
              keyExtractor={(r) => r.id}
              selectedId={rules.some((r) => r.id === effectiveSelectedId) ? effectiveSelectedId : undefined}
            />
          </div>
        }
        detail={
          <DetailRail
            isOpen={isTesterOpen}
            title="决策模拟器 (Decision Tester)"
            subtitle="仅模拟判定，不修改真实系统规则"
            onClose={() => setIsTesterOpen(false)}
            actions={
              <>
                <button
                  type="button"
                  className="btn primary sm"
                  style={{ width: '100%' }}
                  disabled={isLive}
                  aria-disabled={isLive}
                  onClick={() => {
                    if (isLive) return;
                    handleRunSimulation();
                  }}
                  title={isLive ? '服务端裁决模拟接口暂不可用 (P3 目标)' : undefined}
                >
                  {isLive ? '裁决模拟不可用 (P3)' : '执行裁决模拟计算'}
                </button>
                {isLive && (
                  <div
                    style={{
                      marginTop: 8,
                      padding: '10px 12px',
                      background: 'var(--surface)',
                      border: '1px solid var(--line)',
                      borderRadius: 'var(--radius-sm)',
                      fontSize: 11,
                      color: 'var(--metadata)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                    }}
                    role="note"
                  >
                    <StatusBadge state="P3 目标" className="sm">P3 目标</StatusBadge>
                    <span>
                      实时模式下服务端授权裁决模拟接口暂不可用，禁止以前端内置策略矩阵冒充服务端裁决结果。
                    </span>
                  </div>
                )}
              </>
            }
          >
            <DetailSection title="评测场景快捷预设 (DESIGN_EVAL §19)">
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                <button
                  type="button"
                  className="btn secondary sm"
                  style={{ fontSize: 11, padding: '3px 6px' }}
                  onClick={() => {
                    setTesterPrincipal('owner_primary');
                    setTesterResource('workspace://glassbox-main');
                    setTesterAction('read');
                    setTesterChannel('web');
                  }}
                >
                  1. Owner 读私有资源
                </button>
                <button
                  type="button"
                  className="btn secondary sm"
                  style={{ fontSize: 11, padding: '3px 6px' }}
                  onClick={() => {
                    setTesterPrincipal('owner_primary');
                    setTesterResource('patch:diff_private');
                    setTesterAction('deliver');
                    setTesterChannel('onebot_qq_group');
                  }}
                >
                  2. Owner 投递私密至公开群
                </button>
                <button
                  type="button"
                  className="btn secondary sm"
                  style={{ fontSize: 11, padding: '3px 6px' }}
                  onClick={() => {
                    setTesterPrincipal('visitor_guest_99');
                    setTesterResource('task://task-215');
                    setTesterAction('read');
                    setTesterChannel('onebot_qq_group');
                  }}
                >
                  3. Visitor 读无关 Task
                </button>
                <button
                  type="button"
                  className="btn secondary sm"
                  style={{ fontSize: 11, padding: '3px 6px' }}
                  onClick={() => {
                    setTesterPrincipal('worker_herdr_04');
                    setTesterResource('task://task-218');
                    setTesterAction('read');
                    setTesterChannel('web');
                  }}
                >
                  4. Worker 读委托 Task
                </button>
                <button
                  type="button"
                  className="btn secondary sm"
                  style={{ fontSize: 11, padding: '3px 6px' }}
                  onClick={() => {
                    setTesterPrincipal('worker_herdr_04');
                    setTesterResource('repo://unrelated-project');
                    setTesterAction('read');
                    setTesterChannel('web');
                  }}
                >
                  5. Worker 读未委托仓库
                </button>
                <button
                  type="button"
                  className="btn secondary sm"
                  style={{ fontSize: 11, padding: '3px 6px' }}
                  onClick={() => {
                    setTesterPrincipal('owner_primary');
                    setTesterResource('workspace:clean_reset');
                    setTesterAction('execute');
                    setTesterChannel('web');
                  }}
                >
                  6. 破坏性工作区重置
                </button>
              </div>
            </DetailSection>

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

      {/* Approval Queue Section (Approval ≠ Permission) */}
      <div style={{ marginTop: 24 }}>
        <SectionHeader
          title="待人工审批队列 (Approval Queue)"
          subtitle="审批通过仅授予单次或受限豁免，审批不等于授权 (Approval ≠ Permission)"
          capabilityState={isLive ? 'P3 目标' : '设计数据'}
        />
        {isLive ? (
          <div
            style={{
              padding: '24px 16px',
              textAlign: 'center',
              color: 'var(--metadata)',
              background: 'var(--surface)',
              border: '1px solid var(--line)',
              borderRadius: 'var(--radius-sm)',
              fontSize: 12,
              marginTop: 12,
            }}
          >
            审批队列接口暂不可用 (P3 目标：需要 ApprovalQueue 持久化事件流)
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
            {mockApprovalQueueData.map((item) => (
              <div
                key={item.id}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '12px 14px',
                  background: 'var(--surface)',
                  border: '1px solid var(--line)',
                  borderRadius: 'var(--radius-sm)',
                }}
              >
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--ink)' }}>{item.id}</span>
                    <span className="mono" style={{ fontSize: 11, color: 'var(--metadata)' }}>{item.resource}</span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--metadata)', marginTop: 2 }}>
                    申请主体: <span className="mono">{item.principal}</span> · 动作: <span className="mono">{item.action}</span> · 原因: {item.reason}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 11, color: 'var(--metadata)' }}>{item.requestedAt}</span>
                  <StatusBadge
                    variant={item.status === 'pending' ? 'warn' : item.status === 'approved' ? 'ok' : 'bad'}
                    className="sm"
                  >
                    {item.status === 'pending' ? '待审批' : item.status === 'approved' ? '已批准' : '已拒绝'}
                  </StatusBadge>
                </div>
              </div>
            ))}
            {mockApprovalQueueData.length === 0 && (
              <div
                style={{
                  padding: '24px 16px',
                  textAlign: 'center',
                  color: 'var(--metadata)',
                  background: 'var(--surface)',
                  border: '1px solid var(--line)',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: 12,
                }}
              >
                当前无待人工审批事项 (Approval Queue Empty)
              </div>
            )}
          </div>
        )}
      </div>

      {/* Hard Gate Reference & Policy Provenance Section */}
      <div style={{ marginTop: 24 }}>
        <SectionHeader
          title="硬门禁参考与溯源依据 (Gate Reference & Provenance)"
          subtitle="系统硬编码防线与代码层安全边界，不依赖模型提示词或软性指令"
        />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12, marginTop: 12 }}>
          <div style={{ padding: 12, background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 'var(--radius-sm)' }}>
            <div style={{ fontSize: 11, color: 'var(--metadata)', fontWeight: 600 }}>Hard Gate 1</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', margin: '4px 0' }}>默认拒绝 (Deny by Default)</div>
            <div style={{ fontSize: 11, color: 'var(--secondary)' }}>无显式 Grant 声明的任何访问一律拦截为 DENY。</div>
          </div>
          <div style={{ padding: 12, background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 'var(--radius-sm)' }}>
            <div style={{ fontSize: 11, color: 'var(--metadata)', fontWeight: 600 }}>Hard Gate 2</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', margin: '4px 0' }}>破坏性操作门禁 (Destructive Gate)</div>
            <div style={{ fontSize: 11, color: 'var(--secondary)' }}>工作区重置、文件删除、破坏性脚本执行强制 REQUIRES_APPROVAL。</div>
          </div>
          <div style={{ padding: 12, background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 'var(--radius-sm)' }}>
            <div style={{ fontSize: 11, color: 'var(--metadata)', fontWeight: 600 }}>Hard Gate 3</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', margin: '4px 0' }}>投递边界隔离 (Delivery Screening)</div>
            <div style={{ fontSize: 11, color: 'var(--secondary)' }}>严禁将包含私有上下文、Token、内部路径的产物投递至未授权渠道。</div>
          </div>
          <div style={{ padding: 12, background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 'var(--radius-sm)' }}>
            <div style={{ fontSize: 11, color: 'var(--metadata)', fontWeight: 600 }}>Hard Gate 4</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', margin: '4px 0' }}>委派不越权 (Delegation Invariant)</div>
            <div style={{ fontSize: 11, color: 'var(--secondary)' }}>受托 Worker 权限集合必须严格为 Caller 权限的子集 (worker ⊆ caller)。</div>
          </div>
        </div>
      </div>
    </div>
  );
};
