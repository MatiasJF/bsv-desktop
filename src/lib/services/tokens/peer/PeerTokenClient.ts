/**
 * PeerTokenClient (local vendored copy)
 *
 * The token analog of PeerPayClient: moves classic STAS, DSTAS, and BSV-21
 * tokens peer-to-peer over MessageBox by delegating to a per-standard
 * {@link TokenSettlementAdapter}.
 *
 * This is a LOCAL MIRROR of the upstream `PeerTokenClient` in
 * @bsv/message-box-client (which isn't in the published 2.0.x this wallet
 * depends on). It extends the *installed* MessageBoxClient so there is no
 * dual-@bsv/sdk hazard. Once the upstream package is published with
 * PeerTokenClient, delete this file and import from the package — the public
 * surface is identical.
 */
import { MessageBoxClient, PeerMessage } from '@bsv/message-box-client';
import { WalletInterface, createNonce } from '@bsv/sdk';
import {
  TokenSettlementAdapter, TokenSourceRef, TokenAdapterContext,
} from './tokenSettlementTypes';

const log = {
  log: (...a: any[]) => console.log('[PT CLIENT]', ...a),
  warn: (...a: any[]) => console.warn('[PT CLIENT]', ...a),
  error: (...a: any[]) => console.error('[PT CLIENT]', ...a),
};

function safeParse<T>(input: any): T | undefined {
  try {
    return typeof input === 'string' ? JSON.parse(input) : input;
  } catch {
    log.error('failed to parse message body', input);
    return undefined;
  }
}

export const STANDARD_TOKEN_MESSAGEBOX = 'token_inbox';
export const TOKEN_REQUESTS_MESSAGEBOX = 'token_requests';
export const TOKEN_REQUEST_RESPONSES_MESSAGEBOX = 'token_request_responses';

/** A token transfer carried in the token message box. */
export interface TokenToken {
  protocol: string;
  assetId: string;
  amount: string;
  customInstructions: { derivationPrefix: string; derivationSuffix: string };
  transaction: number[];
  outputIndex?: number;
}

export interface IncomingToken {
  messageId: string;
  sender: string;
  token: TokenToken;
}

export interface SendTokenParams {
  recipient: string;
  protocol: string;
  source: TokenSourceRef;
  amount: string;
}

export interface TokenRequestResponse {
  requestId: string;
  status: 'sent' | 'declined';
  protocol?: string;
  assetId?: string;
  amountSent?: string;
  note?: string;
}

export interface IncomingTokenRequest {
  messageId: string;
  sender: string;
  requestId: string;
  protocol: string;
  assetId: string;
  amount: string;
  description: string;
  expiresAt: number;
}

export interface PeerTokenClientConfig {
  messageBoxHost?: string;
  messageBox?: string;
  walletClient: WalletInterface;
  adapters: TokenSettlementAdapter[];
  enableLogging?: boolean;
  originator?: string;
}

export class PeerTokenClient extends MessageBoxClient {
  private readonly peerTokenWalletClient: WalletInterface;
  private readonly tokenMessageBox: string;
  private readonly tokenHost?: string;
  private readonly adapters: Map<string, TokenSettlementAdapter>;

  constructor(config: PeerTokenClientConfig) {
    super({
      host: config.messageBoxHost,
      walletClient: config.walletClient,
      enableLogging: config.enableLogging ?? false,
      originator: config.originator,
    });
    this.tokenMessageBox = config.messageBox ?? STANDARD_TOKEN_MESSAGEBOX;
    this.tokenHost = config.messageBoxHost;
    this.peerTokenWalletClient = config.walletClient;
    this.originator = config.originator;
    this.adapters = new Map(config.adapters.map((a) => [a.protocol, a]));
  }

  private adapterFor(protocol: string): TokenSettlementAdapter {
    const adapter = this.adapters.get(protocol);
    if (!adapter) {
      throw new Error(`No token settlement adapter registered for protocol '${protocol}'`);
    }
    return adapter;
  }

  private adapterContext(dryRun = false): TokenAdapterContext {
    return { wallet: this.peerTokenWalletClient, originator: this.originator, logger: log, dryRun };
  }

  /**
   * Builds a transferable token artifact. With `dryRun` the adapter derives the
   * recipient + validates only and DOES NOT touch the chain (empty transaction).
   */
  async createTokenToken(params: SendTokenParams, dryRun = false): Promise<TokenToken> {
    const adapter = this.adapterFor(params.protocol);
    const result = await adapter.buildTokenSettlement(
      { recipient: params.recipient, source: params.source, amount: params.amount },
      this.adapterContext(dryRun)
    );
    if (result.action === 'terminate') throw new Error(result.termination.message);
    const { artifact } = result;
    return {
      protocol: artifact.protocol,
      assetId: artifact.assetId,
      amount: artifact.amount,
      customInstructions: artifact.customInstructions,
      transaction: artifact.transaction,
      outputIndex: artifact.outputIndex,
    };
  }

