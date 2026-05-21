/**
 * Rate-limited fetch queue with 429 retry/backoff.
 *
 * Caps outbound rate (default: 2 req/s) AND auto-retries on 429 with
 * exponential backoff. Without retry, the STAS gap-limit scan (100+ addresses
 * to Bitails / WoC) loses any candidate that happens to be 429'd — the
 * IndexerClient catches errors and silently treats them as []. So a real
 * STAS UTXO at one of those addresses can be missed entirely and the scan
 * reports Candidates 0 even when the indexer has it.
 *
 * Honours `Retry-After` when the server sends it; otherwise backs off
 * 1.5s, 3s, 6s across three attempts before surfacing the 429 to the caller.
 */
class RateLimitedFetch {
  private queue: Array<{
    url: string
    options?: RequestInit
    resolve: (value: Response) => void
    reject: (error: Error) => void
  }> = []
  private processing = false
  private requestsPerSecond: number
  private minInterval: number
  private maxRetries: number

  constructor(requestsPerSecond: number = 2, maxRetries: number = 3) {
    this.requestsPerSecond = requestsPerSecond
    this.minInterval = 1000 / requestsPerSecond
    this.maxRetries = maxRetries
  }

  async fetch(url: string, options?: RequestInit): Promise<Response> {
    return new Promise((resolve, reject) => {
      this.queue.push({ url, options, resolve, reject })
      if (!this.processing) {
        this.processQueue()
      }
    })
  }

  private async fetchWithRetry(url: string, options?: RequestInit): Promise<Response> {
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const res = await fetch(url, options)
      if (res.status !== 429) return res
      if (attempt === this.maxRetries) return res
      const retryAfter = parseInt(res.headers.get('Retry-After') ?? '', 10)
      const backoff = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 1500 * Math.pow(2, attempt)
      await new Promise((r) => setTimeout(r, backoff))
    }
    return fetch(url, options)
  }

  private async processQueue() {
    if (this.queue.length === 0) {
      this.processing = false
      return
    }

    this.processing = true
    const item = this.queue.shift()!
    const startTime = Date.now()

    try {
      const response = await this.fetchWithRetry(item.url, item.options)
      item.resolve(response)
    } catch (error) {
      item.reject(error as Error)
    }

    const elapsed = Date.now() - startTime
    const delay = Math.max(0, this.minInterval - elapsed)

    setTimeout(() => {
      this.processQueue()
    }, delay)
  }
}

// Singleton instance for WhatsOnChain / Bitails API calls. 2 req/s leaves
// headroom for wallet-toolbox's own concurrent WoC traffic; 429s auto-retry
// with backoff.
export const wocFetch = new RateLimitedFetch(2)
