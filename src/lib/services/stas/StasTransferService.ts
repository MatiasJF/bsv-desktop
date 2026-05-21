/**
 * StasTransferService — spend a STAS UTXO to a new owner address using the
 * wallet's BRC-42-derived key for signing. No private keys exposed to UI.
 *
 * The integration sits on top of `stas-js`'s `transferWithCallback`, which
 * already exposes external-signing hooks. We provide a callback that:
 *   1. computes the sighash preimage via bsv-js (no key needed),
 *   2. hashes it (double-SHA256, Bitcoin convention),
 *   3. signs the 32-byte digest via `wallet.createSignature` with the recv-N
 *      protocol/keyID context,
 *   4. returns the DER signature + sighash flag byte as hex (`toTxFormat()`).
 *
 * stas-js then plugs that signature into the STAS input's unlocking script
 * using its existing partialSTASUnlockingScript builder.
 *
 * Fee model: MVP starts with ZERO-FEE transfers (no paymentUtxo). The STAS
 * UTXO's satoshis pass through; miners may or may not accept zero-fee STAS.
 * For paid transfers we'd select a BSV UTXO from the default basket and add
 * a paymentSignatureCallback alongside the owner one (deferred).
 */

import type { WalletInterface } from '@bsv/sdk';
import { STAS_PROTOCOL_ID, STAS_COUNTERPARTY } from './constants';

// Old bsv-js + stas-js are CJS — pull them in via require shims that Vite
// pre-bundles. See vite.config.ts optimizeDeps.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const bsv: any = require('bsv');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const stasJs: any = require('stas-js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const stasInternals: any = require('stas-js/lib/stas');
const SIGHASH: number = stasInternals.sighash;

const ORIGINATOR = 'admin.stas-transfer';

export interface StasTransferArgs {
  /** The STAS UTXO to spend. Comes from listOutputs / our basket. */
  source: {
    txid: string;
    vout: number;
    /** Full locking script hex of the STAS UTXO. */
    scriptHex: string;
    /** Satoshis on the UTXO. */
    satoshis: number;
    /** BRC-42 keyID, e.g. `"recv 15"`. */
    brc42KeyId: string;
  };
  /** Base58 P2PKH-ish recipient address. */
  recipientAddress: string;
}

export interface StasTransferResult {
  ok: boolean;
  /** TXID of the broadcast transfer tx. */
  txid?: string;
  /** Human-readable reason on failure. */
  reason?: string;
}

export class StasTransferService {
  constructor(private readonly wallet: WalletInterface) {}

  async transfer(args: StasTransferArgs): Promise<StasTransferResult> {
    const { source, recipientAddress } = args;

    // 1. Get the owner's public key for this STAS via the BRC-42 derivation
    //    that produced the recv-N owner field. The wallet stores the same
    //    key, so getPublicKey is deterministic and matches the script.
    let ownerPublicKey: any;
    try {
      const { publicKey } = await this.wallet.getPublicKey(
        {
          protocolID: STAS_PROTOCOL_ID as any,
          keyID: source.brc42KeyId,
          counterparty: STAS_COUNTERPARTY as any,
        },
        ORIGINATOR
      );
      ownerPublicKey = bsv.PublicKey.fromString(publicKey);
    } catch (err) {
      return {
        ok: false,
        reason: `getPublicKey failed: ${errMsg(err)}`,
      };
    }

    // 2. STAS UTXO in stas-js's expected shape.
    const stasUtxo = {
      txid: source.txid,
      vout: source.vout,
      scriptPubKey: source.scriptHex,
      satoshis: source.satoshis,
    };

    // 3. Owner-signature callback. Computes the sighash preimage via bsv-js
    //    using the actual tx being built, hashes it, and asks the wallet to
    //    sign that digest with the recv-N derivation.
    const ownerSignatureCallback = async (
      tx: any,
      inputIndex: number,
      script: any,
      satoshisBN: any
    ): Promise<string> => {
      const preimageBuf = bsv.Transaction.sighash.sighashPreimage(
        tx,
        SIGHASH,
        inputIndex,
        script,
        satoshisBN
      );
      const digestBuf = bsv.crypto.Hash.sha256sha256(preimageBuf);
      const digestBytes = Array.from(digestBuf as Buffer) as number[];

      const sigRes = await this.wallet.createSignature(
        {
          protocolID: STAS_PROTOCOL_ID as any,
          keyID: source.brc42KeyId,
          counterparty: STAS_COUNTERPARTY as any,
          data: digestBytes,
        },
        ORIGINATOR
      );

      // wallet.createSignature returns DER bytes; tx-format is DER + sighash byte.
      const derHex = toHex(sigRes.signature);
      const sighashHex = SIGHASH.toString(16).padStart(2, '0');
      return derHex + sighashHex;
    };

    // 4. Drive stas-js's transferWithCallback. Zero-fee mode (paymentUtxo
    //    null) — STAS satoshis pass straight through.
    let signedTxHex: string;
    try {
      const { transferWithCallback } = stasJs;
      signedTxHex = await transferWithCallback(
        ownerPublicKey,
        stasUtxo,
        recipientAddress,
        null,
        null,
        ownerSignatureCallback,
        null
      );
    } catch (err) {
      return {
        ok: false,
        reason: `transferWithCallback failed: ${errMsg(err)}`,
      };
    }

    // 5. Broadcast via WoC (matches the faucet's pattern).
    try {
      const txid = await broadcastViaWoc(signedTxHex);
      return { ok: true, txid };
    } catch (err) {
      return {
        ok: false,
        reason: `broadcast failed: ${errMsg(err)}`,
      };
    }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toHex(bytes: number[] | Uint8Array): string {
  const arr = Array.isArray(bytes) ? bytes : Array.from(bytes);
  return arr.map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function broadcastViaWoc(txHex: string): Promise<string> {
  const res = await fetch('https://api.whatsonchain.com/v1/bsv/main/tx/raw', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txhex: txHex }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`WoC ${res.status}: ${text.slice(0, 200)}`);
  }
  return text.trim().replace(/^"|"$/g, '');
}
