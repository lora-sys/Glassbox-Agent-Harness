/**
 * @file apps/web/src/management/preferences.test.ts
 * Focused tests for typed client preference store validation, serialization, and sessionStorage persistence.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  validateSettingsDraft,
  loadSettingsDraft,
  saveSettingsDraft,
  resetSettingsDraft,
  DEFAULT_PREFERENCES,
  SETTINGS_STORAGE_KEY,
} from './adapter/preferences';
import type { SettingsProjection } from './types';

class MockStorage {
  private store: Record<string, string> = {};

  getItem(key: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.store, key) ? this.store[key] : null;
  }

  setItem(key: string, value: string): void {
    this.store[key] = String(value);
  }

  removeItem(key: string): void {
    delete this.store[key];
  }

  clear(): void {
    this.store = {};
  }
}

describe('Preferences Store & Validation', () => {
  let mockStorage: MockStorage;

  beforeEach(() => {
    mockStorage = new MockStorage();
    vi.stubGlobal('sessionStorage', mockStorage);
    vi.stubGlobal('window', { sessionStorage: mockStorage });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('validateSettingsDraft', () => {
    it('returns default fallback when given non-object or invalid types', () => {
      expect(validateSettingsDraft(null)).toEqual(DEFAULT_PREFERENCES);
      expect(validateSettingsDraft(undefined)).toEqual(DEFAULT_PREFERENCES);
      expect(validateSettingsDraft('random string')).toEqual(DEFAULT_PREFERENCES);
      expect(validateSettingsDraft(123)).toEqual(DEFAULT_PREFERENCES);
      expect(validateSettingsDraft([])).toEqual(DEFAULT_PREFERENCES);
    });

    it('validates and preserves compliant settings', () => {
      const custom: SettingsProjection = {
        retentionDays: 60,
        unknownPricingDisplay: 'hide_cost',
        defaultChannelPolicy: 'owner_only',
        autoReviewOnWorkerDone: false,
        colorBlindMode: true,
        enableTraceKeyboardShortcuts: false,
        isLocalDraftDirty: true,
      };

      const result = validateSettingsDraft(custom);
      expect(result.retentionDays).toBe(60);
      expect(result.unknownPricingDisplay).toBe('hide_cost');
      expect(result.defaultChannelPolicy).toBe('owner_only');
      expect(result.autoReviewOnWorkerDone).toBe(false);
      expect(result.colorBlindMode).toBe(true);
      expect(result.enableTraceKeyboardShortcuts).toBe(false);
      // isLocalDraftDirty is always reset to false on validated persisted settings
      expect(result.isLocalDraftDirty).toBe(false);
    });

    it('clamps or falls back for out-of-range retention days', () => {
      expect(validateSettingsDraft({ retentionDays: 2 }).retentionDays).toBe(
        DEFAULT_PREFERENCES.retentionDays
      );
      expect(validateSettingsDraft({ retentionDays: 5 }).retentionDays).toBe(
        DEFAULT_PREFERENCES.retentionDays
      );
      expect(validateSettingsDraft({ retentionDays: 400 }).retentionDays).toBe(
        DEFAULT_PREFERENCES.retentionDays
      );
      expect(validateSettingsDraft({ retentionDays: 500 }).retentionDays).toBe(
        DEFAULT_PREFERENCES.retentionDays
      );
      expect(validateSettingsDraft({ retentionDays: NaN }).retentionDays).toBe(
        DEFAULT_PREFERENCES.retentionDays
      );
      expect(validateSettingsDraft({ retentionDays: undefined }).retentionDays).toBe(
        DEFAULT_PREFERENCES.retentionDays
      );
      expect(validateSettingsDraft({ retentionDays: '30' }).retentionDays).toBe(
        DEFAULT_PREFERENCES.retentionDays
      );
      expect(validateSettingsDraft({ retentionDays: 90 }).retentionDays).toBe(90);
    });

    it('falls back for invalid enum values and types', () => {
      const result = validateSettingsDraft({
        unknownPricingDisplay: 'invalid_enum',
        defaultChannelPolicy: 'open_to_all',
        colorBlindMode: 'yes',
        enableTraceKeyboardShortcuts: 1,
      });

      expect(result.unknownPricingDisplay).toBe(DEFAULT_PREFERENCES.unknownPricingDisplay);
      expect(result.defaultChannelPolicy).toBe(DEFAULT_PREFERENCES.defaultChannelPolicy);
      expect(result.colorBlindMode).toBe(DEFAULT_PREFERENCES.colorBlindMode);
      expect(result.enableTraceKeyboardShortcuts).toBe(
        DEFAULT_PREFERENCES.enableTraceKeyboardShortcuts
      );
    });

    it('strips injected secrets or unrecognized keys', () => {
      const payloadWithSecrets = {
        retentionDays: 45,
        token: 'secret_management_token_123',
        password: 'admin_password',
        apiKey: 'sk-1234567890',
      };

      const result = validateSettingsDraft(payloadWithSecrets) as unknown as Record<string, unknown>;
      expect(result.retentionDays).toBe(45);
      expect(result.token).toBeUndefined();
      expect(result.password).toBeUndefined();
      expect(result.apiKey).toBeUndefined();
    });
  });

  describe('sessionStorage Persistence & Retrieval', () => {
    it('returns default preferences when sessionStorage is empty', () => {
      const loaded = loadSettingsDraft();
      expect(loaded).toEqual(DEFAULT_PREFERENCES);
    });

    it('persists and reloads valid settings from sessionStorage', () => {
      const updated: SettingsProjection = {
        retentionDays: 90,
        unknownPricingDisplay: 'hide_cost',
        defaultChannelPolicy: 'strict_allowlist',
        autoReviewOnWorkerDone: true,
        colorBlindMode: true,
        enableTraceKeyboardShortcuts: false,
        isLocalDraftDirty: false,
      };

      saveSettingsDraft(updated);

      const storedRaw = mockStorage.getItem(SETTINGS_STORAGE_KEY);
      expect(storedRaw).not.toBeNull();
      const parsed = JSON.parse(storedRaw!);
      expect(parsed.retentionDays).toBe(90);
      expect(parsed.colorBlindMode).toBe(true);
      expect(parsed.unknownPricingDisplay).toBe('hide_cost');

      const reloaded = loadSettingsDraft();
      expect(reloaded).toEqual(updated);
    });

    it('handles corrupted JSON in sessionStorage safely without crashing', () => {
      mockStorage.setItem(SETTINGS_STORAGE_KEY, '{"retentionDays": invalid_json...');
      const loaded = loadSettingsDraft();
      expect(loaded).toEqual(DEFAULT_PREFERENCES);
    });

    it('resets settings draft and removes sessionStorage item', () => {
      saveSettingsDraft({
        ...DEFAULT_PREFERENCES,
        retentionDays: 120,
        colorBlindMode: true,
      });

      expect(mockStorage.getItem(SETTINGS_STORAGE_KEY)).not.toBeNull();

      const resetResult = resetSettingsDraft();
      expect(resetResult).toEqual(DEFAULT_PREFERENCES);
      expect(mockStorage.getItem(SETTINGS_STORAGE_KEY)).toBeNull();
    });
  });
});
