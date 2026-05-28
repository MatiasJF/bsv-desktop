# Multi-protocol token support — what changed and why

> Handoff document for the `close-out` branch. Audience: a developer who already
> knows BSV Desktop's STAS-era architecture and needs to understand how it grew
> to support three token protocols at once.

## TL;DR

The wallet went from **STAS-only** to **STAS + DSTAS + BSV-21**. A new
`TokenProtocolAdapter` seam abstracts protocol-specific work (script parsing,
transfer building, basket routing); the existing STAS pipeline is now a
concrete adapter; DSTAS and BSV-21 are two more. Discovery is **indexer-driven
on Refresh** for all three protocols — Bitails for STAS/DSTAS, the 1Sat overlay
SSE stream for BSV-21. The demo faucet broadcasts mints via WhatsOnChain **and**
submits to `POST /1sat/tx` so the BSV-21 topic-manager indexes each tx,
matching the pattern yours-wallet's `@1sat/client` uses internally.

Three database migrations land in this PR. No breaking changes to the BRC-100
HTTP Apps API surface (`/stas/list`, `/stas/transfer`, etc.) — they remain
STAS-shaped. New parallel routes for BSV-21 exist as demo fast-paths only.

---

## What the wallet was before

Single-protocol STAS pipeline:

- One satellite table per concept (`stas_tokens`, `stas_outputs`,
  `stas_receive_contexts`).
- One basket (`stas-tokens`) for token UTXOs.
- One discovery service (`StasDiscoveryService`) that ran a per-address Bitails
  scan and registered matches.
- One transfer service (`StasTransferService`) that handled the stas-js engine
  flow (CreateContract + Issue, BRC-42 unlock, sighash + createSignature).
- One BRC-42 protocol-id (`'stas token ownership'`) for receive-key derivation.
- The renderer assumed every UTXO in `stas_outputs` was classic STAS even
  though `StasDiscoveryService` silently also handled DSTAS via
  `dstasParser.ts`. DSTAS-shaped outputs co-existed in the same basket with
  no schema awareness — they were identified by re-parsing the locking script.
- Transfer worked only for classic STAS. DSTAS UTXOs that the user happened
  to receive would fail at send-time with a generic *"Invalid STAS script"*.

That was fine for a single-protocol demo and not fine for the next two protocols.

---

## What this PR added

### 1. A protocol-adapter seam (`src/lib/services/tokens/`)

`TokenProtocolAdapter` is the cross-protocol contract:

```ts
interface TokenProtocolAdapter {
  id: 'stas' | 'dstas' | 'bsv-21'
  basketName: string
  displayName: string
  transferSupported: boolean
  parseOutput(scriptHex, ctx?): Promise<ParsedTokenOutput | null>
  transfer?(args): Promise<TransferResult>
}
```

Three concrete adapters:

- **`StasProtocolAdapter`** — wraps `parseClassicStasMetadata` +
  `findCreateContractTxid` + `StasTransferService.transfer`.
  `transferSupported: true`. Basket: `stas-tokens`.
- **`DstasProtocolAdapter`** — wraps `parseDstasLockingScript` from
  `dstasParser`. `transferSupported: false` (DSTAS engine integration is a
  separate effort). Basket: `dstas-tokens`.
- **`BSV21ProtocolAdapter`** — wraps the inline inscription parser + a
  `BSV21TransferService` using standard `createAction`/`signAction`.
  `transferSupported: true`. Basket: `bsv-21-tokens`.

A `TokenProtocolRegistry` holds the three adapters. `find(scriptHex, ctx)` walks
them in registration order (STAS prefix sniff first — cheapest — then DSTAS SDK
reader, then BSV-21 ord-envelope match) and returns the first that recognises
the script. `getById(id)` is used by the send dialog to pick the right transfer
path for a given UTXO.

The registry is exposed on `stas.tokens` from `WalletService` so the renderer
can dispatch sends without knowing protocol internals.

### 2. Per-protocol baskets

`src/lib/constants/baskets.ts`:

