
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';

import { randomUUID } from 'node:crypto';

import {
  IsolationLevel,
  LockMode,
} from '@mikro-orm/core';

import {
  MikroORM,
} from '@mikro-orm/postgresql';

import config from '../../src/mikro-orm.config.js';

import {
  CreateWalletUseCase,
} from '../../src/application/use-cases/create-wallet.use-case.js';

import {
  ProcessWagerTransactionUseCase,
  type ProcessWagerInput,
} from '../../src/application/use-cases/process-wager-transaction.use-case.js';

import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../src/domain/entities/wager-transaction.js';

import {
  WalletEntity,
} from '../../src/infrastructure/persistence/entities/wallet.entity.js';

import {
  OutboxMessageEntity,
} from '../../src/infrastructure/persistence/outbox-message.entity.js';

// =====================================
// TYPES
// =====================================

interface AuditWallet {
  id: string;
  playerId: string;
}

interface FinancialAuditRow {
  storedBalance: string;
  ledgerBalance: string;
  difference: string;
  entryCount: number;
  arithmeticErrors: number;
  currencyErrors: number;
  missingLedgerCount: number;
}

// =====================================
// SETUP
// =====================================

let orm: MikroORM;
let processor: ProcessWagerTransactionUseCase;

beforeAll(async () => {
  orm = await MikroORM.init(config);

  processor =
    new ProcessWagerTransactionUseCase(orm);
});

afterAll(async () => {
  if (orm) {
    await orm.close();
  }
});

// =====================================
// FACTORIES
// =====================================

async function createWallet(): Promise<AuditWallet> {
  const playerId = randomUUID();

  const result = await new CreateWalletUseCase(
    orm,
  ).execute({
    playerId,
    initialBalance: {
      amount: '100.00',
      currency: 'BRL',
    },
  });

  return {
    id: result.id,
    playerId: result.playerId,
  };
}

function operation(
  wallet: AuditWallet,
  kind: Kind,
  amount: string,
  referenceExternalTransactionId?: string,
): ProcessWagerInput {
  const externalTransactionId = randomUUID();

  return {
    providerId: 'financial-audit-test',
    externalTransactionId,
    idempotencyKey:
      `financial-audit:${externalTransactionId}`,
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: 'audit-round',
    gameId: 'audit-game',
    kind,
    money: {
      amount,
      currency: 'BRL',
    },
    referenceExternalTransactionId,
  };
}

// =====================================
// AUDIT QUERY
// =====================================

async function auditWallet(
  walletId: string,
): Promise<FinancialAuditRow> {
  const em = orm.em.fork();

  return em.transactional(
    async (tx) => {
      const rows = await tx.execute<
        FinancialAuditRow[]
      >(
        `
        WITH wallet AS (
          SELECT
            id,
            balance,
            currency
          FROM wallets
          WHERE id = ?::uuid
        ),
        ledger AS (
          SELECT
            COALESCE(
              SUM(
                CASE
                  WHEN l.direction = 'CREDIT'
                    THEN l.amount
                  WHEN l.direction = 'DEBIT'
                    THEN -l.amount
                  ELSE 0
                END
              ),
              0
            )::numeric AS signed_total,

            COUNT(l.id)::integer AS entry_count,

            COUNT(l.id) FILTER (
              WHERE
                l.amount <= 0
                OR l.balance_before < 0
                OR l.balance_after < 0
                OR (
                  l.direction = 'CREDIT'
                  AND l.balance_after <>
                    l.balance_before + l.amount
                )
                OR (
                  l.direction = 'DEBIT'
                  AND l.balance_after <>
                    l.balance_before - l.amount
                )
                OR l.direction NOT IN (
                  'CREDIT',
                  'DEBIT'
                )
            )::integer AS arithmetic_errors,

            COUNT(l.id) FILTER (
              WHERE l.currency <> w.currency
            )::integer AS currency_errors

          FROM wallet w

          LEFT JOIN wallet_ledger_entries l
            ON l.wallet_id = w.id

          GROUP BY w.id
        )

        SELECT
          w.balance::numeric(20,2)::text
            AS "storedBalance",

          l.signed_total::numeric(20,2)::text
            AS "ledgerBalance",

          (
            w.balance - l.signed_total
          )::numeric(20,2)::text
            AS "difference",

          l.entry_count
            AS "entryCount",

          l.arithmetic_errors
            AS "arithmeticErrors",

          l.currency_errors
            AS "currencyErrors",

          (
            SELECT COUNT(*)::integer
            FROM wager_transactions t
            WHERE t.wallet_id = w.id
              AND t.status = 'PROCESSED'
              AND t.kind <> 'LOSS'
              AND NOT EXISTS (
                SELECT 1
                FROM wallet_ledger_entries entry
                WHERE entry.transaction_id = t.id
              )
          ) AS "missingLedgerCount"

        FROM wallet w
        CROSS JOIN ledger l
        `,
        [walletId],
      );

      const result = rows[0];

      if (!result) {
        throw new Error(
          'Wallet not found during audit',
        );
      }

      return result;
    },
    {
      clear: true,
      isolationLevel:
        IsolationLevel.REPEATABLE_READ,
    },
  );
}

// =====================================
// TESTS
// =====================================

