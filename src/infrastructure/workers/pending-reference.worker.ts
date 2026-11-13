
import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';

import { MikroORM } from '@mikro-orm/postgresql';

import {
  WagerTransactionStatus,
} from '../../domain/entities/wager-transaction.js';

import {
  ProcessWagerTransactionUseCase,
} from '../../application/use-cases/process-wager-transaction.use-case.js';

import {
  WagerTransactionEntity,
} from '../persistence/wager-transaction.entity.js';

export interface PendingReferenceWorkerResult {
  scanned: number;
  processed: number;
  rejected: number;
  pending: number;
  failed: number;
}

@Injectable()
export class PendingReferenceWorker
  implements OnApplicationBootstrap, OnModuleDestroy {

  private readonly logger =
    new Logger(PendingReferenceWorker.name);

  private readonly pollIntervalMs = 5_000;
  private readonly batchSize = 25;
  private readonly concurrency = 4;

  private timer?: ReturnType<typeof setTimeout>;
  private activeCycle?: Promise<void>;
  private stopping = false;

  constructor(
    private readonly orm: MikroORM,
    private readonly processor: ProcessWagerTransactionUseCase,
  ) {}

  // =======================================
  // START
  // =======================================

  onApplicationBootstrap(): void {
    if (
      process.env.PENDING_REFERENCE_WORKER_ENABLED ===
      'false'
    ) {
      this.logger.log(
        'Pending reference worker disabled',
      );
      return;
    }

    this.logger.log(
      'Pending reference worker started',
    );

    this.schedule(0);
  }

  // =======================================
  // SHUTDOWN
  // =======================================

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    if (this.activeCycle) {
      await this.activeCycle;
    }

    this.logger.log(
      'Pending reference worker stopped',
    );
  }

  // =======================================
  // SCHEDULING
  // =======================================

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

  // =======================================
  // EXECUTE CYCLE
  // =======================================

  private async executeCycle(): Promise<void> {
    try {
      const result = await this.runOnce();

      if (
        result.scanned > 0 ||
        result.failed > 0
      ) {
        this.logger.log(
          JSON.stringify({
            event: 'pending_reference_cycle',
            ...result,
          }),
        );
      }
    } catch (error: unknown) {
      this.logger.error(
        JSON.stringify({
          event: 'pending_reference_cycle_failed',
          error:
            error instanceof Error
              ? error.name
              : 'UnknownError',
        }),
      );
    }
  }

  // =======================================
  // PROCESS ONE BATCH
  // =======================================

  async runOnce(): Promise<PendingReferenceWorkerResult> {
    const result: PendingReferenceWorkerResult = {
      scanned: 0,
      processed: 0,
      rejected: 0,
      pending: 0,
      failed: 0,
    };

    const now = new Date();
    const em = this.orm.em.fork();

    // Seleciona operacoes vencidas para retry
    // ou cujo TTL ja expirou.
    const candidates = await em.find(
      WagerTransactionEntity,
      {
        status:
          WagerTransactionStatus.PendingReference,
        $or: [
          {
            referenceNextRetryAt: {
              $lte: now,
            },
          },
          {
            referenceNextRetryAt: null,
          },
          {
            referenceExpiresAt: {
              $lte: now,
            },
          },
        ],
      },
      {
        orderBy: {
          referenceNextRetryAt: 'asc',
          createdAt: 'asc',
          id: 'asc',
        },
        limit: this.batchSize,
      },
    );

    result.scanned = candidates.length;

    // Limita o numero de operacoes simultaneas.
    for (
      let index = 0;
      index < candidates.length;
      index += this.concurrency
    ) {
      const batch = candidates.slice(
        index,
        index + this.concurrency,
      );

      await Promise.all(
        batch.map(async (candidate) => {
          try {
            const output =
              await this.processor.retryPendingReference(
                candidate.id,
              );

            if (!output) {
              return;
            }

            switch (output.status) {
              case WagerTransactionStatus.Processed:
                result.processed++;
                break;

              case WagerTransactionStatus.Rejected:
                result.rejected++;
                break;

              case WagerTransactionStatus.PendingReference:
                result.pending++;
                break;

              default:
                result.failed++;
                break;
            }
          } catch (error: unknown) {
            result.failed++;

            this.logger.error(
              JSON.stringify({
                event:
                  'pending_reference_retry_failed',
                transactionId: candidate.id,
                walletId: candidate.walletId,
                providerId: candidate.providerId,
                error:
                  error instanceof Error
                    ? error.name
                    : 'UnknownError',
              }),
            );
          }
        }),
      );
    }

    return result;
  }
}
