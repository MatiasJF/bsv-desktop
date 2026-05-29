/**
 * RelayClient — HTTP client for the stas-relay service.
 *
 * The relay is a stateless address→txid mailbox used to bridge the
 * organic-receive gap for tokens with no public indexer:
 *
 * - DSTAS — Bitails's STAS-aware matcher rejects DSTAS template scripts
 * - BSV-21 transfers of unactivated tokens — 1sat-stack's per-token
 *   topic-manager isn't running until the issuer funds `fee_address`
 *
 * Senders push (txid, recipientAddress, protocol) after broadcast;
 * receivers poll per derived address during their discovery scan.
 *
 * The wallet only uses the pull side — pushing is the sender's job
 * (see `demo/stas-faucet/lib/mint-dstas.mjs`).
 *
 * Default relay URL is `http://127.0.0.1:8081` (the demo deployment).
 * Production deployments should pass a real URL. If the relay is
 * unreachable, pull methods return empty results — the scan continues
 * without the relay-assist, so a relay outage doesn't break discovery.
 */

/** A single relay entry returned by pull / pull-multi. */
export interface RelayEntry {
  /** Monotonic id assigned by the relay. Used for incremental polling. */
  id: number;
  /** 64-hex tx id. */
  txid: string;
  /** Short protocol identifier — `dstas` | `bsv-21` | `stas` | `other`. */
  protocol: string;
  /** Unix epoch seconds. */
  created_at: number;
}

export interface RelayClientOptions {
  /** Base URL of the relay. Default `http://127.0.0.1:8081`. */
  baseUrl?: string;
  /** Fetch timeout per call in ms. Default 8000. */
  timeoutMs?: number;
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:8081';

export class RelayClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: RelayClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs ?? 8000;
  }

  /**
   * GET /relay/pull?addr=<base58>&since=<id>&limit=<n>
   *
   * Returns `null` on any network error or non-2xx response — callers
   * should treat null as "relay unavailable, skip the assist" rather
   * than fail the scan.
   */
  async pull(
    address: string,
    opts: { sinceId?: number; limit?: number } = {},
  ): Promise<RelayEntry[] | null> {
    const url = new URL(`${this.baseUrl}/relay/pull`);
    url.searchParams.set('addr', address);
    if (opts.sinceId !== undefined) url.searchParams.set('since', String(opts.sinceId));
    if (opts.limit !== undefined) url.searchParams.set('limit', String(opts.limit));
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const r = await fetch(url.toString(), { signal: ctl.signal });
      if (!r.ok) return null;
      const body = (await r.json()) as { entries?: RelayEntry[] } | null;
      return Array.isArray(body?.entries) ? body!.entries : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * POST /relay/pull-multi
   * body: { addresses, sinceId?, limit? }
   *
   * Bulk variant — single round-trip for an entire BRC-42 gap walk.
   * Returns `Map<address, RelayEntry[]>` (addresses with no entries
   * map to an empty array, so the caller can rely on key presence).
   * Returns `null` on any error — same fail-soft contract as `pull`.
   */
  async pullMulti(
    addresses: string[],
    opts: { sinceId?: number; limit?: number } = {},
  ): Promise<Map<string, RelayEntry[]> | null> {
    if (addresses.length === 0) return new Map();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const r = await fetch(`${this.baseUrl}/relay/pull-multi`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          addresses,
          sinceId: opts.sinceId ?? 0,
          limit: opts.limit ?? 200,
        }),
        signal: ctl.signal,
      });
      if (!r.ok) return null;
      const body = (await r.json()) as { grouped?: Record<string, RelayEntry[]> } | null;
      const grouped = body?.grouped;
      if (!grouped || typeof grouped !== 'object') return null;
      const out = new Map<string, RelayEntry[]>();
      for (const a of addresses) {
        const entries = grouped[a];
        out.set(a, Array.isArray(entries) ? entries : []);
      }
      return out;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * POST /relay/push — wallet doesn't typically push (that's the sender's
   * job), but the method is here for completeness so future flows (e.g.
   * a "share this with the recipient via relay" button) can use it.
   *
   * Idempotent on the relay side; this method returns the response shape
   * (`{ id, duplicate? }`) verbatim, or null on error.
   */
  async push(args: {
    txid: string;
    recipientAddress: string;
    protocol: string;
  }): Promise<{ id: number; duplicate?: boolean } | null> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const r = await fetch(`${this.baseUrl}/relay/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
        signal: ctl.signal,
      });
      if (!r.ok) return null;
      const body = (await r.json()) as { id?: number; duplicate?: boolean } | null;
      if (!body || typeof body.id !== 'number') return null;
      return { id: body.id, duplicate: !!body.duplicate };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
