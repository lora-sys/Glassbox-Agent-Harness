/**
 * @file apps/web/src/management/adapter/queryClient.ts
 */
import { QueryClient } from '@tanstack/react-query';

export const managementQueryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 30, // 30 seconds
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});
