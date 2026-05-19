/**
 * DSTAS locking-script parser.
 *
 * The single import site of `dxs-bsv-token-sdk` for ownership recognition —
 * the rest of bsv-desktop works against the normalized `ParsedDstas` shape and
 * never touches the SDK's reader types directly.
 */

import { ScriptType, LockingScriptReader, toHex } from 'dxs-bsv-token-sdk/bsv';

export interface ParsedDstas {
  /** 20-byte owner field (PKH), hex — what ownership recognition matches on. */
  ownerFieldHash160: string;
  /** Redemption / protoID PKH (the token id), hex. */
  tokenId: string;
  freezeEnabled: boolean;
  confiscationEnabled: boolean;
  /** Raw flags region, hex. */
  flagsHex: string;
  /** Service-field byte regions, hex. */
  serviceFields: string[];
}

/**
 * Parse a locking script as DSTAS. Returns `null` — never throws — for any
 * script that is not DSTAS or whose owner field is not a 20-byte PKH (other
 * identity-field shapes are not wallet-recognisable and are treated as foreign).
 */
export function parseDstasLockingScript(scriptHex: string): ParsedDstas | null {
  let reader: any;
  try {
    reader = LockingScriptReader.readHex(scriptHex);
  } catch {
    return null;
  }
  if (!reader || reader.ScriptType !== ScriptType.dstas) return null;

  const d = reader.Dstas;
  if (!d || !d.Owner || d.Owner.length !== 20) return null;

  return {
    ownerFieldHash160: toHex(d.Owner),
    tokenId: toHex(d.Redemption),
    freezeEnabled: !!d.FreezeEnabled,
    confiscationEnabled: !!d.ConfiscationEnabled,
    flagsHex: toHex(d.Flags),
    serviceFields: (d.ServiceFields || []).map((f: any) => toHex(f)),
  };
}
