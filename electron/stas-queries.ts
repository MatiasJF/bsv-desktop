/**
 * STAS query layer.
 *
 * A thin, parameterized accessor over the STAS extension tables created by
 * electron/stas-migrations. It is reached from the renderer through the
 * dedicated `stas:query` IPC channel (see electron/main.ts + preload.ts),
 * kept separate from wallet-toolbox's `storage:call-method` proxy so STAS
 * queries never share the StorageKnex method namespace.
 *
 * `knex` is typed `any` (tsconfig.electron has strict:false) to avoid a direct
 * knex type dependency.
 */

export interface StasTokenRow {
  tokenId: string;
  symbol: string;
  name?: string;
  satoshisPerToken: number;
  freezeEnabled: boolean;
  confiscationEnabled: boolean;
  redemptionPkh?: string;
  issuerIdentityKey?: string;
  flagsHex?: string;
  createdAt: string;
}

export interface StasOutputRow {
  outputId: number;
  tokenId: string;
  brc42KeyId?: string;
  ownerFieldHash160: string;
  tokenSatoshis: number;
  frozen?: boolean;
  confiscated?: boolean;
  serviceFieldsJson?: string;
  createdAt: string;
  updatedAt: string;
}

export interface StasReceiveContextRow {
  profileIdentityKey: string;
  keyIndex: number;
  keyId: string;
  ownerFieldHash160: string;
  derivedPublicKey: string;
  createdAt: string;
}

/** Query/command surface over the STAS extension tables. */
export class StasQueries {
  constructor(private readonly knex: any) {}

  // --- tokens -------------------------------------------------------------

  async getStasToken(tokenId: string): Promise<StasTokenRow | undefined> {
    return this.knex('stas_tokens').where({ tokenId }).first();
  }

  async listStasTokens(): Promise<StasTokenRow[]> {
    return this.knex('stas_tokens').select('*');
  }

  async upsertStasToken(row: StasTokenRow): Promise<void> {
    const existing = await this.knex('stas_tokens')
      .where({ tokenId: row.tokenId })
      .first();
    if (existing) {
      await this.knex('stas_tokens').where({ tokenId: row.tokenId }).update(row);
    } else {
      await this.knex('stas_tokens').insert(row);
    }
  }

  // --- outputs ------------------------------------------------------------

  /**
   * STAS outputs the wallet STILL OWNS — joins our satellite to the wallet-
   * toolbox `outputs` row and filters by `spentBy IS NULL`.
   *
   * wallet-toolbox's spend lifecycle:
   *   - own + available  →  spendable=1, spentBy=NULL
   *   - in-flight spend  →  spendable=0, spentBy=<txid>
   *   - finalised spend  →  spendable=0, spentBy=<txid>
   *   - unspent revert   →  spendable=1, spentBy=NULL (set by wallet-toolbox
   *                          when the spending tx fails to confirm)
   *
   * Filter on `spentBy IS NULL` rather than `spendable=1` because we
   * deliberately set `spendable=1` on STAS at register-time (the toolbox
   * conservatively defaults it to 0 for non-template scripts). `spentBy`
   * is the unambiguous "this is gone" signal.
   *
   * Pass `includeSpent: true` to surface fully sent STAS too (for history /
   * activity views — not exposed via the Apps API by default).
   */
  async listStasOutputs(filter: {
    tokenId?: string;
    includeSpent?: boolean;
  } = {}): Promise<any[]> {
    let q = this.knex('stas_outputs')
      .join('outputs', 'outputs.outputId', 'stas_outputs.outputId')
      .select(
        'stas_outputs.*',
        'outputs.satoshis as outputSatoshis',
        'outputs.spendable',
        'outputs.spentBy',
        'outputs.txid',
        'outputs.vout',
        'outputs.lockingScript' // bytes — converted to hex below for the transfer UI
      );
    if (filter.tokenId) q = q.where('stas_outputs.tokenId', filter.tokenId);
    if (!filter.includeSpent) q = q.whereNull('outputs.spentBy');
    const rows = await q;
    // outputs.lockingScript is stored as Buffer in SQLite (BLOB). Convert to
    // hex so renderer-side consumers (Transfer UI) get a usable string.
    return rows.map((r: any) => ({
      ...r,
      lockingScript:
        r.lockingScript == null
          ? undefined
          : Buffer.isBuffer(r.lockingScript)
            ? r.lockingScript.toString('hex')
            : typeof r.lockingScript === 'string'
              ? r.lockingScript
              : Buffer.from(r.lockingScript).toString('hex'),
    }));
  }

  async insertStasOutput(row: StasOutputRow): Promise<void> {
    await this.knex('stas_outputs').insert(row);
  }

  /**
   * Mark a wallet-toolbox `outputs` row as spendable / not-spendable.
   *
   * STAS outputs land in the basket with `spendable=false` because the
   * toolbox doesn't recognise the custom locking script as one it knows how
   * to unlock. Our transfer flow handles the unlocking externally via the
   * BRC-42 sign path, so we need to flip the flag back to `true` so
   * createAction will let us reference the outpoint as an input.
   */
  async setOutputSpendable(outputId: number, spendable: boolean): Promise<{ updated: number }> {
    const updated = await this.knex('outputs')
      .where({ outputId })
      .update({ spendable: spendable ? 1 : 0 });
    return { updated };
  }

