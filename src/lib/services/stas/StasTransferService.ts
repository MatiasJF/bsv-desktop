/**
 * StasTransferService — spend a STAS UTXO via the full BRC-100 path:
 * `wallet.createAction` + `wallet.signAction`. The wallet picks BSV funding
 * inputs from the default basket and adds change automatically; we only sign
 * the STAS input ourselves via `wallet.createSignature` with the BRC-42
 * derivation that owns the STAS.
 *
 * No private keys exposed to UI. Wallet handles its own basket reconciliation
 * (the spent STAS leaves stas-tokens; the change replenishes default).
 *
 * stas-js + bsv (1.5.6) loaded lazily on transfer() — they never touch app
 * boot, so any browser-side init failure is confined to this call.
 */

import type { WalletInterface } from '@bsv/sdk';
import { Beef } from '@bsv/sdk';
import { STAS_PROTOCOL_ID, STAS_COUNTERPARTY } from './constants';
import { buildChainedAtomicBeef } from './buildChainedAtomicBeef';

async function loadStasDeps(): Promise<{
  bsv: any;
  stasInternals: any;
  SIGHASH: number;
}> {
  // Dynamic ESM imports — `require` doesn't exist in the browser/Vite world.
  // Vite's optimizeDeps pre-bundles these CJS packages so we can import them.
  // CJS modules expose their `module.exports` as the default export under ESM
  // interop, so unwrap `.default` if present.
  const bsvMod: any = await import('bsv');
  const bsv = bsvMod.default ?? bsvMod;
  const stasInternalsMod: any = await import('stas-js/lib/stas.js');
  const stasInternals = stasInternalsMod.default ?? stasInternalsMod;
  return { bsv, stasInternals, SIGHASH: stasInternals.sighash };
}

