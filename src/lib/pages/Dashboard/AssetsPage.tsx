/**
 * AssetsPage — production-facing wallet view for STAS holdings.
 *
 * Replaces the dev panel's "My STAS" surface with a token-grouped layout:
 * one card per (symbol, tokenId) bucket, expandable to show the underlying
 * UTXOs, with explicit Send and Receive flows.
 *
 * Reads + writes through the same internal services the Apps API (Task 7a)
 * exposes externally. This page is the user-facing surface. (The former
 * StasDebugPanel dev route has been retired from navigation.)
 */

import React, { useCallback, useContext, useEffect, useMemo, useState } from 'react'
import {
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material'
import RefreshIcon from '@mui/icons-material/Refresh'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import CheckIcon from '@mui/icons-material/Check'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import ExpandLessIcon from '@mui/icons-material/ExpandLess'
import SendIcon from '@mui/icons-material/Send'
import OpenInNewIcon from '@mui/icons-material/OpenInNew'
import TokenIcon from '@mui/icons-material/Token'
import AddCircleOutlineIcon from '@mui/icons-material/AddCircleOutline'
import SearchIcon from '@mui/icons-material/Search'
import { QRCodeSVG } from 'qrcode.react'
import { Address, fromHex } from 'dxs-bsv-token-sdk/bsv'
import { WalletContext } from '../../WalletContext'
import { stasQuery } from '../../services/stas'
import type { TokenProtocolId, Bsv21SendExtras } from '../../services/tokens'
import { parseBsv21LockingScript } from '../../services/tokens'
import { BSV21_BASKET } from '../../constants/baskets'

interface OutputView {
  outpoint: string
  txid: string
  vout: number
  satoshis: number
  spendable: boolean
  tokenId: string
  symbol: string | null
  name: string | null
  brc42KeyId: string | null
  ownerFieldHash160: string
  ownerAddress: string
  scriptHex: string | null
  frozen: boolean
  confiscated: boolean
  /** Set when wallet-toolbox marked this row as spent (consumed by a tx). */
  spentBy: string | null
  /** ISO timestamp from stas_outputs.createdAt — used for activity ordering. */
  createdAt: string | null
  /** Which token protocol this UTXO belongs to. */
  protocol: TokenProtocolId
  /**
   * Raw token amount (stringified bigint). For STAS/DSTAS this is `satoshis`
   * since their satoshisPerToken=1. For BSV-21 it's the `amt` field parsed
   * from the basket tag, which may be much larger than the 1-sat output.
   */
  tokenAmount: string
  /** Decimal precision for display. Zero for STAS/DSTAS. */
  decimals: number
  /** Optional icon URL/outpoint for BSV-21. */
  icon: string | null
}

interface TokenGroup {
  groupKey: string
  symbol: string
  name: string | null
  tokenIds: Set<string>
  outputCount: number
  totalSatoshis: number
  spendableSatoshis: number
  outputs: OutputView[]
  /** Protocol this group represents — distinct protocols never merge. */
  protocol: TokenProtocolId
  /** Sum of `tokenAmount` across outputs in this group (stringified bigint). */
  tokenAmount: string
  /** Same, but only for spendable outputs. */
  spendableTokenAmount: string
  /** Decimal precision for display, taken from the first output. */
  decimals: number
}

/**
 * Parse a stringified bigint defensively. BSV-21 `amt` tags come from
 * arbitrary minter input and can be anything — non-numeric values used
 * to crash the entire AssetsPage at the `BigInt()` call site. Return
 * `0n` for anything that doesn't parse so the row still renders.
 */
function safeBigInt(s: string | null | undefined): bigint {
  if (!s) return 0n
  try {
    return BigInt(s)
  } catch {
    return 0n
  }
}

function groupByToken(outputs: OutputView[]): TokenGroup[] {
  const byKey = new Map<string, TokenGroup>()
  for (const o of outputs) {
    // Key on (protocol, symbol, tokenId) so a DSTAS and STAS that happen
    // to share a symbol never collapse into one card. Empty tokenId falls
    // back to (protocol, symbol).
    const key = o.tokenId
      ? `${o.protocol}::${o.symbol ?? '?'}::${o.tokenId}`
      : `${o.protocol}::${o.symbol ?? 'unknown'}`
    let g = byKey.get(key)
    if (!g) {
      g = {
        groupKey: key,
        symbol: o.symbol ?? 'unknown',
        name: o.name,
        tokenIds: new Set(),
        outputCount: 0,
        totalSatoshis: 0,
        spendableSatoshis: 0,
        outputs: [],
        protocol: o.protocol,
        tokenAmount: '0',
        spendableTokenAmount: '0',
        decimals: o.decimals,
      }
      byKey.set(key, g)
    }
    g.outputCount += 1
    g.totalSatoshis += o.satoshis
    if (o.spendable) g.spendableSatoshis += o.satoshis
    // BigInt sums for token amounts — BSV-21 values can exceed JS's safe-int.
    // `safeBigInt` defends against malformed amt tags (e.g. someone minted
    // BSV-21 with `amt: "lorem ipsum"`); we keep the row visible at 0.
    g.tokenAmount = (safeBigInt(g.tokenAmount) + safeBigInt(o.tokenAmount)).toString()
    if (o.spendable) {
      g.spendableTokenAmount = (safeBigInt(g.spendableTokenAmount) + safeBigInt(o.tokenAmount)).toString()
    }
    if (o.tokenId) g.tokenIds.add(o.tokenId)
    if (!g.name && o.name) g.name = o.name
    g.outputs.push(o)
  }
  // Sort by spendable-amount descending. BigInt-safe comparator.
  return Array.from(byKey.values()).sort((a, b) => {
    const av = safeBigInt(a.tokenAmount)
    const bv = safeBigInt(b.tokenAmount)
    return av < bv ? 1 : av > bv ? -1 : 0
  })
}

/**
 * Format a raw token amount (stringified bigint) with the protocol's
 * decimal precision. `dec=0` is the STAS/DSTAS case — render the integer
 * with locale separators. `dec>0` is BSV-21 — divide by 10^dec and trim
 * trailing zeros so 1500000 with dec=6 reads as "1.5", not "1.500000".
 */
function formatTokenAmount(amount: string, dec: number): string {
  // Defensive: malformed `amt` tags (non-numeric strings, e.g. when a mint
  // call accidentally passed "lorem ipsum") show as `?` rather than crashing.
  let n: bigint
  try { n = BigInt(amount || '0') } catch { return amount ? `? (${amount})` : '0' }
  if (dec === 0) return n.toLocaleString()
  const divisor = 10n ** BigInt(dec)
  const integer = n / divisor
  const fraction = n % divisor
  const intStr = integer.toLocaleString()
  const fracPadded = fraction.toString().padStart(dec, '0')
  const fracTrimmed = fracPadded.replace(/0+$/, '')
  return fracTrimmed ? `${intStr}.${fracTrimmed}` : intStr
}

/** Extract tag values like `id:abc` → `abc`. Returns undefined if absent. */
function tagValue(tags: string[] | undefined, prefix: string): string | undefined {
  if (!tags) return undefined
  for (const t of tags) {
    if (t.startsWith(prefix + ':')) return t.slice(prefix.length + 1)
  }
  return undefined
}

/** Parse customInstructions JSON safely; returns null if malformed. */
function parseCustomInstructions(s: string | null | undefined): any | null {
  if (!s) return null
  try { return JSON.parse(s) } catch { return null }
}

/**
 * Shape a wallet-toolbox `listOutputs` row from the `bsv-21-tokens` basket
 * into the unified `OutputView`. Token-level metadata (id, amt, dec, sym,
 * icon) lives on basket TAGS per 1sat-toolbox convention; BRC-42 unlock
 * context lives in customInstructions.
 */
function bsv21RowToView(o: any): OutputView {
  const tags: string[] | undefined = o.tags
  const tokenId = tagValue(tags, 'id') ?? ''
  const amt = tagValue(tags, 'amt') ?? '0'
  const decStr = tagValue(tags, 'dec')
  const decimals = decStr ? Number(decStr) : 0
  const sym = tagValue(tags, 'sym') ?? null
  const icon = tagValue(tags, 'icon') ?? null

  const ci = parseCustomInstructions(o.customInstructions)
  const brc42KeyId = (ci && typeof ci.keyID === 'string') ? ci.keyID : null
  const ownerAddrFromCI = (ci && typeof ci.ownerAddress === 'string') ? ci.ownerAddress : null

  // Locking script may include the full ord envelope; parse to recover the
  // P2PKH owner hash160. Fall back to customInstructions for the address.
  const scriptHex: string | null = o.lockingScript ?? null
  const parsed = scriptHex ? parseBsv21LockingScript(scriptHex) : null

  const [txid, voutStr] = (o.outpoint ?? '.').split('.')
  const vout = Number(voutStr)

  return {
    outpoint: o.outpoint,
    txid,
    vout: Number.isNaN(vout) ? 0 : vout,
    satoshis: o.satoshis ?? 1,
    spendable: !!o.spendable,
    tokenId,
    symbol: sym,
    name: null,
    brc42KeyId,
    ownerFieldHash160: parsed?.ownerHash160 ?? '',
    ownerAddress: ownerAddrFromCI ?? (parsed ? hash160ToAddress(parsed.ownerHash160) : ''),
    scriptHex,
    frozen: false,
    confiscated: false,
    spentBy: null,
    createdAt: o.createdAt ?? null,
    protocol: 'bsv-21',
    tokenAmount: amt,
    decimals,
    icon,
  }
}

/** Display label for the protocol badge chip. */
function protocolLabel(p: TokenProtocolId): string {
  switch (p) {
    case 'stas': return 'STAS'
    case 'dstas': return 'DSTAS'
    case 'bsv-21': return 'BSV-21'
  }
}

function hash160ToAddress(hash160Hex: string): string {
  return new (Address as any)(fromHex(hash160Hex)).Value as string
}

export default function AssetsPage() {
  const { wallet, stas } = useContext(WalletContext)

  const [holdings, setHoldings] = useState<OutputView[]>([])
  const [sentHoldings, setSentHoldings] = useState<OutputView[]>([])
  const [activityExpanded, setActivityExpanded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [scanSummary, setScanSummary] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const [receiveAddress, setReceiveAddress] = useState<string | null>(null)
  const [receiveLabel, setReceiveLabel] = useState<string | null>(null)
  const [generatingReceive, setGeneratingReceive] = useState(false)
  const [receiveCopied, setReceiveCopied] = useState(false)
  const [receiveError, setReceiveError] = useState<string | null>(null)
  /** Which protocol the next "Generate new address" derives under. */
  const [receiveProtocol, setReceiveProtocol] = useState<TokenProtocolId>('stas')

  const [sendTarget, setSendTarget] = useState<OutputView | null>(null)
  const [sendRecipient, setSendRecipient] = useState('')
  /**
   * For BSV-21 only: the amount of tokens to send (raw integer string,
   * pre-decimals). Empty string = full UTXO. STAS/DSTAS ignore this and
   * always send the whole UTXO (their transfer engines aren't change-aware
   * at this layer).
   */
  const [sendBsv21Amount, setSendBsv21Amount] = useState('')
  const [sending, setSending] = useState(false)
  const [sendResult, setSendResult] = useState<{ ok: boolean; message: string } | null>(null)

  // BSV-21 orphan recovery — pre-PR-32 sends produced change outputs
  // without basket+customInstructions+tags, so they don't show up in
  // the holdings list. This dialog lets a user re-internalize one by
  // outpoint after the fix shipped.
  const [recoverDialogOpen, setRecoverDialogOpen] = useState(false)
  const [recoverTxid, setRecoverTxid] = useState('')
  const [recoverVout, setRecoverVout] = useState('')
  const [recovering, setRecovering] = useState(false)
  const [recoverResult, setRecoverResult] = useState<{ ok: boolean; message: string } | null>(null)

  // Filter state — applied to groups by symbol, name, or tokenId.
  const [filter, setFilter] = useState('')

  const identityKey = stas?.keyDeriver?.identityKey
  const chain = stas?.keyDeriver?.chain

  const loadHoldings = useCallback(async () => {
    if (!identityKey || !chain) return
    setLoading(true)
    setError(null)
    try {
      // Fetch both current (default) and the full set (includeSpent: true).
      // The full set lets us build the Activity feed alongside the live holdings.
      const [outputsRaw, allRaw, tokensRaw]: [any[], any[], any[]] = await Promise.all([
        stasQuery(identityKey, chain, 'listStasOutputs', []),
        stasQuery(identityKey, chain, 'listStasOutputs', [{ includeSpent: true }]),
        stasQuery(identityKey, chain, 'listStasTokens', []),
      ])
      const tokenMap: Record<string, any> = {}
      for (const t of tokensRaw ?? []) tokenMap[t.tokenId] = t

      const toView = (o: any): OutputView => {
        const sats = o.outputSatoshis ?? o.tokenSatoshis ?? 0
        return {
          outpoint: `${o.txid}.${o.vout}`,
          txid: o.txid,
          vout: o.vout,
          satoshis: sats,
          spendable: !!o.spendable,
          tokenId: o.tokenId ?? '',
          symbol: tokenMap[o.tokenId]?.symbol ?? o.symbol ?? null,
          name: tokenMap[o.tokenId]?.name ?? null,
          brc42KeyId: o.brc42KeyId ?? null,
          ownerFieldHash160: o.ownerFieldHash160,
          ownerAddress: hash160ToAddress(o.ownerFieldHash160),
          scriptHex: o.lockingScript ?? null,
          frozen: !!o.frozen,
          confiscated: !!o.confiscated,
          spentBy: o.spentBy ?? null,
          createdAt: o.createdAt ?? null,
          // Stamped by migration 0002; legacy rows default to 'stas'.
          protocol: (o.protocol as TokenProtocolId) ?? 'stas',
          // STAS/DSTAS: satoshisPerToken=1, so tokenAmount = satoshis.
          tokenAmount: String(sats),
          decimals: 0,
          icon: null,
        }
      }

      // STAS / DSTAS holdings.
      const stasHoldings = (outputsRaw ?? []).map(toView)

      // BSV-21 holdings — second data source. Goes through the BRC-100
      // listOutputs surface so tags (id/amt/dec/sym/icon) come back with
      // each row. The IPC basket query doesn't expose tags.
      let bsv21Holdings: OutputView[] = []
      if (wallet) {
        try {
          const res: any = await wallet.listOutputs({
            basket: BSV21_BASKET,
            includeTags: true,
            // includeCustomInstructions is load-bearing: bsv21RowToView reads
            // brc42KeyId / ownerAddress out of customInstructions, and the
            // Send button gate disables on `!brc42KeyId`. Without this flag
            // every BSV-21 row renders unsendable.
            includeCustomInstructions: true,
            include: 'locking scripts',
            limit: 10000,
          } as any)
          const rows: any[] = res?.outputs ?? []
          bsv21Holdings = rows.map(bsv21RowToView)
        } catch {
          /* BSV-21 holdings just won't surface if the basket is missing */
        }
      }

      setHoldings([...stasHoldings, ...bsv21Holdings])

      // Sent = anything from the "all" set that has spentBy set (and isn't in
      // the current set). Newest first by createdAt (best proxy we have).
      const sent = (allRaw ?? [])
        .filter((o: any) => o?.spentBy)
        .map(toView)
        .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
      setSentHoldings(sent)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [identityKey, chain, wallet])

  // Wraps loadHoldings with a real Bitails discovery scan first — picks up
  // STAS that arrived after the wallet's startup auto-scan. Without this the
  // page would only ever surface what's already in the local satellite, and
  // freshly received UTXOs stay invisible until the user manually scans from
  // the dev panel.
  const handleScan = useCallback(async () => {
    if (!stas?.discovery) {
      // No discovery service available — fall back to local refresh.
      await loadHoldings()
      return
    }
    setScanning(true)
    setScanSummary(null)
    try {
      // Run STAS / DSTAS first (per-address Bitails scan), then BSV-21
      // (per-address 1Sat REST). Sequential so error attribution is clear
      // in the summary line below.
      const stasRes = await stas.discovery.scan()
      const bits: string[] = []
      bits.push(`STAS: ${stasRes.candidates ?? 0} found`)
      if ((stasRes.registered ?? 0) > 0) bits.push(`${stasRes.registered} new`)
      if ((stasRes.skippedAlreadyKnown ?? 0) > 0) bits.push(`${stasRes.skippedAlreadyKnown} known`)
      if ((stasRes.deferred ?? 0) > 0) bits.push(`${stasRes.deferred} deferred`)
      if ((stasRes.errors?.length ?? 0) > 0) bits.push(`${stasRes.errors.length} errors`)

      if (stas.bsv21Discovery) {
        try {
          const bsv21Res = await stas.bsv21Discovery.scan()
          bits.push(`· BSV-21: ${bsv21Res.candidates ?? 0} found`)
          if ((bsv21Res.registered ?? 0) > 0) bits.push(`${bsv21Res.registered} new`)
          if ((bsv21Res.skippedAlreadyKnown ?? 0) > 0) bits.push(`${bsv21Res.skippedAlreadyKnown} known`)
          if ((bsv21Res.errors?.length ?? 0) > 0) bits.push(`${bsv21Res.errors.length} errors`)
        } catch (e) {
          bits.push(`· BSV-21 scan failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      setScanSummary(bits.join(' · '))
    } catch (e) {
      setScanSummary(`scan failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setScanning(false)
    }
    await loadHoldings()
  }, [stas?.discovery, stas?.bsv21Discovery, loadHoldings])

  useEffect(() => {
    if (!stas?.keyDeriver) return
    // First load: local-only (fast paint) plus a real scan in the background
    // so freshly arrived STAS show up without the user pressing anything.
    loadHoldings()
    handleScan()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stas?.keyDeriver])

  const handleRecoverOrphan = useCallback(async () => {
    if (!stas?.bsv21Discovery || !identityKey || !chain) {
      setRecoverResult({ ok: false, message: 'discovery service or identity not ready' })
      return
    }
    const txid = recoverTxid.trim().toLowerCase()
    const voutNum = Number(recoverVout.trim())
    if (!/^[0-9a-f]{64}$/.test(txid)) {
      setRecoverResult({ ok: false, message: 'txid must be 64 hex chars' })
      return
    }
    if (!Number.isInteger(voutNum) || voutNum < 0) {
      setRecoverResult({ ok: false, message: 'vout must be a non-negative integer' })
      return
    }
    setRecovering(true)
    setRecoverResult(null)
    try {
      const res = await (stas.bsv21Discovery as any).recoverByOutpoint({
        txid,
        vout: voutNum,
        identityKey,
        chain,
      })
      if (res.ok) {
        if (res.alreadyHadBasket) {
          setRecoverResult({ ok: true, message: `Already recovered (outputId ${res.outputId}). No-op.` })
        } else {
          setRecoverResult({
            ok: true,
            message: `Recovered outputId ${res.outputId} (token ${res.tokenId?.slice(0, 12)}…, key recv ${res.keyIndex})`,
          })
        }
        await loadHoldings()
      } else {
        setRecoverResult({ ok: false, message: res.reason ?? 'recovery failed' })
      }
    } catch (e) {
      setRecoverResult({ ok: false, message: e instanceof Error ? e.message : String(e) })
    } finally {
      setRecovering(false)
    }
  }, [stas?.bsv21Discovery, identityKey, chain, recoverTxid, recoverVout, loadHoldings])

  const allGroups = useMemo(() => groupByToken(holdings), [holdings])

  const groups = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (!needle) return allGroups
    return allGroups.filter((g) => {
      if (g.symbol.toLowerCase().includes(needle)) return true
      if (g.name && g.name.toLowerCase().includes(needle)) return true
      for (const id of g.tokenIds) {
        if (id.toLowerCase().includes(needle)) return true
      }
      return false
    })
  }, [allGroups, filter])

  const totalSats = useMemo(() => holdings.reduce((s, o) => s + o.satoshis, 0), [holdings])

  const handleGenerateReceive = async () => {
    if (!stas) return
    setGeneratingReceive(true)
    setReceiveError(null)
    setReceiveCopied(false)
    try {
      // Dispatch to the protocol-specific deriver. BSV-21 lives in its own
      // BRC-42 keyspace so the receive-counter never collides with STAS.
      const deriver =
        receiveProtocol === 'bsv-21' ? stas.bsv21KeyDeriver : stas.keyDeriver
      if (!deriver) throw new Error(`no deriver for protocol ${receiveProtocol}`)
      const row = await deriver.createNextReceiveContext()
      setReceiveAddress(hash160ToAddress(row.ownerFieldHash160))
      setReceiveLabel(`${protocolLabel(receiveProtocol)} · ${row.keyId}`)
    } catch (e) {
      setReceiveError(e instanceof Error ? e.message : String(e))
    } finally {
      setGeneratingReceive(false)
    }
  }

  const handleCopyReceive = async () => {
    if (!receiveAddress) return
    try {
      await navigator.clipboard.writeText(receiveAddress)
      setReceiveCopied(true)
      setTimeout(() => setReceiveCopied(false), 1500)
    } catch {
      /* ignore */
    }
  }

  const openSend = (o: OutputView) => {
    setSendTarget(o)
    setSendRecipient('')
    // Pre-fill BSV-21 amount with the full UTXO so the default behavior
    // matches the pre-F4 "send everything" UX. User can edit down.
    setSendBsv21Amount(o.protocol === 'bsv-21' ? o.tokenAmount : '')
    setSendResult(null)
  }

  const handleSendConfirm = async () => {
    if (!sendTarget || !stas?.tokens || !sendTarget.scriptHex || !sendTarget.brc42KeyId) return
    const adapter = stas.tokens.getById(sendTarget.protocol)
    if (!adapter || !adapter.transferSupported || !adapter.transfer) {
      setSendResult({
        ok: false,
        message: `Send is not yet available for ${protocolLabel(sendTarget.protocol)} in this wallet.`,
      })
      return
    }
    setSending(true)
    setSendResult(null)
    try {
      // Build the cross-protocol args; for BSV-21 attach the extras the
      // adapter needs (token id + amounts + display metadata).
      const baseArgs = {
        source: {
          txid: sendTarget.txid,
          vout: sendTarget.vout,
          scriptHex: sendTarget.scriptHex,
          satoshis: sendTarget.satoshis,
          brc42KeyId: sendTarget.brc42KeyId,
        },
        recipientAddress: sendRecipient.trim(),
      }
      let args: any = baseArgs
      if (sendTarget.protocol === 'bsv-21') {
        // BSV-21 amount is a raw bigint string; validated here at the UI
        // boundary so the transfer service can trust its input.
        const raw = sendBsv21Amount.trim() || sendTarget.tokenAmount
        if (!/^\d+$/.test(raw)) {
          setSendResult({ ok: false, message: 'Amount must be a non-negative integer (raw token units).' })
          setSending(false)
          return
        }
        let sendAmtBig: bigint
        let sourceAmtBig: bigint
        try {
          sendAmtBig = BigInt(raw)
          sourceAmtBig = BigInt(sendTarget.tokenAmount)
        } catch {
          setSendResult({ ok: false, message: 'Could not parse amount as a bigint.' })
          setSending(false)
          return
        }
        if (sendAmtBig <= 0n) {
          setSendResult({ ok: false, message: 'Amount must be > 0.' })
          setSending(false)
          return
        }
        if (sendAmtBig > sourceAmtBig) {
          setSendResult({ ok: false, message: `Amount exceeds UTXO balance (${formatTokenAmount(sendTarget.tokenAmount, sendTarget.decimals)}).` })
          setSending(false)
          return
        }
        // BSV21TransferService builds a token-change output when sendAmt < sourceAmt.
        const extras: Bsv21SendExtras = {
          tokenId: sendTarget.tokenId,
          sourceAmt: sendTarget.tokenAmount,
          amount: sendAmtBig.toString(),
          dec: sendTarget.decimals || undefined,
          sym: sendTarget.symbol ?? undefined,
          icon: sendTarget.icon ?? undefined,
        }
        args = { ...baseArgs, ...extras }
      }
      const result = await adapter.transfer(args)
      if (result.ok) {
        setSendResult({ ok: true, message: `Broadcast ✓ txid=${result.txid}` })
        loadHoldings()
      } else {
        setSendResult({ ok: false, message: result.reason ?? 'transfer failed' })
      }
    } catch (e) {
      setSendResult({ ok: false, message: e instanceof Error ? e.message : String(e) })
    } finally {
      setSending(false)
    }
  }

  const toggleExpand = (key: string) => {
    setExpanded((cur) => {
      const next = new Set(cur)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  if (!wallet) return null

  return (
    <Box sx={{ m: 2 }}>
      {/* Header */}
      <Card sx={{ mb: 2 }}>
        <CardContent>
          <Stack
            direction='row'
            justifyContent='space-between'
            alignItems='flex-start'
            spacing={2}
          >
            <Box>
              <Typography variant='h5' sx={{ fontWeight: 600 }}>
                Assets
              </Typography>
              <Typography variant='body2' color='text.secondary' sx={{ mt: 0.5 }}>
                STAS tokens held by this wallet — grouped by token, expandable to see each UTXO.
              </Typography>
              <Stack direction='row' spacing={2} sx={{ mt: 2 }}>
                <Chip
                  icon={<TokenIcon />}
                  label={`${allGroups.length} ${allGroups.length === 1 ? 'token' : 'tokens'}`}
                />
                <Chip
                  label={`${holdings.length} ${holdings.length === 1 ? 'output' : 'outputs'}`}
                  variant='outlined'
                />
                <Chip
                  label={`${totalSats.toLocaleString()} sats total`}
                  variant='outlined'
                  color='primary'
                />
              </Stack>
              <TextField
                size='small'
                placeholder='Filter by symbol, name, or tokenId…'
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                sx={{ mt: 2, minWidth: 320 }}
                InputProps={{
                  startAdornment: <SearchIcon fontSize='small' sx={{ mr: 1, color: 'text.secondary' }} />,
                }}
              />
            </Box>
            <Stack spacing={1} alignItems='flex-end'>
              <Stack direction='row' spacing={1}>
                <Button
                  size='small'
                  variant='text'
                  onClick={() => {
                    setRecoverResult(null)
                    setRecoverDialogOpen(true)
                  }}
                  disabled={loading || scanning}
                >
                  Recover orphan
                </Button>
                <Button
                  size='small'
                  variant='outlined'
                  startIcon={(loading || scanning) ? <CircularProgress size={14} /> : <RefreshIcon />}
                  onClick={handleScan}
                  disabled={loading || scanning}
                >
                  {scanning ? 'Scanning…' : loading ? 'Loading…' : 'Scan for STAS'}
                </Button>
              </Stack>
              {scanSummary && (
                <Typography variant='caption' color='text.secondary' sx={{ maxWidth: 240, textAlign: 'right' }}>
                  {scanSummary}
                </Typography>
              )}
            </Stack>
          </Stack>
          {error && (
            <Typography variant='caption' color='error' sx={{ display: 'block', mt: 1 }}>
              {error}
            </Typography>
          )}
        </CardContent>
      </Card>

      {/* Receive address */}
      <Card sx={{ mb: 2 }}>
        <CardContent>
          <Stack
            direction='row'
            justifyContent='space-between'
            alignItems='center'
            spacing={2}
          >
            <Box>
              <Typography variant='h6' sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <AddCircleOutlineIcon fontSize='small' /> Receive {protocolLabel(receiveProtocol)}
              </Typography>
              <Typography variant='caption' color='text.secondary'>
                Generates the next BRC-42 derived receive address. Share with a sender.
              </Typography>
            </Box>
            <Stack direction='row' spacing={1} alignItems='center'>
              {(['stas', 'bsv-21'] as TokenProtocolId[]).map((p) => (
                <Button
                  key={p}
                  size='small'
                  variant={receiveProtocol === p ? 'contained' : 'outlined'}
                  color={receiveProtocol === p ? 'primary' : 'inherit'}
                  onClick={() => setReceiveProtocol(p)}
                  disabled={generatingReceive}
                >
                  {protocolLabel(p)}
                </Button>
              ))}
              <Button
                variant='contained'
                onClick={handleGenerateReceive}
                disabled={generatingReceive}
              >
                {generatingReceive ? 'Generating…' : 'Generate new address'}
              </Button>
            </Stack>
          </Stack>
          {receiveError && (
            <Typography variant='caption' color='error' sx={{ display: 'block', mt: 1 }}>
              {receiveError}
            </Typography>
          )}
          {receiveAddress && (
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              spacing={2}
              alignItems={{ xs: 'stretch', sm: 'center' }}
              sx={{ mt: 2, p: 1.5, borderRadius: 1, bgcolor: 'action.hover' }}
            >
              <Box
                sx={{
                  p: 1,
                  bgcolor: 'background.paper',
                  borderRadius: 1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  alignSelf: { xs: 'center', sm: 'flex-start' },
                }}
              >
                <QRCodeSVG value={receiveAddress} size={140} includeMargin={false} />
              </Box>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant='caption' color='text.secondary' display='block'>
                  {receiveLabel}
                </Typography>
                <Typography
                  variant='body1'
                  sx={{ fontFamily: 'monospace', wordBreak: 'break-all', fontWeight: 600 }}
                >
                  {receiveAddress}
                </Typography>
                <Tooltip title={receiveCopied ? 'Copied!' : 'Copy address'}>
                  <Button
                    size='small'
                    startIcon={receiveCopied ? <CheckIcon /> : <ContentCopyIcon />}
                    onClick={handleCopyReceive}
                    sx={{ mt: 1 }}
                  >
                    {receiveCopied ? 'Copied' : 'Copy address'}
                  </Button>
                </Tooltip>
              </Box>
            </Stack>
          )}
        </CardContent>
      </Card>

      {/* Token groups */}
      {groups.length === 0 && !loading && (
        <Card>
          <CardContent>
            <Typography variant='body2' color='text.secondary' textAlign='center'>
              No STAS holdings yet. Click "Generate new address" above and send STAS to it,
              or use the dev panel's <em>Register STAS by txid</em> to register one manually.
            </Typography>
          </CardContent>
        </Card>
      )}

      {groups.map((g) => {
        const isExpanded = expanded.has(g.groupKey)
        return (
          <Card key={g.groupKey} sx={{ mb: 1.5 }}>
            <CardContent
              onClick={() => toggleExpand(g.groupKey)}
              sx={{
                cursor: 'pointer',
                py: 1.5,
                '&:last-child': { pb: 1.5 },
                '&:hover': { bgcolor: 'action.hover' },
              }}
            >
              <Stack direction='row' alignItems='center' spacing={2}>
                <TokenIcon />
                <Box sx={{ flex: 1 }}>
                  <Typography variant='h6' sx={{ fontWeight: 600 }}>
                    {g.name || g.symbol}
                    {g.name && g.symbol !== g.name && (
                      <Typography
                        component='span'
                        variant='body2'
                        color='text.secondary'
                        sx={{ ml: 1, fontWeight: 400 }}
                      >
                        ({g.symbol})
                      </Typography>
                    )}
                  </Typography>
                  <Stack direction='row' spacing={1} sx={{ mt: 0.5 }}>
                    <Chip
                      size='small'
                      label={protocolLabel(g.protocol)}
                      color={g.protocol === 'stas' ? 'primary' : 'default'}
                      variant={g.protocol === 'stas' ? 'filled' : 'outlined'}
                    />
                    <Chip
                      size='small'
                      label={
                        g.protocol === 'bsv-21'
                          ? `${formatTokenAmount(g.tokenAmount, g.decimals)} ${g.symbol}`
                          : `${g.totalSatoshis.toLocaleString()} sats`
                      }
                      variant='outlined'
                    />
                    <Chip
                      size='small'
                      label={`${g.outputCount} ${g.outputCount === 1 ? 'UTXO' : 'UTXOs'}`}
                      variant='outlined'
                    />
                    {g.protocol === 'bsv-21'
                      ? (g.spendableTokenAmount !== g.tokenAmount && (
                          <Chip
                            size='small'
                            label={`${formatTokenAmount(g.spendableTokenAmount, g.decimals)} spendable`}
                            variant='outlined'
                            color='warning'
                          />
                        ))
                      : (g.spendableSatoshis < g.totalSatoshis && (
                          <Chip
                            size='small'
                            label={`${g.spendableSatoshis.toLocaleString()} spendable`}
                            variant='outlined'
                            color='warning'
                          />
                        ))}
                    {g.tokenIds.size > 0 && (
                      <Tooltip title={Array.from(g.tokenIds).join(', ')}>
                        <Chip
                          size='small'
                          label={`id ${Array.from(g.tokenIds)[0].substring(0, 8)}…`}
                          variant='outlined'
                        />
                      </Tooltip>
                    )}
                  </Stack>
                </Box>
                <IconButton size='small'>
                  {isExpanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
                </IconButton>
              </Stack>
            </CardContent>

            <Collapse in={isExpanded} unmountOnExit>
              <Divider />
              <Box sx={{ p: 1 }}>
                {g.outputs.map((o) => (
                  <Stack
                    key={o.outpoint}
                    direction='row'
                    alignItems='center'
                    spacing={2}
                    sx={{
                      p: 1.5,
                      borderRadius: 1,
                      '&:hover': { bgcolor: 'action.hover' },
                    }}
                  >
                    <Box sx={{ flex: 1 }}>
                      <Stack direction='row' spacing={1} alignItems='center'>
                        <Typography
                          variant='body2'
                          sx={{ fontFamily: 'monospace', fontWeight: 600 }}
                        >
                          {o.protocol === 'bsv-21'
                            ? `${formatTokenAmount(o.tokenAmount, o.decimals)} ${o.symbol ?? ''}`
                            : `${o.satoshis.toLocaleString()} sats`}
                        </Typography>
                        {o.brc42KeyId && (
                          <Chip size='small' label={o.brc42KeyId} variant='outlined' />
                        )}
                        {!o.spendable && (
                          <Chip size='small' label='not spendable' color='warning' variant='outlined' />
                        )}
                        {o.frozen && <Chip size='small' label='frozen' color='error' />}
                        {o.confiscated && <Chip size='small' label='confiscated' color='error' />}
                      </Stack>
                      <Typography
                        variant='caption'
                        color='text.secondary'
                        sx={{ fontFamily: 'monospace', display: 'block' }}
                      >
                        {o.txid.substring(0, 16)}…:{o.vout}
                        <a
                          href={`https://whatsonchain.com/tx/${o.txid}`}
                          target='_blank'
                          rel='noreferrer'
                          style={{
                            color: 'inherit',
                            marginLeft: 6,
                            verticalAlign: 'middle',
                            display: 'inline-flex',
                          }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <OpenInNewIcon sx={{ fontSize: 12 }} />
                        </a>
                      </Typography>
                      <Typography variant='caption' color='text.secondary' display='block'>
                        owner: {o.ownerAddress}
                      </Typography>
                    </Box>
                    {(() => {
                      const adapter = stas?.tokens?.getById(o.protocol)
                      const transferSupported = adapter?.transferSupported ?? false
                      const sendDisabled =
                        !o.spendable ||
                        o.frozen ||
                        o.confiscated ||
                        !o.scriptHex ||
                        !o.brc42KeyId ||
                        !transferSupported
                      const tooltip = !transferSupported
                        ? `Send is not yet available for ${protocolLabel(o.protocol)} in this wallet.`
                        : ''
                      const btn = (
                        <Button
                          size='small'
                          variant='outlined'
                          startIcon={<SendIcon fontSize='small' />}
                          onClick={(e) => {
                            e.stopPropagation()
                            openSend(o)
                          }}
                          disabled={sendDisabled}
                        >
                          Send
                        </Button>
                      )
                      return tooltip ? (
                        <Tooltip title={tooltip}>
                          {/* span so MUI can attach the tooltip to a disabled button */}
                          <span>{btn}</span>
                        </Tooltip>
                      ) : btn
                    })()}
                  </Stack>
                ))}
              </Box>
            </Collapse>
          </Card>
        )
      })}

      {/* Activity — sent STAS history (uses includeSpent:true on listStasOutputs) */}
      {sentHoldings.length > 0 && (
        <Card sx={{ mt: 2 }}>
          <CardContent
            onClick={() => setActivityExpanded((v) => !v)}
            sx={{
              cursor: 'pointer',
              py: 1.5,
              '&:last-child': { pb: 1.5 },
              '&:hover': { bgcolor: 'action.hover' },
            }}
          >
            <Stack direction='row' alignItems='center' spacing={2}>
              <SendIcon fontSize='small' />
              <Box sx={{ flex: 1 }}>
                <Typography variant='subtitle1' sx={{ fontWeight: 600 }}>
                  Recent activity
                </Typography>
                <Typography variant='caption' color='text.secondary'>
                  {sentHoldings.length} STAS {sentHoldings.length === 1 ? 'transfer' : 'transfers'} sent from this wallet
                </Typography>
              </Box>
              <IconButton size='small'>
                {activityExpanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
              </IconButton>
            </Stack>
          </CardContent>
          <Collapse in={activityExpanded} unmountOnExit>
            <Divider />
            <Box sx={{ p: 1 }}>
              {sentHoldings.map((o) => (
                <Stack
                  key={o.outpoint}
                  direction='row'
                  alignItems='center'
                  spacing={2}
                  sx={{
                    p: 1.5,
                    borderRadius: 1,
                    '&:hover': { bgcolor: 'action.hover' },
                  }}
                >
                  <Chip
                    size='small'
                    label='SENT'
                    color='warning'
                    variant='outlined'
                    sx={{ minWidth: 64 }}
                  />
                  <Box sx={{ flex: 1 }}>
                    <Stack direction='row' spacing={1} alignItems='center'>
                      <Typography
                        variant='body2'
                        sx={{ fontFamily: 'monospace', fontWeight: 600 }}
                      >
                        {o.protocol === 'bsv-21'
                          ? `${formatTokenAmount(o.tokenAmount, o.decimals)} ${o.symbol ?? ''}`
                          : `${o.satoshis.toLocaleString()} sats`}
                      </Typography>
                      {o.protocol !== 'bsv-21' && o.symbol && (
                        <Chip size='small' label={o.symbol} variant='outlined' />
                      )}
                      {o.brc42KeyId && (
                        <Chip size='small' label={`from ${o.brc42KeyId}`} variant='outlined' />
                      )}
                    </Stack>
                    <Typography
                      variant='caption'
                      color='text.secondary'
                      sx={{ fontFamily: 'monospace', display: 'block' }}
                    >
                      <span>source </span>
                      <a
                        href={`https://whatsonchain.com/tx/${o.txid}`}
                        target='_blank'
                        rel='noreferrer'
                        style={{ color: 'inherit' }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {o.txid.substring(0, 14)}…:{o.vout}
                      </a>
                    </Typography>
                    {o.spentBy && (
                      <Typography
                        variant='caption'
                        color='text.secondary'
                        sx={{ fontFamily: 'monospace', display: 'block' }}
                      >
                        <span>spent in </span>
                        <a
                          href={`https://whatsonchain.com/tx/${o.spentBy}`}
                          target='_blank'
                          rel='noreferrer'
                          style={{ color: 'inherit' }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {o.spentBy.substring(0, 14)}…
                        </a>
                      </Typography>
                    )}
                    {o.createdAt && (
                      <Typography variant='caption' color='text.secondary' display='block'>
                        received {new Date(o.createdAt).toLocaleString()}
                      </Typography>
                    )}
                  </Box>
                </Stack>
              ))}
            </Box>
          </Collapse>
        </Card>
      )}

      {/* Send dialog */}
      <Dialog
        open={!!sendTarget}
        onClose={() => {
          if (!sending) {
            setSendTarget(null)
            setSendResult(null)
          }
        }}
        fullWidth
        maxWidth='sm'
      >
        <DialogTitle>Send {sendTarget?.symbol ?? 'STAS'}</DialogTitle>
        <DialogContent>
          {sendTarget && (
            <Stack spacing={2}>
              <Box>
                <Typography variant='caption' color='text.secondary'>
                  Sending
                </Typography>
                <Typography variant='body1' sx={{ fontWeight: 600 }}>
                  {sendTarget.protocol === 'bsv-21'
                    ? `${formatTokenAmount(sendTarget.tokenAmount, sendTarget.decimals)} ${sendTarget.symbol ?? ''}`
                    : `${sendTarget.satoshis.toLocaleString()} sats · ${sendTarget.symbol ?? 'STAS'}`}
                </Typography>
                <Typography
                  variant='caption'
                  color='text.secondary'
                  sx={{ fontFamily: 'monospace', display: 'block' }}
                >
                  from {sendTarget.brc42KeyId} ({sendTarget.ownerAddress.substring(0, 14)}…)
                </Typography>
              </Box>
              <TextField
                label='Recipient address'
                value={sendRecipient}
                onChange={(e) => setSendRecipient(e.target.value)}
                fullWidth
                placeholder='1...'
                disabled={sending}
                autoFocus
              />
              {sendTarget.protocol === 'bsv-21' && (
                <Box>
                  <TextField
                    label={`Amount (raw, max ${sendTarget.tokenAmount})`}
                    value={sendBsv21Amount}
                    onChange={(e) => setSendBsv21Amount(e.target.value)}
                    fullWidth
                    placeholder={sendTarget.tokenAmount}
                    disabled={sending}
                    helperText={
                      sendBsv21Amount && /^\d+$/.test(sendBsv21Amount)
                        ? `≈ ${formatTokenAmount(sendBsv21Amount, sendTarget.decimals)} ${sendTarget.symbol ?? ''}${
                            BigInt(sendBsv21Amount) < BigInt(sendTarget.tokenAmount)
                              ? ` · change ${formatTokenAmount((BigInt(sendTarget.tokenAmount) - BigInt(sendBsv21Amount)).toString(), sendTarget.decimals)} ${sendTarget.symbol ?? ''}`
                              : ''
                          }`
                        : 'Raw token units (integer). Leave blank to send the whole UTXO.'
                    }
                  />
                </Box>
              )}
              <Typography variant='caption' color='text.secondary'>
                The wallet covers BSV fee automatically. After broadcast, the recipient
                wallet picks up the UTXO via the indexer-driven scan on its next Refresh
                (or via the demo /…/register-by-txid fast-path when colocated).
              </Typography>
              {sendResult && (
                <Typography
                  variant='body2'
                  color={sendResult.ok ? 'success.main' : 'error'}
                  sx={{ wordBreak: 'break-all' }}
                >
                  {sendResult.message}
                </Typography>
              )}
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setSendTarget(null)
              setSendResult(null)
            }}
            disabled={sending}
          >
            Close
          </Button>
          <Button
            variant='contained'
            onClick={handleSendConfirm}
            disabled={sending || !sendRecipient.trim() || sendResult?.ok}
          >
            {sending ? 'Sending…' : 'Send'}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={recoverDialogOpen}
        onClose={() => !recovering && setRecoverDialogOpen(false)}
        maxWidth='sm'
        fullWidth
      >
        <DialogTitle>Recover orphaned BSV-21 output</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <Typography variant='body2' color='text.secondary'>
              Pre-fix BSV-21 sends produced change outputs that landed in the wallet's
              outputs table but were not assigned to the bsv-21-tokens basket, so they
              don't show up in your holdings. Enter the outpoint to reassign it
              retroactively. Idempotent — re-running on a recovered output is a no-op.
            </Typography>
            <TextField
              size='small'
              label='Transaction ID'
              placeholder='64 hex chars'
              value={recoverTxid}
              onChange={(e) => setRecoverTxid(e.target.value)}
              disabled={recovering}
              fullWidth
            />
            <TextField
              size='small'
              label='Vout'
              placeholder='non-negative integer'
              value={recoverVout}
              onChange={(e) => setRecoverVout(e.target.value)}
              disabled={recovering}
              fullWidth
            />
            {recoverResult && (
              <Typography
                variant='body2'
                color={recoverResult.ok ? 'success.main' : 'error'}
                sx={{ wordBreak: 'break-all' }}
              >
                {recoverResult.message}
              </Typography>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setRecoverDialogOpen(false)
              setRecoverTxid('')
              setRecoverVout('')
              setRecoverResult(null)
            }}
            disabled={recovering}
          >
            Close
          </Button>
          <Button
            variant='contained'
            onClick={handleRecoverOrphan}
            disabled={recovering || !recoverTxid.trim() || !recoverVout.trim()}
          >
            {recovering ? 'Recovering…' : 'Recover'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
