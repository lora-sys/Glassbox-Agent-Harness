/**
 * @file apps/web/src/routes/manage.tsx
 * Mounts the Web Management UI at /manage while preserving the canvas route at /
 *
 * TanStack Router search params validation:
 * - page: one of the 11 frozen page IDs
 * - mode: 'design' | 'live' (preserves data-source mode across navigation, back/forward, and reload)
 * - runId: deep-linking to specific run
 */
import { createRoute } from '@tanstack/react-router';
import { Route as rootRoute } from './__root';
import { ManagementRoot, VALID_PAGES, type ManagementPageId } from '../management/ManagementRoot';

export interface ManageSearch {
  page?: ManagementPageId;
  mode?: 'design' | 'live';
  runId?: string;
}

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: 'manage',
  validateSearch: (search: Record<string, unknown>): ManageSearch => {
    const page = (typeof search.page === 'string' && VALID_PAGES.includes(search.page as ManagementPageId))
      ? (search.page as ManagementPageId)
      : 'overview';
    const mode = search.mode === 'live' ? 'live' : 'design';
    const runId = typeof search.runId === 'string' ? search.runId : undefined;
    return { page, mode, runId };
  },
  component: ManagementRoot,
});
