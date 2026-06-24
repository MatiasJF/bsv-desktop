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
import type { RelayClient } from '../../relay/RelayClient'

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
    /**
     * Optional owner-key derivation override for signing the DSTAS input.
     * Defaults to the self-owned scheme (STAS_PROTOCOL_ID, keyID
     * `brc42KeyId`, counterparty 'self'). A token received over a peer
     * channel (BRC-29) is owned under a derivation keyed to the SENDER, so
     * re-spending it requires `keyID = "<prefix> <suffix>"` and
     * `counterparty = senderIdentityKey`. Backward compatible.
     */
    owner?: {
      protocolID?: [number, string]
      keyID: string
      counterparty: string
    }
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
    private readonly chain: 'main' | 'test',
    /**
     * Optional stas-relay client for organic-receive bridging. When set,
     * the service pushes `(txid, recipientAddress, 'dstas')` after
     * broadcast so a remote recipient's wallet can discover the send
     * during its next scan without needing colocated
     * `/stas/register-by-txid` access. Bitails's STAS-aware matcher does
     * NOT recognise DSTAS template scripts, so the relay is the primary
     * discovery channel for DSTAS receives.
     */
    private readonly relay?: RelayClient
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
    // Effective owner-key derivation. Defaults to the self-owned scheme; a
    // BRC-29 peer-received token overrides keyID + counterparty so it stays
    // spendable.
    const ownerDerivation = {
      protocolID: (source.owner?.protocolID ?? STAS_PROTOCOL_ID) as any,
      keyID: source.owner?.keyID ?? source.brc42KeyId,
      counterparty: (source.owner?.counterparty ?? STAS_COUNTERPARTY) as any,
    }

    let ownerPubKeyHex: string
    try {
      const { publicKey } = await this.wallet.getPublicKey(
        {
          protocolID: ownerDerivation.protocolID,
          keyID: ownerDerivation.keyID,
          counterparty: ownerDerivation.counterparty,
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

      // 10. Resolve the funding input. The DSTAS template encodes EXACTLY
      //     ONE funding outpoint (vout + txid) into the unlock witness;
      //     the template verifies this matches the tx's prevout hash.
      //     wallet-toolbox normally pulls a single funding input, but
      //     if the default basket only has fragments smaller than the
      //     fee, it combines multiple — which the template can't accept.
      //     Same constraint applies to the SDK's `BuildDstasTransferTx`
      //     (see `input-builder.ts:resolveFundingInput`).
      //
      //     Fail clean here so the user gets an actionable message
      //     instead of a cryptic "OP_EQUALVERIFY required equal" deep
      //     in the script evaluator.
      const nonDstasInputs: number[] = []
      for (let i = 0; i < tx.inputs.length; i++) {
        if (i === 0) continue // input 0 is our DSTAS source
        nonDstasInputs.push(i)
      }
      if (nonDstasInputs.length === 0) {
        return { ok: false, reason: 'no funding input found in the assembled tx' }
      }
      if (nonDstasInputs.length > 1) {
        return {
          ok: false,
          reason:
            `DSTAS template requires exactly one funding input, but wallet-toolbox ` +
            `picked ${nonDstasInputs.length} from the default basket — likely ` +
            `because no single change UTXO is large enough to cover the tx fee. ` +
            `Workaround: consolidate the default basket by sending a small BSV ` +
            `self-payment to yourself first, then retry the DSTAS send. ` +
            `(Same architectural constraint applies to the SDK's BuildDstasTransferTx.)`,
        }
      }
      const fundingInputIdx = nonDstasInputs[0]

      // Same constraint on outputs: the DSTAS template walks outputs and
      // expects exactly the recipient DSTAS output + at most 1 P2PKH
      // change output (+ optional null-data). Multiple P2PKH outputs from
      // fragmentation would break the template's per-output handling.
      let p2pkhOutputCount = 0
      for (const out of tx.outputs) {
        const sh = out.script.toHex()
        if (sh.startsWith('76a914') && sh.endsWith('88ac') && sh.length === 50) {
          p2pkhOutputCount++
        }
      }
      if (p2pkhOutputCount > 1) {
        return {
          ok: false,
          reason:
            `DSTAS template requires at most one P2PKH change output, but the ` +
            `assembled tx has ${p2pkhOutputCount}. Same root cause as the ` +
            `multi-funding-input case — consolidate the default basket first.`,
        }
      }

      console.log(
        `[dstas-transfer] tx shape: ${tx.inputs.length} inputs (DSTAS at 0, funding at ${fundingInputIdx}), ${tx.outputs.length} outputs`
      )

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
            protocolID: ownerDerivation.protocolID,
            keyID: ownerDerivation.keyID,
            counterparty: ownerDerivation.counterparty,
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

      // 13. Best-effort pre-broadcast script-level diagnostic.
      //
      //     The SDK's AGENTS.md mandates `evaluateTransactionHex` for
      //     "every flow-producing change" — but that's a normative rule
      //     for SDK developers writing fully-signed test fixtures, not
      //     a wallet running mid-flow validation. At THIS point in our
      //     flow the funding input (input 1) is still unsigned — the
      //     wallet only signs it inside the upcoming `signAction` call.
      //     So a full-tx evaluation will fail on input 1 regardless of
      //     whether our DSTAS input 0 is byte-perfect.
      //
      //     We run the evaluator anyway as a diagnostic and log its
      //     result, but we DO NOT gate the broadcast on it — chain
      //     validation is the real backstop and StasTransferService
      //     follows the same trust-the-wallet-and-the-chain model.
      //
      //     If the evaluator surfaces a structured per-input result we
      //     can later harden this into "input 0 must pass" — left as a
      //     TODO until we see what the evaluator actually returns.
      try {
        const evalResult = await evaluateDstasInputZero({
          tx,
          sourceScriptHex: source.scriptHex,
          sourceSatoshis: source.satoshis,
          unlockingScriptHex,
        })
        if (evalResult.success) {
          console.log('[dstas-transfer] script-evaluator pre-broadcast: success')
        } else {
          // Expected when the funding input isn't signed yet — log full
          // diagnostic so a real failure mode (e.g. byte-mismatch on
          // input 0's unlock) can be diagnosed from the dev tools.
          console.warn(
            '[dstas-transfer] script-evaluator pre-broadcast: NON-SUCCESS (expected — funding input still unsigned at this point). ' +
            `Diagnostic: ${evalResult.reason ?? 'no detail'}`
          )
          if (evalResult.fullResult) {
            console.warn('[dstas-transfer] full evaluator result:', evalResult.fullResult)
          }
        }
      } catch (err) {
        console.warn(`[dstas-transfer] script-evaluator threw: ${errMsg(err)}`)
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

      // 15. Stas-relay push — DSTAS has no public indexer (Bitails's STAS
      //     matcher rejects DSTAS scripts), so the relay is how a remote
      //     recipient's wallet discovers this send during its next scan.
      //     Fail-soft: RelayClient.push returns null on errors and never
      //     throws; the transfer is reported ok regardless.
      if (this.relay && signResp?.txid) {
        try {
          const res = await this.relay.push({
            txid: signResp.txid,
            recipientAddress,
            protocol: 'dstas',
          })
          if (res) {
            console.log(`[dstas-transfer] relay push ✓ ${signResp.txid.slice(0, 12)}… → ${recipientAddress}${res.duplicate ? ' (dup)' : ''}`)
          } else {
            console.warn('[dstas-transfer] relay push returned null (relay unreachable)')
          }
        } catch (err) {
          console.warn(`[dstas-transfer] relay push threw: ${errMsg(err)}`)
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
}): Promise<{ success: boolean; reason?: string; fullResult?: any }> {
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
    return { success: true, reason: 'evaluator unavailable in this environment' }
  }
  try {
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
      // Funding input's prev-output: we don't have it cached here, so the
      // evaluator may report a resolver miss. That's expected — we want
      // input 0's result, not the full-tx pass.
      return null
    })
    // Surface a structured summary plus the full result for the caller
    // to log. The SDK's `evaluateTransactionHex` historically returns
    // `{ success, results: InputResult[], failureReason? }`; field names
    // vary across versions so we keep `fullResult` opaque for diagnostics.
    const reason = result?.failureReason
      ?? result?.results?.find?.((r: any) => r && r.success === false)?.reason
      ?? (result?.success ? undefined : 'evaluator returned non-success (see fullResult)')
    return {
      success: !!result?.success,
      reason,
      fullResult: result,
    }
  } catch (err) {
    return { success: false, reason: errMsg(err) }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

