
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
  WalletNotFoundError,
  type ProcessWagerInput,
} from '../../src/application/use-cases/process-wager-transaction.use-case.js';

import {
  WagerTransactionKind,
} from '../../src/domain/entities/wager-transaction.js';

import {
  WagerSqsConsumer,
  WAGER_CONSUMER_NAME,
  type WagerSqsEnvelope,
} from '../../src/infrastructure/messaging/wager-sqs.consumer.js';

import {
  SqsService,
  SQS_QUEUES,
} from '../../src/infrastructure/messaging/sqs.service.js';

import {
  WalletEntity,
} from '../../src/infrastructure/persistence/entities/wallet.entity.js';

import {
  WalletLedgerEntryEntity,
} from '../../src/infrastructure/persistence/entities/wallet-ledger-entry.entity.js';

import {
  WagerTransactionEntity,
} from '../../src/infrastructure/persistence/wager-transaction.entity.js';

import {
  InboxMessageEntity,
} from '../../src/infrastructure/persistence/inbox-message.entity.js';

let orm: MikroORM;
let sqs: SqsService;
let processor: ProcessWagerTransactionUseCase;
let consumer: WagerSqsConsumer;

beforeAll(async () => {
  orm = await MikroORM.init(config);

  sqs = new SqsService();
  await sqs.checkConnection();

  processor = new ProcessWagerTransactionUseCase(orm);

  consumer = new WagerSqsConsumer(
    sqs,
    processor,
  );
});

afterAll(async () => {
  if (sqs) {
    sqs.onModuleDestroy();
  }

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

function makeInput(
  wallet: {
    id: string;
    playerId: string;
  },
): ProcessWagerInput {
  const externalId = randomUUID();

  return {
    providerId: 'sqs-inbox-test',
    externalTransactionId: externalId,
    idempotencyKey:
      `sqs-inbox-test:${externalId}`,
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: 'round-sqs-inbox',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: {
      amount: '80.00',
      currency: 'BRL',
    },
  };
}

async function sendEnvelope(
  envelope: WagerSqsEnvelope,
): Promise<void> {
  await sqs.sendJsonFifo(
    SQS_QUEUES.transactions,

    // Cada entrega SQS tem deduplicationId
    // diferente, para simular redelivery real.
    randomUUID(),

    envelope.data.walletId,

    { ...envelope },
  );
}

async function consumeAvailable() {
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = await consumer.runOnce();

    if (result.received > 0) {
      return result;
    }
  }

  throw new Error(
    'No SQS message was received during the test',
  );
}

describe('SQS Transactional Inbox', () => {
  test(
    'processes a BET and prevents duplicate debit',
    async () => {
      const wallet = await createWallet();

      const input = makeInput(wallet);
      const messageId = randomUUID();

      const envelope: WagerSqsEnvelope = {
        messageId,
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        data: input,
      };

      // Primeira entrega.
      await sendEnvelope(envelope);

      const first = await consumeAvailable();

      expect(first.acknowledged).toBe(1);
      expect(first.retried).toBe(0);

      // Mesmo messageId de negocio,
      // mas nova entrega pelo SQS.
      await sendEnvelope(envelope);

      const second = await consumeAvailable();

      expect(second.acknowledged).toBe(1);
      expect(second.retried).toBe(0);

      const em = orm.em.fork();

      const storedWallet = await em.findOneOrFail(
        WalletEntity,
        { id: wallet.id },
      );

      const transactions = await em.find(
        WagerTransactionEntity,
        {
          providerId: input.providerId,
          externalTransactionId:
            input.externalTransactionId,
        },
      );

      const ledger = await em.find(
        WalletLedgerEntryEntity,
        { walletId: wallet.id },
      );

      const inbox = await em.find(
        InboxMessageEntity,
        {
          consumerName: WAGER_CONSUMER_NAME,
          messageId,
        },
      );

      expect(storedWallet.balance).toBe('20.00');
      expect(storedWallet.version).toBe(2);

      expect(transactions).toHaveLength(1);

      // OPENING + um unico debito.
      expect(ledger).toHaveLength(2);

      expect(
        ledger.filter(
          (entry) => entry.direction === 'DEBIT',
        ),
      ).toHaveLength(1);

      expect(inbox).toHaveLength(1);
      expect(inbox[0]!.processedAt).toBeInstanceOf(Date);

      // Mesmo messageId, payload diferente:
      // conflito, nunca outro debito.
      const conflictingEnvelope: WagerSqsEnvelope = {
        ...envelope,
        data: {
          ...input,
          money: {
            amount: '79.00',
            currency: 'BRL',
          },
        },
      };

      await sendEnvelope(conflictingEnvelope);

      const conflict = await consumeAvailable();

      expect(conflict.conflicts).toBe(1);
      expect(conflict.acknowledged).toBe(1);

      const updated = await orm.em.fork().findOneOrFail(
        WalletEntity,
        { id: wallet.id },
      );

      expect(updated.balance).toBe('20.00');
    },
    60000,
  );

  test(
    'does not persist Inbox when transaction fails',
    async () => {
      const missingWallet = {
        id: randomUUID(),
        playerId: randomUUID(),
      };

      const messageId = randomUUID();
      const input = makeInput(missingWallet);

      await expect(
        processor.execute(
          input,
          {
            consumerName: WAGER_CONSUMER_NAME,
            messageId,
          },
        ),
      ).rejects.toBeInstanceOf(
        WalletNotFoundError,
      );

      const inboxCount = await orm.em.fork().count(
        InboxMessageEntity,
        {
          consumerName: WAGER_CONSUMER_NAME,
          messageId,
        },
      );

      expect(inboxCount).toBe(0);
    },
    30000,
  );
});
