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
        'outputs.vout'
      );
    if (filter.tokenId) q = q.where('stas_outputs.tokenId', filter.tokenId);
    return q;
  }

  async insertStasOutput(row: StasOutputRow): Promise<void> {
    await this.knex('stas_outputs').insert(row);
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
