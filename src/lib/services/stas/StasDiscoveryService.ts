/**
 * StasDiscoveryService — the renderer-only orchestrator that closes the
 * receive loop.
 *
 *   enumerate derived owner addresses
 *   → scan WoC for UTXOs at each
 *   → fetch each candidate tx via wallet.getServices() to read its script
 *   → parse as DSTAS and match owner field
 *   → register via StasRegistration (confirmed-only MVP)
 *   → return a structured ScanResult
 *
 * No timer; one scan per invocation. Auto-fired on wallet ready, and re-fired
 * by the dev-only debug panel button.
 */

import { Transaction } from '@bsv/sdk';
import { Address, fromHex } from 'dxs-bsv-token-sdk/bsv';
import { STAS_GAP_LIMIT } from './constants';
import { parseDstasLockingScript, type ParsedDstas } from './dstasParser';
import type { StasKeyDeriver } from './StasKeyDeriver';
import type { StasRegistration } from './StasRegistration';
import type { IndexerClient } from './IndexerClient';
import { stasQuery } from './stasIpc';

export interface ScanResult {
  scannedAddresses: number;
  /** Total UTXOs the indexer returned across all scanned addresses. */
  candidates: number;
  /** Candidates whose locking script parsed as DSTAS. */
  dstas: number;
  /** DSTAS UTXOs whose owner field matched a derived key. */
  ownedAndDstas: number;
  registered: number;
  /** Owned DSTAS that we deferred (unconfirmed / no merkle proof yet). */
  deferred: number;
  skippedAlreadyKnown: number;
  errors: Array<{ txid?: string; vout?: number; message: string }>;
  /** Set when registration succeeded — outpoints + token info for the UI. */
  registeredOutpoints: Array<{ txid: string; vout: number; tokenId: string }>;
}

export interface StasDiscoveryDeps {
  deriver: StasKeyDeriver;
  indexer: IndexerClient;
  registration: StasRegistration;
  /** Wallet exposing `getServices()` (wallet-toolbox Wallet). */
  wallet: any;
  gapLimit?: number;
}

export class StasDiscoveryService {
  constructor(private readonly deps: StasDiscoveryDeps) {}

  async scan(): Promise<ScanResult> {
    const result: ScanResult = {
      scannedAddresses: 0,
      candidates: 0,
      dstas: 0,
      ownedAndDstas: 0,
      registered: 0,
      deferred: 0,
      skippedAlreadyKnown: 0,
      errors: [],
      registeredOutpoints: [],
    };
    const gap = this.deps.gapLimit ?? STAS_GAP_LIMIT;
    const identityKey = this.deps.deriver.identityKey;
    const chain = this.deps.deriver.chain;

    // 1. Enumerate derived owner fields (hash160 -> keyIndex). Memoized in the
    //    deriver, so repeated scans are cheap after the first.
    //
    // Bootstrap mode: when hwm === 0 no receive context has ever been issued,
    // so a full BIP-32-style gap scan is pure waste (and floods WoC). Cap the
    // effective range at a small bootstrap window — enough to cover the
    // "send to recv 1..N without preparation" case but cheap on bandwidth.
    const hwm = await this.deps.deriver.getHighWaterMark();
    const bootstrapGap = 5;
    const effectiveUpTo = hwm > 0 ? hwm + gap : Math.min(bootstrapGap, gap);
    const ownerMap = await this.deps.deriver.enumerateOwnerFields(effectiveUpTo);

    // 2. Convert each hash160 to a base58 address for WoC.
    const addressToHash = new Map<string, string>();
    for (const hash160Hex of ownerMap.keys()) {
      try {
        const address = new Address(fromHex(hash160Hex)).Value as string;
        addressToHash.set(address, hash160Hex);
      } catch {
        // Skip undecodable owner fields; should not happen in practice.
      }
    }
    result.scannedAddresses = addressToHash.size;

    // 3. Bulk WoC UTXO scan.
    const addresses = [...addressToHash.keys()];
    const scanned = await this.deps.indexer.getUtxosForAddresses(addresses);

    // 4. Walk each UTXO: fetch tx, parse output script, match, register.
    const services = (this.deps.wallet as any).getServices?.();
    if (!services) {
      result.errors.push({ message: 'wallet.getServices() unavailable' });
      return result;
    }
    const txCache = new Map<string, Transaction>();

    for (const { utxos } of scanned) {
      for (const utxo of utxos) {
        result.candidates++;
        try {
          // Idempotency pre-check — saves fetching tx/proof for known outpoints.
          try {
            const existing = await stasQuery(identityKey, chain, 'findStasOutputByOutpoint', [utxo.txid, utxo.vout]);
            if (existing) {
              result.skippedAlreadyKnown++;
              continue;
            }
          } catch {
            // Channel error: best-effort; let registration handle the duplicate.
          }

          // Fetch tx once per txid.
          let tx = txCache.get(utxo.txid);
          if (!tx) {
            const rawTxRes = await services.getRawTx(utxo.txid);
            if (!rawTxRes?.rawTx) {
              result.errors.push({
                txid: utxo.txid,
                vout: utxo.vout,
                message: rawTxRes?.error?.message ?? 'getRawTx returned no rawTx',
              });
              continue;
            }
            tx = Transaction.fromBinary(rawTxRes.rawTx as number[]);
            txCache.set(utxo.txid, tx);
          }

          const out = tx.outputs[utxo.vout];
          if (!out) {
            result.errors.push({
              txid: utxo.txid,
              vout: utxo.vout,
              message: 'output index out of range',
            });
            continue;
          }
          const lockingScriptHex = out.lockingScript.toHex();
          const parsed: ParsedDstas | null = parseDstasLockingScript(lockingScriptHex);
          if (!parsed) continue;
          result.dstas++;

          // Owner-field match.
          const keyIndex = ownerMap.get(parsed.ownerFieldHash160);
          if (keyIndex === undefined) continue;
          result.ownedAndDstas++;

          // Confirmed-only MVP — defer mempool UTXOs.
          if (!utxo.height || utxo.height === 0) {
            result.deferred++;
            continue;
          }

          const reg = await this.deps.registration.register({
            txid: utxo.txid,
            vout: utxo.vout,
            tokenSatoshis: utxo.value,
            ownerFieldHash160: parsed.ownerFieldHash160,
            brc42KeyId: `recv ${keyIndex}`,
            parsed,
          });

          if (reg.registered) {
            result.registered++;
            result.registeredOutpoints.push({
              txid: utxo.txid,
              vout: utxo.vout,
              tokenId: parsed.tokenId,
            });
          } else if (reg.reason === 'already registered') {
            result.skippedAlreadyKnown++;
          } else if (reg.reason?.includes('merkle proof') || reg.reason?.includes('deferred')) {
            result.deferred++;
          } else if (reg.reason) {
            result.errors.push({ txid: utxo.txid, vout: utxo.vout, message: reg.reason });
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          result.errors.push({ txid: utxo.txid, vout: utxo.vout, message });
        }
      }
    }

    return result;
  }
}
