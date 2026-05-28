/**
 * OneSatIndexerClient — REST client for the 1Sat overlay API.
 *
 * Discovers BSV-21 UTXOs at wallet-owned addresses, fetches token
 * metadata, and optionally validates that outpoints trace back to the
 * canonical deploy (origin-verification before send).
 *
 * Endpoint patterns mirror @1sat/wallet-toolbox's `Bsv21Client` /
 * `OwnerClient` so future protocol changes show up on a single, shared
 * surface — adjust paths here when the upstream toolkit moves.
 *
 *   Base:                    https://api.1sat.app
 *   Token detail:            GET  /1sat/bsv21/{tokenId}
 *   Unspent (1 address):     GET  /1sat/bsv21/{tokenId}/{lockType}/{address}/unspent
 *   Unspent (multi-address): POST /1sat/bsv21/{tokenId}/{lockType}/unspent
 *                            body: ["addr1", "addr2", …]
 *   Validate outpoints:      POST /1sat/bsv21/{tokenId}/outputs?unspent=true
 *                            body: ["txid_vout", …]
 *   Owner txos (any token):  GET  /1sat/owner/{address}/txos?unspent=true
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
   * of the token's ancestry DAG. Caller treats anything missing as
   * unverified and surfaces a warning to the user.
   */
  async validateOutputs(tokenId: string, outpoints: string[]): Promise<Set<string>> {
    if (outpoints.length === 0) return new Set();
    const url = `${this.baseUrl}/1sat/bsv21/${encodeURIComponent(tokenId)}/outputs?unspent=true`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(outpoints),
    });
    if (!r.ok) return new Set();
    const validated = (await r.json()) as IndexedOutput[];
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
   * POST /1sat/tx — submit a signed transaction so the overlay's BSV-21
   * topic-manager indexes it.
   *
   * This is the load-bearing step for organic discovery on the receiving
   * side: the public 1sat overlay doesn't auto-follow the chain for BSV-21
   * inscriptions, so a tx broadcast via WoC / mAPI / ARC alone is invisible
   * to the overlay's per-address sync. Routing the same bytes through
   * /1sat/tx after the primary broadcast registers the tx with the topic-
   * manager. This is what yours-wallet's @1sat/client does internally on
   * every send and what the demo faucet does after every BSV-21 mint.
   *
   * Best-effort by convention — callers should NOT fail their flow on a
   * non-OK response here. The tx is already on-chain via the primary
   * broadcast; this only adds the indexer entry.
   */
  async submitTransaction(rawTx: number[] | Uint8Array): Promise<{
    ok: boolean;
    status: number;
    body: string;
  }> {
    const bytes = rawTx instanceof Uint8Array ? rawTx : new Uint8Array(rawTx);
    const r = await fetch(`${this.baseUrl}/1sat/tx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytes,
    });
    const body = await r.text();
    return { ok: r.ok, status: r.status, body };
  }
}
