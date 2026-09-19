/**
 * @file apps/web/src/management/adapter/preferences.tsx
 *
 * Typed client preference store backed by sessionStorage.
 * Invariants:
 * - Uses existing SettingsProjection schema and fixture defaults.
 * - Validates stored values before use.
 * - Never stores secrets (tokens, credentials, private payloads).
 * - Does not call any backend endpoints and clearly indicates client-session draft semantics.
 */
import React, { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import type { SettingsProjection } from '../types';
import { mockSettingsData } from '../fixtures/settings';

export const SETTINGS_STORAGE_KEY = 'glassbox_settings_draft';

export const DEFAULT_PREFERENCES: SettingsProjection = {
  ...mockSettingsData,
  isLocalDraftDirty: false,
};

/**
 * Validates untrusted or deserialized settings data against the typed schema.
 * Rejects invalid types, out-of-bounds numbers, or unknown enums and safely falls back.
 */
export function validateSettingsDraft(
  raw: unknown,
  fallback: SettingsProjection = DEFAULT_PREFERENCES,
): SettingsProjection {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...fallback, isLocalDraftDirty: false };
  }

  const obj = raw as Record<string, unknown>;

  const retentionDays =
    typeof obj.retentionDays === 'number' &&
    Number.isFinite(obj.retentionDays) &&
    obj.retentionDays >= 7 &&
    obj.retentionDays <= 365
      ? Math.round(obj.retentionDays)
      : fallback.retentionDays;

  const unknownPricingDisplay =
    obj.unknownPricingDisplay === 'show_unknown' || obj.unknownPricingDisplay === 'hide_cost'
      ? obj.unknownPricingDisplay
      : fallback.unknownPricingDisplay;

  const defaultChannelPolicy =
    obj.defaultChannelPolicy === 'owner_only' || obj.defaultChannelPolicy === 'strict_allowlist'
      ? obj.defaultChannelPolicy
      : fallback.defaultChannelPolicy;

  const autoReviewOnWorkerDone =
    typeof obj.autoReviewOnWorkerDone === 'boolean'
      ? obj.autoReviewOnWorkerDone
      : fallback.autoReviewOnWorkerDone;

  const colorBlindMode =
    typeof obj.colorBlindMode === 'boolean'
      ? obj.colorBlindMode
      : fallback.colorBlindMode;

  const enableTraceKeyboardShortcuts =
    typeof obj.enableTraceKeyboardShortcuts === 'boolean'
      ? obj.enableTraceKeyboardShortcuts
      : fallback.enableTraceKeyboardShortcuts;

  return {
    retentionDays,
    unknownPricingDisplay,
    defaultChannelPolicy,
    autoReviewOnWorkerDone,
    colorBlindMode,
    enableTraceKeyboardShortcuts,
    isLocalDraftDirty: false,
  };
}

/**
 * Loads preferences from sessionStorage, validating them before use.
 */
export function loadSettingsDraft(): SettingsProjection {
  if (typeof window === 'undefined' || !window.sessionStorage) {
    return { ...DEFAULT_PREFERENCES };
  }
  try {
    const raw = window.sessionStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PREFERENCES };
    const parsed = JSON.parse(raw);
    return validateSettingsDraft(parsed);
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

/**
 * Saves validated preferences to sessionStorage.
 */
export function saveSettingsDraft(draft: SettingsProjection): SettingsProjection {
  const validated = validateSettingsDraft(draft);
  if (typeof window !== 'undefined' && window.sessionStorage) {
    try {
      window.sessionStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(validated));
    } catch {
      // Storage quota or privacy sandbox errors fail-safe
    }
  }
  return validated;
}

/**
 * Clears saved preferences from sessionStorage and returns default fixture settings.
 */
export function resetSettingsDraft(): SettingsProjection {
  if (typeof window !== 'undefined' && window.sessionStorage) {
    try {
      window.sessionStorage.removeItem(SETTINGS_STORAGE_KEY);
    } catch {
      // ignore
    }
  }
  return { ...DEFAULT_PREFERENCES };
}

export interface PreferencesContextValue {
  settings: SettingsProjection;
  saveSettings: (newSettings: SettingsProjection) => void;
  resetSettings: () => void;
}

export const PreferencesContext = createContext<PreferencesContextValue>({
  settings: DEFAULT_PREFERENCES,
  saveSettings: () => {},
  resetSettings: () => {},
});

export const PreferencesProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [settings, setSettingsState] = useState<SettingsProjection>(() => loadSettingsDraft());

  const saveSettings = useCallback((newSettings: SettingsProjection) => {
    const saved = saveSettingsDraft(newSettings);
    setSettingsState(saved);
  }, []);

  const resetSettings = useCallback(() => {
    const reset = resetSettingsDraft();
    setSettingsState(reset);
  }, []);

  return (
    <PreferencesContext.Provider value={{ settings, saveSettings, resetSettings }}>
      {children}
    </PreferencesContext.Provider>
  );
};

export function usePreferences(): PreferencesContextValue {
  return useContext(PreferencesContext);
}
