
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

import { CreateWalletUseCase } from '../../src/application/use-cases/create-wallet.use-case.js';

import {
  ProcessWagerTransactionUseCase,
  IdempotencyConflictError,
  type ProcessWagerInput,
} from '../../src/application/use-cases/process-wager-transaction.use-case.js';

import {
  WagerTransactionKind,
  WagerTransactionStatus,
  FailureCode,
} from '../../src/domain/entities/wager-transaction.js';

import { WalletEntity } from '../../src/infrastructure/persistence/entities/wallet.entity.js';

import { WalletLedgerEntryEntity } from '../../src/infrastructure/persistence/entities/wallet-ledger-entry.entity.js';

let orm: MikroORM;

beforeAll(async () => {
  orm = await MikroORM.init(config);
});

afterAll(async () => {
  if (orm) {
    await orm.close();
  }
});

async function setupWallet() {
  const playerId = randomUUID();

  return new CreateWalletUseCase(orm).execute({
    playerId,
    initialBalance: {
      amount: '100.00',
      currency: 'BRL',
    },
  });
}

function betInput(
  wallet: { id: string; playerId: string },
  externalId: string,
  amount = '80.00',
): ProcessWagerInput {
  return {
    providerId: 'provider-a',
    externalTransactionId: externalId,
    idempotencyKey: `provider-a:${externalId}`,
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: {
      amount,
      currency: 'BRL',
    },
  };
}

describe('BET - PostgreSQL concurrency', () => {
  test('two bets of 80 compete for balance 100', async () => {
    const wallet = await setupWallet();
    const useCase = new ProcessWagerTransactionUseCase(orm);

    const [first, second] = await Promise.all([
      useCase.execute(
        betInput(wallet, `bet-${randomUUID()}`),
      ),
      useCase.execute(
        betInput(wallet, `bet-${randomUUID()}`),
      ),
    ]);

    const statuses = [first.status, second.status];

    expect(
      statuses.filter(
        (status) =>
          status === WagerTransactionStatus.Processed,
      ),
    ).toHaveLength(1);

    expect(
      statuses.filter(
        (status) =>
          status === WagerTransactionStatus.Rejected,
      ),
    ).toHaveLength(1);

    const rejected = [first, second].find(
      (result) =>
        result.status === WagerTransactionStatus.Rejected,
    );

    expect(rejected?.failureCode)
      .toBe(FailureCode.InsufficientBalance);

    const em = orm.em.fork();

    const storedWallet = await em.findOneOrFail(
      WalletEntity,
      { id: wallet.id },
    );

    const entries = await em.find(
      WalletLedgerEntryEntity,
      { walletId: wallet.id },
    );

    expect(storedWallet.balance).toBe('20.00');
    expect(storedWallet.version).toBe(2);

    // Um credito OPENING e um debito BET.
    expect(entries).toHaveLength(2);

    expect(
      entries.filter(
        (entry) => entry.direction === 'DEBIT',
      ),
    ).toHaveLength(1);
  }, 60000);

  test('50 parallel deliveries cause one debit', async () => {
    const wallet = await setupWallet();
    const useCase = new ProcessWagerTransactionUseCase(orm);

    const input = betInput(
      wallet,
      `repeated-${randomUUID()}`,
    );

    const results = await Promise.all(
      Array.from(
        { length: 50 },
        () => useCase.execute(input),
      ),
    );

    expect(results).toHaveLength(50);

    expect(
      results.every(
        (result) =>
          result.status === WagerTransactionStatus.Processed,
      ),
    ).toBe(true);

    expect(
      new Set(
        results.map((result) => result.transactionId),
      ).size,
    ).toBe(1);

    expect(
      results.filter((result) => !result.idempotentReplay),
    ).toHaveLength(1);

    const em = orm.em.fork();

    const storedWallet = await em.findOneOrFail(
      WalletEntity,
      { id: wallet.id },
    );

    const entries = await em.find(
      WalletLedgerEntryEntity,
      { walletId: wallet.id },
    );

    expect(storedWallet.balance).toBe('20.00');
    expect(storedWallet.version).toBe(2);
    expect(entries).toHaveLength(2);

    expect(
      entries.filter(
        (entry) => entry.direction === 'DEBIT',
      ),
    ).toHaveLength(1);

    // Mesma chave, payload diferente = conflito.
    await expect(
      useCase.execute({
        ...input,
        money: {
          amount: '79.00',
          currency: 'BRL',
        },
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  }, 60000);
});