```ts
export const STAS_BASKET   = 'stas-tokens'
export const DSTAS_BASKET  = 'dstas-tokens'
export const BSV21_BASKET  = 'bsv-21-tokens'
export const TOKEN_BASKETS = [STAS_BASKET, DSTAS_BASKET, BSV21_BASKET] as const
```

Discovery's spendable-flag backfill iterates `TOKEN_BASKETS` so each protocol's
basket gets the same `setOutputSpendable(true)` treatment STAS got historically
(wallet-toolbox marks non-stock-template outputs `spendable=false` by default;
all three of our protocols need the flag flipped post-internalize).

### 3. Database migrations (additive)

| Migration | What it does |
|---|---|
| `0001_create_stas_tables.ts` | Original — `stas_tokens`, `stas_outputs`, `stas_receive_contexts`. Unchanged. |
| `0002_add_protocol_column.ts` | Adds `protocol TEXT NOT NULL DEFAULT 'stas'` to `stas_outputs` and `stas_tokens`. Backfills any DSTAS-shaped row in `stas_outputs` to `protocol = 'dstas'`. Moves those rows' wallet-toolbox `outputs.basketId` to a new `dstas-tokens` basket. Wrapped in `knex.transaction`. |
| `0003_bsv21_receive_contexts.ts` | Creates `bsv21_receive_contexts` mirroring the STAS variant — `(profileIdentityKey, keyIndex, keyId, ownerHash160, derivedPublicKey, createdAt)` unique on `(profileIdentityKey, keyIndex)`. No `bsv21_tokens` / `bsv21_outputs` satellite — BSV-21 metadata (`id/amt/dec/sym/icon`) lives on wallet-toolbox basket tags by the 1sat-toolbox convention, so the satellite is receive-only. |

The DSTAS basket split (0002) is the only data-mutating migration. Forward-only;
running it on an empty wallet is a no-op other than the `ALTER TABLE` additions.

### 4. Discovery model — indexer-driven, per protocol

```
                  PRIMARY (Refresh button + on mount)         DEMO FAST-PATH
                  ─────────────────────────────────────       (immediate UI feedback)
   STAS    →   StasDiscoveryService.scan() via Bitails    +   /stas/register-by-txid
              (auto-indexes the STAS template at owner
               addresses)
   DSTAS   →   StasDiscoveryService.scan() — same scanner,    (none — Refresh-only)
              registry.find() picks the DSTAS adapter's
              parser for matching scripts
   BSV-21  →   BSV21DiscoveryService.scan() via the 1Sat   +   /bsv-21/register-by-txid
              overlay's per-address SSE stream
              (/1sat/owner/{addr}/txos?unspent=true)
```

The `register-by-txid` HTTP routes are **demo-only fast-paths** — they let a
colocated mint flow (the dex-shell after a faucet mint) push the new txid to
the wallet and get immediate UI feedback without waiting for the next Refresh.
They mirror STAS's original pattern and bind to 127.0.0.1, not a public surface.

### 5. BSV-21 ord-inscription handling

Output format:

```
00 63                                           OP_FALSE OP_IF
03 6f7264                                       push "ord"
01 01                                           push 0x01  (content-type marker)
12 6170706c69636174696f6e2f6273762d3230         push "application/bsv-20"
00                                              OP_0  (separator)
<pushdata> <json bytes>                         {"p":"bsv-20","op":"deploy+mint"|"transfer",
                                                 "amt":"<int>","dec":<n>,"sym":"<sym>",…}
68                                              OP_ENDIF
76 a9 14 <20-byte pkh> 88 ac                    standard P2PKH owner script
```

Implementation (no SDK dependency for the envelope):

- `src/lib/services/tokens/bsv21/inscription.ts` — `buildBsv21Transfer` +
  `parseBsv21LockingScript`. Pure, ~200 LOC.
- The trailing P2PKH means **wallet-toolbox can sign the input natively** via
  the standard sighash + the wallet's `createSignature` path. No engine, no
  custom unlock template, no `partialSTASUnlockingScript`-style trickery.
  Token id = `<txid>_<vout>` of the deploy+mint outpoint.

### 6. The 1Sat overlay coupling (the load-bearing piece)

