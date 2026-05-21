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

  /** STAS outputs joined to wallet-toolbox's authoritative `outputs` row. */
  async listStasOutputs(filter: { tokenId?: string } = {}): Promise<any[]> {
    let q = this.knex('stas_outputs')
      .join('outputs', 'outputs.outputId', 'stas_outputs.outputId')
      .select(
        'stas_outputs.*',
        'outputs.satoshis as outputSatoshis',
        'outputs.spendable',
        'outputs.txid',
        'outputs.vout',
        'outputs.lockingScript' // bytes — converted to hex below for the transfer UI
      );
    if (filter.tokenId) q = q.where('stas_outputs.tokenId', filter.tokenId);
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
}
