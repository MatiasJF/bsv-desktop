/**
 * StasRegistration — turn a discovered STAS UTXO into a wallet-recognised
 * output via `internalizeAction` (basket insertion).
 *
 * Flow:
 *   1. defensive idempotency check via stas:query findStasOutputByOutpoint
 *   2. fetch raw tx and merkle path via `wallet.getServices()` — confirmed-only
 *      for MVP, bails out if no merkle path is available yet
 *   3. assemble an AtomicBEEF (Transaction + MerklePath -> Beef -> toBinaryAtomic)
 *   4. `wallet.internalizeAction({ outputs: [{ protocol: 'basket insertion', ... }] })`
 *   5. link the satellite rows (stas_tokens + stas_outputs) to the new
 *      wallet-toolbox `outputs.outputId`
 */

import type { WalletInterface } from '@bsv/sdk';
import { Beef, Transaction } from '@bsv/sdk';
import { STAS_BASKET } from '../../constants/baskets';
import type { ParsedDstas } from './dstasParser';

export interface RegisterStasArgs {
  txid: string;
  vout: number;
  /** Satoshis on the UTXO (from the indexer scan). */
  tokenSatoshis: number;
  /** hash160 of the BRC-42-derived owner key, hex. */
  ownerFieldHash160: string;
  /** BRC-42 keyID, e.g. `"recv 7"`. */
  brc42KeyId: string;
  /** Parsed DSTAS fields. */
  parsed: ParsedDstas;
}

export interface RegisterStasResult {
  registered: boolean;
  txid: string;
  vout: number;
  outputId?: number;
  /** Set when registered=false: human-readable reason. */
  reason?: string;
}

const ORIGINATOR = 'admin.stas-discovery';

export class StasRegistration {
  constructor(
    private readonly wallet: WalletInterface,
    private readonly identityKey: string,
    private readonly chain: 'main' | 'test'
  ) {}

  async register(args: RegisterStasArgs): Promise<RegisterStasResult> {
    const { txid, vout, parsed, brc42KeyId, ownerFieldHash160, tokenSatoshis } = args;

    // 1. Idempotency — skip outpoints that already live in stas_outputs.
    try {
      const existing = await this.stasQuery('findStasOutputByOutpoint', [txid, vout]);
      if (existing) {
        return {
          registered: false,
          txid,
          vout,
          outputId: existing.outputId,
          reason: 'already registered',
        };
      }
    } catch (err) {
      // Query channel missing (e.g. unit tests without IPC) — proceed cautiously.
      if (!isQueryUnavailable(err)) throw err;
    }

    // 2. Fetch raw tx + merkle proof from the wallet's own services. This means
    //    the wallet uses whichever indexer it's already configured for (WoC
    //    today) — we don't reinvent that surface.
    const services: any = (this.wallet as any).getServices?.();
    if (!services) {
      return { registered: false, txid, vout, reason: 'wallet.getServices() unavailable' };
    }

    let rawTxRes: any;
    try {
      rawTxRes = await services.getRawTx(txid);
    } catch (err) {
      return {
        registered: false,
        txid,
        vout,
        reason: `getRawTx failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (!rawTxRes?.rawTx) {
      return {
        registered: false,
        txid,
        vout,
        reason: rawTxRes?.error?.message ?? 'getRawTx returned no rawTx',
      };
    }

    let mpRes: any;
    try {
      mpRes = await services.getMerklePath(txid);
    } catch (err) {
      return {
        registered: false,
        txid,
        vout,
        reason: `getMerklePath failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (!mpRes?.merklePath) {
      // Confirmed-only MVP — defer until the tx confirms.
      return { registered: false, txid, vout, reason: 'no merkle proof yet (deferred)' };
    }

    // 3. Build AtomicBEEF.
    let atomicBeef: number[];
    try {
      const tx = Transaction.fromBinary(rawTxRes.rawTx as number[]);
      tx.merklePath = mpRes.merklePath;
      const beef = new Beef();
      beef.mergeTransaction(tx);
      atomicBeef = beef.toBinaryAtomic(txid);
    } catch (err) {
      return {
        registered: false,
        txid,
        vout,
        reason: `BEEF assembly failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // 4. internalizeAction (basket insertion).
    const customInstructions = JSON.stringify({
      tokenId: parsed.tokenId,
      brc42KeyId,
      flagsHex: parsed.flagsHex,
      serviceFields: parsed.serviceFields,
    });
    try {
      await this.wallet.internalizeAction(
        {
          tx: atomicBeef,
          outputs: [
            {
              outputIndex: vout,
              protocol: 'basket insertion',
              insertionRemittance: {
                basket: STAS_BASKET,
                customInstructions,
                tags: ['dstas'],
              },
            },
          ],
          description: 'STAS discovery',
          seekPermission: false,
        },
        ORIGINATOR
      );
    } catch (err) {
      return {
        registered: false,
        txid,
        vout,
        reason: `internalizeAction failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // 5. Link satellite tables. The wallet-toolbox `outputs` row was created
    //    inside internalizeAction; we look it up by outpoint to populate ours.
    let outputId: number | undefined;
    try {
      outputId = await this.stasQuery('findOutputIdByOutpoint', [txid, vout]);
      if (outputId) {
        const now = new Date().toISOString();
        await this.stasQuery('upsertStasToken', [
          {
            tokenId: parsed.tokenId,
            symbol: 'STAS', // refined when richer parsing lands in Task 5
            name: undefined,
            satoshisPerToken: 1,
            freezeEnabled: parsed.freezeEnabled,
            confiscationEnabled: parsed.confiscationEnabled,
            redemptionPkh: parsed.tokenId,
            issuerIdentityKey: undefined,
            flagsHex: parsed.flagsHex,
            createdAt: now,
          },
        ]);
        await this.stasQuery('insertStasOutput', [
          {
            outputId,
            tokenId: parsed.tokenId,
            brc42KeyId,
            ownerFieldHash160,
            tokenSatoshis,
            frozen: false,
            confiscated: false,
            serviceFieldsJson: JSON.stringify(parsed.serviceFields),
            createdAt: now,
            updatedAt: now,
          },
        ]);
      }
    } catch (err) {
      // The token is internalized regardless; satellite linkage is best-effort.
      // Log but report registered=true so the discovery loop does not retry.
      if (!isQueryUnavailable(err)) {
        // eslint-disable-next-line no-console
        console.warn(`[StasRegistration] satellite linkage failed for ${txid}:${vout}`, err);
      }
    }

    return { registered: true, txid, vout, outputId };
  }

  private async stasQuery(method: string, args: any[]): Promise<any> {
    const api =
      typeof window !== 'undefined' ? (window as any).electronAPI?.stas : undefined;
    if (!api) {
      throw new QueryUnavailableError('STAS query channel unavailable');
    }
    const res = await api.query(this.identityKey, this.chain, method, args);
    if (!res || !res.success) {
      throw new Error(`stas:query ${method} failed: ${res && res.error}`);
    }
    return res.result;
  }
}

class QueryUnavailableError extends Error {
  readonly _queryUnavailable = true;
}

function isQueryUnavailable(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as any)._queryUnavailable === true;
}
