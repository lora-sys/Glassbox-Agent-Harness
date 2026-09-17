/**
 * @file apps/web/src/management/ManagementRoot.tsx
 *
 * Root Management Container:
 * - Mounts TanStack QueryClientProvider
 * - Enforces ManagementAuth access guard (Owner-only)
 * - Manages PageShell with synchronized URL navigation, browser back/forward, and deep links
 * - Renders all 11 frozen pages
 */
import React, { useState, useEffect, useCallback } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { managementQueryClient } from './adapter/queryClient';
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

const VALID_PAGES = [
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

function getInitialPage(): ManagementPageId {
  if (typeof window === 'undefined') return 'overview';

  // Support path-based (/manage/ops) or search-based (/manage?page=ops)
  const path = window.location.pathname.replace(/^\/manage\/?/, '').split('/')[0];
  if (VALID_PAGES.includes(path as ManagementPageId)) {
    return path as ManagementPageId;
  }

  const params = new URLSearchParams(window.location.search);
  const pageParam = params.get('page');
  if (pageParam && VALID_PAGES.includes(pageParam as ManagementPageId)) {
    return pageParam as ManagementPageId;
  }

  return 'overview';
}

export const ManagementRoot: React.FC = () => {
  const [currentPage, setCurrentPage] = useState<ManagementPageId>(getInitialPage());

  // Handle browser back/forward navigation
  useEffect(() => {
    const handlePopState = () => {
      setCurrentPage(getInitialPage());
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const navigateToPage = useCallback((pageId: string) => {
    if (!VALID_PAGES.includes(pageId as ManagementPageId)) return;

    setCurrentPage(pageId as ManagementPageId);

    // Update URL history for deep-linking and browser back/forward
    const newPath = `/manage?page=${pageId}`;
    if (window.location.pathname + window.location.search !== newPath) {
      window.history.pushState({ page: pageId }, '', newPath);
    }
  }, []);

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
      <ManagementAuth>
        <PageShell currentPageId={currentPage} onNavigate={navigateToPage}>
          {renderCurrentPage()}
        </PageShell>
      </ManagementAuth>
    </QueryClientProvider>
  );
};
