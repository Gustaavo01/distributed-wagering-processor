
import 'dotenv/config';

import {
  BeforeApplicationShutdown,
  Injectable,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';

import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';

// ======================================
// QUEUE NAMES
// ======================================

export const SQS_QUEUES = {
  transactions: 'wager-transactions.fifo',
  transactionsDlq: 'wager-transactions-dlq.fifo',
  events: 'wager-events.fifo',
  eventsDlq: 'wager-events-dlq.fifo',
} as const;

// ======================================
// AWS CLIENT FACTORY
// ======================================

export function createSqsClient(): SQSClient {
  const endpoint = process.env.SQS_ENDPOINT;

  return new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',

    ...(endpoint
      ? {
          endpoint,
          credentials: {
            accessKeyId:
              process.env.AWS_ACCESS_KEY_ID ?? 'test',
            secretAccessKey:
              process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
          },
        }
      : {}),
  });
}

// ======================================
// SQS SERVICE
// ======================================

@Injectable()
export class SqsService
  implements
    OnModuleDestroy,
    BeforeApplicationShutdown {

  private readonly logger =
    new Logger(SqsService.name);

  private readonly client =
    createSqsClient();

  private readonly queueUrls =
    new Map<string, string>();

  // Registra somente os receipt handles
  // recebidos por esta instancia.
  //
  // Um receipt handle nao confirmado
  // continua aqui ate o ACK ou ate
  // uma mudanca explicita de visibilidade.
  private readonly outstandingReceipts =
    new Map<string, Set<string>>();

  private stopping = false;
  private closed = false;

  // ====================================
  // TRACK RECEIPTS
  // ====================================

  private trackReceipt(
    queueName: string,
    receiptHandle: string,
  ): void {
    let handles =
      this.outstandingReceipts.get(queueName);

    if (!handles) {
      handles = new Set<string>();

      this.outstandingReceipts.set(
        queueName,
        handles,
      );
    }

    handles.add(receiptHandle);
  }

  private forgetReceipt(
    queueName: string,
    receiptHandle: string,
  ): void {
    const handles =
      this.outstandingReceipts.get(queueName);

    if (!handles) {
      return;
    }

    handles.delete(receiptHandle);

    if (handles.size === 0) {
      this.outstandingReceipts.delete(
        queueName,
      );
    }
  }

  // ====================================
  // GET QUEUE URL
  // ====================================

  async getQueueUrl(
    queueName: string,
  ): Promise<string> {
    const cached =
      this.queueUrls.get(queueName);

    if (cached) {
      return cached;
    }

    const response = await this.client.send(
      new GetQueueUrlCommand({
        QueueName: queueName,
      }),
    );

    if (!response.QueueUrl) {
      throw new Error(
        `SQS queue not found: ${queueName}`,
      );
    }

    let queueUrl = response.QueueUrl;

    // Compatibilidade com MiniStack
    // executando em Docker.
    if (process.env.SQS_ENDPOINT) {
      const received = new URL(queueUrl);

      const configured = new URL(
        process.env.SQS_ENDPOINT,
      );

      received.protocol =
        configured.protocol;

      received.host =
        configured.host;

      queueUrl = received.toString();
    }

    this.queueUrls.set(
      queueName,
      queueUrl,
    );

    return queueUrl;
  }

  // ====================================
  // SEND FIFO MESSAGE
  // ====================================

  async sendJsonFifo(
    queueName: string,
    messageId: string,
    aggregateId: string,
    payload: Record<string, unknown>,
  ): Promise<string> {
    const queueUrl =
      await this.getQueueUrl(queueName);

    const response = await this.client.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(payload),
        MessageGroupId: aggregateId,
        MessageDeduplicationId: messageId,
      }),
    );

    if (!response.MessageId) {
      throw new Error(
        'SQS did not return a MessageId',
      );
    }

    return response.MessageId;
  }

  // ====================================
  // PUBLISH OUTBOX EVENT
  // ====================================

  async publishEvent(event: {
    id: string;
    aggregateId: string;
    payload: Record<string, unknown>;
  }): Promise<string> {
    return this.sendJsonFifo(
      SQS_QUEUES.events,
      event.id,
      event.aggregateId,
      event.payload,
    );
  }

  // ====================================
  // RECEIVE MESSAGES
  // ====================================

  async receiveMessages(
    queueName: string,
    maxMessages = 5,
    waitTimeSeconds = 2,
  ): Promise<Message[]> {
    // Nao inicia uma nova leitura quando
    // o encerramento ja comecou.
    if (this.stopping) {
      return [];
    }

    const queueUrl =
      await this.getQueueUrl(queueName);

    const response = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,

        MaxNumberOfMessages: maxMessages,

        WaitTimeSeconds: waitTimeSeconds,

        VisibilityTimeout: 60,

        MessageSystemAttributeNames: [
          'ApproximateReceiveCount',
        ],
      }),
    );

    const messages = response.Messages ?? [];

    // Registra todos os recibos recebidos,
    // inclusive os das mensagens que
    // ainda nao foram processadas.
    for (const message of messages) {
      if (message.ReceiptHandle) {
        this.trackReceipt(
          queueName,
          message.ReceiptHandle,
        );
      }
    }

    return messages;
  }

  // ====================================
  // ACK AFTER COMMIT
  // ====================================

  async acknowledge(
    queueName: string,
    receiptHandle: string,
  ): Promise<void> {
    const queueUrl =
      await this.getQueueUrl(queueName);

    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: receiptHandle,
      }),
    );

    // O recibo so deixa de ser rastreado
    // apos o SQS confirmar a exclusao.
    this.forgetReceipt(
      queueName,
      receiptHandle,
    );
  }

  // ====================================
  // RETRY VISIBILITY
  // ====================================

  async changeVisibility(
    queueName: string,
    receiptHandle: string,
    timeoutSeconds: number,
  ): Promise<void> {
    const queueUrl =
      await this.getQueueUrl(queueName);

    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: timeoutSeconds,
      }),
    );

    // A responsabilidade pela proxima
    // entrega voltou para o SQS.
    //
    // O receipt handle deixa de ser
    // considerado processamento pendente
    // desta instancia.
    this.forgetReceipt(
      queueName,
      receiptHandle,
    );
  }

  // ====================================
  // READINESS
  // ====================================

  async checkConnection(): Promise<boolean> {
    await this.getQueueUrl(
      SQS_QUEUES.transactions,
    );

    await this.getQueueUrl(
      SQS_QUEUES.events,
    );

    return true;
  }

  // ====================================
  // SHUTDOWN: PHASE 1
  // ====================================

  onModuleDestroy(): void {
    // Os workers executam seus proprios
    // onModuleDestroy para terminar os
    // ciclos que ja estao em andamento.
    //
    // Nao destruimos o cliente AWS aqui.
    // Ele ainda pode ser necessario para
    // ACK ou atualizacao da visibilidade.
    this.stopping = true;
  }

  // ====================================
  // RELEASE OUTSTANDING RECEIPTS
  // ====================================

  private async releaseOutstanding(): Promise<void> {
    let released = 0;
    let failed = 0;

    const pending = [
      ...this.outstandingReceipts.entries(),
    ].flatMap(
      ([queueName, handles]) =>
        [...handles].map(
          (receiptHandle) => ({
            queueName,
            receiptHandle,
          }),
        ),
    );

    for (const item of pending) {
      try {
        const queueUrl =
          await this.getQueueUrl(
            item.queueName,
          );

        // Zero devolve a mensagem
        // imediatamente a visibilidade
        // do SQS para futura entrega.
        await this.client.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: queueUrl,

            ReceiptHandle:
              item.receiptHandle,

            VisibilityTimeout: 0,
          }),
        );

        this.forgetReceipt(
          item.queueName,
          item.receiptHandle,
        );

        released++;
      } catch (error: unknown) {
        failed++;

        this.logger.error(
          JSON.stringify({
            event:
              'sqs_shutdown_visibility_release_failed',

            queueName: item.queueName,

            errorName:
              error instanceof Error
                ? error.name
                : 'UnknownError',
          }),
        );

        // Em caso de falha, o SQS
        // eventualmente expirara o
        // VisibilityTimeout original.
      }
    }

    this.logger.log(
      JSON.stringify({
        event: 'sqs_shutdown_completed',
        releasedMessages: released,
        releaseFailures: failed,
      }),
    );
  }

  // ====================================
  // SHUTDOWN: PHASE 2
  // ====================================

  async beforeApplicationShutdown(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.stopping = true;

    try {
      // Neste ponto, os hooks
      // onModuleDestroy dos workers
      // ja terminaram.
      await this.releaseOutstanding();
    } finally {
      this.client.destroy();
    }
  }
}
