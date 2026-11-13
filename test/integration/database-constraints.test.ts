
import 'dotenv/config';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';

import { randomUUID } from 'node:crypto';

import { MikroORM } from '@mikro-orm/postgresql';

import config from '../../src/mikro-orm.config.js';

import {
  CreateWalletUseCase,
} from '../../src/application/use-cases/create-wallet.use-case.js';

// =====================================
// TYPES
// =====================================

interface TestWallet {
  id: string;
  playerId: string;
}

interface LedgerRow {
  id: string;
  walletId: string;
  transactionId: string;
  amount: string;
}

interface WalletRow {
  id: string;
  playerId: string;
  balance: string;
}

interface TriggerFunctionRow {
  definition: string;
}

// =====================================
// DATABASE
// =====================================

let orm: MikroORM;

beforeAll(async () => {
  orm = await MikroORM.init(config);
});

afterAll(async () => {
  if (orm) {
    await orm.close();
  }
});

// =====================================
// FACTORIES
// =====================================

async function createWallet(): Promise<TestWallet> {
  const playerId = randomUUID();

  const wallet = await new CreateWalletUseCase(
    orm,
  ).execute({
    playerId,
    initialBalance: {
      amount: '100.00',
      currency: 'BRL',
    },
  });

  return {
    id: wallet.id,
    playerId,
  };
}

async function getWallet(
  walletId: string,
): Promise<WalletRow> {
  const rows = await orm.em.fork().execute<
    WalletRow[]
  >(
    `
    SELECT
      id::text AS "id",
      player_id::text AS "playerId",
      balance::numeric(20,2)::text AS "balance"
    FROM wallets
    WHERE id = ?::uuid
    `,
    [walletId],
  );

  const wallet = rows[0];

  if (!wallet) {
    throw new Error('Test wallet not found');
  }

  return wallet;
}

async function getLedger(
  walletId: string,
): Promise<LedgerRow> {
  const rows = await orm.em.fork().execute<
    LedgerRow[]
  >(
    `
    SELECT
      id::text AS "id",
      wallet_id::text AS "walletId",
      transaction_id::text AS "transactionId",
      amount::numeric(20,2)::text AS "amount"
    FROM wallet_ledger_entries
    WHERE wallet_id = ?::uuid
    ORDER BY created_at, id
    LIMIT 1
    `,
    [walletId],
  );

  const ledger = rows[0];

  if (!ledger) {
    throw new Error(
      'Opening ledger entry not found',
    );
  }

  return ledger;
}

// =====================================
// PROTECTED SQL EXECUTION
// =====================================

async function expectDatabaseToReject(
  sql: string,
  parameters: string[],
): Promise<Error> {
  let operationSucceeded = false;
  let capturedError: unknown;

  try {
    await orm.em.fork().transactional(
      async (tx) => {
        await tx.execute(
          sql,
          parameters,
        );

        // Se chegarmos aqui, o banco aceitou
        // a instrucao, o que seria um problema.
        operationSucceeded = true;

        // Garante rollback mesmo quando a
        // protecao de banco estiver ausente.
        throw new Error(
          'FORCED_ROLLBACK_AFTER_UNEXPECTED_SUCCESS',
        );
      },
      {
        clear: true,
      },
    );
  } catch (error: unknown) {
    capturedError = error;
  }

  if (operationSucceeded) {
    throw new Error(
      'INTEGRITY FAILURE: database allowed a forbidden operation',
    );
  }

  if (!(capturedError instanceof Error)) {
    throw new Error(
      'Expected a PostgreSQL constraint or trigger error',
    );
  }

  return capturedError;
}

// =====================================
// INTEGRATION TESTS
// =====================================

