/**
 * Peer Tokens — send/receive STAS, DSTAS, and BSV-21 tokens peer-to-peer over
 * MessageBox, the token analog of the Payments (PeerPay) page.
 *
 * Flow: copy your identity key → share it → sender picks a holding + pastes the
 * recipient's identity key → confirm (network/recipient/token/amount) → send.
 * Receiver sees the incoming token and clicks Accept (internalizes into the
 * protocol basket). A DRY RUN toggle builds the settlement without sending.
 *
 * Holdings are loaded the same way AssetsPage does: STAS/DSTAS via the
 * `listStasOutputs` IPC query, BSV-21 via wallet.listOutputs on the BSV-21
 * basket. This is the first testable surface; partial/divisible sends and
 * richer UX are follow-ups.
 */
import React, { useCallback, useContext, useEffect, useMemo, useState } from 'react'
import {
  Container, Paper, Stack, Typography, TextField, Button, Chip, Divider, List,
  ListItem, ListItemText, IconButton, Tooltip, FormControlLabel, Switch, MenuItem,
  Dialog, DialogTitle, DialogContent, DialogActions, Alert, CircularProgress, Box
} from '@mui/material'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import RefreshIcon from '@mui/icons-material/Refresh'
import { toast } from 'react-toastify'
import { WalletContext } from '../../../WalletContext'
import type { IncomingToken, SendTokenParams } from '../../../services/tokens/peer/PeerTokenClient'
import { loadPeerHoldings, type PeerHolding as Holding } from '../../../services/tokens/peer/loadPeerHoldings'

