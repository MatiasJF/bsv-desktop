/**
 * Local mirror of @bsv/message-box-client's TokenSettlementAdapter contract.
 *
 * bsv-desktop depends on the *published* @bsv/message-box-client (2.0.x), which
 * does not yet export these types. The shapes here are structurally identical
 * to the upstream `TokenSettlementAdapter.ts`, so a concrete adapter written
 * against this mirror is assignable to the published interface after the
 * version bump — at which point this file can be deleted and the imports
 * repointed at the package.
 */
import type { WalletInterface } from '@bsv/sdk';

export interface TokenSourceRef {
  txid: string;
  outputIndex: number;
  lockingScriptHex: string;
  satoshis: number;
  protocol: string;
  assetId: string;
  brc42KeyId?: string;
  /** Present when re-sending a BRC-29-received token (counterparty = sender). */
  owner?: { protocolID?: [number, string]; keyID: string; counterparty: string };
  [key: string]: unknown;
}

export interface TokenSettlementArtifact {
  customInstructions: { derivationPrefix: string; derivationSuffix: string };
  transaction: number[];
  protocol: string;
  assetId: string;
  amount: string;
  outputIndex: number;
}

export interface TokenAdapterContext {
  wallet: WalletInterface;
  originator?: string;
  logger?: { log: (...a: any[]) => void; warn: (...a: any[]) => void; error: (...a: any[]) => void };
  /**
   * When true, the adapter MUST NOT touch the chain: derive the recipient
   * address + validate inputs only, then return a preview artifact with an
   * empty `transaction`. No createAction / signAction / broadcast.
   */
  dryRun?: boolean;
}

export interface Termination { code: string; message: string }

export type TokenBuildResult =
  | { action: 'settle'; artifact: TokenSettlementArtifact }
  | { action: 'terminate'; termination: Termination };

export type TokenAcceptResult =
  | { action: 'accept'; receiptData?: { internalizeResult?: unknown } }
  | { action: 'terminate'; termination: Termination };

export interface TokenSettlementAdapter {
  readonly protocol: string;
  buildTokenSettlement: (
    args: { recipient: string; source: TokenSourceRef; amount: string },
    ctx: TokenAdapterContext
  ) => Promise<TokenBuildResult>;
  acceptTokenSettlement: (
    args: { sender: string; settlement: TokenSettlementArtifact },
    ctx: TokenAdapterContext
  ) => Promise<TokenAcceptResult>;
}
