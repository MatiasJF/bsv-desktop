/**
 * TokenVerificationService tests — the caching + aggregation layer over B2G.
 *
 * The security-relevant invariants: a counterfeit output taints its card's
 * badge, an `undetermined` never reads as verified, settled verdicts are cached
 * (and `undetermined` ones are NOT — they must be retried), and the
 * protocol→std mapping is right (`bsv-21` → `bsv21`).
 */

import { describe, test, expect, vi, beforeEach } from 'vitest'
import {
  TokenVerificationService,
  aggregateBadge,
  type OutpointVerification,
} from '../../src/lib/services/tokens/TokenVerificationService'

// A stub B2G client we can drive per outpoint.
function stubClient(byTxid: Record<string, any>) {
  return {
    verify: vi.fn(async (_std: string, txid: string, index: number) => {
      const base = byTxid[txid] ?? { result: 'undetermined', reason: 'source-unavailable' }
      return { outpoint: { txid, index }, ...base }
    }),
  } as any
}

// The electron vitest env is `node` (no localStorage) — shim a minimal one so
// the persistence path is exercised exactly as it runs in the renderer.
beforeEach(() => {
  const store = new Map<string, string>()
  ;(globalThis as any).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  }
})

describe('aggregateBadge — worst verdict wins', () => {
  const v = (result: string): OutpointVerification => ({ outpoint: 'x_0', result: result as any })
  test('all authentic → verified', () => {
    expect(aggregateBadge([v('authentic'), v('authentic')])).toBe('verified')
  })
  test('any counterfeit → counterfeit, even amid authentic', () => {
    expect(aggregateBadge([v('authentic'), v('not-authentic')])).toBe('counterfeit')
  })
  test('undetermined present, none counterfeit → unknown', () => {
    expect(aggregateBadge([v('authentic'), v('undetermined')])).toBe('unknown')
  })
  test('empty → unknown', () => {
    expect(aggregateBadge([])).toBe('unknown')
  })
})

describe('verifyOutput — protocol→std mapping + shape', () => {
  test('bsv-21 protocol maps to the bsv21 endpoint segment', async () => {
    const client = stubClient({ tx1: { result: 'authentic', genesis: { txid: 'tx1', index: 0 }, genesisDepth: 0 } })
    const svc = new TokenVerificationService({ chain: 'main', client })
    await svc.verifyOutput({ txid: 'tx1', vout: 0, protocol: 'bsv-21' })
    expect(client.verify).toHaveBeenCalledWith('bsv21', 'tx1', 0, { expectedGenesis: undefined })
  })

  test('maps genesis outpoint to the string form', async () => {
    const client = stubClient({ tx1: { result: 'authentic', genesis: { txid: 'gen', index: 2 }, genesisDepth: 3 } })
    const svc = new TokenVerificationService({ chain: 'main', client })
    const r = await svc.verifyOutput({ txid: 'tx1', vout: 0, protocol: 'stas' })
    expect(r.genesis).toBe('gen_2')
    expect(r.genesisDepth).toBe(3)
  })
})

describe('caching', () => {
  test('a settled verdict is not re-fetched', async () => {
    const client = stubClient({ tx1: { result: 'authentic', genesis: { txid: 'tx1', index: 0 } } })
    const svc = new TokenVerificationService({ chain: 'main', client })
    await svc.verifyOutput({ txid: 'tx1', vout: 0, protocol: 'stas' })
    await svc.verifyOutput({ txid: 'tx1', vout: 0, protocol: 'stas' })
    expect(client.verify).toHaveBeenCalledTimes(1)
  })

  test('an undetermined verdict IS retried (it means "unknown", not "no")', async () => {
    const client = stubClient({ tx1: { result: 'undetermined', reason: 'source-unavailable' } })
    const svc = new TokenVerificationService({ chain: 'main', client })
    await svc.verifyOutput({ txid: 'tx1', vout: 0, protocol: 'stas' })
    await svc.verifyOutput({ txid: 'tx1', vout: 0, protocol: 'stas' })
    expect(client.verify).toHaveBeenCalledTimes(2)
  })

  test('settled verdicts persist across service instances; undetermined does not', async () => {
    const c1 = stubClient({
      good: { result: 'authentic', genesis: { txid: 'good', index: 0 } },
      pend: { result: 'undetermined', reason: 'source-unavailable' },
    })
    const svc1 = new TokenVerificationService({ chain: 'main', client: c1 })
    await svc1.verifyOutput({ txid: 'good', vout: 0, protocol: 'stas' })
    await svc1.verifyOutput({ txid: 'pend', vout: 0, protocol: 'stas' })

    // New instance shares localStorage — 'good' is cached, 'pend' is not.
    const c2 = stubClient({
      good: { result: 'authentic', genesis: { txid: 'good', index: 0 } },
      pend: { result: 'authentic', genesis: { txid: 'pend', index: 0 } },
    })
    const svc2 = new TokenVerificationService({ chain: 'main', client: c2 })
    await svc2.verifyOutput({ txid: 'good', vout: 0, protocol: 'stas' })
    await svc2.verifyOutput({ txid: 'pend', vout: 0, protocol: 'stas' })
    expect(c2.verify).toHaveBeenCalledTimes(1) // only 'pend' re-fetched
    expect(c2.verify).toHaveBeenCalledWith('stas', 'pend', 0, expect.anything())
  })
})

describe('verifyOutputs — batch', () => {
  test('returns a map keyed by outpoint', async () => {
    const client = stubClient({
      a: { result: 'authentic', genesis: { txid: 'a', index: 0 } },
      b: { result: 'not-authentic', reason: 'no-genesis' },
    })
    const svc = new TokenVerificationService({ chain: 'main', client })
    const m = await svc.verifyOutputs([
      { txid: 'a', vout: 0, protocol: 'stas' },
      { txid: 'b', vout: 1, protocol: 'dstas' },
    ])
    expect(m.get('a_0')?.result).toBe('authentic')
    expect(m.get('b_1')?.result).toBe('not-authentic')
  })
})
