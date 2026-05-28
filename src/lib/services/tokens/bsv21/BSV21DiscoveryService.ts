/**
 * BSV21DiscoveryService — find BSV-21 UTXOs the wallet owns at any of its
 * derived BSV-21 receive addresses, then register them via
 * BSV21Registration.
 *
 * Discovery shape mirrors StasDiscoveryService:
 *   enumerate derived owner addresses
 *   → query the 1Sat indexer per-address for any unspent BSV-21 outputs
 *   → parse the on-chain script locally (defence-in-depth) and confirm
 *      it agrees with the indexer's claim
 *   → register via BSV21Registration (BEEF + internalizeAction + tag set)
 *   → return a structured ScanResult
 *
 * One scan per call; no background timer. The Refresh button in
 * AssetsPage triggers scan(), same pattern as STAS.
 */

import { Transaction } from '@bsv/sdk';
import { Address, fromHex } from 'dxs-bsv-token-sdk/bsv';
import type { BSV21KeyDeriver } from './BSV21KeyDeriver';
import type { OneSatIndexerClient, IndexedOutput } from './OneSatIndexerClient';
import type { BSV21Registration } from './BSV21Registration';
import { BSV21_GAP_LIMIT } from './constants';
import { parseBsv21LockingScript } from './inscription';

export interface Bsv21ScanResult {
  scannedAddresses: number;
  /** Total UTXOs the indexer returned across scanned addresses. */
  candidates: number;
  /** Candidates whose locking script parses as BSV-21. */
  bsv21: number;
  /** BSV-21 UTXOs that mapped to a derived key (always true if the address binding works). */
  ownedAndBsv21: number;
  registered: number;
  skippedAlreadyKnown: number;
  errors: Array<{ outpoint?: string; message: string }>;
  registeredOutpoints: Array<{ txid: string; vout: number; tokenId: string }>;
  /** Outputs whose spendable flag we flipped from false → true post-register. */
  spendableFlipped?: number;
}

export interface BSV21DiscoveryDeps {
  deriver: BSV21KeyDeriver;
  indexer: OneSatIndexerClient;
  registration: BSV21Registration;
  /** Wallet exposing `getServices()` (wallet-toolbox Wallet). */
  wallet: any;
  gapLimit?: number;
}

export interface Bsv21RegisterByTxidResult {
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

function hash160ToAddress(hash160Hex: string): string {
  return new (Address as any)(fromHex(hash160Hex)).Value as string;
}

export class BSV21DiscoveryService {
  constructor(private readonly deps: BSV21DiscoveryDeps) {}

