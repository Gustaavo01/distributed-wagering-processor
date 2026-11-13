
import 'dotenv/config';

import {
  describe,
  expect,
  test,
} from 'bun:test';

import { randomUUID } from 'node:crypto';

import {
  CreateQueueCommand,
  DeleteQueueCommand,
} from '@aws-sdk/client-sqs';

import {
  createSqsClient,
  SqsService,
} from '../../src/infrastructure/messaging/sqs.service.js';

describe('SQS graceful shutdown', () => {
  test(
    'releases received but unacknowledged messages during shutdown',
    async () => {
      const queueName =
        `shutdown-${randomUUID()}.fifo`;

      const admin = createSqsClient();

      const firstInstance = new SqsService();
      const secondInstance = new SqsService();

      let queueUrl: string | undefined;

      try {
        // Cria uma fila exclusiva para
        // este teste, sem interferir nas
        // filas financeiras existentes.
        await admin.send(
          new CreateQueueCommand({
            QueueName: queueName,

            Attributes: {
              FifoQueue: 'true',
              VisibilityTimeout: '60',
            },
          }),
        );

        queueUrl =
          await firstInstance.getQueueUrl(
            queueName,
          );

        const messageId = randomUUID();

        await firstInstance.sendJsonFifo(
          queueName,
          messageId,
          'shutdown-test-group',
          {
            type: 'ShutdownVisibilityTest',
            messageId,
          },
        );

        // A primeira instancia recebe
        // a mensagem e a torna invisivel.
        const firstBatch =
          await firstInstance.receiveMessages(
            queueName,
            1,
            2,
          );

        expect(firstBatch).toHaveLength(1);

        const originalMessage =
          firstBatch[0]!;

        expect(
          originalMessage.ReceiptHandle,
        ).toBeDefined();

        const originalSqsMessageId =
          originalMessage.MessageId;

        expect(
          originalSqsMessageId,
        ).toBeDefined();

        // Primeiro hook:
        // para novas leituras.
        firstInstance.onModuleDestroy();

        // Segundo hook:
        // libera recibos restantes
        // e fecha o cliente.
        await firstInstance
          .beforeApplicationShutdown();

        // A segunda instancia deve
        // conseguir receber a mesma
        // mensagem sem esperar 60s.
        const secondBatch =
          await secondInstance.receiveMessages(
            queueName,
            1,
            2,
          );

        expect(secondBatch).toHaveLength(1);

        const redelivered =
          secondBatch[0]!;

        expect(redelivered.MessageId).toBe(
          originalSqsMessageId,
        );

        const receiptHandle =
          redelivered.ReceiptHandle;

        if (!receiptHandle) {
          throw new Error(
            'Redelivered message has no receipt handle',
          );
        }

        await secondInstance.acknowledge(
          queueName,
          receiptHandle,
        );

        // Depois do ACK, o registro
        // nao deve voltar a aparecer.
        const emptyBatch =
          await secondInstance.receiveMessages(
            queueName,
            1,
            1,
          );

        expect(emptyBatch).toHaveLength(0);
      } finally {
        // Limpeza independente do
        // resultado do teste.
        try {
          firstInstance.onModuleDestroy();

          await firstInstance
            .beforeApplicationShutdown();
        } catch {
          // Preserva o erro original.
        }

        try {
          secondInstance.onModuleDestroy();

          await secondInstance
            .beforeApplicationShutdown();
        } catch {
          // Preserva o erro original.
        }

        if (queueUrl) {
          try {
            await admin.send(
              new DeleteQueueCommand({
                QueueUrl: queueUrl,
              }),
            );
          } catch {
            // Fila temporaria pode
            // ja ter sido removida.
          }
        }

        admin.destroy();
      }
    },
    30000,
  );
});
