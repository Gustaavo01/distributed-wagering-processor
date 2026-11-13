
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';

import { randomUUID } from 'node:crypto';

import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
} from '@aws-sdk/client-sqs';

import { MikroORM } from '@mikro-orm/postgresql';

import config from '../../src/mikro-orm.config.js';

import {
  createSqsClient,
  SqsService,
} from '../../src/infrastructure/messaging/sqs.service.js';

import {
  OutboxPublisher,
} from '../../src/infrastructure/workers/outbox.publisher.js';

import {
  OutboxMessageEntity,
} from '../../src/infrastructure/persistence/outbox-message.entity.js';

// =====================================
// TEST DEPENDENCIES
// =====================================

let orm: MikroORM;
let sqs: SqsService;

// =====================================
// SETUP
// =====================================

beforeAll(async () => {
  orm = await MikroORM.init(config);

  sqs = new SqsService();

  await sqs.checkConnection();
});

// =====================================
// CLEANUP
// =====================================

afterAll(async () => {
  if (sqs) {
    sqs.onModuleDestroy();
  }

  if (orm) {
    await orm.close();
  }
});

// =====================================
// INTEGRATION TESTS
// =====================================

describe('AWS SQS and Transactional Outbox', () => {

  // =====================================
  // TEST 1 - SEND AND RECEIVE FIFO MESSAGE
  // =====================================

  test(
    'sends and receives a FIFO message',
    async () => {
      const client = createSqsClient();

      const queueName =
        `integration-${randomUUID()}.fifo`;

      const aggregateId = randomUUID();
      const eventId = randomUUID();

      let queueUrl: string | undefined;

      try {
        // =====================================
        // CREATE QUEUE
        // =====================================

        const queue = await client.send(
          new CreateQueueCommand({
            QueueName: queueName,
            Attributes: {
              FifoQueue: 'true',
              ContentBasedDeduplication: 'false',
            },
          }),
        );

        expect(queue.QueueUrl).toBeDefined();

        // Resolve a URL usando o mesmo
        // endpoint local do SqsService.
        queueUrl = await sqs.getQueueUrl(queueName);

        // =====================================
        // CREATE MESSAGE
        // =====================================

        const messageBody = {
          eventId,
          eventType: 'IntegrationTestEvent',
          aggregateId,
          version: 1,
        };

        // =====================================
        // SEND MESSAGE
        // =====================================

        await sqs.sendJsonFifo(
          queueName,
          eventId,
          aggregateId,
          messageBody,
        );

        // =====================================
        // RECEIVE MESSAGE
        // =====================================

        const received = await client.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            WaitTimeSeconds: 5,
            MaxNumberOfMessages: 1,
          }),
        );

        expect(received.Messages).toHaveLength(1);

        const message = received.Messages![0]!;

        expect(message.Body).toBeDefined();

        // =====================================
        // VALIDATE MESSAGE CONTENT
        // =====================================

        const payload = JSON.parse(
          message.Body!,
        ) as typeof messageBody;

        expect(payload.eventId).toBe(eventId);

        expect(payload.aggregateId).toBe(aggregateId);

        expect(payload.eventType).toBe(
          'IntegrationTestEvent',
        );

        // =====================================
        // ACKNOWLEDGE MESSAGE
        // =====================================

        if (message.ReceiptHandle) {
          await client.send(
            new DeleteMessageCommand({
              QueueUrl: queueUrl,
              ReceiptHandle: message.ReceiptHandle,
            }),
          );
        }
      } finally {
        // =====================================
        // REMOVE TEST QUEUE
        // =====================================

        try {
          if (queueUrl) {
            await client.send(
              new DeleteQueueCommand({
                QueueUrl: queueUrl,
              }),
            );
          }
        } finally {
          client.destroy();
        }
      }
    },
    30000,
  );

  // =====================================
  // TEST 2 - CONCURRENT OUTBOX PUBLISHERS
  // =====================================

  test(
    'two publishers claim an outbox event once',
    async () => {
      const aggregateId = randomUUID();

      const eventId = randomUUID();

      const now = new Date();

      // =====================================
      // CREATE OUTBOX ENTITY
      // =====================================

      const row = Object.assign(
        new OutboxMessageEntity(),
        {
          id: eventId,

          aggregateId,

          eventType: 'IntegrationTestEvent',

          payload: {
            eventId,
            eventType: 'IntegrationTestEvent',
            aggregateId,
            correlationId: randomUUID(),
            occurredAt: now.toISOString(),
            version: 1,

            data: {
              test: true,
            },
          },

          occurredAt: now,

          attempts: 0,

          nextAttemptAt: null,

          publishedAt: null,
        },
      );

      // =====================================
      // PERSIST OUTBOX EVENT
      // MikroORM 7 compatible
      // =====================================

      const em = orm.em.fork();

      em.persist(row);

      await em.flush();

      // =====================================
      // CREATE TWO PUBLISHERS
      // =====================================

      const publisherA = new OutboxPublisher(
        orm,
        sqs,
      );

      const publisherB = new OutboxPublisher(
        orm,
        sqs,
      );

      // =====================================
      // EXECUTE CONCURRENTLY
      // =====================================

      const [first, second] = await Promise.all([
        publisherA.runOnce(aggregateId),
        publisherB.runOnce(aggregateId),
      ]);

      // =====================================
      // VALIDATE SINGLE PUBLICATION
      // =====================================

      expect(
        first.published + second.published,
      ).toBe(1);

      expect(
        first.scanned + second.scanned,
      ).toBe(1);

      // =====================================
      // VERIFY DATABASE
      // =====================================

      const checkEm = orm.em.fork();

      const stored = await checkEm.findOneOrFail(
        OutboxMessageEntity,
        {
          id: eventId,
        },
      );

      expect(stored.publishedAt).toBeInstanceOf(Date);

      expect(stored.attempts).toBe(1);

      // =====================================
      // VERIFY REPROCESSING IS SAFE
      // =====================================

      const again = await publisherA.runOnce(
        aggregateId,
      );

      expect(again.scanned).toBe(0);

      expect(again.published).toBe(0);
    },
    30000,
  );
});
