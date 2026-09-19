/**
 * @file apps/web/src/management/primitives/PageShell.tsx
 *
 * Locked 232px Desktop Sidebar, Mobile Drawer (with focus containment and Escape handler),
 * Topbar with breadcrumb and repository metadata.
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { usePreferences } from '../adapter';

export interface PageShellProps {
  currentPageId: string;
  onNavigate: (pageId: string) => void;
  mode?: 'design' | 'live';
  onModeChange?: (mode: 'design' | 'live') => void;
  onDisconnect?: () => void;
  children: React.ReactNode;
}

interface NavItemDef {
  id: string;
  titleZh: string;
  titleEn: string;
  badge?: string | number;
}

const NAV_GROUPS: Array<{ label: string; items: NavItemDef[] }> = [
  {
    label: '工作台',
    items: [
      { id: 'overview', titleZh: '概览', titleEn: 'Overview' },
      { id: 'conversations', titleZh: '会话', titleEn: 'Conversations' },
      { id: 'ops', titleZh: '任务协作', titleEn: 'Task Collaboration', badge: 3 },
      { id: 'identity', titleZh: '身份与访问', titleEn: 'Identity & Access' },
      { id: 'runs', titleZh: '运行记录', titleEn: 'Runs' },
      { id: 'trace', titleZh: '追踪', titleEn: 'Trace' },
    ],
  },
  {
    label: 'PI Core',
    items: [
      { id: 'pi', titleZh: 'PI', titleEn: 'PI Engine' },
      { id: 'channels', titleZh: '渠道与集成', titleEn: 'Channels & Integrations' },
      { id: 'permissions', titleZh: '权限', titleEn: 'Permissions' },
      { id: 'monitor', titleZh: '监控', titleEn: 'Monitor' },
    ],
  },
  {
    label: '设置',
    items: [
      { id: 'settings', titleZh: '设置', titleEn: 'Settings' },
    ],
  },
];

export function clampCommandPaletteIndex(index: number, length: number): number {
  if (length <= 0) return -1;
  return Math.min(Math.max(0, index), length - 1);
}

export function getCommandPaletteActiveDescendantId(
  items: Array<{ id: string }>,
  index: number,
): string | undefined {
  const clamped = clampCommandPaletteIndex(index, items.length);
  return clamped >= 0 && items[clamped] ? `cmd-item-${items[clamped].id}` : undefined;
}

/**
 * Sidebar nav counts are a design projection of the fixture Attention queue
 * (ops badge 3 === 3 fixture attention items). They are never server truth, so
 * live mode must not render them as authoritative counts.
 */
export function isNavBadgeVisible(
  itemBadge: string | number | undefined,
  mode: 'design' | 'live',
): boolean {
  return itemBadge !== undefined && mode !== 'live';
}

function trapFocus(container: HTMLElement | null, e: KeyboardEvent) {
  if (!container || e.key !== 'Tab') return;
  const focusables = container.querySelectorAll<HTMLElement>(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  );
  if (focusables.length === 0) {
    e.preventDefault();
    return;
  }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];

  if (e.shiftKey) {
    if (document.activeElement === first || !container.contains(document.activeElement)) {
      e.preventDefault();
      last.focus();
    }
  } else {
    if (document.activeElement === last || !container.contains(document.activeElement)) {
      e.preventDefault();
      first.focus();
    }
  }
}

