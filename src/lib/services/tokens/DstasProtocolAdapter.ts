/**
 * DstasProtocolAdapter — STAS v3 / "DSTAS", parsed via dxs-bsv-token-sdk.
 *
 * Discovery + registration are fully supported. Transfer is intentionally
 * NOT implemented: the DSTAS engine has different unlock semantics from
 * classic STAS and the wallet doesn't yet carry the BRC-42 path for it.
 * Exposing `transferSupported: false` lets the UI surface this honestly
 * (disabled Send button with a tooltip) instead of failing mid-flow.
 */

import { DSTAS_BASKET } from '../../constants/baskets';
import { parseDstasLockingScript } from '../stas/dstasParser';
import type {
  TokenProtocolAdapter,
  ParsedTokenOutput,
} from './TokenProtocolAdapter';

export class DstasProtocolAdapter implements TokenProtocolAdapter {
  readonly id = 'dstas' as const;
  readonly basketName = DSTAS_BASKET;
  readonly displayName = 'DSTAS';
  readonly transferSupported = false;

  async parseOutput(scriptHex: string): Promise<ParsedTokenOutput | null> {
    const parsed = parseDstasLockingScript(scriptHex);
    if (!parsed) return null;
    return {
      tokenId: parsed.tokenId,
      ownerFieldHash160: parsed.ownerFieldHash160,
      flagsHex: parsed.flagsHex,
      satoshisPerToken: 1,
      freezeEnabled: parsed.freezeEnabled,
      confiscationEnabled: parsed.confiscationEnabled,
      serviceFields: parsed.serviceFields,
    };
  }
}
