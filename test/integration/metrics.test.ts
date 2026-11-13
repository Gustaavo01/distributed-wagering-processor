
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';

import { randomUUID } from 'node:crypto';

import {
  type INestApplication,
  ValidationPipe,
} from '@nestjs/common';

import { NestFactory } from '@nestjs/core';

import {
  AppModule,
} from '../../src/app.module.js';

import {
  ApiExceptionFilter,
} from '../../src/presentation/http/api-exception.filter.js';

interface WalletResponse {
  id: string;
  playerId: string;
}

interface WagerResponse {
  transactionId: string;
  status: string;
  idempotentReplay: boolean;
}

let app: INestApplication;
let baseUrl: string;

const TEST_TOKEN =
  'integration-metrics-token';

const originalEnvironment = {
  token: process.env.METRICS_TOKEN,
  pending:
    process.env.PENDING_REFERENCE_WORKER_ENABLED,
  outbox:
    process.env.OUTBOX_PUBLISHER_ENABLED,
  consumer:
    process.env.WAGER_SQS_CONSUMER_ENABLED,
};

function restore(
  key: string,
  value: string | undefined,
): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

async function metricsRequest(
  authorized = true,
): Promise<Response> {
  return fetch(`${baseUrl}/metrics`, {
    headers: authorized
      ? {
          Authorization: `Bearer ${TEST_TOKEN}`,
        }
      : {},
  });
}

async function createWallet(): Promise<WalletResponse> {
  const playerId = randomUUID();

  const response = await fetch(
    `${baseUrl}/wallets`,
    {
      method: 'POST',

      headers: {
        'Content-Type': 'application/json',
      },

      body: JSON.stringify({
        playerId,
        initialBalance: {
          amount: '100.00',
          currency: 'BRL',
        },
      }),
    },
  );

  expect(response.status).toBe(201);

  return (
    await response.json()
  ) as WalletResponse;
}

beforeAll(async () => {
  process.env.METRICS_TOKEN = TEST_TOKEN;

  process.env.PENDING_REFERENCE_WORKER_ENABLED =
    'false';

  process.env.OUTBOX_PUBLISHER_ENABLED =
    'false';

  process.env.WAGER_SQS_CONSUMER_ENABLED =
    'false';

  app = await NestFactory.create(
    AppModule,
    {
      logger: false,
    },
  );

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
      transform: true,
    }),
  );

  app.useGlobalFilters(
    new ApiExceptionFilter(),
  );

  await app.listen(
    0,
    '127.0.0.1',
  );

  baseUrl = (
    await app.getUrl()
  ).replace(/\/$/, '');
});

afterAll(async () => {
  try {
    if (app) {
      await app.close();
    }
  } finally {
    restore(
      'METRICS_TOKEN',
      originalEnvironment.token,
    );

    restore(
      'PENDING_REFERENCE_WORKER_ENABLED',
      originalEnvironment.pending,
    );

    restore(
      'OUTBOX_PUBLISHER_ENABLED',
      originalEnvironment.outbox,
    );

    restore(
      'WAGER_SQS_CONSUMER_ENABLED',
      originalEnvironment.consumer,
    );
  }
});

describe('Financial observability', () => {
  test(
    'protects metrics endpoint and exposes real database and SQS gauges',
    async () => {
      const unauthorized =
        await metricsRequest(false);

      expect(unauthorized.status).toBe(401);

      const authorized =
        await metricsRequest(true);

      expect(authorized.status).toBe(200);

      expect(
        authorized.headers.get('content-type'),
      ).toContain('text/plain');

      const body = await authorized.text();

      expect(body).toContain(
        'wager_transactions_stored',
      );

      expect(body).toContain(
        'wager_outbox_pending_messages',
      );

      expect(body).toContain(
        'wager_outbox_retry_attempts_recorded',
      );

      expect(body).toContain(
        'wager_outbox_oldest_pending_age_seconds',
      );

      expect(body).toContain(
        'wager_sqs_dlq_messages',
      );

      expect(body).toContain(
        'wager_http_processing_duration_seconds_bucket',
      );

      expect(body).toContain(
        'wager_reconciliation_mismatches_total',
      );
    },
    30000,
  );

  test(
    'tracks processed HTTP operations, replay and reconciliation',
    async () => {
      const wallet = await createWallet();

      const externalTransactionId =
        randomUUID();

      const idempotencyKey =
        `metrics:${externalTransactionId}`;

      const body = {
        providerId: 'metrics-test-provider',
        externalTransactionId,
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId: 'metrics-round',
        gameId: 'metrics-game',
        kind: 'BET',
        money: {
          amount: '25.00',
          currency: 'BRL',
        },
      };

      async function wagerRequest(): Promise<Response> {
        return fetch(
          `${baseUrl}/wagering/transactions`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Idempotency-Key': idempotencyKey,
            },
            body: JSON.stringify(body),
          },
        );
      }

      const first = await wagerRequest();

      expect(first.status).toBe(200);

      const firstResult =
        (await first.json()) as WagerResponse;

      expect(firstResult.status).toBe(
        'PROCESSED',
      );

      expect(firstResult.idempotentReplay).toBe(
        false,
      );

      const replay = await wagerRequest();

      expect(replay.status).toBe(200);

      const replayResult =
        (await replay.json()) as WagerResponse;

      expect(replayResult.idempotentReplay).toBe(
        true,
      );

      expect(replayResult.transactionId).toBe(
        firstResult.transactionId,
      );

      const reconciliation = await fetch(
        `${baseUrl}/wallets/${wallet.id}/reconciliation`,
        {
          method: 'POST',
        },
      );

      expect(reconciliation.status).toBe(
        200,
      );

      const metricsResponse =
        await metricsRequest(true);

      expect(metricsResponse.status).toBe(
        200,
      );

      const metrics = await metricsResponse.text();

      // Uma BET nova + um replay HTTP.
      expect(metrics).toContain(
        'wager_http_requests_total{status="PROCESSED"} 2',
      );

      expect(metrics).toContain(
        'wager_http_idempotent_replays_total 1',
      );

      expect(metrics).toContain(
        'wager_reconciliation_checks_total 1',
      );

      expect(metrics).toContain(
        'wager_reconciliation_mismatches_total 0',
      );

      expect(metrics).toContain(
        'wager_http_processing_duration_seconds_count 2',
      );

      // Esta metrica consulta registros reais.
      expect(metrics).toMatch(
        /wager_transactions_stored\{kind="BET",status="PROCESSED"\} [1-9]\d*/,
      );

      // Verifica que as duas DLQs possuem
      // series separadas.
      expect(metrics).toContain(
        'wager_sqs_dlq_messages{queue="transactions",state="visible"}',
      );

      expect(metrics).toContain(
        'wager_sqs_dlq_messages{queue="events",state="visible"}',
      );
    },
    30000,
  );
});
