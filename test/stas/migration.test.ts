/**
 * V1 — STAS storage migration.
 *
 * Verifies that the bsv-desktop-owned STAS migration creates its three tables,
 * tracks itself in the isolated `knex_migrations_stas` ledger, and is idempotent.
 * Pure local logic — no chain interaction.
 */

import { describe, test, expect } from 'vitest'
import knex from 'knex'
import { stasMigrationSource } from '../../electron/stas-migrations/index'

// `better-sqlite3` is a native module rebuilt against Electron's Node ABI by
// the project's `postinstall: electron-builder install-app-deps` hook. Plain
// `node` (which Vitest uses by default) then can't load it. These tests still
// pass when better-sqlite3 happens to match the runtime ABI (e.g. you ran
// `npm rebuild better-sqlite3` first — see `npm run test:stas:db`). We skip
// gracefully otherwise so the rest of the suite stays runnable in plain node.
async function canUseBetterSqlite3(): Promise<boolean> {
  try {
    const probe = knex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
    })
    await probe.raw('SELECT 1')
    await probe.destroy()
    return true
  } catch {
    return false
  }
}

const sqliteAvailable = await canUseBetterSqlite3()

const MIGRATOR = { migrationSource: stasMigrationSource, tableName: 'knex_migrations_stas' }

async function freshDb() {
  const db = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
  })
  // Minimal stand-in for wallet-toolbox's `outputs` table (FK target of stas_outputs).
  await db.schema.createTable('outputs', (t: any) => {
    t.integer('outputId').primary()
  })
  return db
}

describe.skipIf(!sqliteAvailable)('STAS migration 0001', () => {
  test('creates the three STAS tables and records the migration', async () => {
    const db = await freshDb()
    await db.migrate.latest(MIGRATOR)

    expect(await db.schema.hasTable('stas_tokens')).toBe(true)
    expect(await db.schema.hasTable('stas_outputs')).toBe(true)
    expect(await db.schema.hasTable('stas_receive_contexts')).toBe(true)

    const ledger = await db('knex_migrations_stas').select('name')
    expect(ledger.map((r: any) => r.name)).toContain('0001_create_stas_tables')

    await db.destroy()
  })

  test('is idempotent — a second run applies nothing new', async () => {
    const db = await freshDb()
    await db.migrate.latest(MIGRATOR)
    await db.migrate.latest(MIGRATOR)

    const count = await db('knex_migrations_stas').count('* as c')
    expect(Number((count[0] as any).c)).toBe(1)

    await db.destroy()
  })

  test('stas_receive_contexts enforces unique (profile, keyIndex)', async () => {
    const db = await freshDb()
    await db.migrate.latest(MIGRATOR)

    const row = {
      profileIdentityKey: 'p1',
      keyIndex: 1,
      keyId: 'recv 1',
      ownerFieldHash160: '00'.repeat(20),
      derivedPublicKey: '02'.padEnd(66, '0'),
      createdAt: new Date().toISOString(),
    }
    await db('stas_receive_contexts').insert(row)
    await expect(db('stas_receive_contexts').insert(row)).rejects.toThrow()

    await db.destroy()
  })
})
