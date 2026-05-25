/**
 * STAS Discovery — dev-only debug panel.
 *
 * Mounted at the top of the Dashboard in development builds. Two affordances:
 *
 *   - Generate a new STAS receive address (calls
 *     StasKeyDeriver.createNextReceiveContext — derives the next recv N key,
 *     persists the row in stas_receive_contexts, displays the base58 address).
 *   - Scan for STAS (runs StasDiscoveryService.scan and shows the structured
 *     result: counts, registered outpoints, errors).
 *
 * Replaced by the real Assets / Receive UI in Tasks 5/7.
 */

import React, { useContext, useState } from 'react'
import {
  Card,
  CardContent,
  Typography,
  Button,
  Box,
  Chip,
  Stack,
  CircularProgress,
  IconButton,
  Tooltip,
  Divider,
} from '@mui/material'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import CheckIcon from '@mui/icons-material/Check'
import { Address, fromHex } from 'dxs-bsv-token-sdk/bsv'
import { WalletContext } from '../../WalletContext'
import { stasQuery } from '../../services/stas'
import type { ScanResult } from '../../services/stas'

interface ReceiveContextView {
  keyIndex: number
  keyId: string
  ownerFieldHash160: string
  derivedPublicKey: string
  base58Address: string
}

interface StasStateSnapshot {
  tokens: any[]
  outputs: Array<{
    txid: string
    vout: number
    tokenId: string
    brc42KeyId: string | null
    ownerFieldHash160: string
    tokenSatoshis: number
    frozen: boolean
    confiscated: boolean
    spendable: boolean
  }>
  receiveContexts: Array<{
    keyIndex: number
    keyId: string
    ownerFieldHash160: string
    derivedPublicKey: string
  }>
  profileIdentityKey: string
  exportedAt: string
}

interface ResyncDiff {
  ok: boolean
  fileExportedAt: string
  currentExportedAt: string
  outputs: {
    matching: number
    missing: StasStateSnapshot['outputs']
    extra: StasStateSnapshot['outputs']
    corrupted: Array<{
      outpoint: string
      field: string
      before: any
      after: any
    }>
  }
  receiveContexts: {
    matching: number
    missing: StasStateSnapshot['receiveContexts']
    extra: StasStateSnapshot['receiveContexts']
    corrupted: Array<{
      keyIndex: number
      field: string
      before: any
      after: any
    }>
  }
  identityKeyMatch: boolean
}

