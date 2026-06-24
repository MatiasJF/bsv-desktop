/**
 * StasTokenSettlementAdapter — concrete TokenSettlementAdapter for classic STAS.
 *
 * Plugs into `PeerTokenClient` (from @bsv/message-box-client) to move classic
 * STAS tokens peer-to-peer over MessageBox, the token analog of PeerPay's
 * BRC-29 settlement. It composes the wallet's existing building blocks:
 *   - owner-field derivation (BRC-29 style, so the recipient can reconstruct
 *     the key) via wallet.getPublicKey;
 *   - StasTransferService.transfer to build + sign + broadcast the transfer;
 *   - buildChainedAtomicBeef to package the signed tx for the recipient;
 *   - wallet.internalizeAction (basket insertion) on accept, recording the
 *     BRC-29 derivation so the received token stays re-spendable.
 *
 * The TokenSettlementAdapter interface is mirrored locally until
 * @bsv/message-box-client publishes it; the shape is structurally identical, so
 * this class is assignable to the published interface after the version bump.
 */
import type { WalletInterface } from '@bsv/sdk';
import { Hash, Utils, createNonce } from '@bsv/sdk';
import { StasTransferService } from '../../stas/StasTransferService';
import { buildChainedAtomicBeef } from '../../stas/buildChainedAtomicBeef';
import { STAS_PROTOCOL_ID } from '../../stas/constants';
import { STAS_BASKET } from '../../../constants/baskets';
import type {
  TokenSettlementAdapter, TokenSourceRef, TokenSettlementArtifact,
  TokenAdapterContext, TokenBuildResult, TokenAcceptResult,
} from './tokenSettlementTypes';

const ORIGINATOR = 'admin.stas-peer';

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class StasTokenSettlementAdapter implements TokenSettlementAdapter {
  readonly protocol = 'stas';

  constructor(
    private readonly wallet: WalletInterface,
    private readonly identityKey: string,
    private readonly chain: 'main' | 'test'
  ) {}

  /**
   * Derives the recipient's STAS owner key with a BRC-29-style shared
   * derivation: the recipient can reconstruct the matching private key by
   * deriving with `counterparty = senderIdentityKey` and the same keyID.
   */
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

    // v1 supports full-value transfer only (classic STAS amount == satoshis).
    if (amount !== String(source.satoshis)) {
      return {
        action: 'terminate',
        termination: {
          code: 'stas.partial_unsupported',
          message: `classic STAS peer transfer is full-value only (amount=${amount}, utxo=${source.satoshis})`,
        },
      };
    }

    try {
      const derivationPrefix = await createNonce(this.wallet, 'self', ctx.originator);
      const derivationSuffix = await createNonce(this.wallet, 'self', ctx.originator);
      const recipientAddress = await this.deriveRecipientAddress(recipient, derivationPrefix, derivationSuffix);

      // Dry run: prove derivation + validation only — never touch the chain.
      if (ctx.dryRun) {
        ctx.logger?.log(`[stas dry-run] would transfer ${amount} to ${recipientAddress}`);
        return {
          action: 'settle',
          artifact: {
            customInstructions: { derivationPrefix, derivationSuffix },
            transaction: [],
            protocol: 'stas',
            assetId: source.assetId,
            amount,
            outputIndex: 0,
          },
        };
      }

      const transfer = new StasTransferService(this.wallet, this.identityKey, this.chain);
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
        return { action: 'terminate', termination: { code: 'stas.transfer_failed', message: res.reason ?? 'transfer failed' } };
      }

      // Prefer the signed AtomicBEEF the wallet already returned (no re-fetch
      // race); fall back to assembling a chained BEEF if it wasn't surfaced.
      const transaction = (res.beef && res.beef.length > 0)
        ? res.beef
        : (await buildChainedAtomicBeef({ wallet: this.wallet, txid: res.txid })).atomicBeef;

      return {
        action: 'settle',
        artifact: {
          customInstructions: { derivationPrefix, derivationSuffix },
          transaction,
          protocol: 'stas',
          assetId: source.assetId,
          amount,
          outputIndex: 0, // STAS engine places the recipient output at vout 0
        },
      };
    } catch (err) {
      return { action: 'terminate', termination: { code: 'stas.build_error', message: errMsg(err) } };
    }
  }

  async acceptTokenSettlement(
    args: { sender: string; settlement: TokenSettlementArtifact },
    _ctx: TokenAdapterContext
  ): Promise<TokenAcceptResult> {
    const { sender, settlement } = args;
    try {
      // Record the BRC-29 derivation so a later transfer can re-derive the
      // owner key: keyID = "<prefix> <suffix>", counterparty = senderIdentityKey.
      const customInstructions = JSON.stringify({
        scheme: 'brc29',
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
                basket: STAS_BASKET,
                customInstructions,
                tags: ['stas', 'peer'],
              },
            },
          ],
          description: 'STAS peer receive',
          seekPermission: false,
        } as any,
        ORIGINATOR
      );

      return { action: 'accept', receiptData: { internalizeResult } };
    } catch (err) {
      return { action: 'terminate', termination: { code: 'stas.internalize_failed', message: errMsg(err) } };
    }
  }
}
