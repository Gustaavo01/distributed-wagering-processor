
import 'dotenv/config';

import assert from 'node:assert/strict';

import {
  randomUUID,
} from 'node:crypto';

import {
  MikroORM,
} from '@mikro-orm/postgresql';

import config from '../src/mikro-orm.config.js';

// ==========================================
// ISOLATED MIGRATION VERIFICATION
// ==========================================

const EXPECTED_MIGRATIONS = 3;

const EXPECTED_TABLES = [
  'wallets',
  'wallet_ledger_entries',
  'wager_transactions',
  'inbox_messages',
  'outbox_messages',
] as const;

interface TableRow {
  tableName: string;
}

function heading(message: string): void {
  console.log('');
  console.log('='.repeat(60));
  console.log(message);
  console.log('='.repeat(60));
}

function assertLocalDatabase(
  orm: MikroORM,
): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'This script cannot run with NODE_ENV=production',
    );
  }

  const clientUrl = orm.config.get(
    'clientUrl',
  );

  const host = clientUrl
    ? new URL(clientUrl).hostname
    : orm.config.get('host') ?? 'localhost';

  const allowedHosts = new Set([
    'localhost',
    '127.0.0.1',
    '::1',
    '[::1]',
  ]);

  if (!allowedHosts.has(host)) {
    throw new Error(
      'Migration verification requires a local PostgreSQL connection',
    );
  }

  console.log(
    `Local PostgreSQL confirmed: ${host}`,
  );
}

async function getFinancialTables(
  orm: MikroORM,
): Promise<string[]> {
  const rows = await orm.em.fork().execute<
    TableRow[]
  >(
    `
    SELECT
      table_name AS "tableName"

    FROM information_schema.tables

    WHERE table_schema = current_schema()

      AND table_name IN (
        'wallets',
        'wallet_ledger_entries',
        'wager_transactions',
        'inbox_messages',
        'outbox_messages'
      )

    ORDER BY table_name
    `,
  );

  return rows.map((row) => row.tableName);
}

function assertFinancialTables(
  actual: string[],
): void {
  assert.deepEqual(
    [...actual].sort(),
    [...EXPECTED_TABLES].sort(),
    'Expected financial tables were not created',
  );
}

