
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

import { CreateWalletUseCase } from '../../src/application/use-cases/create-wallet.use-case.js';

import {
  ProcessWagerTransactionUseCase,
  type ProcessWagerInput,
} from '../../src/application/use-cases/process-wager-transaction.use-case.js';

import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  FailureCode,
} from '../../src/domain/entities/wager-transaction.js';

import { WalletEntity } from '../../src/infrastructure/persistence/entities/wallet.entity.js';
import { WalletLedgerEntryEntity } from '../../src/infrastructure/persistence/entities/wallet-ledger-entry.entity.js';
import { WagerTransactionEntity } from '../../src/infrastructure/persistence/wager-transaction.entity.js';
import { OutboxMessageEntity } from '../../src/infrastructure/persistence/outbox-message.entity.js';

let orm: MikroORM;
let processor: ProcessWagerTransactionUseCase;

beforeAll(async () => {
  orm = await MikroORM.init(config);
  processor = new ProcessWagerTransactionUseCase(orm);
});

afterAll(async () => {
  if (orm) await orm.close();
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
  referenceExternalTransactionId?: string,
): ProcessWagerInput {
  const id = randomUUID();

  return {
    providerId: 'provider-a',
    externalTransactionId: id,
    idempotencyKey: `provider-a:${id}`,
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: {
      amount,
      currency: 'BRL',
    },
    referenceExternalTransactionId,
  };
}

async function storedBalance(walletId: string) {
  const row = await orm.em.fork().findOneOrFail(
    WalletEntity,
    { id: walletId },
  );

  return row.balance;
}

async function ledgerCount(walletId: string) {
  return orm.em.fork().count(
    WalletLedgerEntryEntity,
    { walletId },
  );
}

describe('Financial wagering operations', () => {
  test('WIN credits the wallet', async () => {
    const wallet = await createWallet();

    const win = await processor.execute(
      operation(wallet, Kind.Win, '50.00'),
    );

    expect(win.status).toBe(Status.Processed);
    expect(win.balance.amount).toBe('150.00');
    expect(await storedBalance(wallet.id)).toBe('150.00');

    // OPENING + WIN
    expect(await ledgerCount(wallet.id)).toBe(2);
  });

  test('LOSS does not change balance or ledger', async () => {
    const wallet = await createWallet();

    const loss = await processor.execute(
      operation(wallet, Kind.Loss, '20.00'),
    );

    expect(loss.status).toBe(Status.Processed);
    expect(loss.balance.amount).toBe('100.00');
    expect(await ledgerCount(wallet.id)).toBe(1);

    const row = await orm.em.fork().findOneOrFail(
      WalletEntity,
      { id: wallet.id },
    );

    expect(row.version).toBe(1);
  });

  test('REFUND reverses a BET only once', async () => {
    const wallet = await createWallet();

    const betInput = operation(wallet, Kind.Bet, '60.00');
    const bet = await processor.execute(betInput);

    expect(bet.status).toBe(Status.Processed);
    expect(bet.balance.amount).toBe('40.00');

    const refundInput = operation(
      wallet,
      Kind.Refund,
      '60.00',
      betInput.externalTransactionId,
    );

    const refund = await processor.execute(refundInput);

    expect(refund.status).toBe(Status.Processed);
    expect(refund.balance.amount).toBe('100.00');

    const replay = await processor.execute(refundInput);

    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transactionId).toBe(refund.transactionId);

    const duplicate = await processor.execute(
      operation(
        wallet,
        Kind.Refund,
        '60.00',
        betInput.externalTransactionId,
      ),
    );

    expect(duplicate.status).toBe(Status.Rejected);
    expect(duplicate.failureCode)
      .toBe(FailureCode.DuplicateReversal);

    expect(await storedBalance(wallet.id)).toBe('100.00');

    // OPENING + BET + primeiro REFUND
    expect(await ledgerCount(wallet.id)).toBe(3);
  });

  test('ROLLBACK of a BET restores its debit', async () => {
    const wallet = await createWallet();

    const betInput = operation(wallet, Kind.Bet, '25.00');
    await processor.execute(betInput);

    const rollback = await processor.execute(
      operation(
        wallet,
        Kind.Rollback,
        '25.00',
        betInput.externalTransactionId,
      ),
    );

    expect(rollback.status).toBe(Status.Processed);
    expect(rollback.balance.amount).toBe('100.00');
    expect(await ledgerCount(wallet.id)).toBe(3);
  });

  test('ROLLBACK of WIN debits the wallet', async () => {
    const wallet = await createWallet();

    const winInput = operation(wallet, Kind.Win, '40.00');
    await processor.execute(winInput);

    const rollback = await processor.execute(
      operation(
        wallet,
        Kind.Rollback,
        '40.00',
        winInput.externalTransactionId,
      ),
    );

    expect(rollback.status).toBe(Status.Processed);
    expect(rollback.balance.amount).toBe('100.00');
    expect(await ledgerCount(wallet.id)).toBe(3);
  });

  test('ROLLBACK cannot create negative balance', async () => {
    const wallet = await createWallet();

    const winInput = operation(wallet, Kind.Win, '40.00');

    await processor.execute(winInput);

    await processor.execute(
      operation(wallet, Kind.Bet, '130.00'),
    );

    const rollback = await processor.execute(
      operation(
        wallet,
        Kind.Rollback,
        '40.00',
        winInput.externalTransactionId,
      ),
    );

    expect(rollback.status).toBe(Status.Rejected);
    expect(rollback.failureCode)
      .toBe(FailureCode.ReversalWouldOverdraw);

    expect(await storedBalance(wallet.id)).toBe('10.00');

    // OPENING + WIN + BET. ROLLBACK nao gera ledger.
    expect(await ledgerCount(wallet.id)).toBe(3);
  });

  test('REFUND arriving before BET can be retried', async () => {
    const wallet = await createWallet();

    const betInput = operation(wallet, Kind.Bet, '30.00');

    const refundInput = operation(
      wallet,
      Kind.Refund,
      '30.00',
      betInput.externalTransactionId,
    );

    const pending = await processor.execute(refundInput);

    expect(pending.status).toBe(Status.PendingReference);
    expect(pending.balance.amount).toBe('100.00');

    const outbox = await orm.em.fork().find(
      OutboxMessageEntity,
      { aggregateId: wallet.id },
    );

    expect(
      outbox.some(
        (event) =>
          event.eventType ===
          'WagerTransactionPendingReference',
      ),
    ).toBe(true);

    // A BET chega depois do REFUND.
    const bet = await processor.execute(betInput);

    expect(bet.status).toBe(Status.Processed);
    expect(bet.balance.amount).toBe('70.00');

    // Antecipamos o agendamento apenas neste teste,
    // sem aguardar o backoff real.
    const em = orm.em.fork();

    const pendingRow = await em.findOneOrFail(
      WagerTransactionEntity,
      { id: pending.transactionId },
    );

    pendingRow.referenceNextRetryAt = new Date(0);
    await em.flush();

    const retried = await processor.retryPendingReference(
      pending.transactionId,
    );

    expect(retried?.status).toBe(Status.Processed);
    expect(retried?.balance.amount).toBe('100.00');

    expect(await storedBalance(wallet.id)).toBe('100.00');
    expect(await ledgerCount(wallet.id)).toBe(3);
  }, 30000);

  test('REFUND amount must match original BET', async () => {
    const wallet = await createWallet();

    const betInput = operation(wallet, Kind.Bet, '50.00');
    await processor.execute(betInput);

    const refund = await processor.execute(
      operation(
        wallet,
        Kind.Refund,
        '25.00',
        betInput.externalTransactionId,
      ),
    );

    expect(refund.status).toBe(Status.Rejected);
    expect(refund.failureCode)
      .toBe(FailureCode.InvalidReference);

    expect(await storedBalance(wallet.id)).toBe('50.00');
    expect(await ledgerCount(wallet.id)).toBe(2);
  });

  test('ROLLBACK of REFUND reverses its credit', async () => {
    const wallet = await createWallet();

    const betInput = operation(wallet, Kind.Bet, '20.00');
    await processor.execute(betInput);

    const refundInput = operation(
      wallet,
      Kind.Refund,
      '20.00',
      betInput.externalTransactionId,
    );

    await processor.execute(refundInput);

    const rollback = await processor.execute(
      operation(
        wallet,
        Kind.Rollback,
        '20.00',
        refundInput.externalTransactionId,
      ),
    );

    expect(rollback.status).toBe(Status.Processed);
    expect(rollback.balance.amount).toBe('80.00');

    // OPENING + BET + REFUND + ROLLBACK
    expect(await ledgerCount(wallet.id)).toBe(4);
  });
});
