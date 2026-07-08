/**
 * Token discovery-source resolution.
 *
 * Single source of truth for WHERE the wallet pulls organic token receives
 * from. Resolution order (most specific first):
 *
 *   1. `localStorage['tokenDiscoverySource']` — user-set override (Settings/debug UI).
 *   2. `import.meta.env.VITE_TOKEN_DISCOVERY_SOURCE` — build-time env override.
 *   3. `'woc'` — the default: WhatsOnChain per-address token endpoints for
 *      STAS / DSTAS / BSV-21 (one provider for all three).
 *
 * `'legacy'` keeps the pre-migration path (Bitails for STAS, the local relay
 * for DSTAS, the 1Sat overlay SSE for BSV-21). Retained one release as a
 * rollback safety net while WOC's production indexers finish rolling out
 * (DSTAS to mainnet; classic-STAS from curated registry to live indexer).
 *
 * The choice is read once at wallet-init time, so changing it requires a
 * reload — same UX as the relay URL and backup storage settings.
 */

export type TokenDiscoverySource = 'woc' | 'legacy';

const LOCAL_STORAGE_KEY = 'tokenDiscoverySource';
const DEFAULT_SOURCE: TokenDiscoverySource = 'woc';

function normalize(v: string | null | undefined): TokenDiscoverySource | null {
  if (v === 'woc' || v === 'legacy') return v;
  return null;
}

/** Returns the resolved discovery source ('woc' by default). */
export function getTokenDiscoverySource(): TokenDiscoverySource {
  try {
    const ls = normalize(localStorage.getItem(LOCAL_STORAGE_KEY));
    if (ls) return ls;
  } catch {
    /* localStorage unavailable in worker / SSR — fall through to env */
  }

  const env = normalize((import.meta as any).env?.VITE_TOKEN_DISCOVERY_SOURCE as string | undefined);
  if (env) return env;

  return DEFAULT_SOURCE;
}

/** Persist the user's discovery-source choice. `null` clears the override. */
export function setTokenDiscoverySource(source: TokenDiscoverySource | null): void {
  try {
    if (source === null) localStorage.removeItem(LOCAL_STORAGE_KEY);
    else localStorage.setItem(LOCAL_STORAGE_KEY, source);
  } catch {
    /* localStorage unavailable — settings will not persist */
  }
}

/** Raw stored value (or null) — for the Settings UI to show explicit choice vs default. */
export function getStoredTokenDiscoverySource(): string | null {
  try {
    return localStorage.getItem(LOCAL_STORAGE_KEY);
  } catch {
    return null;
  }
}
