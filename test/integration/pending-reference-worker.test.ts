
import {
  beforeAll,
  afterAll,
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

import {
  ProcessWagerTransactionUseCase,
} from '../../src/application/use-cases/process-wager-transaction.use-case.js';

import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  FailureCode,
} from '../../src/domain/entities/wager-transaction.js';

import {
  PendingReferenceWorker,
} from '../../src/infrastructure/workers/pending-reference.worker.js';

import {
  WalletEntity,
} from '../../src/infrastructure/persistence/entities/wallet.entity.js';

import {
  WagerTransactionEntity,
} from '../../src/infrastructure/persistence/wager-transaction.entity.js';

import {
  WalletLedgerEntryEntity,
} from '../../src/infrastructure/persistence/entities/wallet-ledger-entry.entity.js';

import {
  OutboxMessageEntity,
} from '../../src/infrastructure/persistence/outbox-message.entity.js';

let orm: MikroORM;
let processor: ProcessWagerTransactionUseCase;
let worker: PendingReferenceWorker;

beforeAll(async () => {
  orm = await MikroORM.init(config);

  processor =
    new ProcessWagerTransactionUseCase(orm);

  worker = new PendingReferenceWorker(
    orm,
    processor,
  );
});

afterAll(async () => {
  if (orm) {
    await orm.close();
  }
});

async function createWallet() {
  return new CreateWalletUseCase(orm).execute({
    playerId: randomUUID(),
    initialBalance: {
      amount: '100.00',
      currency: 'BRL',
    },
  });
}

function operation(
  wallet: { id: string; playerId: string },
  kind: Kind,
  amount: string,
  externalTransactionId: string,
  referenceExternalTransactionId?: string,
) {
  return {
    providerId: 'worker-test-provider',
    externalTransactionId,
    idempotencyKey:
      `worker-test-provider:${externalTransactionId}`,
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: 'round-worker-test',
    gameId: 'fortune-chimp',
    kind,
    money: {
      amount,
      currency: 'BRL',
    },
    referenceExternalTransactionId,
  };
}

describe('PendingReferenceWorker - PostgreSQL', () => {
  test(
    'recovers a REFUND after the BET arrives',
    async () => {
      const wallet = await createWallet();
      const betId = randomUUID();
      const refundId = randomUUID();

      // REFUND chega primeiro.
      const pending = await processor.execute(
        operation(
          wallet,
          Kind.Refund,
          '30.00',
          refundId,
          betId,
        ),
      );

      expect(pending.status).toBe(
        Status.PendingReference,
      );

      // Aposta original chega depois.
      const bet = await processor.execute(
        operation(
          wallet,
          Kind.Bet,
          '30.00',
          betId,
        ),
      );

      expect(bet.status).toBe(Status.Processed);
      expect(bet.balance.amount).toBe('70.00');

      // Torna o retry elegivel agora.
      const em = orm.em.fork();

      const pendingRow = await em.findOneOrFail(
        WagerTransactionEntity,
        { id: pending.transactionId },
      );

      pendingRow.referenceNextRetryAt = new Date(0);

      await em.flush();

      // Dois workers independentes competindo
      // pelo mesmo trabalho.
      const worker2 = new PendingReferenceWorker(
        orm,
        new ProcessWagerTransactionUseCase(orm),
      );

      await Promise.all([
        worker.runOnce(),
        worker2.runOnce(),
      ]);

      const check = orm.em.fork();

      const transaction = await check.findOneOrFail(
        WagerTransactionEntity,
        { id: pending.transactionId },
      );

      const storedWallet = await check.findOneOrFail(
        WalletEntity,
        { id: wallet.id },
      );

      const ledger = await check.find(
        WalletLedgerEntryEntity,
        { walletId: wallet.id },
      );

      expect(transaction.status).toBe(
        Status.Processed,
      );

      expect(storedWallet.balance).toBe('100.00');

      // OPENING + BET + REFUND.
      expect(ledger).toHaveLength(3);

      const refundEntries = ledger.filter(
        (entry) =>
          entry.transactionId === pending.transactionId,
      );

      // Mesmo com dois workers,
      // existe um unico lancamento do REFUND.
      expect(refundEntries).toHaveLength(1);

      // Confirma que o evento de processamento
      // da operacao nao foi duplicado.
      const outbox = await check.find(
        OutboxMessageEntity,
        {
          aggregateId: wallet.id,
          eventType: 'WagerTransactionProcessed',
        },
      );

      const refundEvents = outbox.filter(
        (event) => {
          const data = event.payload.data as {
            transactionId?: string;
          };

          return (
            data.transactionId ===
            pending.transactionId
          );
        },
      );

      expect(refundEvents).toHaveLength(1);
    },
    60000,
  );

  test(
    'rejects a missing reference after TTL expires',
    async () => {
      const wallet = await createWallet();

      const pending = await processor.execute(
        operation(
          wallet,
          Kind.Refund,
          '20.00',
          randomUUID(),
          randomUUID(),
        ),
      );

      expect(pending.status).toBe(
        Status.PendingReference,
      );

      const em = orm.em.fork();

      const row = await em.findOneOrFail(
        WagerTransactionEntity,
        { id: pending.transactionId },
      );

      // Simula o vencimento do TTL.
      row.referenceExpiresAt = new Date(0);

      // Mesmo com retry futuro, o TTL
      // vencido deve ter prioridade.
      row.referenceNextRetryAt = new Date(
        Date.now() + 3_600_000,
      );

      await em.flush();

      const result = await worker.runOnce();

      expect(result.rejected).toBeGreaterThanOrEqual(1);

      const check = orm.em.fork();

      const stored = await check.findOneOrFail(
        WagerTransactionEntity,
        { id: pending.transactionId },
      );

      expect(stored.status).toBe(Status.Rejected);

      expect(stored.failureCode).toBe(
        FailureCode.ReferenceNotFound,
      );

      const storedWallet = await check.findOneOrFail(
        WalletEntity,
        { id: wallet.id },
      );

      expect(storedWallet.balance).toBe('100.00');

      const entries = await check.find(
        WalletLedgerEntryEntity,
        { walletId: wallet.id },
      );

      // Apenas o credito de abertura.
      expect(entries).toHaveLength(1);

      // Nao pode gerar outra rejeicao
      // ao executar novamente.
      await worker.runOnce();

      const rejectedEvents = await check.find(
        OutboxMessageEntity,
        {
          aggregateId: wallet.id,
          eventType: 'WagerTransactionRejected',
        },
      );

      expect(rejectedEvents).toHaveLength(1);
    },
    60000,
  );
});
