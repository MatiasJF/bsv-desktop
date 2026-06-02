/**
 * Relay URL resolution.
 *
 * Single source of truth for which stas-relay the wallet talks to. Resolution
 * order (most specific first):
 *
 *   1. `localStorage['relayUrl']` — user-set override via Settings UI.
 *      Empty string disables the relay entirely.
 *   2. `import.meta.env.VITE_RELAY_URL` — build-time env override.
 *      Empty string also disables.
 *   3. `http://127.0.0.1:8081` — the local demo deployment.
 *
 * The relay only takes effect at wallet-init time, so changing the setting
 * requires a reload (same UX as backup storage URLs).
 */

const LOCAL_STORAGE_KEY = 'relayUrl';
const DEFAULT_RELAY_URL = 'http://127.0.0.1:8081';

/**
 * Returns the resolved relay URL, or `null` if the user has explicitly
 * disabled the relay (empty string override).
 */
export function getRelayUrl(): string | null {
  let ls: string | null = null;
  try {
    ls = localStorage.getItem(LOCAL_STORAGE_KEY);
  } catch {
    /* localStorage unavailable in worker / SSR — fall through to env */
  }
  if (ls !== null) {
    return ls === '' ? null : ls;
  }

  const envUrl = (import.meta as any).env?.VITE_RELAY_URL as string | undefined;
  if (envUrl !== undefined) {
    return envUrl === '' ? null : envUrl;
  }

  return DEFAULT_RELAY_URL;
}

/**
 * Persist the user's relay URL choice. Empty string disables the relay.
 * `null` clears the override (falls back to env / default on next read).
 */
export function setRelayUrl(url: string | null): void {
  try {
    if (url === null) {
      localStorage.removeItem(LOCAL_STORAGE_KEY);
    } else {
      localStorage.setItem(LOCAL_STORAGE_KEY, url);
    }
  } catch {
    /* localStorage unavailable — settings will not persist */
  }
}

/**
 * Returns the raw stored value (or null if unset) — used by the Settings UI
 * to show what the user has explicitly chosen vs. what's coming from env.
 */
export function getStoredRelayUrl(): string | null {
  try {
    return localStorage.getItem(LOCAL_STORAGE_KEY);
  } catch {
    return null;
  }
}

export const DEFAULT_RELAY_URL_CONST = DEFAULT_RELAY_URL;
