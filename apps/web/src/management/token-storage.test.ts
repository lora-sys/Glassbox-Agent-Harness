import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getManagementToken,
  isManagementTokenPersistent,
  setManagementToken,
  TOKEN_STORAGE_KEY,
} from './adapter';

const token = 'A'.repeat(43);

function storage() {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => { items.set(key, value); },
    removeItem: (key: string) => { items.delete(key); },
  };
}

describe('management token storage', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps the default token in session storage only', () => {
    const session = storage();
    const local = storage();
    vi.stubGlobal('window', {});
    vi.stubGlobal('sessionStorage', session);
    vi.stubGlobal('localStorage', local);

    expect(setManagementToken(token)).toBe(true);
    expect(session.getItem(TOKEN_STORAGE_KEY)).toBe(token);
    expect(local.getItem(TOKEN_STORAGE_KEY)).toBeNull();
    expect(isManagementTokenPersistent(getManagementToken())).toBe(false);
  });

  it('retains an opted-in token across reload and automatic re-verification', () => {
    const session = storage();
    const local = storage();
    vi.stubGlobal('window', {});
    vi.stubGlobal('sessionStorage', session);
    vi.stubGlobal('localStorage', local);

    expect(setManagementToken(token, true)).toBe(true);
    session.removeItem(TOKEN_STORAGE_KEY); // A fresh tab has its own sessionStorage.
    const restored = getManagementToken();
    expect(restored).toBe(token);
    expect(isManagementTokenPersistent(restored)).toBe(true);
    expect(setManagementToken(restored, isManagementTokenPersistent(restored))).toBe(true);
    expect(local.getItem(TOKEN_STORAGE_KEY)).toBe(token);
  });

  it('does not claim persistent success if local storage rejects the token', () => {
    const session = storage();
    const local = storage();
    local.setItem = () => { throw new Error('storage unavailable'); };
    vi.stubGlobal('window', {});
    vi.stubGlobal('sessionStorage', session);
    vi.stubGlobal('localStorage', local);

    expect(setManagementToken(token, true)).toBe(false);
    expect(session.getItem(TOKEN_STORAGE_KEY)).toBeNull();
  });

  it('cleans up a partially written persistent token after a storage error', () => {
    const session = storage();
    const local = storage();
    const write = local.setItem;
    local.setItem = (key, value) => { write(key, value); throw new Error('partial write'); };
    vi.stubGlobal('window', {});
    vi.stubGlobal('sessionStorage', session);
    vi.stubGlobal('localStorage', local);

    expect(setManagementToken(token, true)).toBe(false);
    expect(session.getItem(TOKEN_STORAGE_KEY)).toBeNull();
    expect(local.getItem(TOKEN_STORAGE_KEY)).toBeNull();
  });
});
