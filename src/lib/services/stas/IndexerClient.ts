/**
 * IndexerClient — minimal WhatsOnChain REST client for STAS discovery.
 *
 * Only the UTXO-list scan goes through here. Raw transactions and merkle
 * proofs come from `wallet.getServices()` (see StasRegistration), so this
 * file does not duplicate that surface.
 *
 * WoC's `/address/{addr}/unspent` does not include the locking script — the
 * discovery loop fetches each candidate transaction via Services and decodes
 * the output script itself.
 *
 * Routes every request through the wallet's shared `wocFetch` queue so STAS
 * scans share the global rate-limit budget with the wallet's own WoC polling
 * (currently 3 req/s for the whole renderer). Without that coordination the
 * scan triggers 429s on the wallet's balance fetcher.
 */

import { wocFetch } from '../../utils/RateLimitedFetch';

const WOC_BASE_MAINNET = 'https://api.whatsonchain.com/v1/bsv/main';

export interface WocUtxo {
  /** Transaction id (hex). */
  txid: string;
  /** Output index. */
  vout: number;
  /** Satoshis. */
  value: number;
  /** Block height; 0 / undefined for mempool. */
  height: number;
}

interface RawWocUtxo {
  tx_hash?: string;
  txHash?: string;
  tx_pos?: number;
  txPos?: number;
  value: number;
  height: number;
}

export class IndexerClient {
  constructor(private readonly baseUrl: string = WOC_BASE_MAINNET) {}

  /**
   * UTXOs at a base58 P2PKH-ish address, confirmed + unconfirmed.
   *
   * WoC's legacy `/address/{addr}/unspent` endpoint only surfaces confirmed
   * outputs, so a fresh STAS sitting in mempool returns 0 candidates. Fetching
   * `/confirmed/unspent` + `/unconfirmed/unspent` in parallel gives the scan
   * mempool visibility — the unconfirmed ones are tagged `height: 0` so the
   * discovery loop defers them (confirmed-only MVP) instead of vanishing.
   */
  async getUtxosForAddress(address: string): Promise<WocUtxo[]> {
    const [confirmed, unconfirmed] = await Promise.all([
      this.fetchUtxoList(`/address/${address}/confirmed/unspent`),
      this.fetchUtxoList(`/address/${address}/unconfirmed/unspent`),
    ]);
    return [
      ...confirmed,
      ...unconfirmed.map((u) => ({ ...u, height: 0 })),
    ];
  }

  private async fetchUtxoList(path: string): Promise<WocUtxo[]> {
    try {
      const raw = await this.wocGet<RawWocUtxo[]>(path);
      if (!Array.isArray(raw)) return [];
      return raw.map((u) => ({
        txid: (u.tx_hash ?? u.txHash) as string,
        vout: (u.tx_pos ?? u.txPos) as number,
        value: u.value,
        height: u.height ?? 0,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Scan UTXOs across many addresses. All requests are queued into the
   * shared `wocFetch` global rate-limit (3 req/s), so callers can fire many
   * lookups concurrently without flooding WoC. Per-address errors are
   * absorbed so one bad address does not abort the scan.
   */
  async getUtxosForAddresses(
    addresses: string[]
  ): Promise<Array<{ address: string; utxos: WocUtxo[] }>> {
    return Promise.all(
      addresses.map(async (address) => {
        try {
          return { address, utxos: await this.getUtxosForAddress(address) };
        } catch {
          return { address, utxos: [] };
        }
      })
    );
  }

  private async wocGet<T>(path: string): Promise<T> {
    const res = await wocFetch.fetch(`${this.baseUrl}${path}`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`WoC GET ${path} -> ${res.status}: ${body.slice(0, 120)}`);
    }
    return res.json() as Promise<T>;
  }
}
