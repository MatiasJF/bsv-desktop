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

/**
 * Extract the owner hash160 from a CLASSIC STAS locking script.
 *
 * Classic STAS contracts always begin with a canonical P2PKH-shaped prefix
 * containing the owner's hash160, immediately followed by OP_VERIFY:
 *
 *   76 a9 14 <20-byte owner-hash160> 88 ac 69  …STAS engine bytes…
 *   ^ OP_DUP                          ^^ ^^ ^^ OP_EQUALVERIFY/OP_CHECKSIG/OP_VERIFY
 *
 * Returns the hash160 as 40-hex-char lowercase, or null if the script doesn't
 * match. This lets us classify and own classic STAS UTXOs even though our
 * DSTAS parser (from the dxs SDK) returns null for them.
 */
function tryParseClassicStasOwner(scriptHex: string): string | null {
  if (typeof scriptHex !== 'string' || scriptHex.length < 56) return null;
  if (!scriptHex.startsWith('76a914')) return null;
  if (scriptHex.substring(46, 52) !== '88ac69') return null;
  return scriptHex.substring(6, 46);
}

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

export interface RegisterByTxidResult {
  txid: string;
  registered: number;
  outputs: Array<{
    vout: number;
    matched: boolean;
    /** When matched=true: the recv-N keyIndex that owns the output. */
    keyIndex?: number;
    /** When matched=true and register failed: reason string. */
    reason?: string;
    /** Was the wallet successful in registering it? */
    ok?: boolean;
  }>;
  /** Error before per-output processing started (e.g. tx not found). */
  error?: string;
}

export class StasDiscoveryService {
  constructor(private readonly deps: StasDiscoveryDeps) {}

  /**
   * Register a STAS UTXO directly by txid, bypassing the (WoC-broken)
   * address-based scan. WoC indexes outputs at P2PKH addresses; DSTAS outputs
   * are custom scripts, never findable that way. Real STAS wallets use
   * STAS-aware indexers — until we have one, this method is the pragmatic
   * escape hatch: the user (or sender) tells the wallet the txid, and the
   * wallet parses + registers every owned DSTAS output in that tx.
   */
  async registerByTxid(txid: string): Promise<RegisterByTxidResult> {
    const out: RegisterByTxidResult = { txid, registered: 0, outputs: [] };
    const services: any = (this.deps.wallet as any).getServices?.();
    if (!services) {
      out.error = 'wallet.getServices() unavailable';
      return out;
    }
    let rawTxRes: any;
    try {
      rawTxRes = await services.getRawTx(txid);
    } catch (err) {
      out.error = `getRawTx failed: ${err instanceof Error ? err.message : String(err)}`;
      return out;
    }
    if (!rawTxRes?.rawTx) {
      out.error = rawTxRes?.error?.message ?? 'getRawTx returned no rawTx';
      return out;
    }
    let tx: any;
    try {
      tx = Transaction.fromBinary(rawTxRes.rawTx as number[]);
    } catch (err) {
      out.error = `tx parse failed: ${err instanceof Error ? err.message : String(err)}`;
      return out;
    }

    const hwm = await this.deps.deriver.getHighWaterMark();
    const gap = this.deps.gapLimit ?? STAS_GAP_LIMIT;
    const ownerMap = await this.deps.deriver.enumerateOwnerFields(
      hwm > 0 ? hwm + gap : Math.min(gap, 5)
    );

    for (let vout = 0; vout < tx.outputs.length; vout++) {
      const txout = tx.outputs[vout];
      const lockingScriptHex: string = txout.lockingScript.toHex();

      // Try DSTAS first; for classic STAS fall back to extracting the owner
      // hash160 from the canonical P2PKH+OP_VERIFY prefix.
      let parsed: ParsedDstas | null = parseDstasLockingScript(lockingScriptHex);
      let ownerFieldHash160: string | undefined = parsed?.ownerFieldHash160;
      if (!parsed) {
        const classicOwner = tryParseClassicStasOwner(lockingScriptHex);
        if (classicOwner) {
          ownerFieldHash160 = classicOwner;
          parsed = {
            ownerFieldHash160: classicOwner,
            tokenId: '',
            freezeEnabled: false,
            confiscationEnabled: false,
            flagsHex: '',
            serviceFields: [],
          };
        }
      }

      if (!parsed || !ownerFieldHash160) {
        out.outputs.push({ vout, matched: false });
        continue;
      }

      const keyIndex = ownerMap.get(ownerFieldHash160);
      if (keyIndex === undefined) {
        out.outputs.push({ vout, matched: false });
        continue;
      }

      const reg = await this.deps.registration.register({
        txid,
        vout,
        tokenSatoshis: txout.satoshis ?? 0,
        ownerFieldHash160,
        brc42KeyId: `recv ${keyIndex}`,
        parsed,
      });
      const ok = !!reg.registered;
      if (ok) out.registered++;
      out.outputs.push({
        vout,
        matched: true,
        keyIndex,
        ok,
        reason: reg.reason,
      });
    }
    return out;
  }

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

