/**
 * buildChainedAtomicBeef — assemble an AtomicBEEF for a target txid even when
 * the target itself is unconfirmed (mempool).
 *
 * Why this exists. `wallet.internalizeAction(...)` ultimately calls
 * `Beef.verify(chainTracker, false)` from `@bsv/sdk`. That validator does NOT
 * require every tx in the BEEF to have its own merkle proof — a tx with full
 * rawTx but no proof is accepted **as long as its inputs chain back to a
 * confirmed bump somewhere in the BEEF**. The hardcoded `allowTxidOnly: false`
 * in wallet-toolbox only rejects txid-only entries (hash-only, no bytes), not
 * proof-less full rawTx entries.
 *
 * Net: to internalize a mempool STAS, we need to bundle the target tx PLUS its
 * input ancestry recursively until every leaf input has a merkle proof (or is
 * coinbase). For a typical Issue tx still in mempool the chain is short:
 *   Issue (mempool) → Contract (mempool) → Funding (confirmed, has proof).
 *
 * Recursion is capped (default 10 hops) — STAS chains stay short in practice,
 * the cap protects against pathological inputs.
 */

import { Beef, Transaction, type MerklePath, type WalletInterface } from '@bsv/sdk';

const COINBASE_TXID =
  '0000000000000000000000000000000000000000000000000000000000000000';

export interface BuildChainedBeefArgs {
  wallet: WalletInterface;
  /** Target txid to internalize. */
  txid: string;
  /** Max input-chain hops to walk back before giving up. Default 10. */
  maxDepth?: number;
}

export interface BuildChainedBeefResult {
  /** AtomicBEEF bytes ready for `internalizeAction(tx: ...)`. */
  atomicBeef: number[];
  /**
   * Plain BEEF bytes (no AtomicBEEF prefix) ready for `createAction(inputBEEF: ...)`.
   * Same payload as `atomicBeef` minus the BRC-95 prefix + atomic txid.
   */
  beef: number[];
  /** Total txs included in the BEEF (target + ancestors). */
  txCount: number;
  /**
   * Number of input-chain hops walked. `0` = target tx had its own merkle path.
   * Useful for telemetry and detecting "this took a while".
   */
  depth: number;
}

/**
 * Build an AtomicBEEF for `txid`. Walks the input chain backwards as needed
 * until every leaf has a merkle proof. Throws if the chain exceeds `maxDepth`
 * or any required tx cannot be fetched.
 */
export async function buildChainedAtomicBeef(
  args: BuildChainedBeefArgs
): Promise<BuildChainedBeefResult> {
  const maxDepth = args.maxDepth ?? 10;
  const services: any = (args.wallet as any).getServices?.();
  if (!services) {
    throw new Error('wallet.getServices() unavailable');
  }

  const beef = new Beef();
  const seen = new Set<string>();
  let maxDepthSeen = 0;

  async function walk(currentTxid: string, depth: number): Promise<void> {
    if (depth > maxDepth) {
      throw new Error(
        `chained BEEF: input-chain depth exceeded ${maxDepth} hops at ${currentTxid}`
      );
    }
    if (seen.has(currentTxid)) return;
    seen.add(currentTxid);
    if (depth > maxDepthSeen) maxDepthSeen = depth;

    // 1. fetch rawTx
    let rawTxRes: any;
    try {
      rawTxRes = await services.getRawTx(currentTxid);
    } catch (err) {
      throw new Error(
        `chained BEEF: getRawTx(${currentTxid}) threw: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (!rawTxRes?.rawTx) {
      throw new Error(
        `chained BEEF: getRawTx(${currentTxid}) returned no rawTx (${rawTxRes?.error?.message ?? 'no error message'})`
      );
    }

    const tx = Transaction.fromBinary(rawTxRes.rawTx as number[]);

    // 2. try to get a merkle proof
    let mp: MerklePath | undefined;
    try {
      const mpRes: any = await services.getMerklePath(currentTxid);
      if (mpRes?.merklePath) {
        mp = mpRes.merklePath as MerklePath;
      }
    } catch {
      // ignore: tx is mempool / no proof yet, will recurse on inputs
    }

    if (mp) {
      // Confirmed leaf: attach the proof and stop recursion on this branch.
      tx.merklePath = mp;
      beef.mergeTransaction(tx);
      return;
    }

    // Mempool: add the rawTx with no proof, then chain back through inputs.
    beef.mergeTransaction(tx);

    for (const input of tx.inputs) {
      const sourceTxid: string | undefined =
        (input as any).sourceTXID ?? input.sourceTransaction?.id('hex');
      if (!sourceTxid) {
        throw new Error(
          `chained BEEF: input on ${currentTxid} has no source txid`
        );
      }
      if (sourceTxid === COINBASE_TXID) continue;
      await walk(sourceTxid, depth + 1);
    }
  }

  await walk(args.txid, 0);

  return {
    atomicBeef: beef.toBinaryAtomic(args.txid),
    beef: beef.toBinary(),
    txCount: seen.size,
    depth: maxDepthSeen,
  };
}
