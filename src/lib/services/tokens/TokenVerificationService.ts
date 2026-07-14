/**
 * TokenVerificationService — Back-to-Genesis provenance for held tokens.
 *
 * Wraps BackToGenesisClient with the two things the UI needs on top of the raw
 * endpoint:
 *
 *  1. A per-outpoint cache. An outpoint's provenance is immutable (barring a
 *     reorg), so we verify each `(std, txid, vout)` at most once per session and
 *     persist the verdict in localStorage. A grown wallet then costs zero WOC
 *     calls on a re-open, and a fresh receive costs exactly one.
 *
 *  2. A per-token aggregate. A token card groups several UTXOs; its badge is the
 *     worst verdict among them — one counterfeit output taints the card, and an
 *     `undetermined` (unknown) never masquerades as verified.
 *
 * Why the wallet needs this at all: for classic STAS `assetKey.tokenId` is the
 * issuer PKH, shared by every token that issuer minted, and B2G omits `symbol`.
 * So `authentic` alone cannot tell EXSTAS1 from EXSTAS2 — the resolved `genesis`
 * outpoint is the only stable identity. Callers should group/trust on genesis,
 * which this service surfaces per outpoint.
 *
 * Fail-safe throughout: a transport failure is `undetermined`, never a throw and
 * never a false counterfeit.
 */

import {
  BackToGenesisClient,
  formatGenesisRef,
  type B2GVerifyResult,
  type TokenStd,
} from './woc/BackToGenesisClient';
import type { TokenProtocolId } from './TokenProtocolAdapter';

/** UI-facing rollup of a token card's provenance. */
export type VerificationBadge = 'verified' | 'counterfeit' | 'unknown';

export interface OutpointVerification {
  outpoint: string; // `${txid}_${vout}`
  result: B2GVerifyResult['result'];
  reason?: string;
  /** `${txid}_${vout}` of the resolved genesis — the stable token identity. */
  genesis?: string;
  genesisDepth?: number;
}

/** The minimum an item must expose to be verifiable. */
export interface VerifiableOutput {
  txid: string;
  vout: number;
  protocol: TokenProtocolId;
}

const PROTOCOL_TO_STD: Record<TokenProtocolId, TokenStd> = {
  stas: 'stas',
  dstas: 'dstas',
  'bsv-21': 'bsv21',
};

/** Roll a set of per-outpoint verdicts into one card badge (worst wins). */
export function aggregateBadge(verdicts: OutpointVerification[]): VerificationBadge {
  if (verdicts.length === 0) return 'unknown';
  if (verdicts.some((v) => v.result === 'not-authentic')) return 'counterfeit';
  if (verdicts.every((v) => v.result === 'authentic')) return 'verified';
  return 'unknown'; // at least one undetermined, none counterfeit
}

export class TokenVerificationService {
  private readonly client: BackToGenesisClient;
  private readonly chain: 'main' | 'test';
  private readonly cacheKey: string;
  /** In-memory cache; mirror of the persisted map for the session. */
  private readonly cache = new Map<string, OutpointVerification>();

  constructor(opts: { chain?: 'main' | 'test'; client?: BackToGenesisClient } = {}) {
    this.chain = opts.chain ?? 'main';
    this.client = opts.client ?? new BackToGenesisClient({ chain: this.chain });
    this.cacheKey = `tokenVerification:${this.chain}`;
    this.loadPersisted();
  }

  private key(std: TokenStd, txid: string, vout: number): string {
    return `${std}:${txid}_${vout}`;
  }

  private loadPersisted(): void {
    try {
      const raw = localStorage.getItem(this.cacheKey);
      if (!raw) return;
      const obj = JSON.parse(raw) as Record<string, OutpointVerification>;
      for (const [k, v] of Object.entries(obj)) this.cache.set(k, v);
    } catch {
      /* corrupt cache — ignore, re-verify from scratch */
    }
  }

  private persist(): void {
    try {
      // Persist only settled verdicts. `undetermined` is transient (a 429 or a
      // not-yet-propagated tx) and must be retried on the next load, not frozen.
      const obj: Record<string, OutpointVerification> = {};
      for (const [k, v] of this.cache.entries()) {
        if (v.result !== 'undetermined') obj[k] = v;
      }
      localStorage.setItem(this.cacheKey, JSON.stringify(obj));
    } catch {
      /* quota / unavailable — cache stays in-memory only */
    }
  }

  /** Cached verdict for one outpoint, or undefined if never verified. */
  peek(output: VerifiableOutput): OutpointVerification | undefined {
    const std = PROTOCOL_TO_STD[output.protocol];
    return this.cache.get(this.key(std, output.txid, output.vout));
  }

  /**
   * Verify one outpoint, using the cache unless `force`. A settled verdict
   * (authentic / not-authentic) is never re-fetched; an `undetermined` one is
   * retried, since it means "couldn't decide yet", not "decided: unknown".
   */
  async verifyOutput(
    output: VerifiableOutput,
    opts: { expectedGenesis?: string; force?: boolean } = {}
  ): Promise<OutpointVerification> {
    const std = PROTOCOL_TO_STD[output.protocol];
    const k = this.key(std, output.txid, output.vout);
    const cached = this.cache.get(k);
    if (!opts.force && cached && cached.result !== 'undetermined') return cached;

    const res = await this.client.verify(std, output.txid, output.vout, {
      expectedGenesis: opts.expectedGenesis,
    });
    const verdict: OutpointVerification = {
      outpoint: `${output.txid}_${output.vout}`,
      result: res.result,
      reason: res.reason,
      genesis: res.genesis ? formatGenesisRef(res.genesis) : undefined,
      genesisDepth: res.genesisDepth,
    };
    this.cache.set(k, verdict);
    this.persist();
    return verdict;
  }

  /**
   * Verify many outpoints. Returns a map keyed by `${txid}_${vout}`. Requests
   * go through the shared WOC rate limiter, so passing the whole wallet at once
   * is safe — they queue rather than burst. Cached outpoints resolve instantly.
   */
  async verifyOutputs(
    outputs: VerifiableOutput[],
    opts: { force?: boolean } = {}
  ): Promise<Map<string, OutpointVerification>> {
    const results = await Promise.all(
      outputs.map((o) => this.verifyOutput(o, { force: opts.force }))
    );
    const map = new Map<string, OutpointVerification>();
    results.forEach((v) => map.set(v.outpoint, v));
    return map;
  }
}