  /**
   * DEMO-ONLY fast-path: register a BSV-21 UTXO directly by txid.
   *
   * The PRIMARY discovery mechanism is `scan()` — query the 1Sat overlay's
   * per-address SSE stream and register every matching output. That covers
   * organic receive (anyone sends to one of our derived addresses) as long
   * as the sender's broadcast went through any `/1sat/tx`-capable endpoint
   * (the faucet now does this per-mint).
   *
   * This method exists so a colocated mint flow (dex-shell after a faucet
   * mint) can skip the indexer round-trip and get immediate UI feedback —
   * the wallet fetches the tx directly via `getServices().getRawTx`, parses
   * outputs, matches owner hash160 against derived keys, and internalizes.
   * Mirrors `StasDiscoveryService.registerByTxid`.
   */
  async registerByTxid(txid: string): Promise<Bsv21RegisterByTxidResult> {
    const out: Bsv21RegisterByTxidResult = { txid, registered: 0, outputs: [] };

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

    // Enumerate owner hashes the wallet has derived under the BSV-21
    // protocolID. Bootstrap mode (hwm=0) uses a small starter window —
    // BSV-21 receives can't predate receive-context generation today.
    const hwm = await this.deps.deriver.getHighWaterMark();
    const gap = this.deps.gapLimit ?? BSV21_GAP_LIMIT;
    const ownerMap = await this.deps.deriver.enumerateOwnerFields(
      hwm > 0 ? hwm + gap : Math.min(gap, 5)
    );

    for (let vout = 0; vout < tx.outputs.length; vout++) {
      const txout = tx.outputs[vout];
      const scriptHex: string = txout.lockingScript.toHex();
      const parsed = parseBsv21LockingScript(scriptHex);
      if (!parsed) {
        out.outputs.push({ vout, matched: false });
        continue;
      }
      const keyIndex = ownerMap.get(parsed.ownerHash160);
      if (keyIndex === undefined) {
        out.outputs.push({ vout, matched: false });
        continue;
      }

      // Deploy+mint payloads carry no `id` in the JSON — the outpoint
      // IS the canonical token id. Transfer payloads carry their own id.
      const tokenId = parsed.id || `${txid}_${vout}`;
      const reg = await this.deps.registration.register({
        txid,
        vout,
        tokenId,
        amt: parsed.amt,
        dec: parsed.dec,
        sym: parsed.sym,
        icon: parsed.icon,
        brc42KeyId: `recv ${keyIndex}`,
        ownerAddress: new (Address as any)(fromHex(parsed.ownerHash160)).Value as string,
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

  async scan(): Promise<Bsv21ScanResult> {
    const result: Bsv21ScanResult = {
      scannedAddresses: 0,
      candidates: 0,
      bsv21: 0,
      ownedAndBsv21: 0,
      registered: 0,
      skippedAlreadyKnown: 0,
      errors: [],
      registeredOutpoints: [],
    };

    const gap = this.deps.gapLimit ?? BSV21_GAP_LIMIT;

    // 1. Enumerate derived owner hashes (hash160 → keyIndex). BRC-42
    //    derivation is deterministic, so the cache is only ever extended.
    const hwm = await this.deps.deriver.getHighWaterMark();
    const bootstrap = 5;
    const upTo = hwm > 0 ? hwm + gap : Math.min(bootstrap, gap);
    const ownerMap = await this.deps.deriver.enumerateOwnerFields(upTo);

    // 2. hash160 → base58 P2PKH address (the indexer talks in addresses).
    const addressToHash = new Map<string, string>();
    for (const hash160Hex of ownerMap.keys()) {
      try {
        const addr = hash160ToAddress(hash160Hex);
        addressToHash.set(addr, hash160Hex);
      } catch {
        /* skip undecodable */
      }
    }
    result.scannedAddresses = addressToHash.size;
    if (addressToHash.size === 0) return result;

    // 3. Query the indexer per address. The owner-txos endpoint returns
    //    every UTXO the overlay knows about for that address regardless
    //    of token — we filter to BSV-21 entries below.
    const candidates: Array<{ address: string; out: IndexedOutput }> = [];
    for (const address of addressToHash.keys()) {
      try {
        const txos = await this.deps.indexer.getOwnedTxos(address);
        for (const o of txos) {
          // The live overlay tags BSV-21 outputs with the event
          // `"type:application/bsv-20"` (the inscription content-type)
          // alongside `"insc"`. Older / alternative indexer revisions
          // emit `"bsv21"` directly or carry a top-level `id`. Accept
          // all three so a server-side rename doesn't break discovery.
          const evs = o.events ?? [];
          const isBsv21 =
            evs.includes('bsv21') ||
            evs.includes('type:application/bsv-20') ||
            !!o.id;
          if (isBsv21) candidates.push({ address, out: o });
        }
      } catch (err) {
        result.errors.push({
          message: `indexer getOwnedTxos(${address}) failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
    result.candidates = candidates.length;
    if (candidates.length === 0) return result;

    // 4. For each candidate, fetch the tx, parse the output's script
    //    locally, and register.
    const services = (this.deps.wallet as any).getServices?.();
    if (!services) {
      result.errors.push({ message: 'wallet.getServices() unavailable' });
      return result;
    }
    const txCache = new Map<string, Transaction>();

    for (const { address, out } of candidates) {
      // The 1sat overlay uses `txid.vout` (period) on the SSE `event: txo`
      // payload, but the same indexer's REST shapes use `txid_vout`
      // (underscore). Accept both — splitting on the last separator that
      // matches either character is safer than committing to one.
      const outpointU = out.outpoint;
      const sepIdx = Math.max(outpointU.lastIndexOf('.'), outpointU.lastIndexOf('_'));
      const txid = sepIdx > 0 ? outpointU.slice(0, sepIdx) : '';
      const voutStr = sepIdx > 0 ? outpointU.slice(sepIdx + 1) : '';
      const vout = Number(voutStr);
      if (!txid || Number.isNaN(vout)) {
        result.errors.push({ outpoint: outpointU, message: 'malformed outpoint from indexer' });
        continue;
      }

      try {
        // Fetch tx once per txid.
        let tx = txCache.get(txid);
        if (!tx) {
          const rawTxRes = await services.getRawTx(txid);
          if (!rawTxRes?.rawTx) {
            result.errors.push({
              outpoint: `${txid}.${vout}`,
              message: rawTxRes?.error?.message ?? 'getRawTx returned no rawTx',
            });
            continue;
          }
          tx = Transaction.fromBinary(rawTxRes.rawTx as number[]);
          txCache.set(txid, tx);
        }

        const txout = tx.outputs[vout];
        if (!txout) {
          result.errors.push({ outpoint: `${txid}.${vout}`, message: 'output index out of range' });
          continue;
        }
        const scriptHex = txout.lockingScript.toHex();

        // Defence-in-depth: confirm the locking script really is BSV-21
        // and that the trailing P2PKH matches the indexer's address.
        const parsed = parseBsv21LockingScript(scriptHex);
        if (!parsed) {
          // Indexer claimed BSV-21 but we don't recognise the script.
          // Don't register; surface as an error so the user can investigate.
          result.errors.push({ outpoint: `${txid}.${vout}`, message: 'parser rejected BSV-21 claim' });
          continue;
        }
        result.bsv21++;

        const expectedHash160 = addressToHash.get(address);
        if (!expectedHash160 || parsed.ownerHash160 !== expectedHash160) {
          result.errors.push({
            outpoint: `${txid}.${vout}`,
            message: `owner hash160 mismatch (script ${parsed.ownerHash160}, address-derived ${expectedHash160 ?? 'unknown'})`,
          });
          continue;
        }
        result.ownedAndBsv21++;

        const keyIndex = ownerMap.get(parsed.ownerHash160);
        if (keyIndex === undefined) continue;

        // Prefer the parsed payload (defence) but fall back to indexer-supplied
        // fields when the parsed payload is missing them (e.g. dec on transfer
        // payloads; the spec only requires dec on deploy+mint).
        const tokenId = parsed.id || out.id || outpointU; // mints: id IS the outpoint
        const amt = parsed.amt;
        const dec = parsed.dec ?? out.dec;
        const sym = parsed.sym ?? out.sym;
        const icon = parsed.icon ?? out.icon;

        const reg = await this.deps.registration.register({
          txid,
          vout,
          tokenId,
          amt,
          dec,
          sym,
          icon,
          brc42KeyId: `recv ${keyIndex}`,
          ownerAddress: address,
        });

        if (reg.registered) {
          result.registered++;
          result.registeredOutpoints.push({ txid, vout, tokenId });
        } else if (reg.reason === 'already registered') {
          result.skippedAlreadyKnown++;
        } else if (reg.reason) {
          result.errors.push({ outpoint: `${txid}.${vout}`, message: reg.reason });
        }
      } catch (err) {
        result.errors.push({
          outpoint: `${txid}.${vout}`,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return result;
  }
}