    for (const { address, utxos } of scanned) {
      // WoC's STAS indexer is queried per-derived-address, so every UTXO it
      // returns is owned by THIS address by construction. We use that address
      // mapping as the source of truth for ownership instead of re-parsing the
      // locking script — that way classic STAS (which the dxs DSTAS parser
      // rejects) still goes through. The parser is still attempted for
      // metadata; if it returns null we build a placeholder.
      const ownerHash160Hex = addressToHash.get(address);
      const ownerKeyIndex = ownerHash160Hex ? ownerMap.get(ownerHash160Hex) : undefined;

      for (const utxo of utxos) {
        result.candidates++;
        try {
          // Idempotency pre-check — saves fetching tx/proof for known outpoints.
          // Counts already-known UTXOs into dstas + ownedAndDstas too, so the
          // panel reflects "STAS the wallet recognises at the scanned range"
          // rather than just "newly registered this scan". Without this,
          // a re-scan after auto-discovery shows DSTAS 0 / Owned 0 even though
          // every UTXO is wallet-owned — confusing.
          try {
            const existing = await stasQuery(identityKey, chain, 'findStasOutputByOutpoint', [utxo.txid, utxo.vout]);
            if (existing) {
              result.dstas++;
              result.ownedAndDstas++;
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

          // Two protocols possible:
          //   - DSTAS: dstasParser succeeds; we trust IT for ownership and reject
          //     foreign owners (defense in depth against a misindexed UTXO).
          //   - Classic STAS: dstasParser returns null; we trust the WoC STAS
          //     indexer's address mapping (it queried this exact derived address).
          let parsed = parseDstasLockingScript(lockingScriptHex);
          let keyIndex: number | undefined;
          if (parsed) {
            keyIndex = ownerMap.get(parsed.ownerFieldHash160);
          } else {
            if (!ownerHash160Hex || ownerKeyIndex === undefined) continue;
            parsed = {
              ownerFieldHash160: ownerHash160Hex,
              tokenId: '',
              freezeEnabled: false,
              confiscationEnabled: false,
              flagsHex: '',
              serviceFields: [],
            };
            keyIndex = ownerKeyIndex;
          }
          result.dstas++;
          if (keyIndex === undefined) continue;
          result.ownedAndDstas++;

          // Mempool tolerance: previously this branch deferred when the
          // indexer reported height 0. Bitails surfaces unconfirmed STAS too,
          // and Task 4c's buildChainedAtomicBeef walks back through inputs to
          // a confirmed ancestor, so mempool UTXOs are no longer special-cased.
          // If chained BEEF assembly fails (e.g. inputs not yet fetchable), the
          // registration returns false and the discovery loop records the
          // error; the next scan retries.

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