async function main(): Promise<void> {
  // Banco exclusivo, com nome gerado
  // automaticamente para esta execucao.
  const databaseName =
    'wager_audit_' +
    randomUUID().replace(/-/g, '');

  // O nome possui somente caracteres
  // gerados internamente e validados.
  assert.match(
    databaseName,
    /^wager_audit_[0-9a-f]{32}$/,
  );

  let admin: MikroORM | undefined;
  let temporary: MikroORM | undefined;

  let databaseCreated = false;
  let stage = 'initialization';

  try {
    // ====================================
    // 1. ADMIN CONNECTION
    // ====================================

    heading('1. Connecting to local PostgreSQL');

    admin = await MikroORM.init(config);

    assertLocalDatabase(admin);

    // ====================================
    // 2. CREATE TEMPORARY DATABASE
    // ====================================

    stage = 'create temporary database';

    heading('2. Creating temporary database');

    console.log(
      `Temporary database: ${databaseName}`,
    );

    await admin.em.fork().execute(
      `CREATE DATABASE "${databaseName}"`,
    );

    databaseCreated = true;

    // ====================================
    // 3. CONNECT TO ISOLATED DATABASE
    // ====================================

    stage = 'connect isolated database';

    heading('3. Connecting to isolated database');

    temporary = await MikroORM.init({
      ...config,

      // Substitui somente o banco selecionado.
      // Nao altera a configuracao original.
      dbName: databaseName,

      migrations: {
        ...config.migrations,

        // Impede atualizacao dos arquivos
        // de snapshot da aplicacao durante
        // o teste de up/down.
        snapshotOnMigrate: false,
      },
    });

    const migrator = temporary.migrator;

    // ====================================
    // 4. CHECK INITIAL STATE
    // ====================================

    stage = 'check initial state';

    heading('4. Checking initial migration state');

    const initiallyExecuted =
      await migrator.getExecuted();

    const initiallyPending =
      await migrator.getPending();

    console.log(
      `Executed migrations: ${initiallyExecuted.length}`,
    );

    console.log(
      `Pending migrations: ${initiallyPending.length}`,
    );

    assert.equal(
      initiallyExecuted.length,
      0,
      'Temporary database must start without migrations',
    );

    assert.equal(
      initiallyPending.length,
      EXPECTED_MIGRATIONS,
      'Unexpected migration count',
    );

    // ====================================
    // 5. MIGRATE UP
    // ====================================

    stage = 'first migration UP';

    heading('5. Applying all migrations (UP)');

    const applied = await migrator.up();

    for (const migration of applied) {
      console.log(
        `Applied: ${migration.name}`,
      );
    }

    const executedAfterUp =
      await migrator.getExecuted();

    assert.equal(
      executedAfterUp.length,
      EXPECTED_MIGRATIONS,
      'Not all migrations were applied',
    );

    const tablesAfterUp =
      await getFinancialTables(temporary);

    assertFinancialTables(
      tablesAfterUp,
    );

    console.log(
      'All financial tables created successfully.',
    );

    // ====================================
    // 6. MIGRATE DOWN STEP BY STEP
    // ====================================

    heading('6. Reverting migrations (DOWN)');

    for (
      let index = EXPECTED_MIGRATIONS;
      index > 0;
      index--
    ) {
      stage = `migration DOWN step ${index}`;

      const reverted =
        await migrator.down();

      assert.equal(
        reverted.length,
        1,
        'Expected exactly one reverted migration',
      );

      const migration = reverted[0]!;

      console.log(
        `Reverted: ${migration.name}`,
      );

      const executed =
        await migrator.getExecuted();

      assert.equal(
        executed.length,
        index - 1,
        'Unexpected number of executed migrations after DOWN',
      );
    }

    // ====================================
    // 7. CHECK EMPTY SCHEMA
    // ====================================

    stage = 'check schema after DOWN';

    heading('7. Checking reverted schema');

    const remainingTables =
      await getFinancialTables(temporary);

    assert.equal(
      remainingTables.length,
      0,
      'Financial tables remain after complete rollback',
    );

    const executedAfterDown =
      await migrator.getExecuted();

    assert.equal(
      executedAfterDown.length,
      0,
      'Migration history was not fully reverted',
    );

    console.log(
      'All financial tables were removed.',
    );

    // ====================================
    // 8. MIGRATE UP AGAIN
    // ====================================

    stage = 'second migration UP';

    heading('8. Applying migrations again');

    const reapplied =
      await migrator.up();

    assert.equal(
      reapplied.length,
      EXPECTED_MIGRATIONS,
      'Migrations could not be reapplied',
    );

    const executedAfterReapply =
      await migrator.getExecuted();

    assert.equal(
      executedAfterReapply.length,
      EXPECTED_MIGRATIONS,
    );

    const restoredTables =
      await getFinancialTables(temporary);

    assertFinancialTables(
      restoredTables,
    );

    console.log(
      'All migrations reapplied successfully.',
    );

    // ====================================
    // SUCCESS
    // ====================================

    heading('MIGRATION VERIFICATION SUCCESSFUL');

    console.log(
      'Initial UP: OK',
    );

    console.log(
      'Individual DOWN: OK',
    );

    console.log(
      'Schema cleanup: OK',
    );

    console.log(
      'Second UP: OK',
    );

    console.log(
      'Original development database: UNCHANGED',
    );
  } catch (error: unknown) {
    console.error('');
    console.error(
      `Migration verification failed at: ${stage}`,
    );

    throw error;
  } finally {
    // ====================================
    // SAFE CLEANUP
    // ====================================

    heading('Cleaning temporary database');

    // Fecha todas as conexoes com o
    // banco temporario antes de remove-lo.
    if (temporary) {
      await temporary.close();
    }

    if (admin) {
      try {
        if (databaseCreated) {
          // Remove exclusivamente o banco
          // que este script acabou de criar.
          await admin.em.fork().execute(
            `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
          );

          console.log(
            `Temporary database removed: ${databaseName}`,
          );
        }
      } finally {
        await admin.close();
      }
    }

    console.log(
      'Cleanup completed.',
    );
  }
}

void main().catch((error: unknown) => {
  console.error(
    'Migration rollback verification error:',
    error,
  );

  process.exitCode = 1;
});