  /**
   * Backfill: flip `outputs.spendable=1` on STAS basket outputs that the
   * wallet still owns. Critical guard: only updates rows where `spentBy
   * IS NULL` so we don't resurrect already-spent UTXOs.
   *
   * Called by StasDiscoveryService.scan to repair the wallet-toolbox
   * conservative default for any STAS registered before the auto-flip
   * fix landed.
   */
  async backfillStasSpendable(): Promise<{ updated: number }> {
    const basket = await this.knex('output_baskets')
      .where({ name: 'stas-tokens', isDeleted: 0 })
      .first('basketId');
    if (!basket) return { updated: 0 };
    const updated = await this.knex('outputs')
      .where({ basketId: basket.basketId })
      .andWhere({ spendable: 0 })
      .whereNull('spentBy')
      .update({ spendable: 1 });
    return { updated };
  }

  /**
   * Override the `default` (change) basket's `numberOfDesiredUTXOs`.
   *
   * Wallet-toolbox's `generateChange` aims for this many UTXOs in the change
   * basket; below the target it adds fragmentation outputs each createAction.
   * The STAS engine assumes exactly 2 outputs (new STAS + one change), so
   * we lower the target to 0 around a STAS transfer to suppress
   * fragmentation, then restore it afterward.
   *
   * Returns previous + new values so the caller can restore.
   */
  async setDefaultBasketUTXOTarget(target: number): Promise<{
    previous: number | null;
    updated: number;
  }> {
    const before = await this.knex('output_baskets')
      .where({ name: 'default' })
      .first('numberOfDesiredUTXOs');
    const updated = await this.knex('output_baskets')
      .where({ name: 'default' })
      .update({ numberOfDesiredUTXOs: target });
    return {
      previous: before?.numberOfDesiredUTXOs ?? null,
      updated,
    };
  }

  /**
   * Enumerate every basket the wallet knows about, with output counts.
   *
   * BRC-100's `listOutputs` requires a basket name upfront — there's no
   * "give me every basket" method on the wallet surface. We query the
   * toolbox's `output_baskets` table directly and join `outputs` for
   * counts/totals.
   */
  async listAllBaskets(): Promise<
    Array<{
      basketId: number;
      name: string;
      numberOfDesiredUTXOs: number | null;
      minimumDesiredUTXOValue: number | null;
      outputCount: number;
      spendableCount: number;
      totalSatoshis: number;
    }>
  > {
    const baskets = await this.knex('output_baskets')
      .where({ isDeleted: 0 })
      .select(
        'basketId',
        'name',
        'numberOfDesiredUTXOs',
        'minimumDesiredUTXOValue'
      );
    if (baskets.length === 0) return [];

    const counts = await this.knex('outputs')
      .whereIn(
        'basketId',
        baskets.map((b: any) => b.basketId)
      )
      .groupBy('basketId')
      .select(
        'basketId',
        this.knex.raw('COUNT(*) as outputCount'),
        this.knex.raw('SUM(CASE WHEN spendable = 1 THEN 1 ELSE 0 END) as spendableCount'),
        this.knex.raw('SUM(satoshis) as totalSatoshis')
      );

    const byId = new Map<number, any>();
    for (const c of counts) byId.set(c.basketId, c);

    return baskets.map((b: any) => ({
      basketId: b.basketId,
      name: b.name,
      numberOfDesiredUTXOs: b.numberOfDesiredUTXOs ?? null,
      minimumDesiredUTXOValue: b.minimumDesiredUTXOValue ?? null,
      outputCount: byId.get(b.basketId)?.outputCount ?? 0,
      spendableCount: byId.get(b.basketId)?.spendableCount ?? 0,
      totalSatoshis: byId.get(b.basketId)?.totalSatoshis ?? 0,
    }));
  }

  /**
   * Outputs inside a specific basket. Returns satellite-friendly fields:
   * outpoint, satoshis, lockingScript (hex), spendable, customInstructions,
   * tags (semicolon-joined if present on the row).
   */
  async listBasketOutputs(basketName: string): Promise<any[]> {
    const basket = await this.knex('output_baskets')
      .where({ name: basketName, isDeleted: 0 })
      .first('basketId');
    if (!basket) return [];
    // wallet-toolbox stores `txid` on `transactions`, not `outputs` — outputs
    // carries `transactionId` as a foreign key. Join to surface the real txid.
    const rows = await this.knex('outputs as o')
      .join('transactions as t', 't.transactionId', 'o.transactionId')
      .where('o.basketId', basket.basketId)
      .select(
        'o.outputId as outputId',
        't.txid as txid',
        'o.vout as vout',
        'o.satoshis as satoshis',
        'o.spendable as spendable',
        'o.lockingScript as lockingScript',
        'o.customInstructions as customInstructions',
        'o.type as type',
        'o.created_at as createdAt'
      )
      .orderBy('o.created_at', 'desc')
      .limit(500);

    return rows.map((r: any) => ({
      outputId: r.outputId,
      outpoint: r.txid != null ? `${r.txid}.${r.vout}` : `?.${r.vout}`,
      txid: r.txid ?? null,
      vout: r.vout,
      satoshis: r.satoshis,
      spendable: !!r.spendable,
      type: r.type,
      customInstructions: r.customInstructions ?? null,
      lockingScript:
        r.lockingScript == null
          ? null
          : Buffer.isBuffer(r.lockingScript)
            ? r.lockingScript.toString('hex')
            : typeof r.lockingScript === 'string'
              ? r.lockingScript
              : Buffer.from(r.lockingScript).toString('hex'),
      createdAt: r.createdAt,
    }));
  }

