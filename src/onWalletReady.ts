import { stasQuery } from './lib/services/stas/stasIpc';
import {
  WalletInterface,
  CreateActionArgs,
  SignActionArgs,
  AbortActionArgs,
  ListActionsArgs,
  InternalizeActionArgs,
  ListOutputsArgs,
  RelinquishOutputArgs,
  GetPublicKeyArgs,
  RevealCounterpartyKeyLinkageArgs,
  RevealSpecificKeyLinkageArgs,
  WalletEncryptArgs,
  WalletDecryptArgs,
  CreateHmacArgs,
  VerifyHmacArgs,
  CreateSignatureArgs,
  VerifySignatureArgs,
  AcquireCertificateArgs,
  ListCertificatesArgs,
  ProveCertificateArgs,
  RelinquishCertificateArgs,
  DiscoverByIdentityKeyArgs,
  DiscoverByAttributesArgs,
  GetHeaderArgs,
  WERR_REVIEW_ACTIONS,
  type AtomicBEEF,
  type OutpointString,
  type ReviewActionResult,
  type SendWithResult,
  type TXIDHexString
} from '@bsv/sdk';

interface HttpRequestEvent {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  request_id: number;
}

interface HttpResponseEvent {
  request_id: number;
  status: number;
  body: string;
}

/**
 * Duck-type check for WERR_REVIEW_ACTIONS-shaped errors. We don't use
 * `error?.constructor.name === 'WERR_REVIEW_ACTIONS'` because Vite's
 * default production build (esbuild minification) renames class names
 * — `constructor.name` then returns mangled identifiers like `'a'`,
 * the check fails, and the error falls through to the generic
 * `{message: ...}` wrapper which strips `code`, `tx`, `txid`,
 * `reviewActionResults`, and `noSendChange`. The calling app then
 * can't recover the signed transaction or surface review reasons,
 * making `acceptDelayedBroadcast: false` flows un-debuggable.
 *
 * `instanceof WERR_REVIEW_ACTIONS` doesn't work either because the
 * error is thrown by `@bsv/wallet-toolbox`'s WERR_REVIEW_ACTIONS class
 * (a different class identity from `@bsv/sdk`'s class imported here).
 *
 * The duck-type check matches on the stable WERR identifier plus the
 * structured result arrays needed by the SDK WERR_REVIEW_ACTIONS
 * constructor.
 */
interface WerrReviewActionsLike {
  reviewActionResults: ReviewActionResult[];
  sendWithResults: SendWithResult[];
  txid?: TXIDHexString;
  tx?: AtomicBEEF;
  noSendChange?: OutpointString[];
}

function isWerrReviewActions(error: unknown): error is WerrReviewActionsLike {
  if (typeof error !== 'object' || error === null) return false;
  const e = error as {
    name?: unknown;
    code?: unknown;
    reviewActionResults?: unknown;
    sendWithResults?: unknown;
    txid?: unknown;
    tx?: unknown;
    noSendChange?: unknown;
  };

  return (
    (e.name === 'WERR_REVIEW_ACTIONS' || e.code === 5) &&
    Array.isArray(e.reviewActionResults) &&
    Array.isArray(e.sendWithResults) &&
    (e.txid === undefined || typeof e.txid === 'string') &&
    (e.tx === undefined || Array.isArray(e.tx) || e.tx instanceof Uint8Array) &&
    (e.noSendChange === undefined || Array.isArray(e.noSendChange))
  );
}

function toSdkWerrReviewActions(error: WerrReviewActionsLike): WERR_REVIEW_ACTIONS {
  return new WERR_REVIEW_ACTIONS(
    error.reviewActionResults,
    error.sendWithResults,
    error.txid,
    error.tx,
    error.noSendChange,
  );
}

// Parse the origin header and turn it into a fqdn (e.g. projectbabbage.com:8080)
// Handles both origin and legacy originator headers
function parseOrigin(headers: Record<string, string>): string | null {
  const rawOrigin = headers['origin'];
  const rawOriginator = headers['originator'];

  // 1) Browser case
  if (rawOrigin) {
    try {
      return new URL(rawOrigin).host;
    } catch {
      return null;
    }
  }

  // 2) Node-injected fallback
  if (rawOriginator) {
    try {
      // Add scheme only if missing
      const candidate = rawOriginator.includes('://')
        ? rawOriginator
        : `http://${rawOriginator}`;
      return new URL(candidate).host;
    } catch {
      return null;
    }
  }

  return null;
}