describe('Financial integrity and recovery', () => {
  test(
    'reconciles BET WIN LOSS REFUND and ROLLBACK',
    async () => {
      const wallet = await createWallet();

      // INITIAL: 100.00

      const betInput = operation(
        wallet,
        Kind.Bet,
        '40.00',
      );

      const bet = await processor.execute(
        betInput,
      );

      expect(bet.status).toBe(
        Status.Processed,
      );

      expect(bet.balance.amount).toBe(
        '60.00',
      );

      // 60 + 25 = 85
      const winInput = operation(
        wallet,
        Kind.Win,
        '25.00',
      );

      const win = await processor.execute(
        winInput,
      );

      expect(win.status).toBe(
        Status.Processed,
      );

      expect(win.balance.amount).toBe(
        '85.00',
      );

      // LOSS: nao altera saldo.
      const loss = await processor.execute(
        operation(
          wallet,
          Kind.Loss,
          '7.00',
        ),
      );

      expect(loss.status).toBe(
        Status.Processed,
      );

      expect(loss.balance.amount).toBe(
        '85.00',
      );

      // REFUND da BET:
      // 85 + 40 = 125
      const refund = await processor.execute(
        operation(
          wallet,
          Kind.Refund,
          '40.00',
          betInput.externalTransactionId,
        ),
      );

      expect(refund.status).toBe(
        Status.Processed,
      );

      expect(refund.balance.amount).toBe(
        '125.00',
      );

      // ROLLBACK da WIN:
      // 125 - 25 = 100
      const rollback = await processor.execute(
        operation(
          wallet,
          Kind.Rollback,
          '25.00',
          winInput.externalTransactionId,
        ),
      );

      expect(rollback.status).toBe(
        Status.Processed,
      );

      expect(rollback.balance.amount).toBe(
        '100.00',
      );

      // Auditoria com snapshot consistente
      // no PostgreSQL.
      const audit = await auditWallet(
        wallet.id,
      );

      expect(audit.storedBalance).toBe(
        '100.00',
      );

      expect(audit.ledgerBalance).toBe(
        '100.00',
      );

      expect(audit.difference).toBe(
        '0.00',
      );

      // OPENING + BET + WIN + REFUND
      // + ROLLBACK = 5 lancamentos.
      // LOSS nao cria ledger.
      expect(audit.entryCount).toBe(5);

      expect(audit.arithmeticErrors).toBe(0);

      expect(audit.currencyErrors).toBe(0);

      expect(audit.missingLedgerCount).toBe(0);

      const storedWallet =
        await orm.em.fork().findOneOrFail(
          WalletEntity,
          { id: wallet.id },
        );

      expect(storedWallet.version).toBe(5);
    },
    60000,
  );

  test(
    'rolls back wallet and outbox after a simulated failure',
    async () => {
      const wallet = await createWallet();

      const eventId = randomUUID();

      const em = orm.em.fork();

      let capturedError: unknown;

      try {
        await em.transactional(
          async (tx) => {
            // Bloqueia a carteira para
            // modificar seu estado no teste.
            const walletRow =
              await tx.findOneOrFail(
                WalletEntity,
                { id: wallet.id },
                {
                  lockMode:
                    LockMode.PESSIMISTIC_WRITE,
                },
              );

            // Simula modificacoes financeiras
            // ainda nao confirmadas.
            walletRow.balance = '1.00';
            walletRow.version += 1;
            walletRow.updatedAt = new Date();

            const now = new Date();

            const outboxRow = Object.assign(
              new OutboxMessageEntity(),
              {
                id: eventId,
                aggregateId: wallet.id,
                eventType: 'RollbackTestEvent',
                payload: {
                  eventId,
                  aggregateId: wallet.id,
                  eventType: 'RollbackTestEvent',
                  occurredAt: now.toISOString(),
                  version: 1,
                  data: {
                    simulatedFailure: true,
                  },
                },
                occurredAt: now,
                attempts: 0,
                nextAttemptAt: null,
                publishedAt: null,
              },
            );

            tx.persist(outboxRow);

            // Executa UPDATE e INSERT
            // dentro da transacao SQL.
            await tx.flush();

            // Simula falha depois do flush,
            // mas antes do commit.
            throw new Error(
              'INJECTED_FAILURE_AFTER_FLUSH',
            );
          },
          { clear: true },
        );
      } catch (error: unknown) {
        capturedError = error;
      }

      expect(capturedError).toBeInstanceOf(
        Error,
      );

      expect(
        (capturedError as Error).message,
      ).toBe('INJECTED_FAILURE_AFTER_FLUSH');

      // Novo EntityManager para nao reutilizar
      // os objetos da transacao revertida.
      const check = orm.em.fork();

      const storedWallet =
        await check.findOneOrFail(
          WalletEntity,
          { id: wallet.id },
        );

      // O UPDATE foi revertido.
      expect(storedWallet.balance).toBe(
        '100.00',
      );

      expect(storedWallet.version).toBe(1);

      // O INSERT da Outbox tambem foi revertido.
      const outboxCount = await check.count(
        OutboxMessageEntity,
        { id: eventId },
      );

      expect(outboxCount).toBe(0);

      // A carteira original continua consistente.
      const audit = await auditWallet(
        wallet.id,
      );

      expect(audit.difference).toBe('0.00');
      expect(audit.entryCount).toBe(1);
    },
    60000,
  );
});
