/**
 * Rate-limited fetch queue with 429 retry/backoff.
 *
 * Caps outbound rate (default: 2 req/s) AND auto-retries when WoC returns
 * 429, with exponential backoff. Previously this class only spaced requests
 * out and surfaced 429s as ordinary failures — which meant a busy scan
 * (e.g. STAS gap-limit hitting 110 derived addresses) would silently lose
 * candidates whenever the wallet's other operations (balance polling,
 * Services calls in wallet-toolbox) burst alongside it. Result: STAS scan
 * shows Candidates 0 even when the indexer has the UTXO indexed.
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
      // exponential backoff: 1.5s, 3s, 6s; honour Retry-After if present
      const retryAfter = parseInt(res.headers.get('Retry-After') ?? '', 10)
      const backoff = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 1500 * Math.pow(2, attempt)
      await new Promise((r) => setTimeout(r, backoff))
    }
    // unreachable; loop returns on the last attempt
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

    // Ensure minimum interval between requests
    const elapsed = Date.now() - startTime
    const delay = Math.max(0, this.minInterval - elapsed)

    setTimeout(() => {
      this.processQueue()
    }, delay)
  }
}

// Singleton instance for WhatsOnChain API calls. 2 req/s leaves headroom for
// wallet-toolbox's own concurrent WoC traffic; 429s are auto-retried.
export const wocFetch = new RateLimitedFetch(2)
