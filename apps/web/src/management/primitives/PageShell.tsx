/**
 * @file apps/web/src/management/primitives/PageShell.tsx
 *
 * Locked 232px Desktop Sidebar, Mobile Drawer (with focus trap and Escape handler),
 * Topbar with breadcrumb and repository metadata.
 */
import React, { useState, useEffect, useRef } from 'react';
import { EntityMark } from './EntityMark';

export interface PageShellProps {
  currentPageId: string;
  onNavigate: (pageId: string) => void;
  children: React.ReactNode;
}

interface NavItemDef {
  id: string;
  titleZh: string;
  titleEn: string;
  path: string;
  badge?: string | number;
}

const NAV_GROUPS: Array<{ label: string; items: NavItemDef[] }> = [
  {
    label: '工作台',
    items: [
      { id: 'overview', titleZh: '概览', titleEn: 'Overview', path: '/manage/overview' },
      { id: 'conversations', titleZh: '会话', titleEn: 'Conversations', path: '/manage/conversations' },
      { id: 'ops', titleZh: '任务协作', titleEn: 'Task Collaboration', path: '/manage/ops', badge: 3 },
      { id: 'identity', titleZh: '身份与访问', titleEn: 'Identity & Access', path: '/manage/identity' },
      { id: 'runs', titleZh: '运行记录', titleEn: 'Runs', path: '/manage/runs' },
      { id: 'trace', titleZh: '追踪', titleEn: 'Trace', path: '/manage/trace' },
    ],
  },
  {
    label: 'PI Core',
    items: [
      { id: 'pi', titleZh: 'PI', titleEn: 'PI Engine', path: '/manage/pi' },
      { id: 'channels', titleZh: '渠道与集成', titleEn: 'Channels & Integrations', path: '/manage/channels' },
      { id: 'permissions', titleZh: '权限', titleEn: 'Permissions', path: '/manage/permissions' },
      { id: 'monitor', titleZh: '监控', titleEn: 'Monitor', path: '/manage/monitor' },
    ],
  },
  {
    label: '设置',
    items: [
      { id: 'settings', titleZh: '设置', titleEn: 'Settings', path: '/manage/settings' },
    ],
  },
];

export const PageShell: React.FC<PageShellProps> = ({
  currentPageId,
  onNavigate,
  children,
}) => {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [cmdOpen, setCmdOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);

  // Manage focus return when mobile drawer closes
  useEffect(() => {
    if (drawerOpen) {
      drawerRef.current?.focus();
    } else {
      menuButtonRef.current?.focus();
    }
  }, [drawerOpen]);

  // Escape key handler for drawer and command palette
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (drawerOpen) {
          e.preventDefault();
          setDrawerOpen(false);
        }
        if (cmdOpen) {
          e.preventDefault();
          setCmdOpen(false);
        }
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCmdOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [drawerOpen, cmdOpen]);

  // Active page title for breadcrumb
  const currentItem = NAV_GROUPS.flatMap((g) => g.items).find((i) => i.id === currentPageId);
  const currentTitle = currentItem ? `${currentItem.titleZh} (${currentItem.titleEn})` : '管理后台';

  const renderNavLinks = (closeDrawerOnSelect = false) => (
    <>
      <div className="brandHeader">
        <div className="brandLogo">GB</div>
        <div className="brandTitle">
          <strong>Glassbox</strong>
          <span>Personal Agent Ops</span>
        </div>
      </div>
      {NAV_GROUPS.map((group) => (
        <div key={group.label} className="navGroup">
          <div className="navGroupLabel">{group.label}</div>
          {group.items.map((item) => {
            const isActive = currentPageId === item.id;
            return (
              <button
                key={item.id}
                type="button"
                className={`navItem ${isActive ? 'active' : ''}`}
                onClick={() => {
                  onNavigate(item.id);
                  if (closeDrawerOnSelect) setDrawerOpen(false);
                }}
                aria-current={isActive ? 'page' : undefined}
              >
                <span>{item.titleZh}</span>
                {item.badge !== undefined && <span className="navBadge">{item.badge}</span>}
              </button>
            );
          })}
        </div>
      ))}
    </>
  );

  return (
    <div className="managementApp">
      {/* Desktop Sticky Sidebar (232px) */}
      <nav className="sidebarNav" aria-label="Main Navigation">
        {renderNavLinks(false)}
      </nav>

      {/* Mobile Drawer Overlay */}
      <div
        className={`mobileDrawerOverlay ${drawerOpen ? 'open' : ''}`}
        onClick={() => setDrawerOpen(false)}
        aria-hidden="true"
      />

      {/* Mobile Drawer */}
      <div
        ref={drawerRef}
        className={`mobileDrawer ${drawerOpen ? 'open' : ''}`}
        tabIndex={-1}
        role="dialog"
        aria-label="Mobile Navigation Menu"
      >
        <button
          type="button"
          className="drawerCloseBtn"
          onClick={() => setDrawerOpen(false)}
          aria-label="关闭菜单"
        >
          ✕
        </button>
        {renderNavLinks(true)}
      </div>

      {/* Main Viewport */}
      <div className="mainViewport">
        {/* Topbar */}
        <header className="topbar">
          <button
            ref={menuButtonRef}
            type="button"
            className="mobileMenuBtn"
            onClick={() => setDrawerOpen(true)}
            aria-label="打开导航菜单"
            aria-expanded={drawerOpen}
          >
            ☰
          </button>
          <div className="breadcrumb">
            <span>GlossBox / </span>
            <b id="crumb">{currentTitle}</b>
          </div>
          <div className="topSpacer" />
          <div className="repoMeta">
            <span>仓库:</span>
            <code>Glassbox-Agent-Harness</code>
            <span>分支:</span>
            <code>main</code>
            <span className="capabilityBadge warn">P3 当前计划</span>
          </div>
          <button
            type="button"
            className="btn secondary sm"
            onClick={() => setCmdOpen(true)}
            aria-label="打开命令面板 (Cmd+K)"
          >
            ⌘K
          </button>
          <a
            href="/"
            className="btn primary sm"
            style={{ textDecoration: 'none' }}
            title="切换至画布对话主界面"
          >
            打开对话
          </a>
        </header>

        {/* Page Content */}
        <main style={{ flex: 1, minWidth: 0, paddingBottom: 40 }}>
          {children}
        </main>
      </div>

      {/* Command Palette Modal */}
      {cmdOpen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'center',
            paddingTop: 100,
            zIndex: 100,
          }}
          onClick={() => setCmdOpen(false)}
        >
          <div
            style={{
              background: 'var(--surface)',
              width: 480,
              maxWidth: '90%',
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--line)',
              boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
              overflow: 'hidden',
            }}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="Command Palette"
          >
            <div style={{ padding: 12, borderBottom: '1px solid var(--line)' }}>
              <input
                type="text"
                autoFocus
                placeholder="快速跳转页面或搜索操作 (ESC 退出)..."
                style={{
                  width: '100%',
                  border: 'none',
                  outline: 'none',
                  fontSize: 14,
                  fontFamily: 'inherit',
                  background: 'transparent',
                }}
              />
            </div>
            <div style={{ padding: 8, maxHeight: 300, overflowY: 'auto' }}>
              {NAV_GROUPS.flatMap((g) => g.items).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    padding: '8px 12px',
                    borderRadius: 'var(--radius-sm)',
                    border: 'none',
                    background: 'transparent',
                    cursor: 'pointer',
                    fontSize: 13,
                  }}
                  onClick={() => {
                    onNavigate(item.id);
                    setCmdOpen(false);
                  }}
                >
                  {item.titleZh} ({item.titleEn})
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
