
import 'dotenv/config';

import { MikroORM } from '@mikro-orm/postgresql';

import config from '../src/mikro-orm.config.js';

interface ConstraintRow {
  tableName: string;
  constraintName: string;
  constraintType: string;
  definition: string;
}

interface IndexRow {
  tableName: string;
  indexName: string;
  definition: string;
}

interface TriggerRow {
  tableName: string;
  triggerName: string;
  definition: string;
}

const tables = [
  'wallets',
  'wallet_ledger_entries',
  'wager_transactions',
  'inbox_messages',
  'outbox_messages',
];

function heading(value: string): void {
  console.log(`\n${'='.repeat(60)}`);
  console.log(value);
  console.log('='.repeat(60));
}

async function main(): Promise<void> {
  const orm = await MikroORM.init(config);

  try {
    const em = orm.em.fork();

    const constraints = await em.execute<
      ConstraintRow[]
    >(
      `
      SELECT
        c.relname AS "tableName",
        con.conname AS "constraintName",
        con.contype::text AS "constraintType",
        pg_get_constraintdef(
          con.oid
        ) AS "definition"

      FROM pg_constraint con

      JOIN pg_class c
        ON c.oid = con.conrelid

      JOIN pg_namespace n
        ON n.oid = c.relnamespace

      WHERE n.nspname = current_schema()
        AND c.relname IN (
          'wallets',
          'wallet_ledger_entries',
          'wager_transactions',
          'inbox_messages',
          'outbox_messages'
        )

      ORDER BY
        c.relname,
        con.conname
      `,
    );

    const indexes = await em.execute<
      IndexRow[]
    >(
      `
      SELECT
        tablename AS "tableName",
        indexname AS "indexName",
        indexdef AS "definition"

      FROM pg_indexes

      WHERE schemaname = current_schema()
        AND tablename IN (
          'wallets',
          'wallet_ledger_entries',
          'wager_transactions',
          'inbox_messages',
          'outbox_messages'
        )

      ORDER BY tablename, indexname
      `,
    );

    const triggers = await em.execute<
      TriggerRow[]
    >(
      `
      SELECT
        c.relname AS "tableName",
        t.tgname AS "triggerName",
        pg_get_triggerdef(
          t.oid
        ) AS "definition"

      FROM pg_trigger t

      JOIN pg_class c
        ON c.oid = t.tgrelid

      JOIN pg_namespace n
        ON n.oid = c.relnamespace

      WHERE n.nspname = current_schema()
        AND NOT t.tgisinternal
        AND c.relname IN (
          'wallets',
          'wallet_ledger_entries',
          'wager_transactions',
          'inbox_messages',
          'outbox_messages'
        )

      ORDER BY
        c.relname,
        t.tgname
      `,
    );

    for (const table of tables) {
      heading(`TABELA: ${table}`);

      const tableConstraints =
        constraints.filter(
          (item) =>
            item.tableName === table,
        );

      const tableIndexes =
        indexes.filter(
          (item) =>
            item.tableName === table,
        );

      const tableTriggers =
        triggers.filter(
          (item) =>
            item.tableName === table,
        );

      console.log('\nCONSTRAINTS');

      if (tableConstraints.length === 0) {
        console.log('Nenhuma encontrada.');
      }

      for (const item of tableConstraints) {
        console.log(
          `[${item.constraintType}] ${item.constraintName}`,
        );

        console.log(
          `  ${item.definition}`,
        );
      }

      console.log('\nINDICES');

      if (tableIndexes.length === 0) {
        console.log('Nenhum encontrado.');
      }

      for (const item of tableIndexes) {
        console.log(item.indexName);

        console.log(
          `  ${item.definition}`,
        );
      }

      console.log('\nTRIGGERS PERSONALIZADOS');

      if (tableTriggers.length === 0) {
        console.log('Nenhum encontrado.');
      }

      for (const item of tableTriggers) {
        console.log(item.triggerName);

        console.log(
          `  ${item.definition}`,
        );
      }
    }

    heading('RESUMO');

    console.log(
      `Constraints encontradas: ${constraints.length}`,
    );

    console.log(
      `Indices encontrados: ${indexes.length}`,
    );

    console.log(
      `Triggers personalizados: ${triggers.length}`,
    );

    console.log('\nPontos para verificar:');

    console.log(
      '1. UNIQUE (player_id, currency) em wallets',
    );

    console.log(
      '2. CHECK (balance >= 0) em wallets',
    );

    console.log(
      '3. Unicidade da identidade externa da transacao',
    );

    console.log(
      '4. Unicidade de (provider_id, idempotency_key)',
    );

    console.log(
      '5. Unicidade dos lancamentos por transacao',
    );

    console.log(
      '6. Restricao de UPDATE e DELETE no ledger',
    );

    console.log(
      '7. Checks de valores e moedas',
    );

    console.log(
      '8. Indices para Inbox, Outbox e pending references',
    );

    console.log(
      '\nEsta inspecao nao altera os dados nem o schema.',
    );

    console.log(
      'A existencia de um trigger, isoladamente,',
    );

    console.log(
      'nao comprova que sua funcao bloqueia UPDATE/DELETE.',
    );
  } finally {
    await orm.close();
  }
}

void main().catch((error: unknown) => {
  console.error(
    'Falha na auditoria do schema:',
    error,
  );

  process.exitCode = 1;
});
