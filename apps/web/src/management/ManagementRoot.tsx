/**
 * @file apps/web/src/management/ManagementRoot.tsx
 *
 * Root Management Container:
 * - Mounts TanStack QueryClientProvider
 * - Manages data-source mode ('design' | 'live') via TanStack Router search params
 * - Preserves mode across navigation, browser back/forward, and reload
 * - Enforces ManagementAuth access guard (fail-closed in live mode)
 * - Renders all 11 frozen pages with PageShell
 */
import React, { useState, useCallback } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { managementQueryClient } from './adapter/queryClient';
import {
  ManagementDataProvider,
  getManagementToken,
  setManagementToken,
  type ManagementMode,
} from './adapter';
import { ManagementAuth } from './access/ManagementAuth';
import { PageShell } from './primitives/PageShell';

import { OverviewPage } from './pages/OverviewPage';
import { ConversationsPage } from './pages/ConversationsPage';
import { OpsPage } from './pages/OpsPage';
import { IdentityPage } from './pages/IdentityPage';
import { RunsPage } from './pages/RunsPage';
import { TracePage } from './pages/TracePage';
import { PiPage } from './pages/PiPage';
import { ChannelsPage } from './pages/ChannelsPage';
import { PermissionsPage } from './pages/PermissionsPage';
import { MonitorPage } from './pages/MonitorPage';
import { SettingsPage } from './pages/SettingsPage';

import './styles/management.css';

export const VALID_PAGES = [
  'overview',
  'conversations',
  'ops',
  'identity',
  'runs',
  'trace',
  'pi',
  'channels',
  'permissions',
  'monitor',
  'settings',
] as const;

export type ManagementPageId = (typeof VALID_PAGES)[number];

export const ManagementRoot: React.FC = () => {
  const search = useSearch({ strict: false }) as {
    page?: ManagementPageId;
    mode?: ManagementMode;
    runId?: string;
  };
  const navigate = useNavigate();

  const currentPage: ManagementPageId =
    search?.page && VALID_PAGES.includes(search.page) ? search.page : 'overview';
  const mode: ManagementMode = search?.mode === 'live' ? 'live' : 'design';

  const [token, setTokenState] = useState<string | null>(() => getManagementToken());

  // TanStack Router navigation preserving search params
  const navigateToPage = useCallback(
    (pageId: string) => {
      if (!VALID_PAGES.includes(pageId as ManagementPageId)) return;
      navigate({
        to: '/manage',
        search: (prev: any) => ({
          ...prev,
          page: pageId,
        }),
      });
    },
    [navigate],
  );

  const setMode = useCallback(
    (newMode: ManagementMode) => {
      navigate({
        to: '/manage',
        search: (prev: any) => ({
          ...prev,
          mode: newMode,
        }),
      });
    },
    [navigate],
  );

  // Authenticate management token with /manage/status
  const handleTokenSubmit = useCallback(
    async (newToken: string, persist: boolean) => {
      try {
        const res = await fetch('/manage/status', {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${newToken.trim()}`,
            Accept: 'application/json',
          },
        });
        if (res.status === 401) {
          return { success: false, status: 401, error: '所有者 Token 鉴权失败 (401 Unauthorized)' };
        }
        if (res.status === 403) {
          return {
            success: false,
            status: 403,
            error: '接口仅允许来自 127.0.0.1 或白名单 Origin 访问 (403 Forbidden)',
          };
        }
        if (!res.ok) {
          return { success: false, status: res.status, error: `服务端返回错误: ${res.status} ${res.statusText}` };
        }
        const json = await res.json();
        if (json?.status !== 'ready' || json?.service !== 'glassbox') {
          return { success: false, status: 502, error: '服务端状态异常，非合规 Glassbox 实例' };
        }
        setTokenState(newToken.trim());
        setManagementToken(newToken.trim(), persist);
        return { success: true };
      } catch (err) {
        return {
          success: false,
          status: 500,
          error: err instanceof Error ? err.message : '网络连接超时或无法连接服务端',
        };
      }
    },
    [],
  );

  const renderCurrentPage = () => {
    switch (currentPage) {
      case 'overview':
        return <OverviewPage onNavigate={navigateToPage} />;
      case 'conversations':
        return <ConversationsPage onNavigate={navigateToPage} />;
      case 'ops':
        return <OpsPage onNavigate={navigateToPage} />;
      case 'identity':
        return <IdentityPage onNavigate={navigateToPage} />;
      case 'runs':
        return <RunsPage onNavigate={navigateToPage} />;
      case 'trace':
        return <TracePage onNavigate={navigateToPage} />;
      case 'pi':
        return <PiPage onNavigate={navigateToPage} />;
      case 'channels':
        return <ChannelsPage onNavigate={navigateToPage} />;
      case 'permissions':
        return <PermissionsPage onNavigate={navigateToPage} />;
      case 'monitor':
        return <MonitorPage onNavigate={navigateToPage} />;
      case 'settings':
        return <SettingsPage onNavigate={navigateToPage} />;
      default:
        return <OverviewPage onNavigate={navigateToPage} />;
    }
  };

  return (
    <QueryClientProvider client={managementQueryClient}>
      <ManagementDataProvider
        mode={mode}
        setMode={setMode}
        token={token}
        setToken={(t) => {
          setTokenState(t);
          setManagementToken(t, false);
        }}
      >
        <ManagementAuth
          mode={mode}
          token={token}
          onTokenSubmit={handleTokenSubmit}
          onSwitchToDesign={() => setMode('design')}
        >
          <PageShell
            currentPageId={currentPage}
            onNavigate={navigateToPage}
            mode={mode}
            onModeChange={setMode}
          >
            {renderCurrentPage()}
          </PageShell>
        </ManagementAuth>
      </ManagementDataProvider>
    </QueryClientProvider>
  );
};