const ORIGINATOR = 'admin.stas-transfer';

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
  constructor(private readonly wallet: WalletInterface) {}

  async transfer(args: StasTransferArgs): Promise<StasTransferResult> {
    const { source, recipientAddress } = args;

    // Lazy-load. Any failure here is reported as a normal error, not a crash.
    let bsv: any, stasInternals: any, SIGHASH: number;
    try {
      ({ bsv, stasInternals, SIGHASH } = await loadStasDeps());
    } catch (err) {
      return { ok: false, reason: `load stas-js/bsv failed: ${errMsg(err)}` };
    }

    const {
      updateStasScript,
      partialSTASUnlockingScript,
      getVersion,
    } = stasInternals;

    // 1. Owner pubkey via BRC-42 (same derivation that owns the STAS).
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
      return { ok: false, reason: `getPublicKey: ${errMsg(err)}` };
    }

    // 2. Validate recipient + extract hash160 (the STAS owner field).
    let recipientPkhHex: string;
    try {
      const addr = bsv.Address.fromString(recipientAddress);
      recipientPkhHex = addr.hashBuffer.toString('hex');
    } catch (err) {
      return { ok: false, reason: `invalid recipient: ${errMsg(err)}` };
    }

    // 3. Build the new STAS locking script — engine + tokenId unchanged, only
    //    the owner-field hash160 swaps. `updateStasScript` and `getVersion`
    //    operate on the HEX STRING form of the script (they regex on it),
    //    NOT a parsed Script object. Pass scriptHex directly.
    let newStasScriptHex: string;
    let stasVersion: number;
    try {
      newStasScriptHex = updateStasScript(recipientPkhHex, source.scriptHex);
      stasVersion = getVersion(source.scriptHex);
    } catch (err) {
      return { ok: false, reason: `script build: ${errMsg(err)}` };
    }

    // 4. Build inputBEEF for the source STAS tx via buildChainedAtomicBeef,
    //    which now falls back to WoC when wallet Services doesn't return a
    //    rawTx or merkle path. Same helper the receive side uses; here we
    //    take its `.beef` (non-atomic) output for createAction's inputBEEF.
    let inputBEEF: number[];
    try {
      const built = await buildChainedAtomicBeef({
        wallet: this.wallet,
        txid: source.txid,
      });
      inputBEEF = built.beef;
    } catch (err) {
      return { ok: false, reason: `inputBEEF assembly: ${errMsg(err)}` };
    }

    // 5. createAction. Wallet auto-funds (adds BSV inputs from default basket
    //    + change). Our STAS input is signable: we provide unlockingScriptLength
    //    only, then sign externally via signAction.
    let createRes: any;
    try {
      createRes = await this.wallet.createAction(
        {
          inputBEEF,
          inputs: [
            {
              outpoint: `${source.txid}.${source.vout}`,
              unlockingScriptLength: 500,
              inputDescription: 'STAS being transferred',
            },
          ],
          outputs: [
            {
              lockingScript: newStasScriptHex,
              satoshis: source.satoshis,
              outputDescription: 'STAS to recipient',
            },
          ],
          description: 'STAS transfer',
          options: { acceptDelayedBroadcast: false },
        } as any,
        ORIGINATOR
      );
    } catch (err) {
      return { ok: false, reason: `createAction: ${errMsg(err)}` };
    }

    const signable = createRes?.signableTransaction;
    if (!signable || !signable.tx) {
      return { ok: false, reason: 'createAction did not return signableTransaction' };
    }

    // 5. Parse the wallet-built tx. signableTransaction.tx is an AtomicBEEF
    //    (not a plain rawTx) — pull out the atomic-txid's transaction bytes
    //    and hand THOSE to bsv-js so stas-js can build the partial unlocking.
    let tx: any;
    try {
      const beef = Beef.fromBinary(signable.tx);
      const atomicTxid = (beef as any).atomicTxid as string | undefined;
      if (!atomicTxid) {
        return { ok: false, reason: 'signable BEEF has no atomic txid' };
      }
      const btx = beef.findTxid(atomicTxid);
      if (!btx?.tx) {
        return { ok: false, reason: `signable BEEF missing atomic tx ${atomicTxid}` };
      }
      const rawTxBytes = btx.tx.toBinary();
      const txHex = Buffer.from(rawTxBytes).toString('hex');
      tx = new bsv.Transaction(txHex);
    } catch (err) {
      return { ok: false, reason: `parse signable tx: ${errMsg(err)}` };
    }

    // 6. Identify the wallet-added change output. Our STAS is vout 0; wallet
    //    typically appends change at vout 1+. Pick the first standard P2PKH.
    let paymentSegment: { satoshis: number; publicKey: string } | null = null;
    for (let v = 1; v < tx.outputs.length; v++) {
      const sHex = tx.outputs[v].script.toHex();
      if (sHex.startsWith('76a914') && sHex.endsWith('88ac') && sHex.length === 50) {
        paymentSegment = {
          satoshis: tx.outputs[v].satoshis,
          publicKey: sHex.substring(6, 46),
        };
        break;
      }
    }

    // 7. partialSTASUnlockingScript populates tx.inputs[0].script with the
    //    engine push-data prefix.
    try {
      partialSTASUnlockingScript(
        tx,
        [
          { satoshis: source.satoshis, publicKey: recipientPkhHex },
          null,
          paymentSegment,
        ],
        stasVersion,
        paymentSegment === null
      );
    } catch (err) {
      return { ok: false, reason: `partial unlocking: ${errMsg(err)}` };
    }

    // 8. Sighash for input 0 over the SOURCE locking script (not the new one).
    let sigHex: string;
    try {
      const sourceLocking = bsv.Script.fromHex(source.scriptHex);
      const satsBN = new bsv.crypto.BN(source.satoshis);
      const preimage = bsv.Transaction.sighash.sighashPreimage(
        tx,
        SIGHASH,
        0,
        sourceLocking,
        satsBN
      );
      const digestBuf = bsv.crypto.Hash.sha256sha256(preimage);
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

      const derHex = toHex(sigRes.signature);
      const sighashHex = SIGHASH.toString(16).padStart(2, '0');
      sigHex = derHex + sighashHex;
    } catch (err) {
      return { ok: false, reason: `sighash / sign: ${errMsg(err)}` };
    }

    // 9. Final unlocking script = partial + sig + pubkey.
    let unlockingScriptHex: string;
    try {
      const partialASM = tx.inputs[0].script.toASM();
      const finalASM = `${partialASM} ${sigHex} ${ownerPubKey.toString('hex')}`;
      unlockingScriptHex = bsv.Script.fromASM(finalASM).toHex();
    } catch (err) {
      return { ok: false, reason: `unlocking assembly: ${errMsg(err)}` };
    }

    // 10. signAction. Wallet signs its own funding inputs + uses our STAS
    //     unlocking, then broadcasts.
    let signResp: any;
    try {
      signResp = await this.wallet.signAction(
        {
          reference: signable.reference,
          spends: {
            0: { unlockingScript: unlockingScriptHex },
          },
        } as any,
        ORIGINATOR
      );
    } catch (err) {
      return { ok: false, reason: `signAction: ${errMsg(err)}` };
    }

    return { ok: true, txid: signResp?.txid };
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toHex(bytes: number[] | Uint8Array): string {
  const arr = Array.isArray(bytes) ? bytes : Array.from(bytes);
  return arr.map((b) => b.toString(16).padStart(2, '0')).join('');
}
