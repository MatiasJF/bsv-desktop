/**
 * IndexerClient — STAS UTXO scanner.
 *
 * Queries Bitails's STAS-aware indexer at
 *   GET https://api.bitails.io/address/{addr}/tokens/unspent
 * which returns STAS UTXOs with the full locking script + token metadata.
 *
 * Why Bitails and not WhatsOnChain: WoC's `stas-tokens-beta` endpoint is a
 * curated registry — it only indexes pre-registered tokens (everything in
 * its `stas_all` is a Taal/Vaionex experiment) and returns `utxos:null` for
 * newly-minted tokens like ours. Bitails auto-indexes any classic-STAS
 * output; live-tested, our `FTK` faucet token shows up immediately after
 * confirmation. Their docs: https://docs.bitails.io/#get-unspent-tokens-address
 *
 * Per-address UTXO fetch only. Raw transactions and merkle proofs still go
 * through `wallet.getServices()` (see `StasRegistration`); Bitails gives us
 * the script + symbol + amount, which is enough to identify ownership but
 * not to build the AtomicBEEF.
 *
 * Routes every request through the shared `wocFetch` queue so this scan
 * shares the global rate-limit budget with the wallet's other WoC polling.
 */

import { wocFetch } from '../../utils/RateLimitedFetch';

const BITAILS_BASE_MAINNET = 'https://api.bitails.io';

export interface WocUtxo {
  /** Transaction id (hex). */
  txid: string;
  /** Output index. */
  vout: number;
  /** Satoshis. */
  value: number;
  /** Block height; 0 / undefined for mempool. */
  height: number;
  /** Optional metadata from the Bitails STAS indexer. */
  symbol?: string;
  /** tokenId / issuer PKH hex, when present in the indexer response. */
  redeemAddr?: string;
  /** Full locking script hex from the indexer (avoids a getRawTx for parsing). */
  scriptHex?: string;
}

interface BitailsStasUtxo {
  txid: string;
  index: number;
  amount?: number;
  script?: string;
  symbol?: string;
  redeemAddr?: string;
}

export class IndexerClient {
  constructor(private readonly baseUrl: string = BITAILS_BASE_MAINNET) {}

  /**
   * STAS UTXOs at a base58 address, via Bitails's STAS indexer.
   *
   * Bitails only surfaces *confirmed* STAS UTXOs (their indexer ingests on
   * block, not on mempool), so we treat every returned UTXO as confirmed and
   * stamp `height: 1` as the sentinel. The discovery loop's confirmed-only
   * MVP gate already trusts height > 0.
   *
   * Per-address query means every UTXO returned IS owned by that address by
   * construction — the discovery loop can trust the address mapping without
   * re-parsing the locking script for ownership, falling back to a parser
   * only for tokenId / metadata extraction.
   */
  async getUtxosForAddress(address: string): Promise<WocUtxo[]> {
    const res = await this.bitailsGet<{ utxos?: BitailsStasUtxo[] }>(
      `/address/${address}/tokens/unspent?from=0&limit=100`
    ).catch(() => null);
    if (!res || !Array.isArray(res.utxos)) return [];
    return res.utxos.map((u) => ({
      txid: u.txid,
      vout: u.index,
      value: u.amount ?? 0,
      height: 1, // Bitails returns only confirmed UTXOs
      symbol: u.symbol,
      redeemAddr: u.redeemAddr,
      scriptHex: u.script,
    }));
  }

  /**
   * Scan UTXOs across many addresses via Bitails's bulk endpoint
   * (POST /address/tokens/unspent/multi). For a typical 100-address gap scan
   * this turns ~100 sequential GETs into ~5 batched POSTs — minutes -> seconds.
   *
   * Body shape: { "addresses": [...] } (NOT "addrList" — that returns 500).
   * Response:   [ { address, utxos: [...] }, ... ].
   *
   * Falls back to per-address GETs on any bulk error, so one bad chunk does
   * not abort the scan.
   */
  async getUtxosForAddresses(
    addresses: string[]
  ): Promise<Array<{ address: string; utxos: WocUtxo[] }>> {
    if (addresses.length === 0) return [];
    const BATCH = 20; // Bitails accepts up to 50, conservative default
    const out: Array<{ address: string; utxos: WocUtxo[] }> = [];
    for (let i = 0; i < addresses.length; i += BATCH) {
      const chunk = addresses.slice(i, i + BATCH);
      try {
        const res = await this.bitailsBulk(chunk);
        if (Array.isArray(res)) {
          // Bitails returns one entry per address it found tokens for. Make
          // sure we cover the whole chunk so the caller can rely on parity.
          const byAddr = new Map<string, BitailsStasUtxo[]>();
          for (const entry of res) {
            if (entry && typeof entry.address === 'string') {
              byAddr.set(entry.address, Array.isArray(entry.utxos) ? entry.utxos : []);
            }
          }
          for (const addr of chunk) {
            const utxos = (byAddr.get(addr) ?? []).map((u) => ({
              txid: u.txid,
              vout: u.index,
              value: u.amount ?? 0,
              height: 1,
              symbol: u.symbol,
              redeemAddr: u.redeemAddr,
              scriptHex: u.script,
            }));
            out.push({ address: addr, utxos });
          }
          continue;
        }
      } catch {
        // fall through to per-address fallback for this chunk
      }
      // Fallback: per-address GETs for this chunk only.
      for (const addr of chunk) {
        try {
          out.push({ address: addr, utxos: await this.getUtxosForAddress(addr) });
        } catch {
          out.push({ address: addr, utxos: [] });
        }
      }
    }
    return out;
  }

  private async bitailsGet<T>(path: string): Promise<T> {
    const res = await wocFetch.fetch(`${this.baseUrl}${path}`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Bitails GET ${path} -> ${res.status}: ${body.slice(0, 120)}`);
    }
    return res.json() as Promise<T>;
  }

  private async bitailsBulk(
    addresses: string[]
  ): Promise<Array<{ address: string; utxos: BitailsStasUtxo[] }>> {
    const res = await wocFetch.fetch(
      `${this.baseUrl}/address/tokens/unspent/multi?from=0&limit=100`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ addresses }),
      }
    );
    if (!res.ok) {
      throw new Error(`Bitails bulk ${res.status}`);
    }
    return res.json();
  }
}
