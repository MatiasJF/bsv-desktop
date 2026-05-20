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
   * UTXOs at a base58 P2PKH-ish address. Returns `[]` on lookup failure
   * (including 404s, which WoC returns for some address states).
   *
   * Mempool visibility note: this endpoint only returns CONFIRMED outputs.
   * A STAS sitting in mempool isn't visible here until the block lands.
   * The earlier attempt to also hit `/confirmed/unspent` + `/unconfirmed/unspent`
   * was a dead end — WoC returns 404 for never-used addresses on those subpaths
   * and rate-limits the unconfirmed one harder. The right path to mempool
   * visibility is `/address/{addr}/history` (lists all txs incl. mempool),
   * but that's a more involved change; for MVP we just wait for confirmation.
   */
  async getUtxosForAddress(address: string): Promise<WocUtxo[]> {
    const raw = await this.wocGet<RawWocUtxo[]>(`/address/${address}/unspent`).catch(() => null);
    if (!Array.isArray(raw)) return [];
    return raw.map((u) => ({
      txid: (u.tx_hash ?? u.txHash) as string,
      vout: (u.tx_pos ?? u.txPos) as number,
      value: u.value,
      height: u.height ?? 0,
    }));
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
