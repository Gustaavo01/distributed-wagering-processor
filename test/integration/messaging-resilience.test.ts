
import 'dotenv/config';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';

import { MikroORM } from '@mikro-orm/postgresql';

import config from '../../src/mikro-orm.config.js';

import {
  CreateWalletUseCase,
} from '../../src/application/use-cases/create-wallet.use-case.js';

import {
  ProcessWagerTransactionUseCase,
} from '../../src/application/use-cases/process-wager-transaction.use-case.js';

import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/domain/entities/wager-transaction.js';

import {
  SqsService,
  createSqsClient,
} from '../../src/infrastructure/messaging/sqs.service.js';

import {
  OutboxPublisher,
} from '../../src/infrastructure/workers/outbox.publisher.js';

import {
  OutboxMessageEntity,
} from '../../src/infrastructure/persistence/outbox-message.entity.js';

import {
  InboxMessageEntity,
} from '../../src/infrastructure/persistence/inbox-message.entity.js';

import {
  WalletEntity,
} from '../../src/infrastructure/persistence/entities/wallet.entity.js';

import {
  WalletLedgerEntryEntity,
} from '../../src/infrastructure/persistence/entities/wallet-ledger-entry.entity.js';

// =====================================
// GLOBAL TEST DEPENDENCIES
// =====================================

let orm: MikroORM;
let client: SQSClient;

beforeAll(async () => {
  orm = await MikroORM.init(config);
  client = createSqsClient();
});

afterAll(async () => {
  client?.destroy();

  if (orm) {
    await orm.close();
  }
});

// =====================================
// SQS HELPERS
// =====================================

function normalizeQueueUrl(url: string): string {
  const endpoint = process.env.SQS_ENDPOINT;

  if (!endpoint) {
    return url;
  }

  const source = new URL(url);
  const target = new URL(endpoint);

  source.protocol = target.protocol;
  source.host = target.host;

  return source.toString();
}

async function createTestQueue(
  name: string,
  attributes: Record<string, string>,
): Promise<string> {
  const response = await client.send(
    new CreateQueueCommand({
      QueueName: name,
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
        ...attributes,
      },
    }),
  );

  if (!response.QueueUrl) {
    throw new Error(`Queue creation failed: ${name}`);
  }

  return normalizeQueueUrl(response.QueueUrl);
}

async function getQueueArn(
  queueUrl: string,
): Promise<string> {
  const response = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['QueueArn'],
    }),
  );

  const arn = response.Attributes?.QueueArn;

  if (!arn) {
    throw new Error('Queue ARN not available');
  }

  return arn;
}

async function receiveOne(
  queueUrl: string,
  visibilityTimeout = 5,
): Promise<Message | undefined> {
  const response = await client.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 1,
      VisibilityTimeout: visibilityTimeout,
      MessageSystemAttributeNames: [
        'ApproximateReceiveCount',
      ],
    }),
  );

  return response.Messages?.[0];
}

async function deleteTestQueue(
  queueUrl: string | undefined,
): Promise<void> {
  if (!queueUrl) {
    return;
  }

  await client.send(
    new DeleteQueueCommand({
      QueueUrl: queueUrl,
    }),
  );
}

// =====================================
// SIMULATED ACK LOSS AFTER SQS SEND
// =====================================

interface OutboxPublishEvent {
  id: string;
  aggregateId: string;
  payload: Record<string, unknown>;
}

class SqsAckLostOnce extends SqsService {
  public acceptedSends = 0;

  private failAfterFirstSend = true;

  override async publishEvent(
    event: OutboxPublishEvent,
  ): Promise<string> {
    // Faz um envio REAL ao SQS.
    const messageId = await super.publishEvent(event);

    this.acceptedSends++;

    // Simula perda da confirmacao apos
    // o SQS aceitar o envio.
    if (this.failAfterFirstSend) {
      this.failAfterFirstSend = false;

      throw new Error(
        'INJECTED_LOST_SQS_CONFIRMATION',
      );
    }

    return messageId;
  }
}

// =====================================
// INTEGRATION TESTS
// =====================================

