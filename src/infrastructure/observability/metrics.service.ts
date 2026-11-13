
import {
  Injectable,
  OnModuleDestroy,
} from '@nestjs/common';

import { MikroORM } from '@mikro-orm/postgresql';

import {
  GetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';

import {
  createSqsClient,
  SQS_QUEUES,
  SqsService,
} from '../messaging/sqs.service.js';

interface TransactionCountRow {
  kind: string;
  status: string;
  total: string;
}

interface OutboxMetricsRow {
  pending: string;
  retries: string;
  oldestPendingSeconds: number;
  averagePublishSeconds: number;
}

interface ProcessingMetricsRow {
  averageSeconds: number;
  samples: string;
}

interface InboxMetricsRow {
  processed: string;
}

interface MetricSample {
  value: number;
  labels?: Record<string, string>;
}

const LATENCY_BUCKETS = [
  0.01,
  0.05,
  0.1,
  0.25,
  0.5,
  1,
  2,
  5,
  10,
  30,
];

function numeric(value: unknown): number {
  const result = Number(value ?? 0);

  if (!Number.isFinite(result)) {
    throw new Error('Invalid numeric metric');
  }

  return result;
}

function escapeLabel(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/"/g, '\\"');
}

function sampleLine(
  name: string,
  sample: MetricSample,
): string {
  const labels = Object.entries(
    sample.labels ?? {},
  );

  const suffix = labels.length === 0
    ? ''
    : `{${labels
        .map(
          ([key, value]) =>
            `${key}="${escapeLabel(value)}"`,
        )
        .join(',')}}`;

  return `${name}${suffix} ${sample.value}`;
}

function writeMetric(
  output: string[],
  name: string,
  help: string,
  type: 'gauge' | 'counter',
  samples: MetricSample[],
): void {
  output.push(`# HELP ${name} ${help}`);
  output.push(`# TYPE ${name} ${type}`);

  for (const sample of samples) {
    output.push(sampleLine(name, sample));
  }

  output.push('');
}

@Injectable()
export class MetricsService
  implements OnModuleDestroy {

  private readonly sqsClient =
    createSqsClient();

  // Estas contagens sao locais da instancia.
  // Nao fazem parte da idempotencia financeira.
  private readonly httpByStatus =
    new Map<string, number>();

  private httpReplays = 0;
  private httpLockConflicts = 0;
  private reconciliationChecks = 0;
  private reconciliationMismatches = 0;

  private durationCount = 0;
  private durationSum = 0;

  private readonly durationBuckets =
    LATENCY_BUCKETS.map(() => 0);

  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SqsService,
  ) {}

  recordHttpWager(
    status: string,
    idempotentReplay: boolean,
  ): void {
    this.httpByStatus.set(
      status,
      (this.httpByStatus.get(status) ?? 0) + 1,
    );

    if (idempotentReplay) {
      this.httpReplays++;
    }
  }

  recordLockConflict(): void {
    this.httpLockConflicts++;
  }

  recordReconciliation(
    consistent: boolean,
  ): void {
    this.reconciliationChecks++;

    if (!consistent) {
      this.reconciliationMismatches++;
    }
  }

  observeHttpDuration(
    seconds: number,
  ): void {
    if (
      !Number.isFinite(seconds) ||
      seconds < 0
    ) {
      return;
    }

    this.durationCount++;
    this.durationSum += seconds;

    for (
      let index = 0;
      index < LATENCY_BUCKETS.length;
      index++
    ) {
      if (seconds <= LATENCY_BUCKETS[index]!) {
        this.durationBuckets[index]!++;
      }
    }
  }

  private async getDlqDepth(
    queueName: string,
  ): Promise<{
    visible: number;
    inFlight: number;
  }> {
    const queueUrl = await this.sqs.getQueueUrl(
      queueName,
    );

    const response = await this.sqsClient.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: [
          'ApproximateNumberOfMessages',
          'ApproximateNumberOfMessagesNotVisible',
        ],
      }),
    );

    return {
      visible: numeric(
        response.Attributes
          ?.ApproximateNumberOfMessages,
      ),

      inFlight: numeric(
        response.Attributes
          ?.ApproximateNumberOfMessagesNotVisible,
      ),
    };
  }

  async renderPrometheus(): Promise<string> {
    const [
      transactions,
      outboxRows,
      processingRows,
      inboxRows,
      transactionsDlq,
      eventsDlq,
    ] = await Promise.all([
      this.orm.em.fork().execute<
        TransactionCountRow[]
      >(
        `
        SELECT
          kind AS "kind",
          status AS "status",
          COUNT(*)::text AS "total"
        FROM wager_transactions
        GROUP BY kind, status
        ORDER BY kind, status
        `,
      ),

      this.orm.em.fork().execute<
        OutboxMetricsRow[]
      >(
        `
        SELECT
          (
            COUNT(*)
            FILTER (WHERE published_at IS NULL)
          )::text AS "pending",

          COALESCE(
            SUM(GREATEST(attempts - 1, 0)),
            0
          )::text AS "retries",

          COALESCE(
            MAX(
              GREATEST(
                EXTRACT(
                  EPOCH FROM (
                    NOW() - occurred_at
                  )
                ),
                0
              )
            ) FILTER (
              WHERE published_at IS NULL
            ),
            0
          )::float8 AS "oldestPendingSeconds",

          COALESCE(
            AVG(
              GREATEST(
                EXTRACT(
                  EPOCH FROM (
                    published_at - occurred_at
                  )
                ),
                0
              )
            ) FILTER (
              WHERE published_at IS NOT NULL
            ),
            0
          )::float8 AS "averagePublishSeconds"

        FROM outbox_messages
        `,
      ),

      this.orm.em.fork().execute<
        ProcessingMetricsRow[]
      >(
        `
        SELECT
          COALESCE(
            AVG(
              GREATEST(
                EXTRACT(
                  EPOCH FROM (
                    processed_at - created_at
                  )
                ),
                0
              )
            ),
            0
          )::float8 AS "averageSeconds",

          COUNT(*)::text AS "samples"

        FROM wager_transactions
        WHERE processed_at IS NOT NULL
        `,
      ),

      this.orm.em.fork().execute<
        InboxMetricsRow[]
      >(
        `
        SELECT
          COUNT(*)::text AS "processed"
        FROM inbox_messages
        WHERE processed_at IS NOT NULL
        `,
      ),

      this.getDlqDepth(
        SQS_QUEUES.transactionsDlq,
      ),

      this.getDlqDepth(
        SQS_QUEUES.eventsDlq,
      ),
    ]);

    const outbox = outboxRows[0];
    const processing = processingRows[0];
    const inbox = inboxRows[0];

    if (!outbox || !processing || !inbox) {
      throw new Error(
        'Metrics query returned no aggregate row',
      );
    }

    const lines: string[] = [];

    // ==================================
    // PERSISTED TRANSACTION COUNTS
    // ==================================

    writeMetric(
      lines,
      'wager_transactions_stored',
      'Transacoes persistidas por tipo e status.',
      'gauge',
      transactions.map((row) => ({
        labels: {
          kind: row.kind,
          status: row.status,
        },
        value: numeric(row.total),
      })),
    );

    // ==================================
    // HTTP INSTRUMENTATION
    // ==================================

    writeMetric(
      lines,
      'wager_http_requests_total',
      'Operacoes HTTP com resultado financeiro.',
      'counter',
      [...this.httpByStatus.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([status, count]) => ({
          labels: { status },
          value: count,
        })),
    );

    writeMetric(
      lines,
      'wager_http_idempotent_replays_total',
      'Replays idempotentes observados nesta instancia HTTP.',
      'counter',
      [{ value: this.httpReplays }],
    );

    writeMetric(
      lines,
      'wager_http_lock_conflicts_total',
      'Conflitos SQL de lock ou serializacao observados nas requisicoes HTTP.',
      'counter',
      [{ value: this.httpLockConflicts }],
    );

    // ==================================
    // DURATIONS
    // ==================================

    lines.push(
      '# HELP wager_http_processing_duration_seconds Latencia de requisicoes HTTP de apostas.',
      '# TYPE wager_http_processing_duration_seconds histogram',
    );

    for (
      let index = 0;
      index < LATENCY_BUCKETS.length;
      index++
    ) {
      lines.push(
        sampleLine(
          'wager_http_processing_duration_seconds_bucket',
          {
            labels: {
              le: String(LATENCY_BUCKETS[index]),
            },
            value: this.durationBuckets[index]!,
          },
        ),
      );
    }

    lines.push(
      sampleLine(
        'wager_http_processing_duration_seconds_bucket',
        {
          labels: { le: '+Inf' },
          value: this.durationCount,
        },
      ),
    );

    lines.push(
      `wager_http_processing_duration_seconds_sum ${this.durationSum}`,
    );

    lines.push(
      `wager_http_processing_duration_seconds_count ${this.durationCount}`,
    );

    lines.push('');

    writeMetric(
      lines,
      'wager_db_processing_duration_seconds',
      'Media do intervalo persisted created_at ate processed_at.',
      'gauge',
      [{
        value: numeric(
          processing.averageSeconds,
        ),
      }],
    );

    writeMetric(
      lines,
      'wager_db_processing_samples',
      'Transacoes com processed_at disponivel.',
      'gauge',
      [{
        value: numeric(
          processing.samples,
        ),
      }],
    );

    // ==================================
    // INBOX
    // ==================================

    writeMetric(
      lines,
      'wager_inbox_processed_records',
      'Registros processados na Inbox persistente.',
      'gauge',
      [{
        value: numeric(
          inbox.processed,
        ),
      }],
    );

    // ==================================
    // OUTBOX
    // ==================================

    writeMetric(
      lines,
      'wager_outbox_pending_messages',
      'Eventos ainda nao publicados.',
      'gauge',
      [{
        value: numeric(
          outbox.pending,
        ),
      }],
    );

    writeMetric(
      lines,
      'wager_outbox_retry_attempts_recorded',
      'Tentativas adicionais registradas na Outbox.',
      'gauge',
      [{
        value: numeric(
          outbox.retries,
        ),
      }],
    );

    writeMetric(
      lines,
      'wager_outbox_oldest_pending_age_seconds',
      'Idade do evento pendente mais antigo.',
      'gauge',
      [{
        value: numeric(
          outbox.oldestPendingSeconds,
        ),
      }],
    );

    writeMetric(
      lines,
      'wager_outbox_average_publish_lag_seconds',
      'Tempo medio entre criacao e publicacao dos eventos confirmados.',
      'gauge',
      [{
        value: numeric(
          outbox.averagePublishSeconds,
        ),
      }],
    );

    // ==================================
    // SQS DEAD LETTER QUEUES
    // ==================================

    writeMetric(
      lines,
      'wager_sqs_dlq_messages',
      'Contagem aproximada de mensagens nas DLQs.',
      'gauge',
      [
        {
          labels: {
            queue: 'transactions',
            state: 'visible',
          },
          value: transactionsDlq.visible,
        },
        {
          labels: {
            queue: 'transactions',
            state: 'in_flight',
          },
          value: transactionsDlq.inFlight,
        },
        {
          labels: {
            queue: 'events',
            state: 'visible',
          },
          value: eventsDlq.visible,
        },
        {
          labels: {
            queue: 'events',
            state: 'in_flight',
          },
          value: eventsDlq.inFlight,
        },
      ],
    );

    // ==================================
    // RECONCILIATION
    // ==================================

    writeMetric(
      lines,
      'wager_reconciliation_checks_total',
      'Reconciliacoes HTTP realizadas nesta instancia.',
      'counter',
      [{
        value: this.reconciliationChecks,
      }],
    );

    writeMetric(
      lines,
      'wager_reconciliation_mismatches_total',
      'Divergencias identificadas nas reconciliacoes HTTP.',
      'counter',
      [{
        value: this.reconciliationMismatches,
      }],
    );

    return `${lines.join('\n')}\n`;
  }

  onModuleDestroy(): void {
    this.sqsClient.destroy();
  }
}
