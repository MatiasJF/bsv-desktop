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
 */

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
  constructor(
    private readonly baseUrl: string = WOC_BASE_MAINNET,
    private readonly delayMs: number = 150
  ) {}

  /** UTXOs at a base58 P2PKH-ish address. Returns `[]` on lookup failure. */
  async getUtxosForAddress(address: string): Promise<WocUtxo[]> {
    const raw = await this.wocGet<RawWocUtxo[]>(`/address/${address}/unspent`);
    if (!Array.isArray(raw)) return [];
    return raw.map((u) => ({
      txid: (u.tx_hash ?? u.txHash) as string,
      vout: (u.tx_pos ?? u.txPos) as number,
      value: u.value,
      height: u.height,
    }));
  }

  /**
   * Scan UTXOs across many addresses. Sequential with inter-call rate-limit
   * to keep WoC happy; per-address errors are absorbed so one bad address
   * does not abort the scan.
   */
  async getUtxosForAddresses(
    addresses: string[]
  ): Promise<Array<{ address: string; utxos: WocUtxo[] }>> {
    const results: Array<{ address: string; utxos: WocUtxo[] }> = [];
    for (let i = 0; i < addresses.length; i++) {
      const address = addresses[i];
      try {
        const utxos = await this.getUtxosForAddress(address);
        results.push({ address, utxos });
      } catch {
        results.push({ address, utxos: [] });
      }
      if (i < addresses.length - 1) await sleep(this.delayMs);
    }
    return results;
  }

  private async wocGet<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`WoC GET ${path} -> ${res.status}: ${body.slice(0, 120)}`);
    }
    return res.json() as Promise<T>;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