describe('Messaging resilience', () => {
  // ===================================
  // TEST 1 - OUTBOX RETRY
  // ===================================

  test(
    'retries outbox when SQS accepts but confirmation is lost',
    async () => {
      const aggregateId = randomUUID();
      const eventId = randomUUID();
      const now = new Date();

      const row = Object.assign(
        new OutboxMessageEntity(),
        {
          id: eventId,
          aggregateId,
          eventType: 'ResilienceTestEvent',

          payload: {
            eventId,
            aggregateId,
            eventType: 'ResilienceTestEvent',
            correlationId: randomUUID(),
            version: 1,
            occurredAt: now.toISOString(),
            data: {
              test: 'lost-confirmation',
            },
          },

          occurredAt: now,
          attempts: 0,
          nextAttemptAt: null,
          publishedAt: null,
        },
      );

      const em = orm.em.fork();

      em.persist(row);
      await em.flush();

      const sqs = new SqsAckLostOnce();
      const publisher = new OutboxPublisher(orm, sqs);

      try {
        // Primeiro envio: SQS aceita, mas
        // simulamos perda da confirmacao.
        const first = await publisher.runOnce(
          aggregateId,
        );

        expect(first.scanned).toBe(1);
        expect(first.published).toBe(0);
        expect(first.failed).toBe(1);

        expect(sqs.acceptedSends).toBe(1);

        const check = orm.em.fork();

        const afterFailure = await check.findOneOrFail(
          OutboxMessageEntity,
          { id: eventId },
        );

        expect(afterFailure.publishedAt).toBeNull();
        expect(afterFailure.attempts).toBe(1);

        expect(
          afterFailure.nextAttemptAt,
        ).toBeInstanceOf(Date);

        // Antecipamos o retry apenas no teste.
        afterFailure.nextAttemptAt = new Date(0);

        await check.flush();

        // Segundo envio utiliza o mesmo eventId.
        const second = await publisher.runOnce(
          aggregateId,
        );

        expect(second.scanned).toBe(1);
        expect(second.published).toBe(1);
        expect(second.failed).toBe(0);

        expect(sqs.acceptedSends).toBe(2);

        const stored = await orm.em
          .fork()
          .findOneOrFail(
            OutboxMessageEntity,
            { id: eventId },
          );

        expect(stored.publishedAt).toBeInstanceOf(
          Date,
        );

        expect(stored.attempts).toBe(2);

        // Evento confirmado nao e republicado.
        const third = await publisher.runOnce(
          aggregateId,
        );

        expect(third.scanned).toBe(0);
        expect(third.published).toBe(0);
      } finally {
        sqs.onModuleDestroy();
      }
    },
    30000,
  );

  // ===================================
  // TEST 2 - SQS REDELIVERY WITHOUT ACK
  // ===================================

  test(
    'redelivered SQS message does not debit twice',
    async () => {
      const queueName =
        `resilience-${randomUUID()}.fifo`;

      let queueUrl: string | undefined;

      try {
        queueUrl = await createTestQueue(
          queueName,
          {
            VisibilityTimeout: '5',
          },
        );

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

        const externalId = randomUUID();
        const messageId = randomUUID();

        const input = {
          providerId: 'resilience-provider',
          externalTransactionId: externalId,
          idempotencyKey:
            `resilience:${externalId}`,
          walletId: wallet.id,
          playerId,
          roundId: 'resilience-round',
          gameId: 'resilience-game',
          kind: WagerTransactionKind.Bet,
          money: {
            amount: '25.00',
            currency: 'BRL',
          },
        };

        const envelope = {
          messageId,
          type: 'WagerTransactionRequested',
          occurredAt: new Date().toISOString(),
          data: input,
        };

        await client.send(
          new SendMessageCommand({
            QueueUrl: queueUrl,
            MessageBody: JSON.stringify(envelope),
            MessageGroupId: wallet.id,
            MessageDeduplicationId: messageId,
          }),
        );

        const firstDelivery = await receiveOne(
          queueUrl,
        );

        expect(firstDelivery).toBeDefined();

        if (!firstDelivery?.ReceiptHandle) {
          throw new Error(
            'First delivery has no receipt handle',
          );
        }

        const processor =
          new ProcessWagerTransactionUseCase(orm);

        const inbox = {
          consumerName: 'resilience-consumer',
          messageId,
        };

        // Processamento financeiro com commit.
        const firstResult = await processor.execute(
          input,
          inbox,
        );

        expect(firstResult.status).toBe(
          WagerTransactionStatus.Processed,
        );

        expect(firstResult.balance.amount).toBe(
          '75.00',
        );

        expect(firstResult.idempotentReplay).toBe(
          false,
        );

        // NAO chamamos DeleteMessage.
        // Em vez de aguardar o timeout real,
        // tornamos a mensagem visivel agora.
        await client.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: queueUrl,
            ReceiptHandle:
              firstDelivery.ReceiptHandle,
            VisibilityTimeout: 0,
          }),
        );

        let secondDelivery: Message | undefined;

        for (let attempt = 0; attempt < 5; attempt++) {
          secondDelivery = await receiveOne(
            queueUrl,
          );

          if (secondDelivery) {
            break;
          }

          await sleep(150);
        }

        expect(secondDelivery).toBeDefined();

        if (!secondDelivery?.ReceiptHandle) {
          throw new Error(
            'Second delivery has no receipt handle',
          );
        }

        expect(secondDelivery.MessageId).toBe(
          firstDelivery.MessageId,
        );

        // A mesma mensagem e reprocessada.
        const replay = await processor.execute(
          input,
          inbox,
        );

        expect(replay.idempotentReplay).toBe(true);

        expect(replay.transactionId).toBe(
          firstResult.transactionId,
        );

        expect(replay.balance.amount).toBe(
          '75.00',
        );

        // Agora simulamos o ACK correto.
        await client.send(
          new DeleteMessageCommand({
            QueueUrl: queueUrl,
            ReceiptHandle:
              secondDelivery.ReceiptHandle,
          }),
        );

        const check = orm.em.fork();

        const storedWallet =
          await check.findOneOrFail(
            WalletEntity,
            { id: wallet.id },
          );

        const ledger = await check.find(
          WalletLedgerEntryEntity,
          { walletId: wallet.id },
        );

        const storedInbox = await check.find(
          InboxMessageEntity,
          {
            consumerName: inbox.consumerName,
            messageId,
          },
        );

        expect(storedWallet.balance).toBe(
          '75.00',
        );

        expect(storedWallet.version).toBe(2);

        // OPENING + somente um BET.
        expect(ledger).toHaveLength(2);

        expect(
          ledger.filter(
            (entry) =>
              entry.direction === 'DEBIT',
          ),
        ).toHaveLength(1);

        expect(storedInbox).toHaveLength(1);
      } finally {
        await deleteTestQueue(queueUrl);
      }
    },
    45000,
  );

  // ===================================
  // TEST 3 - DEAD LETTER QUEUE
  // ===================================

  test(
    'moves repeatedly failing message to DLQ',
    async () => {
      const suffix = randomUUID();

      const dlqName =
        `resilience-dlq-${suffix}.fifo`;

      const mainName =
        `resilience-main-${suffix}.fifo`;

      let dlqUrl: string | undefined;
      let mainUrl: string | undefined;

      try {
        // Cria uma DLQ isolada para este teste.
        dlqUrl = await createTestQueue(
          dlqName,
          {
            VisibilityTimeout: '1',
          },
        );

        const dlqArn = await getQueueArn(
          dlqUrl,
        );

        // Configura no maximo duas entregas
        // antes do redrive para a DLQ.
        mainUrl = await createTestQueue(
          mainName,
          {
            VisibilityTimeout: '1',

            RedrivePolicy: JSON.stringify({
              deadLetterTargetArn: dlqArn,
              maxReceiveCount: 2,
            }),
          },
        );

        const poisonId = randomUUID();

        const poisonBody = JSON.stringify({
          messageId: poisonId,
          type: 'InvalidPoisonMessage',
          data: {
            reason: 'integration-test',
          },
        });

        await client.send(
          new SendMessageCommand({
            QueueUrl: mainUrl,
            MessageBody: poisonBody,
            MessageGroupId: poisonId,
            MessageDeduplicationId: poisonId,
          }),
        );

        let deliveries = 0;
        let deadLetter: Message | undefined;

        // A mensagem nunca e reconhecida.
        // O SQS aplica a RedrivePolicy.
        for (let attempt = 0; attempt < 12; attempt++) {
          deadLetter = await receiveOne(
            dlqUrl,
            5,
          );

          if (deadLetter) {
            break;
          }

          const delivery = await receiveOne(
            mainUrl,
            1,
          );

          if (delivery?.ReceiptHandle) {
            deliveries++;

            // Torna a mensagem imediatamente
            // disponivel para outra tentativa.
            await client.send(
              new ChangeMessageVisibilityCommand({
                QueueUrl: mainUrl,
                ReceiptHandle:
                  delivery.ReceiptHandle,
                VisibilityTimeout: 0,
              }),
            );
          }

          await sleep(150);
        }

        expect(deliveries).toBeGreaterThanOrEqual(
          2,
        );

        expect(deadLetter).toBeDefined();

        expect(deadLetter?.Body).toBe(
          poisonBody,
        );

        if (deadLetter?.ReceiptHandle) {
          await client.send(
            new DeleteMessageCommand({
              QueueUrl: dlqUrl,
              ReceiptHandle:
                deadLetter.ReceiptHandle,
            }),
          );
        }
      } finally {
        // Remove somente filas temporarias.
        // As filas do projeto sao preservadas.
        await deleteTestQueue(mainUrl);
        await deleteTestQueue(dlqUrl);
      }
    },
    60000,
  );
});
