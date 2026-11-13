
import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';

import type { Message } from '@aws-sdk/client-sqs';

import {
  ProcessWagerTransactionUseCase,
  IdempotencyConflictError,
  type ProcessWagerInput,
} from '../../application/use-cases/process-wager-transaction.use-case.js';

import {
  WagerTransactionKind,
  InvalidWagerTransactionError,
} from '../../domain/entities/wager-transaction.js';

import {
  InvalidMoneyError,
} from '../../domain/value-objects/money.js';

import {
  SqsService,
  SQS_QUEUES,
} from './sqs.service.js';

export const WAGER_CONSUMER_NAME =
  'wager-transactions-consumer';

export interface WagerSqsEnvelope {
  messageId: string;
  type: 'WagerTransactionRequested';
  occurredAt: string;
  data: ProcessWagerInput;
}

export interface WagerConsumerResult {
  received: number;
  acknowledged: number;
  retried: number;
  conflicts: number;
}

export class InvalidSqsEnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSqsEnvelopeError';
  }
}

function isObject(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  );
}

function requiredString(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > maxLength
  ) {
    throw new InvalidSqsEnvelopeError(
      `Invalid field: ${field}`,
    );
  }

  return value;
}

export function parseWagerSqsEnvelope(
  body: string,
): WagerSqsEnvelope {
  let parsed: unknown;

  try {
    parsed = JSON.parse(body);
  } catch {
    throw new InvalidSqsEnvelopeError(
      'Message body is not valid JSON',
    );
  }

  if (!isObject(parsed)) {
    throw new InvalidSqsEnvelopeError(
      'Message must be a JSON object',
    );
  }

  if (parsed.type !== 'WagerTransactionRequested') {
    throw new InvalidSqsEnvelopeError(
      'Unsupported message type',
    );
  }

  const messageId = requiredString(
    parsed.messageId,
    'messageId',
    200,
  );

  const occurredAt = requiredString(
    parsed.occurredAt,
    'occurredAt',
    100,
  );

  if (Number.isNaN(Date.parse(occurredAt))) {
    throw new InvalidSqsEnvelopeError(
      'Invalid occurredAt',
    );
  }

  if (!isObject(parsed.data)) {
    throw new InvalidSqsEnvelopeError(
      'Missing message data',
    );
  }

  const data = parsed.data;

  if (!isObject(data.money)) {
    throw new InvalidSqsEnvelopeError(
      'Invalid money object',
    );
  }

  const kind = data.kind;

  if (
    typeof kind !== 'string' ||
    !Object.values(WagerTransactionKind).includes(
      kind as WagerTransactionKind,
    ) ||
    kind === WagerTransactionKind.Opening
  ) {
    throw new InvalidSqsEnvelopeError(
      'Invalid transaction kind',
    );
  }

  const referenceExternalTransactionId =
    data.referenceExternalTransactionId === undefined ||
    data.referenceExternalTransactionId === null
      ? undefined
      : requiredString(
          data.referenceExternalTransactionId,
          'referenceExternalTransactionId',
          160,
        );

  const input: ProcessWagerInput = {
    providerId: requiredString(
      data.providerId,
      'providerId',
      100,
    ),
    externalTransactionId: requiredString(
      data.externalTransactionId,
      'externalTransactionId',
      160,
    ),
    idempotencyKey: requiredString(
      data.idempotencyKey,
      'idempotencyKey',
      256,
    ),
    walletId: requiredString(
      data.walletId,
      'walletId',
      36,
    ),
    playerId: requiredString(
      data.playerId,
      'playerId',
      36,
    ),
    roundId: requiredString(
      data.roundId,
      'roundId',
      160,
    ),
    gameId: requiredString(
      data.gameId,
      'gameId',
      160,
    ),
    kind: kind as WagerTransactionKind,
    money: {
      amount: requiredString(
        data.money.amount,
        'money.amount',
        30,
      ),
      currency: requiredString(
        data.money.currency,
        'money.currency',
        3,
      ),
    },
    referenceExternalTransactionId,
  };

  return {
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt,
    data: input,
  };
}

