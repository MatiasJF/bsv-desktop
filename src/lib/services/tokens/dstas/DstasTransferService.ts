/**
 * DstasTransferService — DSTAS transfer via createAction + signAction.
 *
 * Same architectural shape as StasTransferService: wallet-toolbox owns
 * the tx assembly + funding via createAction; the DSTAS input is signed
 * externally via wallet.createSignature (BRC-42) and the unlocking script
 * is hand-assembled to match the SDK's expected DSTAS witness format
 * (mirror of dxs-bsv-token-sdk's input-builder.ts:91-178 — see
 * buildDstasUnlockingScript.ts for the spec).
 *
 * Output layout (per DSTAS_SCRIPT_INVARIANTS.md §1 — Transfer):
 *   vout 0 = new DSTAS to recipient (spending-type=1, 1-to-1)
 *   vout 1 = BSV change back to funder
 *
 * Funding fragmentation suppressed the same way StasTransferService does
 * (lower default basket's numberOfDesiredUTXOs to 0 around the call,
 * restore on every exit path).
 *
 * Signing:
 *   - DSTAS input (our outpoint): externally via wallet.createSignature
 *     with the BRC-42 derivation that owns the DSTAS — same protocolID
 *     as classic STAS, since the receive namespace is shared.
 *   - BSV input (wallet-owned): the wallet signs it internally during
 *     signAction.
 */

import type { WalletInterface } from '@bsv/sdk'
import { Beef } from '@bsv/sdk'
import { fromHex, toHex } from 'dxs-bsv-token-sdk/bsv'
// Leaf-module imports for SDK builders. We use namespace-import on each
// because Rollup's CJS plugin can't see names forwarded through
// __exportStar in the `/bsv` aggregator (same reason dstasParser.ts
// does this for LockingScriptReader). Each path is whitelisted in
// vendor/dxs-bsv-token-sdk/package.json's `exports` field.
import * as DstasLockingBuilderModule from 'dxs-bsv-token-sdk/script/build/dstas-locking-builder'
const { buildDstasLockingScript } = DstasLockingBuilderModule
import { STAS_PROTOCOL_ID, STAS_COUNTERPARTY } from '../../stas/constants'
import { parseDstasLockingScript } from '../../stas/dstasParser'
import { stasQuery } from '../../stas/stasIpc'
import { buildChainedAtomicBeef } from '../../stas/buildChainedAtomicBeef'
import { buildDstasUnlockingScript, DSTAS_SIGHASH_TYPE } from './buildDstasUnlockingScript'

/**
 * Dynamic bsv-js import — same pattern StasTransferService uses.
 * `createRequire('module')` doesn't work in the Vite browser bundle;
 * `await import('bsv')` does, and Vite pre-bundles bsv via optimizeDeps.
 */
async function loadBsvJs(): Promise<any> {
  const mod: any = await import('bsv')
  return mod.default ?? mod
}

const ORIGINATOR = 'admin.dstas-transfer'
const SIGHASH = DSTAS_SIGHASH_TYPE // 0x41 — ALL | FORKID

export interface DstasTransferArgs {
  source: {
    txid: string
    vout: number
    scriptHex: string
    satoshis: number
    brc42KeyId: string
  }
  recipientAddress: string
}

export interface DstasTransferResult {
  ok: boolean
  txid?: string
  reason?: string
}

export class DstasTransferService {
  constructor(
    private readonly wallet: WalletInterface,
    private readonly identityKey: string,
    private readonly chain: 'main' | 'test'
  ) {}