  async sendToken(params: SendTokenParams, hostOverride?: string): Promise<void> {
    if (!params.recipient || params.recipient.trim() === '') {
      throw new Error('Invalid token transfer: recipient is required');
    }
    const token = await this.createTokenToken(params);
    await this.sendMessage(
      { recipient: params.recipient, messageBox: this.tokenMessageBox, body: JSON.stringify(token) },
      hostOverride ?? this.tokenHost
    );
  }

  async sendLiveToken(params: SendTokenParams, overrideHost?: string): Promise<void> {
    const token = await this.createTokenToken(params);
    const host = overrideHost ?? this.tokenHost;
    try {
      await this.sendLiveMessage({
        recipient: params.recipient,
        messageBox: this.tokenMessageBox,
        body: JSON.stringify(token),
      }, host);
    } catch (err) {
      log.warn('sendLiveMessage failed, falling back to HTTP:', err);
      await this.sendMessage(
        { recipient: params.recipient, messageBox: this.tokenMessageBox, body: JSON.stringify(token) },
        host
      );
    }
  }

  async listenForLiveTokens(params: { onToken: (t: IncomingToken) => void; overrideHost?: string }): Promise<void> {
    await this.listenForLiveMessages({
      messageBox: this.tokenMessageBox,
      host: params.overrideHost ?? this.tokenHost,
      onMessage: (message: PeerMessage) => {
        const token = safeParse<TokenToken>(message.body);
        if (token == null) return;
        params.onToken({ messageId: message.messageId, sender: message.sender, token });
      },
    } as any);
  }

  async acceptToken(incoming: IncomingToken): Promise<any> {
    try {
      const adapter = this.adapterFor(incoming.token.protocol);
      const result = await adapter.acceptTokenSettlement(
        {
          sender: incoming.sender,
          settlement: {
            customInstructions: incoming.token.customInstructions,
            transaction: incoming.token.transaction,
            protocol: incoming.token.protocol,
            assetId: incoming.token.assetId,
            amount: incoming.token.amount,
            outputIndex: incoming.token.outputIndex ?? 0,
          },
        },
        this.adapterContext()
      );
      if (result.action === 'terminate') throw new Error(result.termination.message);
      await this.acknowledgeMessage({ messageIds: [incoming.messageId], host: this.tokenHost });
      return { incoming, receiptData: result.receiptData };
    } catch (error) {
      log.error(`Error accepting token: ${String(error)}`);
      return 'Unable to receive token!';
    }
  }

  async listIncomingTokens(overrideHost?: string): Promise<IncomingToken[]> {
    // listMessagesLite talks to the host directly and skips overlay (SLAP)
    // host resolution — required on mainnet where ls_messagebox has no
    // advertised hosts. listMessages would throw "_queryAdvertisements failed".
    const messages = await this.listMessagesLite({ messageBox: this.tokenMessageBox, host: overrideHost ?? this.tokenHost });
    return messages
      .map((msg: any) => {
        const token = safeParse<TokenToken>(msg.body);
        if (token == null) return null;
        return { messageId: msg.messageId, sender: msg.sender, token };
      })
      .filter((t): t is IncomingToken => t != null);
  }

  // ── Token request flow (parallels PeerPayClient's payment requests) ────────

  async requestToken(
    params: { recipient: string; protocol: string; assetId: string; amount: string; description: string; expiresAt: number },
    hostOverride?: string
  ): Promise<{ requestId: string; requestProof: string }> {
    const requestId = await createNonce(this.peerTokenWalletClient, 'self', this.originator);
    const senderIdentityKey = await this.getIdentityKey();
    const proofData = Array.from(new TextEncoder().encode(requestId + params.recipient));
    const { hmac } = await this.peerTokenWalletClient.createHmac(
      { data: proofData, protocolID: [2, 'token request auth'], keyID: requestId, counterparty: params.recipient },
      this.originator
    );
    const requestProof = Array.from(hmac).map((b) => b.toString(16).padStart(2, '0')).join('');
    const body = {
      requestId, protocol: params.protocol, assetId: params.assetId, amount: params.amount,
      description: params.description, expiresAt: params.expiresAt, senderIdentityKey, requestProof,
    };
    await this.sendMessage(
      { recipient: params.recipient, messageBox: TOKEN_REQUESTS_MESSAGEBOX, body: JSON.stringify(body) },
      hostOverride
    );
    return { requestId, requestProof };
  }

  async listTokenRequestResponses(hostOverride?: string): Promise<TokenRequestResponse[]> {
    const messages = await this.listMessages({ messageBox: TOKEN_REQUEST_RESPONSES_MESSAGEBOX, host: hostOverride });
    return messages
      .map((msg: any) => safeParse<TokenRequestResponse>(msg.body))
      .filter((r): r is TokenRequestResponse => r != null);
  }
}
