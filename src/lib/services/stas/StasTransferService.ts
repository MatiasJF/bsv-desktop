/**
 * StasTransferService — STAS transfer via stas-js's transferWithCallback path.
 *
 * createAction + signAction was the original target but wallet-toolbox's
 * change-fragmentation (numberOfDesiredUTXOs: 144 by default) breaks the STAS
 * engine, which assumes exactly 2 outputs (STAS at vout 0, BSV change at
 * vout 1). No createAction option suppresses fragmentation.
 *
 * This service builds the transfer tx via `stas-js.transferWithCallback`, which
 * produces the exact 2-output layout the engine expects. We sign both the STAS
 * input (BRC-42 derivation) and the BSV funding input (BRC-29 derivation) via
 * `wallet.createSignature` — no private keys exposed to the renderer. Broadcast
 * goes through WoC directly.
 *
 * Trade-off: wallet's basket reconciliation lags until its monitor sees the
 * spend on chain. Acceptable for the demo; basket eventually reconciles.
 */

import type { WalletInterface } from '@bsv/sdk';
import { STAS_PROTOCOL_ID, STAS_COUNTERPARTY } from './constants';
import { stasQuery } from './stasIpc';

async function loadStasDeps(): Promise<{
  bsv: any;
  stasJs: any;
  SIGHASH: number;
}> {
  const bsvMod: any = await import('bsv');
  const bsv = bsvMod.default ?? bsvMod;
  const stasJsMod: any = await import('stas-js/index.js');
  const stasJs = stasJsMod.default ?? stasJsMod;
  const stasInternalsMod: any = await import('stas-js/lib/stas.js');
  const stasInternals = stasInternalsMod.default ?? stasInternalsMod;
  return { bsv, stasJs, SIGHASH: stasInternals.sighash };
}

const ORIGINATOR = 'admin.stas-transfer';
const BRC29_PROTOCOL_ID: any = [2, '3241645161d8'];

export interface StasTransferArgs {
  source: {
    txid: string;
    vout: number;
    /** Full locking script hex of the STAS UTXO. */
    scriptHex: string;
    satoshis: number;
    /** BRC-42 keyID, e.g. `"recv 15"`. */
    brc42KeyId: string;
  };
  recipientAddress: string;
}

export interface StasTransferResult {
  ok: boolean;
  txid?: string;
  reason?: string;
}

export class StasTransferService {
  constructor(
    private readonly wallet: WalletInterface,
    private readonly identityKey: string,
    private readonly chain: 'main' | 'test'
  ) {}