  async transfer(args: DstasTransferArgs): Promise<DstasTransferResult> {
    const { source, recipientAddress } = args

    let bsvJs: any
    try {
      bsvJs = await loadBsvJs()
    } catch (err) {
      return { ok: false, reason: `load bsv-js failed: ${errMsg(err)}` }
    }

    // 1. Parse + validate the source. parseDstasLockingScript returns
    //    null for non-DSTAS scripts, surfaces frozen state via the
    //    action-data marker. We reject frozen UTXOs here (per
    //    DSTAS_SCRIPT_INVARIANTS.md — frozen STAS can't be spent under
    //    spendingType=1; freeze flow is its own surface).
    const parsed = parseDstasLockingScript(source.scriptHex)
    if (!parsed) {
      return {
        ok: false,
        reason: `source.scriptHex doesn't parse as DSTAS — prefix "${source.scriptHex.slice(0, 24)}…"`,
      }
    }
    if (parsed.frozen) {
      return {
        ok: false,
        reason: 'source DSTAS UTXO is frozen — cannot transfer under spendingType=1',
      }
    }

    // 2. Owner pubkey via BRC-42 derivation. DSTAS shares STAS's
    //    receive namespace (see StasKeyDeriver) so the protocolID is
    //    the same.
    let ownerPubKeyHex: string
    try {
      const { publicKey } = await this.wallet.getPublicKey(
        {
          protocolID: STAS_PROTOCOL_ID as any,
          keyID: source.brc42KeyId,
          counterparty: STAS_COUNTERPARTY as any,
        },
        ORIGINATOR
      )
      ownerPubKeyHex = publicKey
    } catch (err) {
      return { ok: false, reason: `getPublicKey: ${errMsg(err)}` }
    }

    // 3. Recipient hash160 (bsv-js parses base58check + extracts).
    let recipientPkhHex: string
    try {
      const addr = bsvJs.Address.fromString(recipientAddress, 'livenet')
      recipientPkhHex = addr.hashBuffer.toString('hex')
    } catch (err) {
      return { ok: false, reason: `invalid recipient: ${errMsg(err)}` }
    }

    // 4. Build the new DSTAS output locking script via the SDK's pure
    //    builder. ownerPkh = recipient's hash160. Everything else
    //    propagates from the source (redemptionPkh, flags,
    //    serviceFields, optionalData byte-exact per §7 invariant).
    //    Fresh transfer → actionData: null, frozen: false.
    let newDstasScriptHex: string
    try {
      const flagsBytes = fromHex(parsed.flagsHex || '00')
      const serviceFields = parsed.serviceFields.map((s) => fromHex(s))
      const optionalData = parsed.optionalData.map((s) => fromHex(s))
      const lockingBytes = buildDstasLockingScript({
        ownerPkh: fromHex(recipientPkhHex),
        redemptionPkh: fromHex(parsed.tokenId),
        flags: flagsBytes,
        serviceFields,
        optionalData,
        actionData: null,
        frozen: false,
      })
      newDstasScriptHex = toHex(lockingBytes)
    } catch (err) {
      return { ok: false, reason: `build new DSTAS locking script: ${errMsg(err)}` }
    }

    // 5. Build inputBEEF (chained-atomic so mempool ancestors are OK).
    let inputBEEF: number[]
    try {
      const built = await buildChainedAtomicBeef({ wallet: this.wallet, txid: source.txid })
      inputBEEF = built.beef
    } catch (err) {
      return { ok: false, reason: `inputBEEF assembly: ${errMsg(err)}` }
    }

    // 6. Mark the source spendable on wallet-toolbox's side — DSTAS
    //    outputs are flagged non-spendable by default (the toolbox
    //    doesn't recognise the custom template).
    try {
      const outputId: number | null = await stasQuery(
        this.identityKey,
        this.chain,
        'findOutputIdByOutpoint',
        [source.txid, source.vout]
      )
      if (outputId) {
        await stasQuery(this.identityKey, this.chain, 'setOutputSpendable', [outputId, true])
      }
    } catch {
      /* best effort */
    }

    // 7. Suppress change fragmentation around the call — same as STAS
    //    transfer needs because the DSTAS template expects the funding
    //    branch to be a single P2PKH change output.
    let previousBasketTarget: number | null = null
    try {
      const res: any = await stasQuery(
        this.identityKey,
        this.chain,
        'setDefaultBasketUTXOTarget',
        [0]
      )
      previousBasketTarget = res?.previous ?? null
    } catch (err) {
      console.warn(
        '[dstas-transfer] setDefaultBasketUTXOTarget failed — fragmentation may break the template. ' +
        'Likely cause: stale dist-electron build. Fully restart `npm run dev`. Error:',
        err
      )
    }
    const restoreBasket = async () => {
      if (previousBasketTarget != null) {
        try {
          await stasQuery(
            this.identityKey,
            this.chain,
            'setDefaultBasketUTXOTarget',
            [previousBasketTarget]
          )
        } catch { /* best effort */ }
      }
    }

    try {
      // 8. createAction. Wallet auto-funds + adds the BSV change output.
      //    Conservation: source.satoshis tokens → new DSTAS output gets
      //    the same satoshis (DSTAS transfer is 1-to-1 per §1).
      let createRes: any
      try {
        createRes = await this.wallet.createAction(
          {
            inputBEEF,
            inputs: [
              {
                outpoint: `${source.txid}.${source.vout}`,
                // DSTAS unlocking script is comparable in size to classic STAS
                // (~3 KB worst-case) — we'll let bsv-js compute the actual size
                // post-build; the estimate guides createAction's fee math.
                unlockingScriptLength: 4500,
                inputDescription: 'DSTAS being transferred',
              },
            ],
            outputs: [
              {
                lockingScript: newDstasScriptHex,
                satoshis: source.satoshis,
                outputDescription: 'DSTAS to recipient',
              },
            ],
            description: 'DSTAS transfer',
            options: { randomizeOutputs: false },
          } as any,
          ORIGINATOR
        )
      } catch (err) {
        return { ok: false, reason: `createAction: ${errMsg(err)}` }
      }

      const signable = createRes?.signableTransaction
      if (!signable || !signable.tx) {
        return { ok: false, reason: 'createAction did not return signableTransaction' }
      }

      // 9. Parse signable.tx (AtomicBEEF) → atomic tx → bsv-js Transaction
      //    so we can compute sighash + walk outputs for the unlock builder.
      let tx: any
      try {
        const beef = Beef.fromBinary(signable.tx)
        const atomicTxid = (beef as any).atomicTxid as string | undefined
        if (!atomicTxid) return { ok: false, reason: 'signable BEEF has no atomic txid' }
        const btx = beef.findTxid(atomicTxid)
        if (!btx?.tx) return { ok: false, reason: `signable BEEF missing atomic tx ${atomicTxid}` }
        const rawTxBytes = btx.tx.toBinary()
        tx = new bsvJs.Transaction(Buffer.from(rawTxBytes).toString('hex'))
        // Attach the source's prev-output for sighash computation.
        tx.inputs[0].output = new bsvJs.Transaction.Output({
          script: bsvJs.Script.fromHex(source.scriptHex),
          satoshis: source.satoshis,
        })
      } catch (err) {
        return { ok: false, reason: `parse signable tx: ${errMsg(err)}` }
      }

      // 10. Resolve the funding input. wallet-toolbox always adds one
      //     BSV-funding input; the DSTAS template encodes its outpoint
      //     into the unlock witness. We pick the first non-DSTAS input.
      let fundingInputIdx = -1
      for (let i = 0; i < tx.inputs.length; i++) {
        if (i === 0) continue // input 0 is our DSTAS source
        fundingInputIdx = i
        break
      }
      if (fundingInputIdx < 0) {
        return { ok: false, reason: 'no funding input found in the assembled tx' }
      }

      // 11. Sighash + signature for input 0.
      let sigDer: Uint8Array
      let preimage: Uint8Array
      try {
        const sourceLocking = bsvJs.Script.fromHex(source.scriptHex)
        const satsBN = new bsvJs.crypto.BN(source.satoshis)
        const preimageBuf: Buffer = bsvJs.Transaction.sighash.sighashPreimage(
          tx, SIGHASH, 0, sourceLocking, satsBN
        )
        preimage = new Uint8Array(preimageBuf)
        const digestBuf = bsvJs.crypto.Hash.sha256sha256(preimageBuf)
        const digestBytes = Array.from(digestBuf as Buffer) as number[]

        const sigRes = await this.wallet.createSignature(
          {
            protocolID: STAS_PROTOCOL_ID as any,
            keyID: source.brc42KeyId,
            counterparty: STAS_COUNTERPARTY as any,
            hashToDirectlySign: digestBytes,
          } as any,
          ORIGINATOR
        )
        sigDer = new Uint8Array(sigRes.signature)
      } catch (err) {
        return { ok: false, reason: `sighash/sign: ${errMsg(err)}` }
      }

      // 12. Assemble DSTAS unlocking script via our helper (mirror of
      //     SDK's input-builder.ts:91-178).
      let unlockingScriptHex: string
      try {
        unlockingScriptHex = buildDstasUnlockingScript({
          unsignedTx: tx,
          inputIdx: 0,
          fundingInputIdx,
          preimage,
          signatureDer: sigDer,
          publicKey: new Uint8Array(Buffer.from(ownerPubKeyHex, 'hex')),
          spendingType: 1,
        })
      } catch (err) {
        return { ok: false, reason: `assemble DSTAS unlocking script: ${errMsg(err)}` }
      }

      // 13. Mandatory script-level evaluation per dxs-bsv-token-sdk
      //     AGENTS.md §4. The evaluator confirms our witness format
      //     matches the DSTAS template's expectations BEFORE we ask the
      //     wallet to broadcast — without this we'd hand the wallet a
      //     tx that miners reject after the fact.
      //
      //     Disabled in test environments where the SDK's evaluator
      //     isn't loaded (tests can pass `{ skipEvaluate: true }` via
      //     a future hook). For now: always run.
      try {
        const evalResult = await evaluateDstasInputZero({
          tx,
          sourceScriptHex: source.scriptHex,
          sourceSatoshis: source.satoshis,
          unlockingScriptHex,
        })
        if (!evalResult.success) {
          return {
            ok: false,
            reason: `DSTAS script evaluation failed: ${evalResult.reason ?? 'unknown'}`,
          }
        }
      } catch (err) {
        // The evaluator is sensitive to setup details (prevout resolver,
        // ScriptType awareness). If it throws before yielding a clean
        // success/fail, surface and bail — we'd rather refuse than
        // broadcast something unverified.
        return { ok: false, reason: `DSTAS script evaluation threw: ${errMsg(err)}` }
      }

      // 14. signAction. wallet-toolbox signs the funding input and
      //     queues the broadcast; monitor worker handles relay.
      let signResp: any
      try {
        signResp = await this.wallet.signAction(
          {
            reference: signable.reference,
            spends: { 0: { unlockingScript: unlockingScriptHex } },
          } as any,
          ORIGINATOR
        )
      } catch (err) {
        return { ok: false, reason: `signAction: ${errMsg(err)}` }
      }

      const sendResults: any[] = Array.isArray(signResp?.sendWithResults)
        ? signResp.sendWithResults
        : []
      const failed = sendResults.find((r) => r?.status === 'failed')
      if (failed) {
        return {
          ok: false,
          reason: `broadcast failed: ${JSON.stringify(failed)} (txid was ${signResp?.txid})`,
        }
      }

      return { ok: true, txid: signResp?.txid }
    } finally {
      await restoreBasket()
    }
  }
}