describe('PostgreSQL financial constraints', () => {
  // ===================================
  // TEST 1 - IMMUTABLE LEDGER UPDATE
  // ===================================

  test(
    'rejects UPDATE on immutable ledger',
    async () => {
      const wallet = await createWallet();
      const ledger = await getLedger(wallet.id);

      // Confirma que existe uma funcao
      // configurada para rejeitar mutacoes.
      const functions = await orm.em.fork()
        .execute<TriggerFunctionRow[]>(
          `
          SELECT pg_get_functiondef(
            'reject_ledger_mutation()'::regprocedure
          ) AS "definition"
          `,
        );

      expect(functions).toHaveLength(1);

      expect(
        functions[0]!.definition,
      ).toMatch(/\bRAISE\b/i);

      // Ate mesmo um UPDATE que nao altera
      // o valor deve ser bloqueado.
      await expectDatabaseToReject(
        `
        UPDATE wallet_ledger_entries
        SET amount = amount
        WHERE id = ?::uuid
        `,
        [ledger.id],
      );

      const stored = await getLedger(wallet.id);

      expect(stored.id).toBe(ledger.id);

      expect(stored.amount).toBe('100.00');
    },
    30000,
  );

  // ===================================
  // TEST 2 - IMMUTABLE LEDGER DELETE
  // ===================================

  test(
    'rejects DELETE on immutable ledger',
    async () => {
      const wallet = await createWallet();
      const ledger = await getLedger(wallet.id);

      await expectDatabaseToReject(
        `
        DELETE FROM wallet_ledger_entries
        WHERE id = ?::uuid
        `,
        [ledger.id],
      );

      // A linha continua existindo.
      const stored = await getLedger(wallet.id);

      expect(stored.id).toBe(ledger.id);

      expect(stored.transactionId).toBe(
        ledger.transactionId,
      );
    },
    30000,
  );

  // ===================================
  // TEST 3 - NEGATIVE WALLET BALANCE
  // ===================================

  test(
    'rejects negative balance at database level',
    async () => {
      const wallet = await createWallet();

      await expectDatabaseToReject(
        `
        UPDATE wallets
        SET balance = -1.00
        WHERE id = ?::uuid
        `,
        [wallet.id],
      );

      const stored = await getWallet(wallet.id);

      expect(stored.balance).toBe('100.00');
    },
    30000,
  );

  // ===================================
  // TEST 4 - UNIQUE PLAYER AND CURRENCY
  // ===================================

  test(
    'rejects duplicate player and currency',
    async () => {
      const first = await createWallet();
      const second = await createWallet();

      // Forca duas wallets diferentes a
      // terem o mesmo playerId + currency.
      await expectDatabaseToReject(
        `
        UPDATE wallets
        SET player_id = ?::uuid
        WHERE id = ?::uuid
        `,
        [
          first.playerId,
          second.id,
        ],
      );

      const firstStored = await getWallet(
        first.id,
      );

      const secondStored = await getWallet(
        second.id,
      );

      expect(firstStored.playerId).toBe(
        first.playerId,
      );

      expect(secondStored.playerId).toBe(
        second.playerId,
      );

      expect(firstStored.id).not.toBe(
        secondStored.id,
      );
    },
    30000,
  );

  // ===================================
  // TEST 5 - UNIQUE LEDGER TRANSACTION
  // ===================================

  test(
    'prevents two ledger entries for one transaction',
    async () => {
      const wallet = await createWallet();

      const ledger = await getLedger(
        wallet.id,
      );

      // Replica um lancamento valido,
      // modificando apenas o seu ID.
      //
      // O banco deve rejeitar a duplicata
      // pelo UNIQUE(transaction_id).
      await expectDatabaseToReject(
        `
        INSERT INTO wallet_ledger_entries (
          id,
          wallet_id,
          transaction_id,
          direction,
          amount,
          currency,
          balance_before,
          balance_after,
          created_at
        )
        SELECT
          gen_random_uuid(),
          wallet_id,
          transaction_id,
          direction,
          amount,
          currency,
          balance_before,
          balance_after,
          NOW()
        FROM wallet_ledger_entries
        WHERE id = ?::uuid
        `,
        [ledger.id],
      );

      const rows = await orm.em.fork().execute<
        Array<{ count: number }>
      >(
        `
        SELECT COUNT(*)::integer AS "count"
        FROM wallet_ledger_entries
        WHERE transaction_id = ?::uuid
        `,
        [ledger.transactionId],
      );

      expect(rows[0]?.count).toBe(1);
    },
    30000,
  );
});
