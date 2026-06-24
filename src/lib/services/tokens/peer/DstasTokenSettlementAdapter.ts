/**
 * DstasTokenSettlementAdapter — concrete TokenSettlementAdapter for DSTAS.
 *
 * The DSTAS analog of StasTokenSettlementAdapter. DSTAS shares classic STAS's
 * BRC-42 receive namespace (STAS_PROTOCOL_ID), so the BRC-29 owner derivation
 * is identical; only the transfer builder (DstasTransferService, custom DSTAS
 * witness) and the destination basket differ.
 *
 *   - buildTokenSettlement derives the recipient's owner key BRC-29-style and
 *     reuses DstasTransferService.transfer (full-value 1-to-1, spending-type 1),
 *     then packages the signed tx as AtomicBEEF.
 *   - acceptTokenSettlement internalizes the recipient output into the DSTAS
 *     basket, recording the BRC-29 derivation so the token stays re-spendable.
 *
 * Interface mirrored locally (see ./tokenSettlementTypes) until
 * @bsv/message-box-client publishes it.
 */
import type { WalletInterface } from '@bsv/sdk';
import { Hash, Utils, createNonce } from '@bsv/sdk';
import { DstasTransferService } from '../dstas/DstasTransferService';
import { buildChainedAtomicBeef } from '../../stas/buildChainedAtomicBeef';
import { STAS_PROTOCOL_ID } from '../../stas/constants';
import { DSTAS_BASKET } from '../../../constants/baskets';
import type { RelayClient } from '../../relay/RelayClient';
import type {
  TokenSettlementAdapter, TokenSourceRef, TokenSettlementArtifact,
  TokenAdapterContext, TokenBuildResult, TokenAcceptResult,
} from './tokenSettlementTypes';

const ORIGINATOR = 'admin.dstas-peer';

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class DstasTokenSettlementAdapter implements TokenSettlementAdapter {
  readonly protocol = 'dstas';

  constructor(
    private readonly wallet: WalletInterface,
    private readonly identityKey: string,
    private readonly chain: 'main' | 'test',
    private readonly relay?: RelayClient
  ) {}

  /** BRC-29-style derivation (shared STAS namespace) so the recipient can reconstruct the key. */
  private async deriveRecipientAddress(
    recipient: string,
    derivationPrefix: string,
    derivationSuffix: string
  ): Promise<string> {
    const { publicKey } = await this.wallet.getPublicKey(
      {
        protocolID: STAS_PROTOCOL_ID as any,
        keyID: `${derivationPrefix} ${derivationSuffix}`,
        counterparty: recipient as any,
      },
      ORIGINATOR
    );
    const pkh = Hash.hash160(Utils.toArray(publicKey, 'hex'));
    const versionByte = this.chain === 'main' ? 0x00 : 0x6f;
    return Utils.toBase58Check(pkh, [versionByte]);
  }

  async buildTokenSettlement(
    args: { recipient: string; source: TokenSourceRef; amount: string },
    ctx: TokenAdapterContext
  ): Promise<TokenBuildResult> {
    const { recipient, source, amount } = args;

    // v1 supports full-value transfer only (DSTAS spending-type 1, 1-to-1).
    if (amount !== String(source.satoshis)) {
      return {
        action: 'terminate',
        termination: {
          code: 'dstas.partial_unsupported',
          message: `DSTAS peer transfer is full-value only (amount=${amount}, utxo=${source.satoshis})`,
        },
      };
    }

    try {
      const derivationPrefix = await createNonce(this.wallet, 'self', ctx.originator);
      const derivationSuffix = await createNonce(this.wallet, 'self', ctx.originator);
      const recipientAddress = await this.deriveRecipientAddress(recipient, derivationPrefix, derivationSuffix);

      // Dry run: prove derivation + validation only — never touch the chain.
      if (ctx.dryRun) {
        ctx.logger?.log(`[dstas dry-run] would transfer ${amount} to ${recipientAddress}`);
        return {
          action: 'settle',
          artifact: {
            customInstructions: { derivationPrefix, derivationSuffix },
            transaction: [],
            protocol: 'dstas',
            assetId: source.assetId,
            amount,
            outputIndex: 0,
          },
        };
      }

      const transfer = new DstasTransferService(this.wallet, this.identityKey, this.chain, this.relay);
      const res = await transfer.transfer({
        source: {
          txid: source.txid,
          vout: source.outputIndex,
          scriptHex: source.lockingScriptHex,
          satoshis: source.satoshis,
          brc42KeyId: source.brc42KeyId ?? 'recv 0',
          owner: source.owner,
        },
        recipientAddress,
      });
      if (!res.ok || res.txid == null) {
        return { action: 'terminate', termination: { code: 'dstas.transfer_failed', message: res.reason ?? 'transfer failed' } };
      }

      const transaction = (res.beef && res.beef.length > 0)
        ? res.beef
        : (await buildChainedAtomicBeef({ wallet: this.wallet, txid: res.txid })).atomicBeef;

      return {
        action: 'settle',
        artifact: {
          customInstructions: { derivationPrefix, derivationSuffix },
          transaction,
          protocol: 'dstas',
          assetId: source.assetId,
          amount,
          outputIndex: 0, // DSTAS transfer places the recipient output at vout 0
        },
      };
    } catch (err) {
      return { action: 'terminate', termination: { code: 'dstas.build_error', message: errMsg(err) } };
    }
  }

  async acceptTokenSettlement(
    args: { sender: string; settlement: TokenSettlementArtifact },
    _ctx: TokenAdapterContext
  ): Promise<TokenAcceptResult> {
    const { sender, settlement } = args;
    try {
      const customInstructions = JSON.stringify({
        scheme: 'brc29',
        kind: 'dstas',
        tokenId: settlement.assetId,
        derivationPrefix: settlement.customInstructions.derivationPrefix,
        derivationSuffix: settlement.customInstructions.derivationSuffix,
        senderIdentityKey: sender,
      });

      const internalizeResult = await this.wallet.internalizeAction(
        {
          tx: settlement.transaction,
          outputs: [
            {
              outputIndex: settlement.outputIndex,
              protocol: 'basket insertion',
              insertionRemittance: {
                basket: DSTAS_BASKET,
                customInstructions,
                tags: ['dstas', 'peer', `id:${settlement.assetId}`],
              },
            },
          ],
          description: 'DSTAS peer receive',
          seekPermission: false,
        } as any,
        ORIGINATOR
      );

      return { action: 'accept', receiptData: { internalizeResult } };
    } catch (err) {
      return { action: 'terminate', termination: { code: 'dstas.internalize_failed', message: errMsg(err) } };
    }
  }
}