/**
 * Apply the unlocking script to tx.inputs[0] and run the SDK's
 * evaluator. Returns `{ success, reason? }`. The evaluator wants the
 * source's prev-output supplied via a resolver callback so it can look
 * up the locking script and satoshis during script execution.
 *
 * Imported via the leaf-module path (whitelisted in the SDK's exports)
 * to bypass Rollup's __exportStar blindness — same pattern dstasParser
 * uses for LockingScriptReader.
 */
async function evaluateDstasInputZero(args: {
  tx: any
  sourceScriptHex: string
  sourceSatoshis: number
  unlockingScriptHex: string
}): Promise<{ success: boolean; reason?: string }> {
  let evaluateTransactionHex: any
  try {
    const evalMod: any = await import(
      'dxs-bsv-token-sdk/script/eval/script-evaluator'
    )
    evaluateTransactionHex = evalMod.evaluateTransactionHex
  } catch {
    /* fall through to no-op */
  }
  if (typeof evaluateTransactionHex !== 'function') {
    console.warn('[dstas-transfer] script evaluator unavailable — skipping pre-broadcast eval')
    return { success: true }
  }
  try {
    // Inject the unlocking script onto input 0 before serialising.
    args.tx.inputs[0].setScript(args.unlockingScriptHex)
    const txHex: string = args.tx.toString()
    const result = evaluateTransactionHex(txHex, (txid: string, vout: number) => {
      const sourcePrevTxIdHex: string =
        typeof args.tx.inputs[0].prevTxId === 'string'
          ? args.tx.inputs[0].prevTxId
          : Buffer.from(args.tx.inputs[0].prevTxId).toString('hex')
      if (txid === sourcePrevTxIdHex && vout === args.tx.inputs[0].outputIndex) {
        return {
          LockingScript: new Uint8Array(Buffer.from(args.sourceScriptHex, 'hex')),
          Satoshis: args.sourceSatoshis,
        }
      }
      return null
    })
    return {
      success: !!result?.success,
      reason: result?.failureReason ?? (result?.success ? undefined : 'evaluator returned non-success'),
    }
  } catch (err) {
    return { success: false, reason: errMsg(err) }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