  async transfer(args: StasTransferArgs): Promise<StasTransferResult> {
    const { source, recipientAddress } = args;

    let bsv: any, stasJs: any, SIGHASH: number;
    try {
      ({ bsv, stasJs, SIGHASH } = await loadStasDeps());
    } catch (err) {
      return { ok: false, reason: `load stas-js/bsv failed: ${errMsg(err)}` };
    }

    // 1. STAS owner pubkey (BRC-42 derivation that owns the STAS).
    let ownerPubKey: any;
    try {
      const { publicKey } = await this.wallet.getPublicKey(
        {
          protocolID: STAS_PROTOCOL_ID as any,
          keyID: source.brc42KeyId,
          counterparty: STAS_COUNTERPARTY as any,
        },
        ORIGINATOR
      );
      ownerPubKey = bsv.PublicKey.fromString(publicKey);
    } catch (err) {
      return { ok: false, reason: `getPublicKey (STAS owner): ${errMsg(err)}` };
    }

    // 2. Pick a BSV UTXO from the wallet's default basket for fee funding.
    let paymentUtxo: any;
    let paymentPubKey: any;
    let paymentDerivation: { protocolID: any; keyID: string; counterparty: any };
    try {
      const lor: any = await this.wallet.listOutputs(
        {
          basket: 'default',
          include: 'locking scripts',
          includeCustomInstructions: true,
          limit: 100,
        } as any,
        ORIGINATOR
      );
      const outs: any[] = Array.isArray(lor?.outputs) ? lor.outputs : [];
      // eslint-disable-next-line no-console
      console.log(
        '[stas-transfer] default basket outputs:',
        outs.length,
        outs.slice(0, 5).map((o) => ({
          outpoint: o.outpoint,
          sats: o.satoshis,
          ci: o.customInstructions ? String(o.customInstructions).slice(0, 80) : undefined,
        }))
      );
      const candidates = outs
        .filter((o) => o.spendable !== false && (o.satoshis ?? 0) >= 500)
        .sort((a, b) => (b.satoshis ?? 0) - (a.satoshis ?? 0));
      if (candidates.length === 0) {
        return {
          ok: false,
          reason: `no BSV UTXO with >= 500 sats in default basket (found ${outs.length} total)`,
        };
      }
      const pick = candidates[0];
      const [pTxid, pVoutStr] = String(pick.outpoint).split('.');
      paymentUtxo = {
        txid: pTxid,
        vout: parseInt(pVoutStr, 10),
        scriptPubKey: pick.lockingScript,
        satoshis: pick.satoshis,
      };

      // Parse BRC-29 derivation from customInstructions.
      let ci: any = {};
      try {
        ci = typeof pick.customInstructions === 'string'
          ? JSON.parse(pick.customInstructions)
          : (pick.customInstructions ?? {});
      } catch {
        /* keep empty */
      }
      const prefix = ci.derivationPrefix ?? '';
      const suffix = ci.derivationSuffix ?? '';
      const keyID = prefix && suffix ? `${prefix} ${suffix}` : suffix || prefix || '';
      const counterparty = ci.payee ?? 'self';

      // eslint-disable-next-line no-console
      console.log('[stas-transfer] payment derivation:', { keyID, counterparty });

      paymentDerivation = {
        protocolID: BRC29_PROTOCOL_ID,
        keyID,
        counterparty,
      };

      const pkRes = await this.wallet.getPublicKey(
        {
          protocolID: paymentDerivation.protocolID,
          keyID: paymentDerivation.keyID,
          counterparty: paymentDerivation.counterparty,
        } as any,
        ORIGINATOR
      );
      paymentPubKey = bsv.PublicKey.fromString(pkRes.publicKey);
    } catch (err) {
      return { ok: false, reason: `payment UTXO selection: ${errMsg(err)}` };
    }

    // 3. STAS UTXO in stas-js's expected shape.
    const stasUtxo = {
      txid: source.txid,
      vout: source.vout,
      scriptPubKey: source.scriptHex,
      satoshis: source.satoshis,
    };

    // 4. Signing callbacks.
    const ownerSignatureCallback = async (
      tx: any,
      inputIndex: number,
      script: any,
      satoshisBN: any
    ): Promise<string> => {
      const preimage = bsv.Transaction.sighash.sighashPreimage(
        tx, SIGHASH, inputIndex, script, satoshisBN
      );
      const digest = bsv.crypto.Hash.sha256sha256(preimage);
      const sigRes = await this.wallet.createSignature(
        {
          protocolID: STAS_PROTOCOL_ID as any,
          keyID: source.brc42KeyId,
          counterparty: STAS_COUNTERPARTY as any,
          hashToDirectlySign: Array.from(digest as Buffer) as number[],
        } as any,
        ORIGINATOR
      );
      const derHex = toHex(sigRes.signature);
      const sighashHex = SIGHASH.toString(16).padStart(2, '0');
      return derHex + sighashHex;
    };

    const paymentSignatureCallback = async (
      tx: any,
      inputIndex: number,
      script: any,
      satoshisBN: any
    ): Promise<string> => {
      const preimage = bsv.Transaction.sighash.sighashPreimage(
        tx, SIGHASH, inputIndex, script, satoshisBN
      );
      const digest = bsv.crypto.Hash.sha256sha256(preimage);
      const sigRes = await this.wallet.createSignature(
        {
          protocolID: paymentDerivation.protocolID,
          keyID: paymentDerivation.keyID,
          counterparty: paymentDerivation.counterparty,
          hashToDirectlySign: Array.from(digest as Buffer) as number[],
        } as any,
        ORIGINATOR
      );
      const derHex = toHex(sigRes.signature);
      const sighashHex = SIGHASH.toString(16).padStart(2, '0');
      return derHex + sighashHex;
    };

    // 5. Flip STAS spendable flag (cosmetic — createAction isn't involved
    //    here, but other wallet paths may check it).
    try {
      const outputId: number | null = await stasQuery(
        this.identityKey,
        this.chain,
        'findOutputIdByOutpoint',
        [source.txid, source.vout]
      );
      if (outputId) {
        await stasQuery(this.identityKey, this.chain, 'setOutputSpendable', [outputId, true]);
      }
    } catch {
      /* best effort */
    }

    // 6. stas-js builds tx + drives callbacks. Returns serialized hex.
    let signedTxHex: string;
    try {
      const { transferWithCallback } = stasJs;
      signedTxHex = await transferWithCallback(
        ownerPubKey,
        stasUtxo,
        recipientAddress,
        paymentUtxo,
        paymentPubKey,
        ownerSignatureCallback,
        paymentSignatureCallback
      );
    } catch (err) {
      return { ok: false, reason: `transferWithCallback: ${errMsg(err)}` };
    }

    // 7. Broadcast via WoC.
    let txid: string;
    try {
      txid = await broadcastViaWoc(signedTxHex);
    } catch (err) {
      return { ok: false, reason: `broadcast: ${errMsg(err)}` };
    }

    return { ok: true, txid };
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
  if (!res.ok) throw new Error(`WoC ${res.status}: ${text.slice(0, 200)}`);
  return text.trim().replace(/^"|"$/g, '');
}
