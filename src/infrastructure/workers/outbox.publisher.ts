
import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';

import { MikroORM } from '@mikro-orm/postgresql';

import {
  SqsService,
} from '../messaging/sqs.service.js';

interface PendingOutboxRow {
  id: string;
  aggregateId: string;
  attempts: number;
  payload: Record<string, unknown>;
}

export interface OutboxPublishResult {
  scanned: number;
  published: number;
  failed: number;
}

@Injectable()
export class OutboxPublisher
  implements OnApplicationBootstrap, OnModuleDestroy {

  private readonly logger =
    new Logger(OutboxPublisher.name);

  private readonly pollIntervalMs = 2_000;
  private readonly batchSize = 10;

  private timer?: ReturnType<typeof setTimeout>;
  private activeCycle?: Promise<void>;
  private stopping = false;

  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SqsService,
  ) {}

  onApplicationBootstrap(): void {
    if (
      process.env.OUTBOX_PUBLISHER_ENABLED === 'false'
    ) {
      this.logger.log('Outbox publisher disabled');
      return;
    }

    this.logger.log('Outbox publisher started');
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

    this.logger.log('Outbox publisher stopped');
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

      if (
        result.published > 0 ||
        result.failed > 0
      ) {
        this.logger.log(
          JSON.stringify({
            event: 'outbox_publish_cycle',
            ...result,
          }),
        );
      }
    } catch (error: unknown) {
      this.logger.error(
        JSON.stringify({
          event: 'outbox_cycle_failed',
          errorName:
            error instanceof Error
              ? error.name
              : 'UnknownError',
        }),
      );
    }
  }

  private static retryDelayMs(
    attempts: number,
  ): number {
    return Math.min(
      5_000 * (2 ** Math.min(attempts, 10)),
      3_600_000,
    );
  }

  async runOnce(
    aggregateId?: string,
  ): Promise<OutboxPublishResult> {
    const em = this.orm.em.fork();

    return em.transactional(
      async (tx) => {
        // Seleciona somente o evento pendente
        // mais antigo de cada aggregateId.
        //
        // Isso evita que dois publishers publiquem
        // eventos posteriores da mesma carteira
        // enquanto o primeiro ainda esta pendente.
        const fetched = await tx.execute(
          `
          SELECT
            o.id::text AS "id",
            o.aggregate_id::text AS "aggregateId",
            o.attempts AS "attempts",
            o.payload AS "payload"
          FROM outbox_messages o
          WHERE o.published_at IS NULL
            AND (
              o.next_attempt_at IS NULL
              OR o.next_attempt_at <= NOW()
            )
            AND (
              ?::uuid IS NULL
              OR o.aggregate_id = ?::uuid
            )
            AND NOT EXISTS (
              SELECT 1
              FROM outbox_messages older
              WHERE older.aggregate_id = o.aggregate_id
                AND older.published_at IS NULL
                AND (
                  older.occurred_at,
                  older.id
                ) < (
                  o.occurred_at,
                  o.id
                )
            )
          ORDER BY o.occurred_at, o.id
          LIMIT ?
          FOR UPDATE OF o SKIP LOCKED
          `,
          [
            aggregateId ?? null,
            aggregateId ?? null,
            this.batchSize,
          ],
        );

        const rows = fetched as PendingOutboxRow[];

        const result: OutboxPublishResult = {
          scanned: rows.length,
          published: 0,
          failed: 0,
        };

        for (const row of rows) {
          try {
            // O evento ja foi confirmado
            // no PostgreSQL pelo caso de uso.
            await this.sqs.publishEvent({
              id: row.id,
              aggregateId: row.aggregateId,
              payload: row.payload,
            });

            await tx.execute(
              `
              UPDATE outbox_messages
              SET
                published_at = NOW(),
                next_attempt_at = NULL,
                attempts = attempts + 1
              WHERE id = ?::uuid
              `,
              [row.id],
            );

            result.published++;
          } catch (error: unknown) {
            const nextRetryAt = new Date(
              Date.now() +
              OutboxPublisher.retryDelayMs(
                row.attempts,
              ),
            );

            await tx.execute(
              `
              UPDATE outbox_messages
              SET
                attempts = attempts + 1,
                next_attempt_at = ?
              WHERE id = ?::uuid
              `,
              [nextRetryAt, row.id],
            );

            result.failed++;

            this.logger.warn(
              JSON.stringify({
                event: 'outbox_publish_retry',
                outboxId: row.id,
                aggregateId: row.aggregateId,
                attempt: row.attempts + 1,
                nextRetryAt:
                  nextRetryAt.toISOString(),
                errorName:
                  error instanceof Error
                    ? error.name
                    : 'UnknownError',
              }),
            );
          }
        }

        return result;
      },
      { clear: true },
    );
  }
}