// Module-level wallet ref — survives React effect cleanup/re-runs
let _currentWallet: WalletInterface | null = null;
let _currentStasDiscovery: any = null;
/**
 * BSV-21 discovery service exposed to `/bsv-21/register-by-txid`.
 *
 * This is a localhost-only demo fast-path: the dex-shell hands the wallet
 * a txid right after a faucet mint and the wallet fetches + parses +
 * internalizes the matching output(s) for immediate UI feedback. It
 * mirrors `/stas/register-by-txid`.
 *
 * The PRIMARY discovery mechanism is `BSV21DiscoveryService.scan()`,
 * which queries the 1Sat overlay's per-address SSE stream
 * (`/1sat/owner/{addr}/txos?unspent=true`). That path covers organic
 * receive (third party sends to one of our addresses) provided the
 * sender's broadcast routed through any `/1sat/tx`-capable endpoint —
 * which the faucet now does automatically per-mint.
 */
let _currentBsv21Discovery: any = null;
/**
 * STAS service bundle exposed to the Apps API routes (Task 7a). Set from
 * WalletContext via setStasForHttpRoute as soon as the WalletService's
 * StasServices snapshot becomes available.
 */
let _currentStasBundle: {
  discovery: any;
  transfer: any;
  keyDeriver: any;
  identityKey: string;
  chain: 'main' | 'test';
} | null = null;
/**
 * Permission gate for /stas/transfer. Set by WalletContext, called by the
 * route handler with the transfer details. Resolves true (approve) or false
 * (deny) once the user clicks one of the modal buttons.
 */
type StasTransferPermissionArgs = {
  originator: string;
  outpoint: string;
  symbol: string | null;
  tokenId: string | null;
  satoshis: number;
  recipient: string;
  brc42KeyId: string | null;
};
let _currentStasTransferEnqueuer:
  | ((args: StasTransferPermissionArgs) => Promise<boolean>)
  | null = null;
let _listenerRegistered = false;

/** Test-only: read current wallet ref */
export function _test_getCurrentWallet(): WalletInterface | null { return _currentWallet; }
/** Test-only: read listener state */
export function _test_isListenerRegistered(): boolean { return _listenerRegistered; }
/** Test-only: reset module state */
export function _test_reset(): void {
  _currentWallet = null;
  _currentStasDiscovery = null;
  _listenerRegistered = false;
}

/**
 * Inject (or clear) the STAS discovery service used by the
 * `/stas/register-by-txid` HTTP route. Called from WalletContext as soon
 * as the wallet's StasServices snapshot becomes available — kept separate
 * from `onWalletReady` so the prop interface stays single-arg.
 */
export function setStasDiscoveryForHttpRoute(
  discovery: { registerByTxid: (txid: string) => Promise<any> } | null
): void {
  _currentStasDiscovery = discovery;
}

/**
 * Inject (or clear) the full STAS service bundle for the Apps API routes
 * (`/stas/list`, `/stas/tokens`, `/stas/receive-address`, `/stas/transfer`).
 * Includes identityKey + chain so each route can drive stas:query without
 * a separate lookup.
 */
export function setStasForHttpRoute(
  bundle: {
    discovery: any;
    transfer: any;
    keyDeriver: any;
    identityKey: string;
    chain: 'main' | 'test';
  } | null
): void {
  _currentStasBundle = bundle;
  // Backward-compat: the older single-purpose discovery setter remains
  // populated for /stas/register-by-txid even if some callers haven't
  // upgraded yet.
  _currentStasDiscovery = bundle?.discovery ?? null;
}

/**
 * Inject (or clear) the BSV-21 discovery service used by the
 * `/bsv-21/register-by-txid` HTTP route. Mirrors `setStasDiscoveryForHttpRoute`.
 */
export function setBsv21DiscoveryForHttpRoute(
  discovery: { registerByTxid: (txid: string) => Promise<any> } | null
): void {
  _currentBsv21Discovery = discovery;
}

/**
 * Inject (or clear) the permission-prompt enqueuer used by /stas/transfer
 * to gate external app calls on user approval. Set by WalletContext.
 */
export function setStasTransferEnqueuer(
  fn: ((args: StasTransferPermissionArgs) => Promise<boolean>) | null
): void {
  _currentStasTransferEnqueuer = fn;
}

/**
 * Update the wallet instance used by the HTTP listener.
 * First call also registers the IPC listener (once, never removed).
 */
