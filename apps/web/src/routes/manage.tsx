/**
 * @file apps/web/src/routes/manage.tsx
 * Mounts the Web Management UI at /manage while preserving the canvas route at /
 */
import { createRoute } from '@tanstack/react-router';
import { Route as rootRoute } from './__root';
import { ManagementRoot } from '../management/ManagementRoot';

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: 'manage',
  component: ManagementRoot,
});