export default function StasDebugPanel() {
  const { wallet, stas } = useContext(WalletContext)

  // Scan state
  const [scanning, setScanning] = useState(false)
  const [scanResult, setScanResult] = useState<ScanResult | null>(null)
  const [scanError, setScanError] = useState<string | null>(null)
  const [lastScanAt, setLastScanAt] = useState<string | null>(null)

  // Receive state
  const [generating, setGenerating] = useState(false)
  const [receiveContext, setReceiveContext] = useState<ReceiveContextView | null>(null)
  const [receiveError, setReceiveError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  // Register-by-txid state
  const [txidInput, setTxidInput] = useState('')
  const [registering, setRegistering] = useState(false)
  const [byTxidResult, setByTxidResult] = useState<any>(null)
  const [byTxidError, setByTxidError] = useState<string | null>(null)

  // My-STAS list state
  const [stasList, setStasList] = useState<any[] | null>(null)
  const [tokensById, setTokensById] = useState<Record<string, any>>({})
  const [loadingStas, setLoadingStas] = useState(false)
  const [stasListError, setStasListError] = useState<string | null>(null)

  // Per-row Send UI state.
  const [sendOpenForOutput, setSendOpenForOutput] = useState<string | null>(null)
  const [sendRecipient, setSendRecipient] = useState('')
  const [sending, setSending] = useState(false)
  const [sendResult, setSendResult] = useState<{ ok: boolean; message: string } | null>(null)

  // Resync verification state.
  const [resyncBusy, setResyncBusy] = useState(false)
  const [resyncResult, setResyncResult] = useState<ResyncDiff | null>(null)
  const [resyncError, setResyncError] = useState<string | null>(null)
  const resyncFileInputRef = React.useRef<HTMLInputElement>(null)

  // Load (or refresh) the list of STAS in the wallet's basket.
  const loadStas = React.useCallback(async () => {
    if (!stas?.keyDeriver) return
    const identityKey = stas.keyDeriver.identityKey
    const chain = stas.keyDeriver.chain
    setLoadingStas(true)
    setStasListError(null)
    try {
      const [outputs, tokens] = await Promise.all([
        stasQuery(identityKey, chain, 'listStasOutputs', []),
        stasQuery(identityKey, chain, 'listStasTokens', []),
      ])
      setStasList(Array.isArray(outputs) ? outputs : [])
      const map: Record<string, any> = {}
      for (const t of tokens ?? []) map[t.tokenId] = t
      setTokensById(map)
    } catch (e) {
      setStasListError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoadingStas(false)
    }
  }, [stas])

  React.useEffect(() => {
    if (stas?.keyDeriver) loadStas()
  }, [stas, loadStas])

  if (!wallet) return null

  const handleScan = async () => {
    if (!stas?.discovery) return
    setScanning(true)
    setScanError(null)
    try {
      const r = await stas.discovery.scan()
      setScanResult(r)
      setLastScanAt(new Date().toLocaleTimeString())
    } catch (e) {
      setScanError(e instanceof Error ? e.message : String(e))
    } finally {
      setScanning(false)
    }
  }

  const handleGenerateReceive = async () => {
    if (!stas?.keyDeriver) return
    setGenerating(true)
    setReceiveError(null)
    try {
      const row = await stas.keyDeriver.createNextReceiveContext()
      const base58 = new (Address as any)(fromHex(row.ownerFieldHash160)).Value as string
      setReceiveContext({
        keyIndex: row.keyIndex,
        keyId: row.keyId,
        ownerFieldHash160: row.ownerFieldHash160,
        derivedPublicKey: row.derivedPublicKey,
        base58Address: base58,
      })
    } catch (e) {
      setReceiveError(e instanceof Error ? e.message : String(e))
    } finally {
      setGenerating(false)
    }
  }

  const handleRegisterByTxid = async () => {
    const txid = txidInput.trim().toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(txid)) {
      setByTxidError('Paste a 64-hex-character txid.')
      return
    }
    if (!stas?.discovery) return
    setRegistering(true)
    setByTxidError(null)
    setByTxidResult(null)
    try {
      const r = await stas.discovery.registerByTxid(txid)
      setByTxidResult(r)
      if (r && r.registered > 0) loadStas()
    } catch (e) {
      setByTxidError(e instanceof Error ? e.message : String(e))
    } finally {
      setRegistering(false)
    }
  }

  // Resync: export current STAS state as a JSON blob the user can download.
  const handleResyncExport = async () => {
    if (!stas?.keyDeriver) return
    setResyncBusy(true)
    setResyncError(null)
    try {
      const snapshot = (await stasQuery(
        stas.keyDeriver.identityKey,
        stas.keyDeriver.chain,
        'exportStasState',
        [stas.keyDeriver.identityKey]
      )) as StasStateSnapshot
      const blob = new Blob([JSON.stringify(snapshot, null, 2)], {
        type: 'application/json',
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      const ts = new Date().toISOString().replace(/[:.]/g, '-')
      a.href = url
      a.download = `stas-state-${snapshot.profileIdentityKey.substring(0, 8)}-${ts}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (e) {
      setResyncError(e instanceof Error ? e.message : String(e))
    } finally {
      setResyncBusy(false)
    }
  }

  // Resync: load a previously-exported snapshot and diff it against the
  // current wallet state. Same identityKey expected.
  const handleResyncVerify = async (file: File) => {
    if (!stas?.keyDeriver) return
    setResyncBusy(true)
    setResyncError(null)
    setResyncResult(null)
    try {
      const text = await file.text()
      const before = JSON.parse(text) as StasStateSnapshot
      const after = (await stasQuery(
        stas.keyDeriver.identityKey,
        stas.keyDeriver.chain,
        'exportStasState',
        [stas.keyDeriver.identityKey]
      )) as StasStateSnapshot

      const identityKeyMatch =
        before.profileIdentityKey === after.profileIdentityKey

      // Outputs: key by outpoint.
      const beforeOuts = new Map(
        before.outputs.map((o) => [`${o.txid}.${o.vout}`, o])
      )
      const afterOuts = new Map(
        after.outputs.map((o) => [`${o.txid}.${o.vout}`, o])
      )
      let outsMatching = 0
      const outsMissing: StasStateSnapshot['outputs'] = []
      const outsExtra: StasStateSnapshot['outputs'] = []
      const outsCorrupted: ResyncDiff['outputs']['corrupted'] = []
      for (const [outpoint, b] of beforeOuts) {
        const a = afterOuts.get(outpoint)
        if (!a) {
          outsMissing.push(b)
          continue
        }
        const fields: (keyof StasStateSnapshot['outputs'][number])[] = [
          'tokenId',
          'brc42KeyId',
          'ownerFieldHash160',
          'tokenSatoshis',
        ]
        let ok = true
        for (const f of fields) {
          if (b[f] !== a[f]) {
            outsCorrupted.push({
              outpoint,
              field: f as string,
              before: b[f],
              after: a[f],
            })
            ok = false
          }
        }
        if (ok) outsMatching++
      }
      for (const [outpoint, a] of afterOuts) {
        if (!beforeOuts.has(outpoint)) outsExtra.push(a)
      }

      // Receive contexts: key by keyIndex.
      const beforeCtxs = new Map(before.receiveContexts.map((c) => [c.keyIndex, c]))
      const afterCtxs = new Map(after.receiveContexts.map((c) => [c.keyIndex, c]))
      let ctxsMatching = 0
      const ctxsMissing: StasStateSnapshot['receiveContexts'] = []
      const ctxsExtra: StasStateSnapshot['receiveContexts'] = []
      const ctxsCorrupted: ResyncDiff['receiveContexts']['corrupted'] = []
      for (const [k, b] of beforeCtxs) {
        const a = afterCtxs.get(k)
        if (!a) {
          ctxsMissing.push(b)
          continue
        }
        const fields: (keyof StasStateSnapshot['receiveContexts'][number])[] = [
          'keyId',
          'ownerFieldHash160',
          'derivedPublicKey',
        ]
        let ok = true
        for (const f of fields) {
          if (b[f] !== a[f]) {
            ctxsCorrupted.push({
              keyIndex: k,
              field: f as string,
              before: b[f],
              after: a[f],
            })
            ok = false
          }
        }
        if (ok) ctxsMatching++
      }
      for (const [k, a] of afterCtxs) {
        if (!beforeCtxs.has(k)) ctxsExtra.push(a)
      }

      const overallOk =
        identityKeyMatch &&
        outsMissing.length === 0 &&
        outsCorrupted.length === 0 &&
        ctxsMissing.length === 0 &&
        ctxsCorrupted.length === 0

      setResyncResult({
        ok: overallOk,
        fileExportedAt: before.exportedAt,
        currentExportedAt: after.exportedAt,
        outputs: {
          matching: outsMatching,
          missing: outsMissing,
          extra: outsExtra,
          corrupted: outsCorrupted,
        },
        receiveContexts: {
          matching: ctxsMatching,
          missing: ctxsMissing,
          extra: ctxsExtra,
          corrupted: ctxsCorrupted,
        },
        identityKeyMatch,
      })
    } catch (e) {
      setResyncError(e instanceof Error ? e.message : String(e))
    } finally {
      setResyncBusy(false)
    }
  }

  const handleCopyAddress = async () => {
    if (!receiveContext) return
    try {
      await navigator.clipboard.writeText(receiveContext.base58Address)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable — ignore */
    }
  }

  return (
    <Card sx={{ mb: 2, border: '1px dashed', borderColor: 'warning.main' }}>
      <CardContent>
        <Typography variant='caption' color='warning.main' sx={{ fontWeight: 600, display: 'block' }}>
          DEV — STAS Integration (Task 4)
        </Typography>
        <Typography variant='caption' display='block' color='text.secondary'>
          Receive: hand out a BRC-42-derived STAS address. Register by txid:
          internalize a STAS the sender broadcast to you. List: your basket.
        </Typography>

        {/* ---- My STAS — basket listing ---- */}
        <Box sx={{ mt: 2 }}>
          <Stack
            direction='row'
            justifyContent='space-between'
            alignItems='center'
            spacing={2}
          >
            <Typography variant='subtitle2' sx={{ fontWeight: 600 }}>
              My STAS ({stasList?.length ?? 0})
            </Typography>
            <Button
              variant='outlined'
              size='small'
              onClick={loadStas}
              disabled={!stas?.keyDeriver || loadingStas}
              startIcon={loadingStas ? <CircularProgress size={14} /> : null}
            >
              {loadingStas ? 'Loading…' : 'Refresh'}
            </Button>
          </Stack>

          {stasListError && (
            <Typography variant='caption' color='error' sx={{ mt: 1, display: 'block' }}>
              {stasListError}
            </Typography>
          )}

          {stasList && stasList.length === 0 && (
            <Typography
              variant='caption'
              color='text.secondary'
              sx={{ mt: 1, display: 'block' }}
            >
              No STAS in the basket yet. Generate a receive address below, send a
              STAS to it, then use "Register STAS by txid" with the sender's
              Issue txid.
            </Typography>
          )}

          {stasList && stasList.length > 0 && (
            <Box sx={{ mt: 1 }}>
              {stasList.map((row: any, i: number) => {
                const token = tokensById[row.tokenId]
                const amount = row.tokenSatoshis ?? row.outputSatoshis ?? 0
                const rowKey = `${row.txid}:${row.vout}`
                const isSendOpen = sendOpenForOutput === rowKey
                return (
                  <Box
                    key={i}
                    sx={{ p: 1.5, mb: 1, bgcolor: 'action.hover', borderRadius: 1 }}
                  >
                    <Stack direction='row' spacing={1} alignItems='center' flexWrap='wrap'>
                      <Chip
                        size='small'
                        label={token?.symbol || 'STAS'}
                        color='primary'
                      />
                      <Chip
                        size='small'
                        label={`${amount} sats`}
                        variant='outlined'
                      />
                      {row.brc42KeyId && (
                        <Chip size='small' label={row.brc42KeyId} variant='outlined' />
                      )}
                      {row.spendable === false && (
                        <Chip size='small' label='not spendable' variant='outlined' />
                      )}
                      {row.frozen ? (
                        <Chip size='small' label='frozen' color='warning' />
                      ) : null}
                      {row.confiscated ? (
                        <Chip size='small' label='confiscated' color='error' />
                      ) : null}
                      <Box sx={{ flexGrow: 1 }} />
                      <Button
                        size='small'
                        variant='outlined'
                        disabled={!row.brc42KeyId || row.spendable === false || row.frozen}
                        onClick={() => {
                          setSendOpenForOutput(isSendOpen ? null : rowKey)
                          setSendRecipient('')
                          setSendResult(null)
                        }}
                      >
                        {isSendOpen ? 'Cancel' : 'Send'}
                      </Button>
                    </Stack>
                    <Typography
                      variant='caption'
                      display='block'
                      sx={{ mt: 0.5, fontFamily: 'monospace', fontSize: 11 }}
                    >
                      {row.txid}:{row.vout}{' '}
                      <a
                        href={`https://whatsonchain.com/tx/${row.txid}`}
                        target='_blank'
                        rel='noreferrer'
                        style={{ color: 'inherit' }}
                      >
                        [WoC]
                      </a>
                    </Typography>
                    <Typography
                      variant='caption'
                      display='block'
                      color='text.secondary'
                      sx={{ fontFamily: 'monospace', fontSize: 10 }}
                    >
                      tokenId: {row.tokenId?.slice(0, 16)}…
                    </Typography>

                    {isSendOpen && (
                      <Box sx={{ mt: 1, p: 1, bgcolor: 'background.paper', borderRadius: 1, border: '1px dashed', borderColor: 'divider' }}>
                        <Typography variant='caption' display='block' sx={{ mb: 0.5 }}>
                          Send this STAS UTXO to a recipient address. Signed via BRC-42
                          ({row.brc42KeyId}); zero-fee transfer. Mainnet — real.
                        </Typography>
                        <Stack direction='row' spacing={1} alignItems='center'>
                          <Box sx={{ flexGrow: 1 }}>
                            <input
                              type='text'
                              value={sendRecipient}
                              onChange={(e) => setSendRecipient(e.target.value)}
                              placeholder='Recipient base58 address (e.g. 1AbC…)'
                              style={{
                                width: '100%',
                                padding: '6px 8px',
                                fontFamily: 'monospace',
                                fontSize: 12,
                                border: '1px solid #ccc',
                                borderRadius: 4,
                                boxSizing: 'border-box',
                              }}
                            />
                          </Box>
                          <Button
                            size='small'
                            variant='contained'
                            disabled={!stas?.transfer || sending || !sendRecipient.trim()}
                            startIcon={sending ? <CircularProgress size={12} /> : null}
                            onClick={async () => {
                              if (!stas?.transfer) return
                              setSending(true)
                              setSendResult(null)
                              try {
                                const result = await stas.transfer.transfer({
                                  source: {
                                    txid: row.txid,
                                    vout: row.vout,
                                    scriptHex: row.lockingScript ?? row.scriptHex ?? '',
                                    satoshis: row.outputSatoshis ?? amount,
                                    brc42KeyId: row.brc42KeyId,
                                  },
                                  recipientAddress: sendRecipient.trim(),
                                })
                                if (result.ok) {
                                  setSendResult({
                                    ok: true,
                                    message: `Broadcast ✓ txid=${result.txid}`,
                                  })
                                  // Keep the form open so the user can SEE the
                                  // txid. Closing it would unmount the result
                                  // display (it lives inside the inline form).
                                  loadStas()
                                } else {
                                  setSendResult({
                                    ok: false,
                                    message: result.reason ?? 'transfer failed',
                                  })
                                }
                                // Surface the result to the console too so we
                                // never lose track of a txid when the UI hides it.
                                // eslint-disable-next-line no-console
                                console.log('[stas-transfer] result:', result)
                              } catch (e) {
                                setSendResult({
                                  ok: false,
                                  message: e instanceof Error ? e.message : String(e),
                                })
                              } finally {
                                setSending(false)
                              }
                            }}
                          >
                            {sending ? 'Sending…' : 'Send'}
                          </Button>
                        </Stack>
                        {sendResult && (
                          <Typography
                            variant='caption'
                            display='block'
                            color={sendResult.ok ? 'success.main' : 'error'}
                            sx={{ mt: 0.5, fontFamily: 'monospace', fontSize: 11, wordBreak: 'break-all' }}
                          >
                            {sendResult.message}
                          </Typography>
                        )}
                      </Box>
                    )}
                  </Box>
                )
              })}
            </Box>
          )}
        </Box>

        <Divider sx={{ my: 2 }} />

        {/* ---- Receive section ---- */}
        <Box sx={{ mt: 2 }}>
          <Stack
            direction='row'
            justifyContent='space-between'
            alignItems='center'
            spacing={2}
          >
            <Typography variant='subtitle2' sx={{ fontWeight: 600 }}>
              Receive STAS
            </Typography>
            <Button
              variant='outlined'
              size='small'
              onClick={handleGenerateReceive}
              disabled={!stas?.keyDeriver || generating}
              startIcon={generating ? <CircularProgress size={14} /> : null}
            >
              {generating ? 'Generating…' : 'Generate new address'}
            </Button>
          </Stack>

          {receiveContext && (
            <Box sx={{ mt: 1, p: 1.5, bgcolor: 'action.hover', borderRadius: 1 }}>
              <Stack direction='row' alignItems='center' spacing={1}>
                <Chip
                  size='small'
                  label={receiveContext.keyId}
                  color='primary'
                  variant='outlined'
                />
                <Typography
                  variant='body2'
                  sx={{
                    fontFamily: 'monospace',
                    fontSize: 13,
                    flexGrow: 1,
                    wordBreak: 'break-all',
                  }}
                >
                  {receiveContext.base58Address}
                </Typography>
                <Tooltip title={copied ? 'Copied' : 'Copy address'}>
                  <IconButton size='small' onClick={handleCopyAddress}>
                    {copied ? (
                      <CheckIcon fontSize='small' color='success' />
                    ) : (
                      <ContentCopyIcon fontSize='small' />
                    )}
                  </IconButton>
                </Tooltip>
              </Stack>
              <Typography
                variant='caption'
                display='block'
                color='text.secondary'
                sx={{ mt: 0.5 }}
              >
                Send a STAS UTXO here, wait for confirmation, then click "Scan for STAS".
                The owner field is {receiveContext.ownerFieldHash160.slice(0, 16)}… (hash160 of {receiveContext.keyId} BRC-42 pubkey).
              </Typography>
            </Box>
          )}

          {receiveError && (
            <Typography variant='caption' color='error' sx={{ mt: 1, display: 'block' }}>
              {receiveError}
            </Typography>
          )}
        </Box>

        <Divider sx={{ my: 2 }} />

        {/* ---- Register-by-txid section ----
            WoC's address-based unspent endpoint can't surface DSTAS outputs
            (custom scripts, not P2PKH). Paste the Issue txid your sender gave
            you and the wallet parses + registers any owned DSTAS outputs
            in that tx directly. */}
        <Box sx={{ mb: 2 }}>
          <Typography variant='subtitle2' sx={{ fontWeight: 600, mb: 1 }}>
            Register STAS by txid
          </Typography>
          <Typography variant='caption' display='block' color='text.secondary' sx={{ mb: 1 }}>
            Paste the Issue txid from your sender. WoC can't find DSTAS UTXOs by
            owner address (they're custom scripts, not P2PKH), so this is the
            reliable path until a STAS-aware indexer lands.
          </Typography>
          <Stack direction='row' spacing={1} alignItems='center'>
            <Box sx={{ flexGrow: 1, fontFamily: 'monospace' }}>
              <input
                type='text'
                value={txidInput}
                onChange={(e) => setTxidInput(e.target.value)}
                placeholder='64-hex-character txid'
                style={{
                  width: '100%',
                  padding: '8px',
                  fontFamily: 'monospace',
                  fontSize: 13,
                  border: '1px solid #ccc',
                  borderRadius: 4,
                  boxSizing: 'border-box',
                }}
              />
            </Box>
            <Button
              variant='outlined'
              size='small'
              onClick={handleRegisterByTxid}
              disabled={!stas?.discovery || registering}
              startIcon={registering ? <CircularProgress size={14} /> : null}
            >
              {registering ? 'Registering…' : 'Register'}
            </Button>
          </Stack>

          {byTxidResult && (
            <Box sx={{ mt: 1, p: 1.5, bgcolor: 'action.hover', borderRadius: 1 }}>
              {byTxidResult.error ? (
                <Typography variant='caption' color='error'>
                  Error: {byTxidResult.error}
                </Typography>
              ) : (
                <>
                  <Typography variant='caption' display='block'>
                    <strong>{byTxidResult.registered}</strong> output(s) registered
                    {' '}out of {byTxidResult.outputs.length} parsed.
                  </Typography>
                  {byTxidResult.outputs.map((o: any, i: number) => (
                    <Typography key={i} variant='caption' display='block' sx={{ fontFamily: 'monospace', fontSize: 11 }}>
                      vout {o.vout}: {o.matched
                        ? (o.ok
                          ? `✓ registered (recv ${o.keyIndex})`
                          : `matched recv ${o.keyIndex}, but ${o.reason ?? 'unknown reason'}`)
                        : 'no match'}
                    </Typography>
                  ))}
                </>
              )}
            </Box>
          )}
          {byTxidError && (
            <Typography variant='caption' color='error' sx={{ mt: 1, display: 'block' }}>
              {byTxidError}
            </Typography>
          )}
        </Box>

        <Divider sx={{ my: 2 }} />

        {/* ---- Scan section ---- */}
        <Stack
          direction='row'
          justifyContent='space-between'
          alignItems='center'
          spacing={2}
        >
          <Typography variant='subtitle2' sx={{ fontWeight: 600 }}>
            Discovery scan
          </Typography>
          <Button
            variant='outlined'
            size='small'
            onClick={handleScan}
            disabled={!stas?.discovery || scanning}
            startIcon={scanning ? <CircularProgress size={14} /> : null}
          >
            {scanning ? 'Scanning…' : 'Scan for STAS'}
          </Button>
        </Stack>

        {lastScanAt && (
          <Typography
            variant='caption'
            display='block'
            sx={{ mt: 1 }}
            color='text.secondary'
          >
            Last scan: {lastScanAt}
          </Typography>
        )}

        {scanResult && (
          <Stack direction='row' spacing={1} flexWrap='wrap' sx={{ mt: 1 }}>
            <Chip size='small' label={`Addresses ${scanResult.scannedAddresses}`} />
            <Chip size='small' label={`Candidates ${scanResult.candidates}`} />
            <Chip size='small' label={`DSTAS ${scanResult.dstas}`} />
            <Chip
              size='small'
              label={`Owned ${scanResult.ownedAndDstas}`}
              color='primary'
              variant='outlined'
            />
            <Chip
              size='small'
              label={`Registered ${scanResult.registered}`}
              color='success'
            />
            <Chip
              size='small'
              label={`Deferred ${scanResult.deferred}`}
              color='warning'
              variant='outlined'
            />
            <Chip
              size='small'
              label={`Already known ${scanResult.skippedAlreadyKnown}`}
              variant='outlined'
            />
            <Chip
              size='small'
              label={`Errors ${scanResult.errors.length}`}
              color={scanResult.errors.length ? 'error' : 'default'}
              variant='outlined'
            />
          </Stack>
        )}

        {scanResult && scanResult.registeredOutpoints.length > 0 && (
          <Box sx={{ mt: 1 }}>
            <Typography variant='caption' color='text.secondary'>
              Registered:
            </Typography>
            {scanResult.registeredOutpoints.map((o, i) => (
              <Typography
                key={i}
                variant='caption'
                display='block'
                sx={{ fontFamily: 'monospace', fontSize: 11 }}
              >
                {o.txid}:{o.vout} (token {o.tokenId.slice(0, 12)}…)
              </Typography>
            ))}
          </Box>
        )}

        {scanResult && scanResult.errors.length > 0 && (
          <Box sx={{ mt: 1 }}>
            <Typography variant='caption' color='error'>
              Errors (first 5):
            </Typography>
            {scanResult.errors.slice(0, 5).map((e, i) => (
              <Typography
                key={i}
                variant='caption'
                display='block'
                color='error'
                sx={{ fontFamily: 'monospace', fontSize: 11 }}
              >
                {e.txid ? `${e.txid}:${e.vout} — ` : ''}
                {e.message}
              </Typography>
            ))}
          </Box>
        )}

        {scanError && (
          <Typography
            variant='caption'
            color='error'
            sx={{ mt: 1, display: 'block' }}
          >
            {scanError}
          </Typography>
        )}

        {/* ===== Resync verification ===== */}
        <Divider sx={{ my: 2 }} />
        <Box>
          <Typography variant='subtitle1' sx={{ fontWeight: 600 }}>
            Resync verification
          </Typography>
          <Typography variant='caption' color='text.secondary' display='block' sx={{ mb: 1 }}>
            Snapshot the wallet's STAS state, wipe <code>~/.bsv-desktop/</code>,
            restore from mnemonic, re-scan, then verify the recovered state
            matches. Validates BRC-42 determinism + basket recovery.
          </Typography>
          <Stack direction='row' spacing={1} sx={{ mb: 1 }}>
            <Button
              variant='outlined'
              size='small'
              onClick={handleResyncExport}
              disabled={resyncBusy || !stas?.keyDeriver}
            >
              {resyncBusy ? <CircularProgress size={14} /> : 'Export state'}
            </Button>
            <Button
              variant='outlined'
              size='small'
              onClick={() => resyncFileInputRef.current?.click()}
              disabled={resyncBusy || !stas?.keyDeriver}
            >
              Verify against file
            </Button>
            <input
              ref={resyncFileInputRef}
              type='file'
              accept='application/json,.json'
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) handleResyncVerify(f)
                e.target.value = ''
              }}
            />
          </Stack>

          {resyncError && (
            <Typography color='error' variant='caption' display='block'>
              {resyncError}
            </Typography>
          )}

          {resyncResult && (
            <Box
              sx={{
                mt: 1,
                p: 1.5,
                borderRadius: 1,
                bgcolor: resyncResult.ok ? 'success.light' : 'error.light',
                border: '1px solid',
                borderColor: resyncResult.ok ? 'success.main' : 'error.main',
              }}
            >
              <Typography variant='body2' sx={{ fontWeight: 600, mb: 0.5 }}>
                {resyncResult.ok
                  ? '✓ Resync clean — STAS state recovered identically'
                  : '✗ Resync mismatch — see details below'}
              </Typography>
              <Typography variant='caption' display='block'>
                file snapshot: {resyncResult.fileExportedAt} · current:{' '}
                {resyncResult.currentExportedAt}
              </Typography>
              <Typography variant='caption' display='block'>
                identityKey: {resyncResult.identityKeyMatch ? 'matches' : 'DIFFERS'}
              </Typography>
              <Box sx={{ mt: 1 }}>
                <Typography variant='body2' sx={{ fontWeight: 600 }}>
                  Outputs
                </Typography>
                <Typography variant='caption' display='block'>
                  {resyncResult.outputs.matching} matching ·{' '}
                  {resyncResult.outputs.missing.length} missing ·{' '}
                  {resyncResult.outputs.extra.length} extra ·{' '}
                  {resyncResult.outputs.corrupted.length} corrupted
                </Typography>
                {resyncResult.outputs.missing.length > 0 && (
                  <Box
                    component='pre'
                    sx={{
                      fontSize: 10,
                      m: 0,
                      mt: 0.5,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-all',
                    }}
                  >
                    missing:{' '}
                    {resyncResult.outputs.missing
                      .map((o) => `${o.txid.substring(0, 12)}…:${o.vout}`)
                      .join(', ')}
                  </Box>
                )}
                {resyncResult.outputs.corrupted.length > 0 && (
                  <Box
                    component='pre'
                    sx={{
                      fontSize: 10,
                      m: 0,
                      mt: 0.5,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-all',
                    }}
                  >
                    {JSON.stringify(resyncResult.outputs.corrupted, null, 2)}
                  </Box>
                )}
              </Box>
              <Box sx={{ mt: 1 }}>
                <Typography variant='body2' sx={{ fontWeight: 600 }}>
                  Receive contexts (BRC-42 determinism)
                </Typography>
                <Typography variant='caption' display='block'>
                  {resyncResult.receiveContexts.matching} matching ·{' '}
                  {resyncResult.receiveContexts.missing.length} missing ·{' '}
                  {resyncResult.receiveContexts.extra.length} extra ·{' '}
                  {resyncResult.receiveContexts.corrupted.length} corrupted
                </Typography>
                {resyncResult.receiveContexts.corrupted.length > 0 && (
                  <Box
                    component='pre'
                    sx={{
                      fontSize: 10,
                      m: 0,
                      mt: 0.5,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-all',
                    }}
                  >
                    {JSON.stringify(resyncResult.receiveContexts.corrupted, null, 2)}
                  </Box>
                )}
                {resyncResult.receiveContexts.corrupted.length > 0 && (
                  <Typography variant='caption' color='error' display='block' sx={{ mt: 0.5, fontWeight: 600 }}>
                    ⚠ Corrupted receive contexts means BRC-42 derivation
                    didn't replay the same keys. Filed as a real bug.
                  </Typography>
                )}
              </Box>
            </Box>
          )}
        </Box>
      </CardContent>
    </Card>
  )
}
