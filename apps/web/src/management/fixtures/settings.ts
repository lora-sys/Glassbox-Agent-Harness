/**
 * @file apps/web/src/management/fixtures/settings.ts
 */
import type { SettingsProjection } from '../types';

export const mockSettingsData: SettingsProjection = {
  retentionDays: 30,
  unknownPricingDisplay: 'show_unknown',
  defaultChannelPolicy: 'strict_allowlist',
  autoReviewOnWorkerDone: true,
  colorBlindMode: false,
  enableTraceKeyboardShortcuts: true,
  isLocalDraftDirty: false,
};