export const PageShell: React.FC<PageShellProps> = ({
  currentPageId,
  onNavigate,
  mode = 'design',
  onModeChange,
  onDisconnect,
  children,
}) => {
  const { settings } = usePreferences();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [cmdQuery, setCmdQuery] = useState('');

  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const cmdDialogRef = useRef<HTMLDivElement>(null);
  const cmdInputRef = useRef<HTMLInputElement>(null);
  const cmdTriggerRef = useRef<HTMLElement | null>(null);

  const prevDrawerOpenRef = useRef(false);

  // Focus management for Mobile Drawer: skip focus on initial mount,
  // focus drawer on open, restore to menu button only after an opened drawer closes.
  useEffect(() => {
    if (!prevDrawerOpenRef.current && drawerOpen) {
      drawerRef.current?.focus();
    } else if (prevDrawerOpenRef.current && !drawerOpen) {
      menuButtonRef.current?.focus();
    }
    prevDrawerOpenRef.current = drawerOpen;
  }, [drawerOpen]);

  // Focus management for Command Palette: capture trigger, restore on close
  const openCommandPalette = useCallback(() => {
    cmdTriggerRef.current = document.activeElement as HTMLElement;
    setCmdOpen(true);
  }, []);

  const closeCommandPalette = useCallback(() => {
    setCmdOpen(false);
    setCmdQuery('');
    setCmdActiveIndex(0);
    if (cmdTriggerRef.current && document.contains(cmdTriggerRef.current)) {
      cmdTriggerRef.current.focus();
    }
  }, []);

  // Keyboard focus containment & Escape handling for Drawer & Command Palette
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (cmdOpen) {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          closeCommandPalette();
          return;
        }
        if (e.key === 'Tab') {
          trapFocus(cmdDialogRef.current, e);
          return;
        }
      }

      if (drawerOpen) {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          setDrawerOpen(false);
          return;
        }
        if (e.key === 'Tab') {
          trapFocus(drawerRef.current, e);
          return;
        }
      }

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        e.stopPropagation();
        if (cmdOpen) {
          closeCommandPalette();
        } else {
          openCommandPalette();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [drawerOpen, cmdOpen, closeCommandPalette, openCommandPalette]);

  // Active page title for breadcrumb
  const allNavItems = NAV_GROUPS.flatMap((g) => g.items);
  const currentItem = allNavItems.find((i) => i.id === currentPageId);
  const currentTitle = currentItem ? `${currentItem.titleZh} (${currentItem.titleEn})` : '管理后台';

  // Filter Command Palette items
  const normalizedQuery = cmdQuery.trim().toLowerCase();
  const filteredNavItems = allNavItems.filter((item) => {
    if (!normalizedQuery) return true;
    return (
      item.titleZh.toLowerCase().includes(normalizedQuery) ||
      item.titleEn.toLowerCase().includes(normalizedQuery) ||
      item.id.toLowerCase().includes(normalizedQuery)
    );
  });

  const [cmdActiveIndex, setCmdActiveIndex] = useState(0);

  useEffect(() => {
    setCmdActiveIndex(0);
  }, [cmdQuery]);

  const clampedActiveIndex = clampCommandPaletteIndex(cmdActiveIndex, filteredNavItems.length);

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (filteredNavItems.length > 0) {
        setCmdActiveIndex((prev) => (prev + 1) % filteredNavItems.length);
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (filteredNavItems.length > 0) {
        setCmdActiveIndex((prev) => (prev - 1 + filteredNavItems.length) % filteredNavItems.length);
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (clampedActiveIndex >= 0 && clampedActiveIndex < filteredNavItems.length) {
        onNavigate(filteredNavItems[clampedActiveIndex].id);
        closeCommandPalette();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeCommandPalette();
    }
  };

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
                {isNavBadgeVisible(item.badge, mode) && (
                  <span className="navBadge">{item.badge}</span>
                )}
              </button>
            );
          })}
        </div>
      ))}
    </>
  );

  return (
    <div
      className={`managementApp ${settings?.colorBlindMode ? 'colorblind-mode' : ''}`}
      data-colorblind={settings?.colorBlindMode ? 'true' : undefined}
    >
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
        style={{ display: drawerOpen ? 'flex' : 'none' }}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Mobile Navigation Menu"
        aria-hidden={!drawerOpen}
        inert={!drawerOpen}
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
            <span>Glassbox / </span>
            <b id="crumb">{currentTitle}</b>
          </div>
          <div className="topSpacer" />
          <div className="repoMeta">
            <span className="sourceLabel">数据源:</span>
            <span
              className={`capabilityBadge ${mode === 'live' ? 'ok' : 'neutral'}`}
              title={mode === 'live' ? '已连接 Glassbox /manage 实时接口' : '当前展示确定性公开设计预览数据，未连接服务端'}
            >
              {mode === 'live' ? '实时接口 (/manage)' : '设计数据 (Preview)'}
            </span>
            {onModeChange && (
              <button
                type="button"
                className="btn secondary sm"
                style={{ padding: '2px 8px', fontSize: 11 }}
                onClick={() => onModeChange(mode === 'live' ? 'design' : 'live')}
                title={mode === 'live' ? '切换为离线设计数据预览' : '切换为连接 Glassbox 服务端 /manage 实时接口'}
              >
                {mode === 'live' ? '切至设计数据' : '切至实时接口'}
              </button>
            )}
            {mode === 'live' && onDisconnect && (
              <button
                type="button"
                className="btn secondary sm disconnectBtn"
                style={{ padding: '2px 8px', fontSize: 11 }}
                onClick={onDisconnect}
                title="断开实时连接并清除凭据"
                aria-label="断开管理凭据连接"
              >
                断开凭据
              </button>
            )}
          </div>
          <button
            type="button"
            className="btn secondary sm"
            onClick={openCommandPalette}
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
          onClick={closeCommandPalette}
        >
          <div
            ref={cmdDialogRef}
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
            aria-modal="true"
            aria-label="Command Palette"
            tabIndex={-1}
          >
            <div style={{ padding: 12, borderBottom: '1px solid var(--line)' }}>
              <input
                ref={cmdInputRef}
                type="text"
                role="combobox"
                aria-expanded="true"
                aria-haspopup="listbox"
                aria-autocomplete="list"
                aria-controls="cmd-palette-listbox"
                aria-activedescendant={getCommandPaletteActiveDescendantId(
                  filteredNavItems,
                  clampedActiveIndex
                )}
                autoFocus
                value={cmdQuery}
                onChange={(e) => setCmdQuery(e.target.value)}
                onKeyDown={handleInputKeyDown}
                placeholder="快速跳转页面或搜索操作 (ESC 退出)..."
                aria-label="快速跳转页面或搜索操作"
                style={{
                  width: '100%',
                  border: 'none',
                  outline: 'none',
                  fontSize: 14,
                  fontFamily: 'inherit',
                  background: 'transparent',
                  color: 'var(--ink)',
                }}
              />
            </div>
            <div
              id="cmd-palette-listbox"
              role="listbox"
              aria-label="页面跳转建议"
              style={{ padding: 8, maxHeight: 300, overflowY: 'auto' }}
            >
              {filteredNavItems.length === 0 ? (
                <div style={{ padding: '24px 16px', textAlign: 'center', color: 'var(--metadata)', fontSize: 13 }}>
                  无匹配页面或操作
                </div>
              ) : (
                filteredNavItems.map((item, idx) => {
                  const isActive = idx === clampedActiveIndex;
                  return (
                    <button
                      key={item.id}
                      id={`cmd-item-${item.id}`}
                      role="option"
                      aria-selected={isActive}
                      type="button"
                      className={`cmdPaletteItem ${isActive ? 'active' : ''}`}
                      style={{
                        display: 'block',
                        width: '100%',
                        textAlign: 'left',
                        padding: '8px 12px',
                        borderRadius: 'var(--radius-sm)',
                        border: 'none',
                        background: isActive ? 'var(--sidebar)' : 'transparent',
                        cursor: 'pointer',
                        fontSize: 13,
                        color: isActive ? 'var(--brand)' : 'var(--ink)',
                        fontWeight: isActive ? 600 : 400,
                      }}
                      onClick={() => {
                        onNavigate(item.id);
                        closeCommandPalette();
                      }}
                      onMouseEnter={() => setCmdActiveIndex(idx)}
                    >
                      {item.titleZh} ({item.titleEn})
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