  /** Idempotency probe: has an outpoint already been registered as STAS? */
  async findStasOutputByOutpoint(
    txid: string,
    vout: number
  ): Promise<StasOutputRow | undefined> {
    return this.knex('stas_outputs')
      .join('outputs', 'outputs.outputId', 'stas_outputs.outputId')
      .where({ 'outputs.txid': txid, 'outputs.vout': vout })
      .first('stas_outputs.*');
  }

  /**
   * Look up wallet-toolbox's `outputs.outputId` for an outpoint — used after
   * internalizeAction to link a satellite `stas_outputs` row to the
   * authoritative UTXO row.
   */
  async findOutputIdByOutpoint(
    txid: string,
    vout: number
  ): Promise<number | undefined> {
    const row = await this.knex('outputs')
      .where({ txid, vout })
      .first('outputId');
    return row ? (row.outputId as number) : undefined;
  }

  async updateStasOutputState(
    outputId: number,
    state: { frozen?: boolean; confiscated?: boolean }
  ): Promise<void> {
    await this.knex('stas_outputs')
      .where({ outputId })
      .update({ ...state, updatedAt: new Date().toISOString() });
  }

  // --- receive contexts ---------------------------------------------------

  async listReceiveContexts(
    profileIdentityKey: string
  ): Promise<StasReceiveContextRow[]> {
    return this.knex('stas_receive_contexts')
      .where({ profileIdentityKey })
      .orderBy('keyIndex', 'asc');
  }

  /** Highest issued receive-key index for a profile (0 if none) — the resync high-water mark. */
  async getReceiveHighWaterMark(profileIdentityKey: string): Promise<number> {
    const row = await this.knex('stas_receive_contexts')
      .where({ profileIdentityKey })
      .max('keyIndex as m')
      .first();
    return (row && row.m) || 0;
  }

  async insertReceiveContext(row: StasReceiveContextRow): Promise<void> {
    await this.knex('stas_receive_contexts').insert(row);
  }

  // --- resync snapshot ----------------------------------------------------

  /**
   * Export every STAS-relevant row in a stable, fingerprint-friendly shape.
   * Used by the resync verification flow: take a snapshot pre-wipe, restore
   * the wallet from mnemonic, take another snapshot, diff the two.
   *
   * Includes a canonical sort so two exports of equivalent states produce
   * byte-identical JSON (handy for shell `diff`).
   */
  async exportStasState(profileIdentityKey: string): Promise<{
    tokens: any[];
    outputs: any[];
    receiveContexts: any[];
    profileIdentityKey: string;
    exportedAt: string;
  }> {
    const tokens = await this.knex('stas_tokens')
      .select(
        'tokenId',
        'symbol',
        'name',
        'satoshisPerToken',
        'freezeEnabled',
        'confiscationEnabled',
        'redemptionPkh',
        'issuerIdentityKey',
        'flagsHex'
      )
      .orderBy('tokenId', 'asc');

    const outputsRaw = await this.knex('stas_outputs as so')
      .join('outputs as o', 'o.outputId', 'so.outputId')
      .join('transactions as t', 't.transactionId', 'o.transactionId')
      .select(
        't.txid as txid',
        'o.vout as vout',
        'so.tokenId as tokenId',
        'so.brc42KeyId as brc42KeyId',
        'so.ownerFieldHash160 as ownerFieldHash160',
        'so.tokenSatoshis as tokenSatoshis',
        'so.frozen as frozen',
        'so.confiscated as confiscated',
        'o.spendable as spendable'
      )
      .orderBy('t.txid', 'asc')
      .orderBy('o.vout', 'asc');

    const outputs = outputsRaw.map((r: any) => ({
      txid: r.txid,
      vout: r.vout,
      tokenId: r.tokenId,
      brc42KeyId: r.brc42KeyId ?? null,
      ownerFieldHash160: r.ownerFieldHash160,
      tokenSatoshis: r.tokenSatoshis,
      frozen: !!r.frozen,
      confiscated: !!r.confiscated,
      spendable: !!r.spendable,
    }));

    const receiveContexts = await this.knex('stas_receive_contexts')
      .where({ profileIdentityKey })
      .select('keyIndex', 'keyId', 'ownerFieldHash160', 'derivedPublicKey')
      .orderBy('keyIndex', 'asc');

    return {
      tokens,
      outputs,
      receiveContexts,
      profileIdentityKey,
      exportedAt: new Date().toISOString(),
    };
  }
}