export const onWalletReady = async (
  wallet: WalletInterface
): Promise<(() => void) | undefined> => {
  _currentWallet = wallet;
  console.log('[onWalletReady] wallet ref updated, listenerRegistered:', _listenerRegistered);

  if (_listenerRegistered) return undefined;
  _listenerRegistered = true;

  console.log('[onWalletReady] registering IPC listener (once)');

  // Register ONCE — never removed. Wallet ref swapped via _currentWallet.
  window.electronAPI.onHttpRequest(async (req: HttpRequestEvent) => {
    let response: HttpResponseEvent;

    const wallet = _currentWallet;
    if (!wallet) {
      response = {
        request_id: req.request_id,
        status: 503,
        body: JSON.stringify({ message: 'Wallet not ready' })
      };
      window.electronAPI.sendHttpResponse(response);
      return;
    }

    try {
      const origin = parseOrigin(req.headers);

      if (!origin) {
        response = {
          request_id: req.request_id,
          status: 400,
          body: JSON.stringify({ message: 'Origin header is required' })
        };
        window.electronAPI.sendHttpResponse(response);
        return;
      }

      switch (req.path) {
        // 1. createAction
        case '/createAction': {
          try {
            const args = JSON.parse(req.body) as CreateActionArgs;
            const result = await wallet.createAction(args, origin);
            response = {
              request_id: req.request_id,
              status: 200,
              body: JSON.stringify(result),
            };
          } catch (error) {
            if (isWerrReviewActions(error)) {
              const e = toSdkWerrReviewActions(error);
              console.error('createAction WERR_REVIEW_ACTIONS:', e);
              response = {
                request_id: req.request_id,
                status: 400,
                body: JSON.stringify(e)
              };
            } else {
              console.error('createAction error:', error);
              response = {
                request_id: req.request_id,
                status: 400,
                body: JSON.stringify({
                  message: error instanceof Error ? error.message : String(error)
                })
              };
            }
          }
          break;
        }

        // 2. signAction
        case '/signAction': {
          try {
            const args = JSON.parse(req.body) as SignActionArgs;
            const result = await wallet.signAction(args, origin);
            response = {
              request_id: req.request_id,
              status: 200,
              body: JSON.stringify(result),
            };
          } catch (error) {
            if (isWerrReviewActions(error)) {
              const e = toSdkWerrReviewActions(error);
              console.error('signAction WERR_REVIEW_ACTIONS:', e);
              response = {
                request_id: req.request_id,
                status: 400,
                body: JSON.stringify(e)
              };
            } else {
              console.error('signAction error:', error);
              response = {
                request_id: req.request_id,
                status: 400,
                body: JSON.stringify({
                  message: error instanceof Error ? error.message : String(error)
                })
              };
            }
          }
          break;
        }

        // 3. abortAction
        case '/abortAction': {
          try {
            const args = JSON.parse(req.body) as AbortActionArgs;
            const result = await wallet.abortAction(args, origin);
            response = {
              request_id: req.request_id,
              status: 200,
              body: JSON.stringify(result),
            };
          } catch (error) {
            console.error('abortAction error:', error);
            response = {
              request_id: req.request_id,
              status: 400,
              body: JSON.stringify({
                message: error instanceof Error ? error.message : String(error)
              }),
            };
          }
          break;
        }

        // 4. listActions
        case '/listActions': {
          try {
            const args = JSON.parse(req.body) as ListActionsArgs;
            const result = await wallet.listActions(args, origin);
            response = {
              request_id: req.request_id,
              status: 200,
              body: JSON.stringify(result),
            };
          } catch (error) {
            console.error('listActions error:', error);
            response = {
              request_id: req.request_id,
              status: 400,
              body: JSON.stringify({
                message: error instanceof Error ? error.message : String(error)
              }),
            };
          }
          break;
        }

        // 5. internalizeAction
        case '/internalizeAction': {
          try {
            const args = JSON.parse(req.body) as InternalizeActionArgs;
            const result = await wallet.internalizeAction(args, origin);
            response = {
              request_id: req.request_id,
              status: 200,
              body: JSON.stringify(result),
            };
          } catch (error) {
            if (isWerrReviewActions(error)) {
              const e = toSdkWerrReviewActions(error);
              console.error('internalizeAction WERR_REVIEW_ACTIONS:', e);
              response = {
                request_id: req.request_id,
                status: 400,
                body: JSON.stringify(e)
              };
            } else {
              console.error('internalizeAction error:', error);
              response = {
                request_id: req.request_id,
                status: 400,
                body: JSON.stringify({
                  message: error instanceof Error ? error.message : String(error)
                }),
              };
            }
          }
          break;
        }

        // 6. listOutputs
        case '/listOutputs': {
          try {
            const args = JSON.parse(req.body) as ListOutputsArgs;
            const result = await wallet.listOutputs(args, origin);
            response = {
              request_id: req.request_id,
              status: 200,
              body: JSON.stringify(result),
            };
          } catch (error) {
            console.error('listOutputs error:', error);
            response = {
              request_id: req.request_id,
              status: 400,
              body: JSON.stringify({
                message: error instanceof Error ? error.message : String(error)
              }),
            };
          }
          break;
        }

        // 7. relinquishOutput
        case '/relinquishOutput': {
          try {
            const args = JSON.parse(req.body) as RelinquishOutputArgs;
            const result = await wallet.relinquishOutput(args, origin);
            response = {
              request_id: req.request_id,
              status: 200,
              body: JSON.stringify(result),
            };
          } catch (error) {
            console.error('relinquishOutput error:', error);
            response = {
              request_id: req.request_id,
              status: 400,
              body: JSON.stringify({
                message: error instanceof Error ? error.message : String(error)
              }),
            };
          }
          break;
        }

        // 8. getPublicKey
        case '/getPublicKey': {
          try {
            const args = JSON.parse(req.body) as GetPublicKeyArgs;
            const result = await wallet.getPublicKey(args, origin);
            response = {
              request_id: req.request_id,
              status: 200,
              body: JSON.stringify(result),
            };
          } catch (error) {
            console.error('getPublicKey error:', error);
            response = {
              request_id: req.request_id,
              status: 400,
              body: JSON.stringify({
                message: error instanceof Error ? error.message : String(error)
              }),
            };
          }
          break;
        }

        // 9. revealCounterpartyKeyLinkage
        case '/revealCounterpartyKeyLinkage': {
          try {
            const args = JSON.parse(req.body) as RevealCounterpartyKeyLinkageArgs;
            const result = await wallet.revealCounterpartyKeyLinkage(args, origin);
            response = {
              request_id: req.request_id,
              status: 200,
              body: JSON.stringify(result),
            };
          } catch (error) {
            console.error('revealCounterpartyKeyLinkage error:', error);
            response = {
              request_id: req.request_id,
              status: 400,
              body: JSON.stringify({
                message: error instanceof Error ? error.message : String(error)
              }),
            };
          }
          break;
        }

        // 10. revealSpecificKeyLinkage
        case '/revealSpecificKeyLinkage': {
          try {
            const args = JSON.parse(req.body) as RevealSpecificKeyLinkageArgs;
            const result = await wallet.revealSpecificKeyLinkage(args, origin);
            response = {
              request_id: req.request_id,
              status: 200,
              body: JSON.stringify(result),
            };
          } catch (error) {
            console.error('revealSpecificKeyLinkage error:', error);
            response = {
              request_id: req.request_id,
              status: 400,
              body: JSON.stringify({
                message: error instanceof Error ? error.message : String(error)
              }),
            };
          }
          break;
        }

        // 11. encrypt
        case '/encrypt': {
          try {
            const args = JSON.parse(req.body) as WalletEncryptArgs;
            const result = await wallet.encrypt(args, origin);
            response = {
              request_id: req.request_id,
              status: 200,
              body: JSON.stringify(result),
            };
          } catch (error) {
            console.error('encrypt error:', error);
            response = {
              request_id: req.request_id,
              status: 400,
              body: JSON.stringify({
                message: error instanceof Error ? error.message : String(error)
              }),
            };
          }
          break;
        }

        // 12. decrypt
        case '/decrypt': {
          try {
            const args = JSON.parse(req.body) as WalletDecryptArgs;
            const result = await wallet.decrypt(args, origin);
            response = {
              request_id: req.request_id,
              status: 200,
              body: JSON.stringify(result),
            };
          } catch (error) {
            console.error('decrypt error:', error);
            response = {
              request_id: req.request_id,
              status: 400,
              body: JSON.stringify({
                message: error instanceof Error ? error.message : String(error)
              }),
            };
          }
          break;
        }

        // 13. createHmac
        case '/createHmac': {
          try {
            const args = JSON.parse(req.body) as CreateHmacArgs;
            const result = await wallet.createHmac(args, origin);
            response = {
              request_id: req.request_id,
              status: 200,
              body: JSON.stringify(result),
            };
          } catch (error) {
            console.error('createHmac error:', error);
            response = {
              request_id: req.request_id,
              status: 400,
              body: JSON.stringify({
                message: error instanceof Error ? error.message : String(error)
              }),
            };
          }
          break;
        }

        // 14. verifyHmac
        case '/verifyHmac': {
          try {
            const args = JSON.parse(req.body) as VerifyHmacArgs;
            const result = await wallet.verifyHmac(args, origin);
            response = {
              request_id: req.request_id,
              status: 200,
              body: JSON.stringify(result),
            };
          } catch (error) {
            console.error('verifyHmac error:', error);
            response = {
              request_id: req.request_id,
              status: 400,
              body: JSON.stringify({
                message: error instanceof Error ? error.message : String(error)
              }),
            };
          }
          break;
        }

        // 15. createSignature
        case '/createSignature': {
          try {
            const args = JSON.parse(req.body) as CreateSignatureArgs;
            const result = await wallet.createSignature(args, origin);
            response = {
              request_id: req.request_id,
              status: 200,
              body: JSON.stringify(result),
            };
          } catch (error) {
            console.error('createSignature error:', error);
            response = {
              request_id: req.request_id,
              status: 400,
              body: JSON.stringify({
                message: error instanceof Error ? error.message : String(error)
              }),
            };
          }
          break;
        }

        // 16. verifySignature
        case '/verifySignature': {
          try {
            const args = JSON.parse(req.body) as VerifySignatureArgs;
            const result = await wallet.verifySignature(args, origin);
            response = {
              request_id: req.request_id,
              status: 200,
              body: JSON.stringify(result),
            };
          } catch (error) {
            console.error('verifySignature error:', error);
            response = {
              request_id: req.request_id,
              status: 400,
              body: JSON.stringify({
                message: error instanceof Error ? error.message : String(error)
              }),
            };
          }
          break;
        }

        // 17. acquireCertificate
        case '/acquireCertificate': {
          try {
            const args = JSON.parse(req.body) as AcquireCertificateArgs;
            const result = await wallet.acquireCertificate(args, origin);
            response = {
              request_id: req.request_id,
              status: 200,
              body: JSON.stringify(result),
            };
          } catch (error) {
            console.error('acquireCertificate error:', error);
            response = {
              request_id: req.request_id,
              status: 400,
              body: JSON.stringify({
                message: error instanceof Error ? error.message : String(error)
              }),
            };
          }
          break;
        }

        // 18. listCertificates
        case '/listCertificates': {
          try {
            const args = JSON.parse(req.body) as ListCertificatesArgs;
            const result = await wallet.listCertificates(args, origin);
            response = {
              request_id: req.request_id,
              status: 200,
              body: JSON.stringify(result),
            };
          } catch (error) {
            console.error('listCertificates error:', error);
            response = {
              request_id: req.request_id,
              status: 400,
              body: JSON.stringify({
                message: error instanceof Error ? error.message : String(error)
              }),
            };
          }
          break;
        }

        // 19. proveCertificate
        case '/proveCertificate': {
          try {
            const args = JSON.parse(req.body) as ProveCertificateArgs;
            const result = await wallet.proveCertificate(args, origin);
            response = {
              request_id: req.request_id,
              status: 200,
              body: JSON.stringify(result),
            };
          } catch (error) {
            console.error('proveCertificate error:', error);
            response = {
              request_id: req.request_id,
              status: 400,
              body: JSON.stringify({
                message: error instanceof Error ? error.message : String(error)
              }),
            };
          }
          break;
        }

        // 20. relinquishCertificate
        case '/relinquishCertificate': {
          try {
            const args = JSON.parse(req.body) as RelinquishCertificateArgs;
            const result = await wallet.relinquishCertificate(args, origin);
            response = {
              request_id: req.request_id,
              status: 200,
              body: JSON.stringify(result),
            };
          } catch (error) {
            console.error('relinquishCertificate error:', error);
            response = {
              request_id: req.request_id,
              status: 400,
              body: JSON.stringify({
                message: error instanceof Error ? error.message : String(error)
              }),
            };
          }
          break;
        }

        // 21. discoverByIdentityKey
        case '/discoverByIdentityKey': {
          try {
            const args = JSON.parse(req.body) as DiscoverByIdentityKeyArgs;
            const result = await wallet.discoverByIdentityKey(args, origin);
            response = {
              request_id: req.request_id,
              status: 200,
              body: JSON.stringify(result),
            };
          } catch (error) {
            console.error('discoverByIdentityKey error:', error);
            response = {
              request_id: req.request_id,
              status: 400,
              body: JSON.stringify({
                message: error instanceof Error ? error.message : String(error)
              }),
            };
          }
          break;
        }

        // 22. discoverByAttributes
        case '/discoverByAttributes': {
          try {
            const args = JSON.parse(req.body) as DiscoverByAttributesArgs;
            const result = await wallet.discoverByAttributes(args, origin);
            response = {
              request_id: req.request_id,
              status: 200,
              body: JSON.stringify(result),
            };
          } catch (error) {
            console.error('discoverByAttributes error:', error);
            response = {
              request_id: req.request_id,
              status: 400,
              body: JSON.stringify({
                message: error instanceof Error ? error.message : String(error)
              }),
            };
          }
          break;
        }

        // 23. isAuthenticated
        case '/isAuthenticated': {
          try {
            const result = await wallet.isAuthenticated({}, origin);
            response = {
              request_id: req.request_id,
              status: 200,
              body: JSON.stringify(result),
            };
          } catch (error) {
            console.error('isAuthenticated error:', error);
            response = {
              request_id: req.request_id,
              status: 400,
              body: JSON.stringify({
                message: error instanceof Error ? error.message : String(error)
              }),
            };
          }
          break;
        }

        // 24. waitForAuthentication
        case '/waitForAuthentication': {
          try {
            const result = await wallet.waitForAuthentication({}, origin);
            response = {
              request_id: req.request_id,
              status: 200,
              body: JSON.stringify(result),
            };
          } catch (error) {
            console.error('waitForAuthentication error:', error);
            response = {
              request_id: req.request_id,
              status: 400,
              body: JSON.stringify({
                message: error instanceof Error ? error.message : String(error)
              }),
            };
          }
          break;
        }

        // 25. getHeight
        case '/getHeight': {
          try {
            const result = await wallet.getHeight({}, origin);
            response = {
              request_id: req.request_id,
              status: 200,
              body: JSON.stringify(result),
            };
          } catch (error) {
            console.error('getHeight error:', error);
            response = {
              request_id: req.request_id,
              status: 400,
              body: JSON.stringify({
                message: error instanceof Error ? error.message : String(error)
              }),
            };
          }
          break;
        }

        // 26. getHeaderForHeight
        case '/getHeaderForHeight': {
          try {
            const args = JSON.parse(req.body) as GetHeaderArgs;
            const result = await wallet.getHeaderForHeight(args, origin);
            response = {
              request_id: req.request_id,
              status: 200,
              body: JSON.stringify(result),
            };
          } catch (error) {
            console.error('getHeaderForHeight error:', error);
            response = {
              request_id: req.request_id,
              status: 400,
              body: JSON.stringify({
                message: error instanceof Error ? error.message : String(error)
              }),
            };
          }
          break;
        }

        // 27. getNetwork
        case '/getNetwork': {
          try {
            const result = await wallet.getNetwork({}, origin);
            response = {
              request_id: req.request_id,
              status: 200,
              body: JSON.stringify(result),
            };
          } catch (error) {
            console.error('getNetwork error:', error);
            response = {
              request_id: req.request_id,
              status: 400,
              body: JSON.stringify({
                message: error instanceof Error ? error.message : String(error)
              }),
            };
          }
          break;
        }

        // 28. getVersion
        case '/getVersion': {
          try {
            const result = await wallet.getVersion({}, origin);
            response = {
              request_id: req.request_id,
              status: 200,
              body: JSON.stringify(result),
            };
          } catch (error) {
            console.error('getVersion error:', error);
            response = {
              request_id: req.request_id,
              status: 400,
              body: JSON.stringify({
                message: error instanceof Error ? error.message : String(error)
              }),
            };
          }
          break;
        }

        // ===== STAS Apps API (Task 7a) =====
        // Five HTTP routes that wrap the wallet's STAS surface so external
        // BRC-100 apps don't have to re-implement the createAction +
        // signAction plumbing from §12. Hides:
        //   - basket fragmentation / spendable flag overrides
        //   - inputBEEF construction with WoC fallback
        //   - partialSTASUnlockingScript + signature digest semantics
        //   - chain-of-state across discovery → transfer
        // Apps just call `fetch('http://127.0.0.1:3321/stas/...')`.

        case '/stas/list': {
          if (!_currentStasBundle) {
            response = {
              request_id: req.request_id,
              status: 503,
              body: JSON.stringify({ error: 'STAS services not ready' }),
            };
            break;
          }
          try {
            const { identityKey, chain } = _currentStasBundle;
            const outputs: any[] =
              (await stasQuery(
                identityKey,
                chain,
                'listStasOutputs',
                []
              )) ?? [];
            const tokens: any[] =
              (await stasQuery(
                identityKey,
                chain,
                'listStasTokens',
                []
              )) ?? [];
            const tokenMap: Record<string, any> = {};
            for (const t of tokens) tokenMap[t.tokenId] = t;
            const holdings = outputs.map((o: any) => ({
              outpoint: `${o.txid}.${o.vout}`,
              txid: o.txid,
              vout: o.vout,
              satoshis: o.outputSatoshis ?? o.tokenSatoshis,
              spendable: !!o.spendable,
              tokenId: o.tokenId,
              symbol: tokenMap[o.tokenId]?.symbol ?? null,
              name: tokenMap[o.tokenId]?.name ?? null,
              brc42KeyId: o.brc42KeyId ?? null,
              ownerFieldHash160: o.ownerFieldHash160,
              frozen: !!o.frozen,
              confiscated: !!o.confiscated,
            }));
            response = {
              request_id: req.request_id,
              status: 200,
              body: JSON.stringify({ holdings, total: holdings.length }),
            };
          } catch (e) {
            response = {
              request_id: req.request_id,
              status: 500,
              body: JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
            };
          }
          break;
        }

        case '/stas/tokens': {
          if (!_currentStasBundle) {
            response = {
              request_id: req.request_id,
              status: 503,
              body: JSON.stringify({ error: 'STAS services not ready' }),
            };
            break;
          }
          try {
            const { identityKey, chain } = _currentStasBundle;
            const tokens: any[] =
              (await stasQuery(
                identityKey,
                chain,
                'listStasTokens',
                []
              )) ?? [];
            const outputs: any[] =
              (await stasQuery(
                identityKey,
                chain,
                'listStasOutputs',
                []
              )) ?? [];
            // Aggregate counts + totalSatoshis per tokenId
            const byToken: Record<string, { count: number; total: number }> = {};
            for (const o of outputs) {
              const tid = o.tokenId;
              if (!tid) continue;
              const stat = (byToken[tid] = byToken[tid] ?? { count: 0, total: 0 });
              stat.count += 1;
              stat.total += o.outputSatoshis ?? o.tokenSatoshis ?? 0;
            }
            const enhanced = tokens.map((t: any) => ({
              tokenId: t.tokenId,
              symbol: t.symbol,
              name: t.name ?? null,
              satoshisPerToken: t.satoshisPerToken,
              freezeEnabled: !!t.freezeEnabled,
              confiscationEnabled: !!t.confiscationEnabled,
              redemptionPkh: t.redemptionPkh ?? null,
              issuerIdentityKey: t.issuerIdentityKey ?? null,
              outputCount: byToken[t.tokenId]?.count ?? 0,
              totalSatoshis: byToken[t.tokenId]?.total ?? 0,
            }));
            response = {
              request_id: req.request_id,
              status: 200,
              body: JSON.stringify({ tokens: enhanced }),
            };
          } catch (e) {
            response = {
              request_id: req.request_id,
              status: 500,
              body: JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
            };
          }
          break;
        }

        case '/stas/receive-address': {
          if (!_currentStasBundle?.keyDeriver) {
            response = {
              request_id: req.request_id,
              status: 503,
              body: JSON.stringify({ error: 'STAS services not ready' }),
            };
            break;
          }
          try {
            const { keyDeriver } = _currentStasBundle;
            const row = await keyDeriver.createNextReceiveContext();
            // hash160 → base58 P2PKH address. We import dxs-bsv-token-sdk's
            // Address inline so the route handler doesn't drag the dep into
            // the top-level import block.
            const dxs = await import('dxs-bsv-token-sdk/bsv');
            const base58 = new (dxs as any).Address(
              (dxs as any).fromHex(row.ownerFieldHash160)
            ).Value as string;
            response = {
              request_id: req.request_id,
              status: 200,
              body: JSON.stringify({
                address: base58,
                ownerFieldHash160: row.ownerFieldHash160,
                brc42KeyId: row.keyId,
                keyIndex: row.keyIndex,
              }),
            };
          } catch (e) {
            response = {
              request_id: req.request_id,
              status: 500,
              body: JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
            };
          }
          break;
        }

        case '/stas/transfer': {
          if (!_currentStasBundle?.transfer) {
            response = {
              request_id: req.request_id,
              status: 503,
              body: JSON.stringify({ error: 'STAS services not ready' }),
            };
            break;
          }
          try {
            const { transfer, identityKey, chain } = _currentStasBundle;
            const parsed = (req.body ? JSON.parse(req.body) : {}) as {
              outpoint?: string;
              recipientAddress?: string;
            };
            const outpoint = parsed.outpoint;
            const recipientAddress = parsed.recipientAddress;
            if (!outpoint || !recipientAddress) {
              response = {
                request_id: req.request_id,
                status: 400,
                body: JSON.stringify({
                  error: 'outpoint and recipientAddress are required',
                }),
              };
              break;
            }
            const [txid, voutStr] = outpoint.split('.');
            const vout = parseInt(voutStr, 10);
            if (!/^[0-9a-f]{64}$/i.test(txid) || !Number.isInteger(vout) || vout < 0) {
              response = {
                request_id: req.request_id,
                status: 400,
                body: JSON.stringify({ error: 'outpoint must be "<txid64hex>.<vout>"' }),
              };
              break;
            }
            // Look up the source's metadata from our satellite table.
            const allOutputs: any[] =
              (await stasQuery(
                identityKey,
                chain,
                'listStasOutputs',
                []
              )) ?? [];
            const source = allOutputs.find(
              (o: any) => o.txid === txid && o.vout === vout
            );
            if (!source) {
              response = {
                request_id: req.request_id,
                status: 404,
                body: JSON.stringify({
                  error: `STAS UTXO ${outpoint} not found in wallet`,
                }),
              };
              break;
            }

            // Permission gate: surface a modal to the user before we sign
            // and broadcast. The enqueuer is set by WalletContext;
            // if it's missing (e.g. the page is still mounting on first
            // boot) we fail closed with 503 rather than silently sign.
            if (!_currentStasTransferEnqueuer) {
              response = {
                request_id: req.request_id,
                status: 503,
                body: JSON.stringify({
                  ok: false,
                  reason: 'STAS transfer permission gate not ready',
                }),
              };
              break;
            }
            // Look up the token's symbol so the prompt shows something
            // meaningful (otherwise it would just say "100 sats").
            let tokenSymbol: string | null = null;
            try {
              const tokens: any[] =
                (await stasQuery(identityKey, chain, 'listStasTokens', [])) ?? [];
              const tok = tokens.find((t: any) => t.tokenId === source.tokenId);
              tokenSymbol = tok?.symbol ?? null;
            } catch { /* best effort */ }

            const approved = await _currentStasTransferEnqueuer({
              originator: origin || 'unknown',
              outpoint,
              symbol: tokenSymbol,
              tokenId: source.tokenId ?? null,
              satoshis: source.outputSatoshis ?? source.tokenSatoshis,
              recipient: recipientAddress,
              brc42KeyId: source.brc42KeyId ?? null,
            });
            if (!approved) {
              response = {
                request_id: req.request_id,
                status: 403,
                body: JSON.stringify({
                  ok: false,
                  reason: 'transfer denied by user',
                }),
              };
              break;
            }

            const result = await transfer.transfer({
              source: {
                txid: source.txid,
                vout: source.vout,
                scriptHex: source.lockingScript,
                satoshis: source.outputSatoshis ?? source.tokenSatoshis,
                brc42KeyId: source.brc42KeyId,
              },
              recipientAddress,
            });
            // Always return 200 when the transfer service produced a result —
            // success/failure is in the body's `ok` field. Reserve 500 for
            // actual handler exceptions (caught below). Previously a
            // failed-but-clean result mapped to 500, which made consumers'
            // generic HTTP-error handlers print "Internal Server Error"
            // instead of the real reason.
            if (!result.ok) {
              // eslint-disable-next-line no-console
              console.warn('[stas/transfer] service reported failure:', result.reason);
            }
            response = {
              request_id: req.request_id,
              status: 200,
              body: JSON.stringify(result),
            };
          } catch (e) {
            // Surface the actual exception so future failures are easier to
            // diagnose than a bare 500. Goes to the renderer's DevTools
            // console where you can read it.
            // eslint-disable-next-line no-console
            console.error('[stas/transfer] handler threw:', e);
            response = {
              request_id: req.request_id,
              status: 500,
              body: JSON.stringify({
                ok: false,
                reason: e instanceof Error ? e.message : String(e),
              }),
            };
          }
          break;
        }

        // STAS auto-register (non-BRC-100, BSV Desktop extension).
        // Faucets / senders POST { txid } after broadcast; the wallet runs
        // discovery.registerByTxid which fetches the rawTx + merkle path,
        // parses, matches owner field to a derived key, and internalizes.
        case '/stas/register-by-txid': {
          // DEMO-ONLY fast-path. The PRIMARY STAS discovery mechanism is
          // `StasDiscoveryService.scan()` via Bitails, fired by the
          // AssetsPage Refresh button + on wallet mount. This route lets
          // a colocated mint flow (the demo faucet via the dex-shell)
          // skip the indexer round-trip and get immediate UI feedback.
          try {
            if (!_currentStasDiscovery) {
              response = {
                request_id: req.request_id,
                status: 503,
                body: JSON.stringify({ error: 'STAS discovery service not ready' }),
              };
              break;
            }
            const { txid } = (req.body ? JSON.parse(req.body) : {}) as { txid?: string };
            if (typeof txid !== 'string' || !/^[0-9a-f]{64}$/i.test(txid)) {
              response = {
                request_id: req.request_id,
                status: 400,
                body: JSON.stringify({ error: 'txid (64-hex) is required' }),
              };
              break;
            }
            const result = await _currentStasDiscovery.registerByTxid(txid);
            response = {
              request_id: req.request_id,
              status: 200,
              body: JSON.stringify(result),
            };
          } catch (e) {
            response = {
              request_id: req.request_id,
              status: 500,
              body: JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
            };
          }
          break;
        }

        case '/bsv-21/register-by-txid': {
          // DEMO-ONLY fast-path. The PRIMARY BSV-21 discovery mechanism
          // is `BSV21DiscoveryService.scan()` via the 1Sat overlay's
          // per-address SSE stream. That path covers organic receive —
          // any sender whose broadcast routes through `/1sat/tx` (the
          // faucet now does this per-mint) registers their tx with the
          // overlay's BSV-21 topic-manager, after which the wallet's
          // per-address sync surfaces the UTXO on Refresh.
          //
          // This route exists for immediate UI feedback: a colocated
          // mint flow (dex-shell after a faucet mint) hands the wallet
          // the txid and we register the output without waiting for the
          // next Refresh. Mirror of `/stas/register-by-txid`.
          try {
            if (!_currentBsv21Discovery) {
              response = {
                request_id: req.request_id,
                status: 503,
                body: JSON.stringify({ error: 'BSV-21 discovery service not ready' }),
              };
              break;
            }
            const { txid } = (req.body ? JSON.parse(req.body) : {}) as { txid?: string };
            if (typeof txid !== 'string' || !/^[0-9a-f]{64}$/i.test(txid)) {
              response = {
                request_id: req.request_id,
                status: 400,
                body: JSON.stringify({ error: 'txid (64-hex) is required' }),
              };
              break;
            }
            const result = await _currentBsv21Discovery.registerByTxid(txid);
            response = {
              request_id: req.request_id,
              status: 200,
              body: JSON.stringify(result),
            };
          } catch (e) {
            response = {
              request_id: req.request_id,
              status: 500,
              body: JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
            };
          }
          break;
        }

        default: {
          response = {
            request_id: req.request_id,
            status: 404,
            body: JSON.stringify({ error: 'Unknown wallet path: ' + req.path }),
          };
          break;
        }
      }

      // Send response back to main process
      window.electronAPI.sendHttpResponse(response);
    } catch (e) {
      console.error("Error handling http-request event:", e);
      response = {
        request_id: req.request_id,
        status: 500,
        body: JSON.stringify({ error: String(e) })
      };
      window.electronAPI.sendHttpResponse(response);
    }
  });

  // No cleanup — listener is permanent
  return undefined;
};