`POST /1sat/tx` on `https://api.1sat.app` is the publicly-exposed broadcast
endpoint that "captures BEEF locally, forwards to arcade with the stack's
callback token, and registers the tx with the BSV-21 topic-manager" (quoted
from `@1sat/client`'s OneSatServices source). After a successful POST, the
overlay's per-address SSE (`/1sat/owner/{addr}/txos?unspent=true`) starts
returning the corresponding `event: txo` payload — which is what the wallet's
discovery consumes.

Without this submission step, the public 1sat overlay never sees self-broadcast
BSV-21 transactions. We confirmed by direct probe that:

- The public `api.1sat.app` is a **read-only mirror** for most surfaces —
  `/1sat/owner/*` and `/1sat/bsv21/*` reads work, but `/1sat/arcade/*` and
  `/1sat/overlay/*` return Express-default 404.
- `/1sat/tx` is the one writable endpoint that **is** publicly exposed, accepts
  raw tx bytes or AtomicBEEF, and triggers topic-manager registration.
- yours-wallet's `@1sat/client` package broadcasts through this exact endpoint.

The faucet (`demo/stas-faucet/lib/mint-bsv21.mjs`) calls `POST /1sat/tx`
automatically after each WoC broadcast. Any other sender who broadcasts through
the toolbox's stack (yours-wallet, @1sat/actions consumers, etc.) does it for
free. This is what makes organic-receive discovery actually work via the
public indexer.

### 7. AssetsPage UI

- `OutputView` gained `protocol`, `tokenAmount`, `decimals`, `icon` fields.
- `groupByToken` keys on `(protocol, symbol, tokenId)` so a STAS and DSTAS that
  happen to share a symbol stay separate. Token-amount sums use bigints
  (`safeBigInt` defensively returns `0n` for malformed `amt` tag values).
- `formatTokenAmount(amt, dec)` renders raw bigint amounts with the right
  decimal precision; malformed amounts render as `? (<raw>)` rather than
  crashing the page.
- Group card carries a protocol-coloured chip ("STAS" filled / "DSTAS" outlined
  / "BSV-21" outlined).
- Per-UTXO Send button is gated on `adapter.transferSupported`. DSTAS rows show
  a disabled button with the tooltip *"Send is not yet available for DSTAS in
  this wallet."*
- Receive card has a STAS / BSV-21 protocol toggle; DSTAS uses STAS's BRC-42
  namespace (intentional — DSTAS receive piggybacks on the STAS deriver).

### 8. WalletService bundle

`stas.tokens` is the new registry. The existing fields stay:

```ts
stas: {
  keyDeriver: StasKeyDeriver
  ownership: StasOwnershipService
  discovery: StasDiscoveryService
  transfer: StasTransferService

  // New
  tokens:           TokenProtocolRegistry
  bsv21KeyDeriver:  BSV21KeyDeriver
  bsv21Discovery:   BSV21DiscoveryService
  bsv21Indexer:     OneSatIndexerClient
}
```

The `transfer` field is back-compat — it only handles classic STAS. New code
should route through `stas.tokens.getById(protocolId).transfer(...)`.

### 9. Apps API HTTP surface

| Route | Status |
|---|---|
| `GET /stas/list`, `POST /stas/receive-address`, `POST /stas/transfer`, `POST /stas/register-by-txid` | Unchanged; still STAS-shaped. |
| `POST /bsv-21/register-by-txid` | New — demo fast-path equivalent of the STAS one. Localhost only. |

No new public route surfaces. External apps continue to talk to the STAS Apps
API unchanged.

---

## Demo apps changes

### `demo/stas-faucet/`

Was a single-file Express server minting classic STAS via `stas-js`. Now a
multi-protocol faucet:

- Refactored `server.mjs` into thin wiring + three protocol modules in `lib/`
  (`mint-stas.mjs`, `mint-dstas.mjs`, `mint-bsv21.mjs`) sharing config,
  key material, and WoC helpers.
