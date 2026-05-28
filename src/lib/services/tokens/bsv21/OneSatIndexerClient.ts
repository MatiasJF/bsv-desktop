/**
 * OneSatIndexerClient — REST client for the 1Sat overlay API.
 *
 * Discovers BSV-21 UTXOs at wallet-owned addresses, fetches token
 * metadata, and optionally validates that outpoints trace back to the
 * canonical deploy (origin-verification before send).
 *
 * Endpoint patterns mirror @1sat/wallet-toolbox's `Bsv21Client` /
 * `OwnerClient` / `OverlayClient` so future protocol changes show up on
 * a single, shared surface — adjust paths here when the upstream toolkit
 * moves.
 *
 *   Base:                    https://api.1sat.app
 *   Token detail:            GET  /1sat/bsv21/{tokenId}
 *   Unspent (1 address):     GET  /1sat/bsv21/{tokenId}/{lockType}/{address}/unspent
 *   Unspent (multi-address): POST /1sat/bsv21/{tokenId}/{lockType}/unspent
 *                            body: ["addr1", "addr2", …]
 *   Validate outpoints:      POST /1sat/bsv21/{tokenId}/outputs?unspent=true
 *                            body: ["txid_vout", …]
 *   Owner txos (any token):  GET  /1sat/owner/{address}/txos?unspent=true
 *   Overlay submit (BSV-21): POST /1sat/bsv21/overlay/submit
 *                            header: X-Topics: tm_bsv21 | tm_<tokenId>
 *                            body: BEEF bytes
 *
 * Outpoint shape is `txid_vout` (underscore), matching the 1Sat overlay.
 * Callers that use `txid.vout` (the rest of this wallet) must convert.
 */

import {
  ONESAT_API_DEFAULT_MAIN,
  ONESAT_API_DEFAULT_TEST,
  ONESAT_LOCK_TYPE_P2PKH,
} from './constants';

export interface IndexedOutput {
  /** `txid_vout` (underscore). */
  outpoint: string;
  /** Token id (deploy outpoint, also `txid_vout`). */
  id?: string;
  /** Token amount, stringified bigint. */
  amt?: string;
  /** Decimals (only on deploy+mint payloads). */
  dec?: number;
  sym?: string;
  icon?: string;
  /** Address that owns the output. */
  owner?: string;
  /** Output value in satoshis (BSV-21 transfers are always 1 sat). */
  satoshis?: number;
  /** Confirmation block height — 0 / undefined means mempool. */
  height?: number;
  /** Event / tag list assigned by the indexer (e.g. ["bsv21"]). */
  events?: string[];
}

export interface TokenDetailResponse {
  /** Token id — `txid_vout`. */
  id?: string;
  tick?: string;
  sym?: string;
  dec?: number;
  icon?: string;
  supply?: string;
  max?: string;
  lim?: string;
  fundAddress?: string;
  /** Many other indexer-internal fields exist; pass-through tolerated. */
  [key: string]: unknown;
}

export interface OneSatIndexerOptions {
  /** Base URL override — defaults to api.1sat.app per chain. */
  baseUrl?: string;
  /** 'main' or 'test'. Default 'main'. */
  chain?: 'main' | 'test';
  /** Lock-type path segment. Default 'p2pkh'. */
  lockType?: string;
}

/**
 * Result of a `/1sat/bsv21/overlay/submit` call. Wraps the raw response so
 * callers can log on failure but proceed — the wallet has already
 * broadcast through ARC; the overlay submit is the indexer-coupling step.
 */
export interface OverlaySubmitResult {
  ok: boolean;
  status: number;
  /** Server-returned body, truncated by the caller as needed. */
  body: string;
  /** Parsed STEAK response on 200, when present. */
  steak?: unknown;
}

export class OneSatIndexerClient {
  private readonly baseUrl: string;
  private readonly lockType: string;

  constructor(opts: OneSatIndexerOptions = {}) {
    const chain = opts.chain ?? 'main';
    this.baseUrl =
      opts.baseUrl ?? (chain === 'main' ? ONESAT_API_DEFAULT_MAIN : ONESAT_API_DEFAULT_TEST);
    this.lockType = opts.lockType ?? ONESAT_LOCK_TYPE_P2PKH;
  }