@Injectable()
export class WagerSqsConsumer
  implements OnApplicationBootstrap, OnModuleDestroy {

  private readonly logger =
    new Logger(WagerSqsConsumer.name);

  private readonly pollIntervalMs = 1_000;

  private timer?: ReturnType<typeof setTimeout>;
  private activeCycle?: Promise<void>;
  private stopping = false;

  constructor(
    private readonly sqs: SqsService,
    private readonly processor:
      ProcessWagerTransactionUseCase,
  ) {}

  onApplicationBootstrap(): void {
    if (
      process.env.WAGER_SQS_CONSUMER_ENABLED === 'false'
    ) {
      this.logger.log('Wager SQS consumer disabled');
      return;
    }

    this.logger.log('Wager SQS consumer started');
    this.schedule(0);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    if (this.activeCycle) {
      await this.activeCycle;
    }

    this.logger.log('Wager SQS consumer stopped');
  }

  private schedule(delayMs: number): void {
    if (this.stopping) {
      return;
    }

    this.timer = setTimeout(() => {
      this.timer = undefined;

      const cycle = this.executeCycle();
      this.activeCycle = cycle;

      void cycle.finally(() => {
        if (this.activeCycle === cycle) {
          this.activeCycle = undefined;
        }

        if (!this.stopping) {
          this.schedule(this.pollIntervalMs);
        }
      });
    }, delayMs);
  }

  private async executeCycle(): Promise<void> {
    try {
      const result = await this.runOnce();

      if (result.received > 0) {
        this.logger.log(
          JSON.stringify({
            event: 'wager_sqs_cycle',
            ...result,
          }),
        );
      }
    } catch (error: unknown) {
      this.logger.error(
        JSON.stringify({
          event: 'wager_sqs_cycle_failed',
          errorName:
            error instanceof Error
              ? error.name
              : 'UnknownError',
        }),
      );
    }
  }

  private static retryDelaySeconds(
    receiveCount: number,
  ): number {
    return Math.min(
      5 * (2 ** Math.min(
        Math.max(receiveCount - 1, 0),
        5,
      )),
      60,
    );
  }

  async runOnce(): Promise<WagerConsumerResult> {
    const result: WagerConsumerResult = {
      received: 0,
      acknowledged: 0,
      retried: 0,
      conflicts: 0,
    };

    const messages = await this.sqs.receiveMessages(
      SQS_QUEUES.transactions,
      5,
      2,
    );

    result.received = messages.length;

    for (const message of messages) {
      if (this.stopping) {
        break;
      }

      const outcome = await this.processMessage(message);

      if (outcome === 'acknowledged') {
        result.acknowledged++;
      } else if (outcome === 'conflict') {
        result.conflicts++;
        result.acknowledged++;
      } else {
        result.retried++;
      }
    }

    return result;
  }

  private async processMessage(
    message: Message,
  ): Promise<'acknowledged' | 'conflict' | 'retry'> {
    const receiptHandle = message.ReceiptHandle;

    if (!receiptHandle) {
      throw new Error(
        'SQS message missing receipt handle',
      );
    }

    let applicationMessageId: string | undefined;

    try {
      const envelope = parseWagerSqsEnvelope(
        message.Body ?? '',
      );

      applicationMessageId = envelope.messageId;

      // A Inbox e persistida pelo use case
      // na mesma transacao da movimentacao financeira.
      const output = await this.processor.execute(
        envelope.data,
        {
          consumerName: WAGER_CONSUMER_NAME,
          messageId: envelope.messageId,
        },
      );

      // O execute() so retorna depois do commit.
      // Nunca fazemos ACK antes dessa confirmacao.
      await this.sqs.acknowledge(
        SQS_QUEUES.transactions,
        receiptHandle,
      );

      this.logger.log(
        JSON.stringify({
          event: 'wager_message_acknowledged',
          messageId: envelope.messageId,
          transactionId: output.transactionId,
          walletId: envelope.data.walletId,
          providerId: envelope.data.providerId,
          status: output.status,
          idempotentReplay: output.idempotentReplay,
        }),
      );

      return 'acknowledged';
    } catch (error: unknown) {
      // Conflito de idempotencia e terminal:
      // nao repetimos uma operacao conflitante.
      if (error instanceof IdempotencyConflictError) {
        await this.sqs.acknowledge(
          SQS_QUEUES.transactions,
          receiptHandle,
        );

        this.logger.warn(
          JSON.stringify({
            event: 'wager_idempotency_conflict',
            messageId: applicationMessageId,
            sqsMessageId: message.MessageId,
          }),
        );

        return 'conflict';
      }

      // Erros de validacao de dominio representam
      // mensagens que nao serao corrigidas por retry.
      if (
        error instanceof InvalidMoneyError ||
        error instanceof InvalidWagerTransactionError
      ) {
        await this.sqs.acknowledge(
          SQS_QUEUES.transactions,
          receiptHandle,
        );

        this.logger.warn(
          JSON.stringify({
            event: 'wager_validation_rejected',
            messageId: applicationMessageId,
            errorName: error.name,
          }),
        );

        return 'acknowledged';
      }

      // Erros restantes nao sao reconhecidos.
      // O SQS tentara novamente. A RedrivePolicy
      // move a mensagem para a DLQ ao atingir
      // o limite de entregas.
      const receivedCount = Number(
        message.Attributes?.ApproximateReceiveCount ?? '1',
      );

      const retryDelay =
        error instanceof InvalidSqsEnvelopeError
          ? 5
          : WagerSqsConsumer.retryDelaySeconds(
              Number.isFinite(receivedCount)
                ? receivedCount
                : 1,
            );

      this.logger.error(
        JSON.stringify({
          event: 'wager_message_retry',
          messageId: applicationMessageId,
          sqsMessageId: message.MessageId,
          receiveCount: receivedCount,
          retryDelaySeconds: retryDelay,
          errorName:
            error instanceof Error
              ? error.name
              : 'UnknownError',
        }),
      );

      try {
        await this.sqs.changeVisibility(
          SQS_QUEUES.transactions,
          receiptHandle,
          retryDelay,
        );
      } catch (visibilityError: unknown) {
        this.logger.error(
          JSON.stringify({
            event: 'wager_visibility_update_failed',
            sqsMessageId: message.MessageId,
            errorName:
              visibilityError instanceof Error
                ? visibilityError.name
                : 'UnknownError',
          }),
        );
      }

      return 'retry';
    }
  }
}