- Three POST endpoints: `/api/send-stas`, `/api/send-dstas`, `/api/send-bsv-21`.
  Same shared WIF funds all three; same `recentlyUsedOutpoints` tracker.
- `/api/info` now exposes a `protocols[]` catalog so the UI can drive itself
  off the server's declared capabilities.
- The standalone faucet UI (`public/index.html`) gains a Classic STAS / DSTAS /
  BSV-21 tab strip on the Mint card with protocol-specific input fields.
- DSTAS minting uses `dxs-bsv-token-sdk`'s `BuildDstasIssueTxs` — the SDK signs
  internally given a `PrivateKey`, so no manual unlocking-script construction.
- BSV-21 minting builds the ord-inscription envelope inline (same code as the
  wallet's parser), broadcasts via WhatsOnChain, **and** POSTs to
  `https://api.1sat.app/1sat/tx` to couple the mint with the overlay's BSV-21
  topic-manager. The 1Sat submit is best-effort; a failure logs but doesn't
  fail the mint (the tx is already on-chain).
- `amt` is now validated as `/^\d+$/` and rejected before broadcast — defends
  against the user typing Lorem-Ipsum into the Amount field.

### `demo/stas-dex-shell/`

Was a STAS-only Mint tab. Now:

- Protocol selector buttons (Classic STAS / DSTAS / BSV-21) above the existing
  mint form.
- Hidden / shown fields per protocol (BSV-21 reveals `amt` + `dec`; STAS/DSTAS
  show `symbol/name/satoshis`).
- After a successful mint, calls the matching wallet route:
  - STAS → `/stas/register-by-txid`
  - DSTAS → no auto-register (relies on Bitails + Refresh)
  - BSV-21 → `/bsv-21/register-by-txid`
- Result panel renders one txid for BSV-21 (deploy+mint is a single tx) or two
  for STAS/DSTAS (Contract + Issue).

---

## File index

New files:

```
src/lib/services/tokens/
  TokenProtocolAdapter.ts          interface + ParsedTokenOutput + TransferArgs/Result
  TokenProtocolRegistry.ts         singleton-ish holder + find()/getById()
  StasProtocolAdapter.ts
  DstasProtocolAdapter.ts
  BSV21ProtocolAdapter.ts
  bsv21/
    constants.ts                   BSV21_PROTOCOL_ID, ONESAT_API_DEFAULT_MAIN, etc.
    inscription.ts                 build/parse the ord envelope (no SDK dep)
    BSV21KeyDeriver.ts             BRC-42 receive keys under the bsv21 protocol id
    OneSatIndexerClient.ts         REST + SSE client for api.1sat.app
    BSV21Registration.ts           internalizeAction into bsv-21-tokens basket
    BSV21DiscoveryService.ts       scan() + registerByTxid()
    BSV21TransferService.ts        createAction + signAction + optional origin guard
  index.ts                         barrel exports

electron/stas-migrations/
  0002_add_protocol_column.ts
  0003_bsv21_receive_contexts.ts

demo/stas-faucet/lib/
  config.mjs                       extracted env + defaults
  wallet.mjs                       single-WIF key material
  woc.mjs                          UTXO listing + balance + broadcast
  mint-stas.mjs                    extracted from monolithic server.mjs
  mint-dstas.mjs                   new — BuildDstasIssueTxs wrapper
  mint-bsv21.mjs                   new — inscription builder + 1Sat /1sat/tx submit
```

Modified files (non-trivial):

```
src/lib/constants/baskets.ts                      DSTAS_BASKET, BSV21_BASKET, TOKEN_BASKETS
src/lib/services/WalletService.ts                 instantiates all three adapters + indexer
src/lib/services/stas/StasDiscoveryService.ts     dispatches through registry.find()
src/lib/services/stas/StasRegistration.ts         accepts {id, basketName} protocol
src/lib/pages/Dashboard/AssetsPage.tsx            protocol-aware grouping + decimal display
src/lib/WalletContext.tsx                         injects bsv21Discovery for the demo route
src/onWalletReady.ts                              /bsv-21/register-by-txid case
electron/stas-queries.ts                          protocol-aware writes + bsv21 receive CRUD
electron/stas-migrations/index.ts                 register 0002 + 0003

demo/stas-faucet/server.mjs                       slimmed to thin routing
demo/stas-faucet/public/index.html                protocol selector + protocol-specific fields
demo/stas-dex-shell/public/index.html             Mint tab protocol picker
demo/stas-dex-shell/public/app.js                 dispatch + per-protocol auto-register
demo/stas-dex-shell/public/styles.css             .mint-proto-row styling
```

---

## Status of the original "known limitations"

The first version of this doc listed five "limitations". A later review found three
of them were punts dressed up as constraints. Four have since been addressed:

| Item | Original state | Now |
|---|---|---|
| **F1 — Vite production build** | `npm run build:renderer` failed on the vendored SDK's `__exportStar` re-exports (Rollup's CJS static analyser couldn't trace them). | **Fixed.** `vite.config.ts` sets `build.commonjsOptions = { include: [/dxs-bsv-token-sdk/, /node_modules/], transformMixedEsModules: true }`. Build succeeds, ~10.5 MB bundle (gzip 2.3 MB). |
| **F2 — Wallet transfers don't reach the overlay** | `BSV21TransferService` only broadcast through wallet-toolbox's default ARC; the 1Sat overlay never saw self-originated transfers, so the recipient's wallet never picked them up via the per-address sync. | **Fixed.** After `signAction` succeeds, the service fetches the signed raw tx via `wallet.getServices().getRawTx(txid)` and POSTs to `OneSatIndexerClient.submitTransaction(...)` (→ `https://api.1sat.app/1sat/tx`). Mirrors the faucet's pattern; matches yours-wallet's `@1sat/client`. Best-effort — failure is logged, transfer still returns `ok: true` (the primary broadcast already happened). |
| **F3 — DSTAS send (`transferSupported: false`)** | "Out of scope" — I never investigated. | **Deliberately deferred to a focused PR.** The SDK exposes `BuildDstasBaseTx` for spends, but its `Owner` type wants raw `PrivateKey | Wallet` bytes that BRC-42 derivation doesn't surface. The `AllowPresetUnlockingScript` escape hatch needs the DSTAS template's witness format (`docs/DSTAS_LOCKING_TEMPLATE_NOTES.md`) and mandatory `evaluateTransactionHex(...)` validation per the SDK's AGENTS.md. ~half-day of careful integration; not a wrap-in-an-adapter job. |
| **F4 — BSV-21 partial-amount send** | UI sent the full UTXO only; `BSV21TransferService` already had the change-output branch. | **Fixed.** Send dialog has an Amount field for BSV-21 with validation (`/^\d+$/`, > 0, ≤ source). Live helper shows decimal-formatted value + change amount. STAS/DSTAS unaffected. |
| **F5 — No tests for new code** | True — only existing STAS tests ran. | **Partially addressed.** `test/tokens/bsv21-inscription.test.ts` adds 12 tests covering build / parse / round-trip / deploy+mint vs transfer / rejection edges for the inscription envelope (the load-bearing pure-function module). `npm run test:tokens` runs them. Other new modules (OneSatIndexerClient SSE, BSV21Registration, migrations) still rely on manual verification. |

The historical "L4 — public 1sat overlay write paths" really is informational rather than a
wallet limitation — `/1sat/tx` is publicly POSTable and the wallet (after F2) and the faucet
both route through it. arcade/* and overlay/* writes aren't deployed publicly, but we don't
need them.

## Outstanding work

Only one substantive item left:

- **F3 — DSTAS send.** Tracked separately so it gets the focused review the SDK's
  mandatory `evaluateTransactionHex(...)` validation requires. The adapter remains
  `transferSupported: false` until then; the UI surfaces this honestly with a
  disabled Send button + tooltip rather than failing mid-transfer.

Running the test suite (May 2026):

```
npm run test:stas      # 15 passed / 3 skipped — adapter refactor didn't regress STAS
npm run test:tokens    # 12 passed — BSV-21 inscription round-trips
npm run build:renderer # ✓ 14.99s, dist/assets/index-*.js  10.48 MB │ gzip 2.34 MB
```

---

## How to add a fourth protocol

If you wanted to add, say, BSV-20 v1 tickers:

1. **Adapter** — implement `TokenProtocolAdapter` in `src/lib/services/tokens/`.
   `parseOutput` recognises the script shape; `transfer` is optional. Pick a
   basket name and a `displayName`.
2. **Basket constant** — add `BSV20_BASKET = 'bsv-20-tokens'` to
   `constants/baskets.ts` and include it in `TOKEN_BASKETS`.
3. **Receive keys** — if the protocol uses a distinct BRC-42 protocol id, mirror
   `BSV21KeyDeriver` and add a `bsv20_receive_contexts` migration. If it
   reuses one of the existing namespaces, skip.
4. **Discovery** — if the protocol's outputs are indexed at owner addresses by
   the existing Bitails / 1Sat overlay scanners, plug the adapter into the
   `TokenProtocolRegistry` (in `WalletService._buildWallet`) and the existing
   scan loops will pick it up. If it needs its own indexer, mirror
   `BSV21DiscoveryService` + indexer client.
5. **WalletService** — instantiate the deriver / discovery / transfer / indexer
   in `_buildWallet`, register the adapter, expose any new services on the
   `stas` bundle.
6. **AssetsPage** — add the new protocol to the `protocolLabel` switch +
   chip-color logic. Add the per-protocol fields to the receive selector and
   the send dialog if relevant.
7. **Migration** — 0004_*.ts for any schema additions. Register in
   `stas-migrations/index.ts`.

The adapter seam means none of this requires touching `StasDiscoveryService`,
`StasTransferService`, the existing migrations, or the BRC-100 HTTP Apps API.

---

## Verification

Manual (no test suite). The day-of-merge smoke test:

1. Snapshot `~/.bsv-desktop/wallet-<identityKey>-main.db` before first launch.
2. `npm run dev` — confirm 0002 + 0003 apply without errors in the Electron
   log. Confirm any pre-existing DSTAS UTXO migrates from `stas-tokens` into
   `dstas-tokens` basket (SQL:
   `SELECT name, COUNT(*) FROM output_baskets b JOIN outputs o USING(basketId) WHERE name LIKE '%-tokens' GROUP BY name;`).
3. **STAS regression** — mint via the dex-shell with `Classic STAS`. Auto-registers
   into `stas-tokens`. Send one UTXO to a fresh address — should be byte-identical
   to pre-PR behavior.
4. **DSTAS** — confirm the migrated DSTAS row renders with a "DSTAS" chip + a
   disabled Send button + tooltip.
5. **BSV-21 mint + receive** — generate a BSV-21 receive address in the wallet
   (Receive card → BSV-21 toggle → Generate). Paste into the dex-shell's BSV-21
   Mint tab. After mint, see *"auto-registered into your bsv-21-tokens basket
   (1 output)"* in the dex-shell result panel. Refresh the wallet's Assets page
   — the same UTXO should be discovered organically by the overlay too (proves
   the indexer path works, not just the localhost shortcut).
6. **BSV-21 input validation** — submit the dex-shell mint with `amt = "lorem"`.
   Faucet returns 500 with *"Invalid BSV-21 amt — must be a non-negative integer
   string"* and broadcasts nothing.

---

## References

- yours-wallet (`@1sat/client`, `@1sat/actions`) — the production model we
  matched for BSV-21 indexer coupling: <https://github.com/yours-org/yours-wallet>
- 1sat-wallet-toolbox — the source-of-truth for the overlay's HTTP surface:
  <https://github.com/b-open-io/1sat-wallet-toolbox>
- 1Sat Stack OpenAPI spec — `GET https://api.1sat.app/1sat/docs` (rendered) or
  `GET https://api.1sat.app/api-spec/swagger.json` (raw)
- BSV-21 spec — <https://docs.1satordinals.com/fungible-tokens/bsv-21>
- DSTAS — uses `dxs-bsv-token-sdk`'s `BuildDstasIssueTxs` factory; SDK at
  `workspace/dxs-bsv-token-sdk/`