export default function PeerTokens() {
  const ctx = useContext(WalletContext) as any
  const stas = ctx?.stas
  const wallet = ctx?.managers?.permissionsManager ?? ctx?.wallet
  const network: string = ctx?.network ?? 'mainnet'
  const useMessageBox: boolean = ctx?.useMessageBox ?? false

  const peerTokens = stas?.peerTokens
  const identityKey: string | undefined = stas?.keyDeriver?.identityKey
  const chain: 'main' | 'test' = stas?.keyDeriver?.chain ?? 'main'
  const originator: string | undefined = ctx?.adminOriginator

  const [holdings, setHoldings] = useState<Holding[]>([])
  const [loadingHoldings, setLoadingHoldings] = useState(false)
  const [selectedKey, setSelectedKey] = useState('')
  const [recipient, setRecipient] = useState('')
  const [amount, setAmount] = useState('')
  const [dryRun, setDryRun] = useState(true)
  const [sending, setSending] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const [incoming, setIncoming] = useState<IncomingToken[]>([])
  const [accepting, setAccepting] = useState<string | null>(null)

  const selected = useMemo(() => holdings.find((h) => h.key === selectedKey), [holdings, selectedKey])

  // ── Load holdings ─────────────────────────────────────────────────────────
  const loadHoldings = useCallback(async () => {
    if (!wallet || !identityKey) return
    setLoadingHoldings(true)
    try {
      setHoldings(await loadPeerHoldings({ wallet, identityKey, chain, originator }))
    } catch (e) {
      console.warn('[PeerTokens] loadPeerHoldings failed', e)
    } finally {
      setLoadingHoldings(false)
    }
  }, [wallet, identityKey, chain, originator])

  // ── Incoming ──────────────────────────────────────────────────────────────
  const refreshIncoming = useCallback(async () => {
    if (!peerTokens) return
    try {
      setIncoming(await peerTokens.listIncomingTokens())
    } catch (e) {
      console.warn('[PeerTokens] listIncomingTokens failed', e)
    }
  }, [peerTokens])

  useEffect(() => {
    void loadHoldings()
    void refreshIncoming()
  }, [loadHoldings, refreshIncoming])

  useEffect(() => {
    if (!peerTokens) return
    let active = true
    peerTokens
      .listenForLiveTokens({
        onToken: (t: IncomingToken) => {
          if (!active) return
          setIncoming((prev) => (prev.some((p) => p.messageId === t.messageId) ? prev : [t, ...prev]))
          toast.info(`Incoming ${t.token.protocol} token`)
        },
      })
      .catch((e: any) => console.warn('[PeerTokens] listen failed', e))
    return () => { active = false }
  }, [peerTokens])

  // ── Send ──────────────────────────────────────────────────────────────────
  const startSend = () => {
    if (!selected) return toast.error('Pick a token to send')
    if (!recipient.trim()) return toast.error('Enter a recipient identity key')
    setConfirmOpen(true)
  }

  const doSend = async () => {
    if (!selected || !peerTokens) return
    setConfirmOpen(false)
    setSending(true)
    try {
      const params: SendTokenParams = {
        recipient: recipient.trim(),
        protocol: selected.protocol,
        source: selected.source,
        amount: amount || selected.amount,
      }
      if (dryRun) {
        // dryRun=true → adapter derives + validates only, never touches the chain.
        const token = await peerTokens.createTokenToken(params, true)
        toast.success(`DRY RUN ok — derived recipient + validated ${selected.protocol} (nothing sent, no broadcast)`)
        console.log('[PeerTokens] DRY RUN preview', token)
      } else {
        console.log('[PeerTokens] LIVE send', params.protocol, params.amount, '→', params.recipient.slice(0, 16), '…')
        const sent = await peerTokens.sendToken(params)
        const woc = (network === 'mainnet' ? 'https://whatsonchain.com/tx/' : 'https://test.whatsonchain.com/tx/') + (sent?.txid ?? '')
        console.log(`[PeerTokens] sent ${selected.protocol} — txid: ${sent?.txid}  ${woc}`)
        toast.success(`Sent ${selected.protocol} ✓ txid ${sent?.txid ? sent.txid.slice(0, 16) + '…' : '(pending)'}`)
        await loadHoldings()
      }
    } catch (e: any) {
      // Surface the full error to the console so it can be read/copied — the
      // toast truncates and there was previously no log.
      console.error('[PeerTokens] send failed — full error:', e)
      console.error('[PeerTokens] send failed — message:', e?.message)
      console.error('[PeerTokens] send failed — stack:', e?.stack)
      toast.error(`Send failed: ${String(e?.message ?? e).slice(0, 160)}`)
    } finally {
      setSending(false)
    }
  }

  const accept = async (t: IncomingToken) => {
    if (!peerTokens) return
    setAccepting(t.messageId)
    try {
      const r = await peerTokens.acceptToken(t)
      if (typeof r === 'string') toast.error(r)
      else {
        toast.success(`Accepted ${t.token.protocol} token`)
        setIncoming((prev) => prev.filter((p) => p.messageId !== t.messageId))
        await loadHoldings()
      }
    } catch (e: any) {
      toast.error(`Accept failed: ${e?.message ?? String(e)}`)
    } finally {
      setAccepting(null)
    }
  }

  const copyIdentity = () => {
    if (identityKey) { void navigator.clipboard.writeText(identityKey); toast.success('Identity key copied') }
  }

  if (!useMessageBox || !peerTokens) {
    return (
      <Container maxWidth="sm" sx={{ py: 4 }}>
        <Typography variant="h5" gutterBottom>Peer Tokens</Typography>
        <Alert severity="info">
          MessageBox is not enabled for this wallet. Enable it in wallet configuration to send and
          receive tokens peer-to-peer.
        </Alert>
      </Container>
    )
  }

  return (
    <Container maxWidth="sm" sx={{ py: 4 }}>
      <Typography variant="h5" gutterBottom>Peer Tokens</Typography>
      <Chip
        size="small"
        color={network === 'mainnet' ? 'warning' : 'default'}
        label={network === 'mainnet' ? 'MAINNET — real value' : 'testnet'}
        sx={{ mb: 2 }}
      />

      {/* My identity key */}
      <Paper elevation={2} sx={{ p: 2, mb: 2 }}>
        <Typography variant="subtitle2" color="text.secondary">Your identity key (share to receive)</Typography>
        <Stack direction="row" spacing={1} alignItems="center">
          <Typography fontFamily="monospace" fontSize="0.85rem" sx={{ wordBreak: 'break-all' }}>
            {identityKey ?? '—'}
          </Typography>
          <Tooltip title="Copy"><span>
            <IconButton size="small" onClick={copyIdentity} disabled={!identityKey}><ContentCopyIcon fontSize="small" /></IconButton>
          </span></Tooltip>
        </Stack>
      </Paper>

      {/* Send */}
      <Paper elevation={2} sx={{ p: 2, mb: 2 }}>
        <Box display="flex" justifyContent="space-between" alignItems="center" mb={1}>
          <Typography variant="h6">Send a token</Typography>
          <Tooltip title="Reload holdings"><span>
            <IconButton size="small" onClick={() => void loadHoldings()} disabled={loadingHoldings}><RefreshIcon fontSize="small" /></IconButton>
          </span></Tooltip>
        </Box>
        <Stack spacing={2}>
          <TextField
            select fullWidth label="Token holding" value={selectedKey}
            onChange={(e) => { setSelectedKey(e.target.value); const h = holdings.find((x) => x.key === e.target.value); setAmount(h?.amount ?? '') }}
            helperText={loadingHoldings ? 'Loading…' : holdings.length === 0 ? 'No token holdings found' : `${holdings.length} holding(s)`}
          >
            {holdings.map((h) => (
              <MenuItem key={h.key} value={h.key}>{h.protocol.toUpperCase()} — {h.label}</MenuItem>
            ))}
          </TextField>
          <TextField fullWidth label="Recipient identity key" value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="03…" />
          <TextField
            fullWidth label="Amount (token units)" value={amount} onChange={(e) => setAmount(e.target.value)}
            helperText={'Partial amounts supported (STAS/DSTAS split; BSV-21 makes change)'}
          />
          <FormControlLabel
            control={<Switch checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />}
            label={dryRun ? 'DRY RUN (build settlement, do not send)' : 'LIVE send'}
          />
          <Box>
            <Button variant="contained" color={dryRun ? 'primary' : 'warning'} disabled={sending || !selected} onClick={startSend}
              startIcon={sending ? <CircularProgress size={16} /> : undefined}>
              {sending ? 'Working…' : dryRun ? 'Build (dry run)' : 'Send token'}
            </Button>
          </Box>
        </Stack>
      </Paper>

      {/* Incoming */}
      <Paper elevation={2} sx={{ p: 2 }}>
        <Box display="flex" justifyContent="space-between" alignItems="center" mb={1}>
          <Typography variant="h6">Incoming tokens</Typography>
          <Button size="small" onClick={() => void refreshIncoming()}>Refresh</Button>
        </Box>
        {incoming.length === 0 ? (
          <Typography color="text.secondary">No incoming tokens</Typography>
        ) : (
          <List>
            {incoming.map((t) => (
              <React.Fragment key={t.messageId}>
                <ListItem secondaryAction={
                  <Button size="small" variant="contained" disabled={accepting === t.messageId} onClick={() => void accept(t)}
                    startIcon={accepting === t.messageId ? <CircularProgress size={16} /> : undefined}>
                    {accepting === t.messageId ? 'Accepting…' : 'Accept'}
                  </Button>
                }>
                  <ListItemText
                    primary={<Stack direction="row" spacing={1} alignItems="center">
                      <Chip size="small" label={t.token.protocol} />
                      <Typography fontSize="0.9rem">{t.token.amount} · {t.token.assetId.slice(0, 12)}…</Typography>
                    </Stack>}
                    secondary={<Typography variant="body2" color="text.secondary">from {t.sender?.slice?.(0, 14) ?? '?'}…</Typography>}
                  />
                </ListItem>
                <Divider component="li" />
              </React.Fragment>
            ))}
          </List>
        )}
      </Paper>

      {/* Confirm */}
      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)}>
        <DialogTitle>{dryRun ? 'Confirm dry run' : 'Confirm token send'}</DialogTitle>
        <DialogContent>
          <Stack spacing={1} sx={{ mt: 1 }}>
            {network === 'mainnet' && !dryRun && <Alert severity="warning">This is a MAINNET send — real value will move.</Alert>}
            <Typography variant="body2">Network: <b>{network}</b></Typography>
            <Typography variant="body2">Protocol: <b>{selected?.protocol}</b></Typography>
            <Typography variant="body2">Token: <b>{selected?.label}</b></Typography>
            <Typography variant="body2">Amount: <b>{amount || selected?.amount}</b></Typography>
            <Typography variant="body2" sx={{ wordBreak: 'break-all' }}>To: <b>{recipient}</b></Typography>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOpen(false)}>Cancel</Button>
          <Button variant="contained" color={dryRun ? 'primary' : 'warning'} onClick={() => void doSend()}>
            {dryRun ? 'Build' : 'Send'}
          </Button>
        </DialogActions>
      </Dialog>
    </Container>
  )
}
