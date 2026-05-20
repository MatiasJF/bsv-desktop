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
import type { ScanResult } from '../../services/stas'

interface ReceiveContextView {
  keyIndex: number
  keyId: string
  ownerFieldHash160: string
  derivedPublicKey: string
  base58Address: string
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
    } catch (e) {
      setByTxidError(e instanceof Error ? e.message : String(e))
    } finally {
      setRegistering(false)
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
          Receive: hand out a BRC-42-derived STAS address. Scan: discover STAS UTXOs at
          all derived addresses and register them via internalizeAction.
        </Typography>

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
      </CardContent>
    </Card>
  )
}