  /** GET /1sat/bsv21/{tokenId} — token metadata (symbol, decimals, icon). */
  async getTokenDetails(tokenId: string): Promise<TokenDetailResponse | null> {
    const r = await fetch(`${this.baseUrl}/1sat/bsv21/${encodeURIComponent(tokenId)}`);
    if (!r.ok) return null;
    return (await r.json()) as TokenDetailResponse;
  }

  /**
   * GET /1sat/bsv21/{id}/{lockType}/{address}/unspent — unspent BSV-21
   * outputs at a single address for the given token.
   */
  async getUnspentAtAddress(tokenId: string, address: string): Promise<IndexedOutput[]> {
    const url = `${this.baseUrl}/1sat/bsv21/${encodeURIComponent(tokenId)}/${this.lockType}/${encodeURIComponent(address)}/unspent`;
    const r = await fetch(url);
    if (!r.ok) return [];
    return (await r.json()) as IndexedOutput[];
  }

  /**
   * POST /1sat/bsv21/{id}/{lockType}/unspent — unspent BSV-21 outputs
   * across many addresses (the bulk shape used by sendBsv21).
   */
  async getUnspentForAddresses(tokenId: string, addresses: string[]): Promise<IndexedOutput[]> {
    if (addresses.length === 0) return [];
    const url = `${this.baseUrl}/1sat/bsv21/${encodeURIComponent(tokenId)}/${this.lockType}/unspent`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(addresses),
    });
    if (!r.ok) return [];
    return (await r.json()) as IndexedOutput[];
  }

  /**
   * GET /1sat/owner/{address}/txos?unspent=true — every unspent output
   * the overlay attributes to this address, regardless of token.
   *
   * Wire format: `text/event-stream`. The server emits framing events
   * (`event: sync` with `{"phase":"fetch"|"done"}`, terminal `event: done`)
   * and zero-or-more output events whose `data:` line is an
   * `IndexedOutput`. We parse the stream incrementally and accumulate.
   *
   * The 1sat-wallet-toolbox's OwnerClient does the same — its sync()
   * is documented as "Server-Sent Events stream of SyncOutput objects".
   * We absorb the stream and return the accumulated array so callers
   * stay JSON-shaped.
   *
   * Stops on the terminal `event: done` frame, the abort signal, or
   * stream EOF — whichever comes first.
   */
  async getOwnedTxos(address: string, opts: { timeoutMs?: number } = {}): Promise<IndexedOutput[]> {
    const url = `${this.baseUrl}/1sat/owner/${encodeURIComponent(address)}/txos?unspent=true`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
    let r: Response;
    try {
      r = await fetch(url, {
        headers: { Accept: 'text/event-stream' },
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timer);
      return [];
    }
    if (!r.ok || !r.body) {
      clearTimeout(timer);
      return [];
    }

    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    const out: IndexedOutput[] = [];
    let buf = '';
    let terminated = false;

    try {
      while (!terminated) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // SSE frames are separated by a blank line (\n\n).
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let event = 'message';
          let data = '';
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trimStart();
          }
          // `event: done` signals end-of-stream from the server.
          if (event === 'done') { terminated = true; break; }
          // `event: sync` carries phase metadata, not outputs — skip.
          if (event === 'sync' || !data) continue;
          // Everything else is treated as an IndexedOutput payload. The
          // server uses `event: txo` (or similar) for real outputs; we
          // accept any data-bearing event whose payload looks JSON-y
          // so a server-side rename doesn't silently break discovery.
          let parsed: any;
          try { parsed = JSON.parse(data); } catch { continue; }
          if (parsed && typeof parsed === 'object' && typeof parsed.outpoint === 'string') {
            out.push(parsed as IndexedOutput);
          }
        }
      }
    } catch {
      // Treat aborts / network errors as "no results" — the discovery
      // loop iterates over many addresses and one bad stream shouldn't
      // poison the whole scan.
    } finally {
      clearTimeout(timer);
      try { await reader.cancel(); } catch { /* best-effort */ }
    }

    return out;
  }

  /**
   * POST /1sat/bsv21/{id}/outputs?unspent=true — origin-validate a batch
   * of outpoints. Returns the subset the overlay considers a valid part
   * of the token's ancestry DAG.
   *
   * Tri-state return:
   *   - `Set<string>` (possibly empty): overlay responded with an array;
   *     each element is a known-valid outpoint
   *   - `null`: overlay returned a `null` body (status 200 with `null` JSON,
   *     which happens for tokens whose per-token topic-manager isn't
   *     active — the 1sat-stack fee-gate keeps `tm_{tokenId}` workers off
   *     until the issuer funds the fee_address). Caller should treat this
   *     as "validation unavailable", not "validation failed".
   *
   * The fetch is wrapped in try/catch so callers don't have to — network
   * errors also surface as `null`.
   */
  async validateOutputs(tokenId: string, outpoints: string[]): Promise<Set<string> | null> {
    if (outpoints.length === 0) return new Set();
    const url = `${this.baseUrl}/1sat/bsv21/${encodeURIComponent(tokenId)}/outputs?unspent=true`;
    let r: Response;
    try {
      r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(outpoints),
      });
    } catch {
      return null; // network error → "unavailable"
    }
    if (!r.ok) return null;
    let validated: IndexedOutput[] | null;
    try {
      validated = (await r.json()) as IndexedOutput[] | null;
    } catch {
      return null;
    }
    if (validated === null || validated === undefined) return null;
    if (!Array.isArray(validated)) return null;
    return new Set(validated.map((v) => v.outpoint));
  }

  /** Convert our wallet's `txid.vout` outpoints into the indexer's `txid_vout` form. */
  static dotToUnderscore(outpoint: string): string {
    return outpoint.replace('.', '_');
  }
  /** And the reverse. */
  static underscoreToDot(outpoint: string): string {
    return outpoint.replace('_', '.');
  }

  /**
   * POST /1sat/bsv21/overlay/submit — feed a BSV-21 transaction into the
   * overlay's topic-manager.
   *
   * This is the load-bearing step for organic-receive on the recipient
   * side. The overlay's BSV-21 topic-manager (mounted on the public
   * `api.1sat.app` at `/1sat/bsv21/overlay/submit`) accepts BEEF-encoded
   * transactions plus an `X-Topics` header listing the topics to consider
   * admission to. Once admitted, the new outputs surface in:
   *   - `GET /1sat/bsv21/{tokenId}`             (token detail)
   *   - `GET /1sat/owner/{addr}/txos`           (per-owner sync, what our
   *                                              discovery scan consumes)
   *   - `GET /1sat/bsv21/{tokenId}/p2pkh/{addr}/unspent`
   *
   * Topics:
   *   - `tm_bsv21` — discovery topic. Use for deploy+mint / deploy+auth
   *     so the topic-manager registers the token AND triggers per-token
   *     worker creation downstream. Pass `{ tokenId: undefined }`.
   *   - `tm_<tokenId>` — per-token topic. Use for transfers; admission
   *     validates the token's ancestry DAG. Pass `{ tokenId }`.
   *
   * Body: BEEF bytes (not raw tx). The BEEF must include parent funding
   * transactions with their merkle proofs so the topic-manager can verify
   * the chain. wallet-toolbox's `signAction` returns an AtomicBEEF with
   * proven parents — pass `signResp.tx` directly.
   *
   * Empirical baseline (2026-05-28):
   *   - raw tx bytes → 500 (overlay can't parse without BEEF framing)
   *   - BEEF without merkle proofs in parents → 500
   *   - BEEF with parent merkle proofs → 200 STEAK
   *
   * Best-effort by convention — callers should NOT fail their flow on a
   * non-OK response. The tx is already on-chain via the primary broadcast;
   * this only adds the indexer entry. If overlay submit fails today, the
   * tx becomes discoverable when JungleBus's auto-pickup catches it (which
   * also requires the inscription to be in canonical form — see the note in
   * `inscription.ts` about `OP_1` for the content-type tag).
   */
  async submitTransaction(
    beef: number[] | Uint8Array,
    opts: { tokenId?: string } = {},
  ): Promise<OverlaySubmitResult> {
    const bytes = beef instanceof Uint8Array ? beef : new Uint8Array(beef);
    // tm_bsv21 admits any deploy. tm_{tokenId} validates transfers against
    // the deploy's ancestry. The SDK pattern in @1sat/client@0.0.38 is to
    // use whichever matches the operation; we let the caller decide via
    // opts.tokenId — undefined → discovery, defined → per-token.
    const topic = opts.tokenId ? `tm_${opts.tokenId}` : 'tm_bsv21';
    const r = await fetch(`${this.baseUrl}/1sat/bsv21/overlay/submit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Topics': topic,
      },
      body: bytes,
    });
    const body = await r.text();
    let steak: unknown;
    if (r.ok) {
      try { steak = JSON.parse(body); } catch { /* leave undefined */ }
    }
    return { ok: r.ok, status: r.status, body, steak };
  }
}
