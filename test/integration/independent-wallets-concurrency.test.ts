
import 'dotenv/config';

import { randomUUID } from 'node:crypto';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';

import { LockMode } from '@mikro-orm/core';
import { MikroORM } from '@mikro-orm/postgresql';

import config from '../../src/mikro-orm.config.js';

import {
  CreateWalletUseCase,
} from '../../src/application/use-cases/create-wallet.use-case.js';

import {
  ProcessWagerTransactionUseCase,
  type ProcessWagerInput,
  type ProcessWagerOutput,
} from '../../src/application/use-cases/process-wager-transaction.use-case.js';

import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/domain/entities/wager-transaction.js';

import {
  WalletEntity,
} from '../../src/infrastructure/persistence/entities/wallet.entity.js';

interface WalletRef {
  id: string;
  playerId: string;
}

let orm: MikroORM;

beforeAll(async () => {
  orm = await MikroORM.init(config);
});

afterAll(async () => {
  if (orm) {
    await orm.close();
  }
});

async function newWallet(): Promise<WalletRef> {
  const result = await new CreateWalletUseCase(orm).execute({
    playerId: randomUUID(),
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

function makeBet(
  wallet: WalletRef,
  amount: string,
): ProcessWagerInput {
  const externalTransactionId = randomUUID();

  return {
    providerId: 'independent-wallets-test',
    externalTransactionId,
    idempotencyKey: `independent:${externalTransactionId}`,
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: 'parallel-wallets-round',
    gameId: 'parallel-wallets-game',
    kind: WagerTransactionKind.Bet,
    money: {
      amount,
      currency: 'BRL',
    },
  };
}

describe('Independent wallet concurrency', () => {
  test(
    'processes wallet B while wallet A is row-locked in another transaction',
    async () => {
      const walletA = await newWallet();
      const walletB = await newWallet();

      const processor = new ProcessWagerTransactionUseCase(orm);

      let signalLock!: () => void;
      let releaseLock!: () => void;

      const locked = new Promise<void>((resolve) => {
        signalLock = resolve;
      });

      const release = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });

      // Mantem um lock pessimista somente
      // sobre a carteira A.
      const holdingTransaction =
        orm.em.fork().transactional(
          async (tx) => {
            await tx.findOneOrFail(
              WalletEntity,
              { id: walletA.id },
              {
                lockMode: LockMode.PESSIMISTIC_WRITE,
              },
            );

            signalLock();

            await release;
          },
          { clear: true },
        );

      await locked;

      // A precisa aguardar a liberacao
      // do lock que estamos segurando.
      const pendingA = processor.execute(
        makeBet(walletA, '30.00'),
      );

      // B nao compartilha esse lock.
      const pendingB = processor.execute(
        makeBet(walletB, '25.00'),
      );

      let timeout:
        | ReturnType<typeof setTimeout>
        | undefined;

      let resultB: ProcessWagerOutput;

      try {
        // B deve concluir antes de liberarmos A.
        resultB = await Promise.race([
          pendingB,

          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => {
              reject(
                new Error(
                  'Wallet B was blocked by a lock on wallet A',
                ),
              );
            }, 5000);
          }),
        ]);

        expect(resultB.status).toBe(
          WagerTransactionStatus.Processed,
        );

        expect(resultB.idempotentReplay).toBe(false);
      } finally {
        if (timeout) {
          clearTimeout(timeout);
        }

        // Libera A mesmo se B falhar no teste.
        releaseLock();

        await holdingTransaction;
      }

      // Agora A pode terminar normalmente.
      const resultA = await pendingA;

      expect(resultA.status).toBe(
        WagerTransactionStatus.Processed,
      );

      const em = orm.em.fork();

      const storedA = await em.findOneOrFail(
        WalletEntity,
        { id: walletA.id },
      );

      const storedB = await em.findOneOrFail(
        WalletEntity,
        { id: walletB.id },
      );

      expect(storedA.balance).toBe('70.00');
      expect(storedB.balance).toBe('75.00');

      expect(storedA.version).toBe(2);
      expect(storedB.version).toBe(2);
    },
    30000,
  );
});
