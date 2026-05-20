/**
 * STAS Discovery — dev-only debug panel.
 *
 * A small card mounted at the top of the Dashboard in development builds.
 * Shows a manual "Scan for STAS" button and the structured result of the
 * last scan (counts + registered outpoints + errors). Replaced by the
 * real Assets UI in Tasks 5/7.
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
} from '@mui/material'
import { WalletContext } from '../../WalletContext'
import type { ScanResult } from '../../services/stas'

export default function StasDebugPanel() {
  const { wallet, stas } = useContext(WalletContext)
  const [scanning, setScanning] = useState(false)
  const [result, setResult] = useState<ScanResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lastRunAt, setLastRunAt] = useState<string | null>(null)

  // Hide entirely until the wallet is built — the auto-scan effect fires once
  // when the wallet first appears; the button is for re-scanning after that.
  if (!wallet) return null

  const handleScan = async () => {
    if (!stas?.discovery) return
    setScanning(true)
    setError(null)
    try {
      const r = await stas.discovery.scan()
      setResult(r)
      setLastRunAt(new Date().toLocaleTimeString())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setScanning(false)
    }
  }

  return (
    <Card sx={{ mb: 2, border: '1px dashed', borderColor: 'warning.main' }}>
      <CardContent>
        <Stack
          direction='row'
          justifyContent='space-between'
          alignItems='center'
          spacing={2}
        >
          <Box>
            <Typography variant='caption' color='warning.main' sx={{ fontWeight: 600 }}>
              DEV — STAS Discovery (Task 4)
            </Typography>
            <Typography variant='caption' display='block' color='text.secondary'>
              Scans WhatsOnChain for STAS UTXOs at wallet-derived addresses and
              registers them into the stas-tokens basket.
            </Typography>
          </Box>
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

        {lastRunAt && (
          <Typography
            variant='caption'
            display='block'
            sx={{ mt: 1 }}
            color='text.secondary'
          >
            Last scan: {lastRunAt}
          </Typography>
        )}

        {result && (
          <Stack direction='row' spacing={1} flexWrap='wrap' sx={{ mt: 1 }}>
            <Chip size='small' label={`Addresses ${result.scannedAddresses}`} />
            <Chip size='small' label={`Candidates ${result.candidates}`} />
            <Chip size='small' label={`DSTAS ${result.dstas}`} />
            <Chip
              size='small'
              label={`Owned ${result.ownedAndDstas}`}
              color='primary'
              variant='outlined'
            />
            <Chip
              size='small'
              label={`Registered ${result.registered}`}
              color='success'
            />
            <Chip
              size='small'
              label={`Deferred ${result.deferred}`}
              color='warning'
              variant='outlined'
            />
            <Chip
              size='small'
              label={`Already known ${result.skippedAlreadyKnown}`}
              variant='outlined'
            />
            <Chip
              size='small'
              label={`Errors ${result.errors.length}`}
              color={result.errors.length ? 'error' : 'default'}
              variant='outlined'
            />
          </Stack>
        )}

        {result && result.registeredOutpoints.length > 0 && (
          <Box sx={{ mt: 1 }}>
            <Typography variant='caption' color='text.secondary'>
              Registered:
            </Typography>
            {result.registeredOutpoints.map((o, i) => (
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

        {result && result.errors.length > 0 && (
          <Box sx={{ mt: 1 }}>
            <Typography variant='caption' color='error'>
              Errors (first 5):
            </Typography>
            {result.errors.slice(0, 5).map((e, i) => (
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

        {error && (
          <Typography
            variant='caption'
            color='error'
            sx={{ mt: 1, display: 'block' }}
          >
            {error}
          </Typography>
        )}
      </CardContent>
    </Card>
  )
}
