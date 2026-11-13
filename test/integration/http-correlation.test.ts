
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

const originalEnvironment = {
  pending:
    process.env.PENDING_REFERENCE_WORKER_ENABLED,
  outbox:
    process.env.OUTBOX_PUBLISHER_ENABLED,
  consumer:
    process.env.WAGER_SQS_CONSUMER_ENABLED,
};

function restore(
  name: string,
  value: string | undefined,
): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

beforeAll(async () => {
  process.env.PENDING_REFERENCE_WORKER_ENABLED =
    'false';

  process.env.OUTBOX_PUBLISHER_ENABLED =
    'false';

  process.env.WAGER_SQS_CONSUMER_ENABLED =
    'false';

  app = await NestFactory.create(
    AppModule,
    { logger: false },
  );

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: false,
      },
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

describe('HTTP correlation', () => {
  test(
    'preserves a valid correlation ID through wallet and wager requests',
    async () => {
      const correlationId =
        `test-${randomUUID()}`;

      const playerId = randomUUID();

      const walletResponse = await fetch(
        `${baseUrl}/wallets`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Correlation-Id': correlationId,
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

      expect(walletResponse.status).toBe(201);

      expect(
        walletResponse.headers.get(
          'x-correlation-id',
        ),
      ).toBe(correlationId);

      const wallet = (
        await walletResponse.json()
      ) as WalletResponse;

      const externalTransactionId =
        randomUUID();

      const wagerResponse = await fetch(
        `${baseUrl}/wagering/transactions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key':
              `correlation:${externalTransactionId}`,
            'X-Correlation-Id': correlationId,
          },
          body: JSON.stringify({
            providerId: 'correlation-test',
            externalTransactionId,
            playerId: wallet.playerId,
            walletId: wallet.id,
            roundId: 'correlation-round',
            gameId: 'correlation-game',
            kind: 'BET',
            money: {
              amount: '10.00',
              currency: 'BRL',
            },
          }),
        },
      );

      expect(wagerResponse.status).toBe(200);

      expect(
        wagerResponse.headers.get(
          'x-correlation-id',
        ),
      ).toBe(correlationId);

      const wager = (
        await wagerResponse.json()
      ) as WagerResponse;

      expect(wager.status).toBe('PROCESSED');
      expect(wager.transactionId).toBeDefined();
      expect(wager.idempotentReplay).toBe(false);
    },
    30000,
  );

  test(
    'generates a correlation ID when none is supplied',
    async () => {
      const response = await fetch(
        `${baseUrl}/health/live`,
      );

      expect(response.status).toBe(200);

      const correlationId =
        response.headers.get(
          'x-correlation-id',
        );

      expect(correlationId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i,
      );
    },
    30000,
  );

  test(
    'replaces unsafe correlation headers',
    async () => {
      const response = await fetch(
        `${baseUrl}/health/live`,
        {
          headers: {
            'X-Correlation-Id':
              'unsafe correlation with spaces',
          },
        },
      );

      expect(response.status).toBe(200);

      const correlationId =
        response.headers.get(
          'x-correlation-id',
        );

      expect(correlationId).toBeDefined();

      expect(correlationId).not.toBe(
        'unsafe correlation with spaces',
      );

      expect(correlationId).toMatch(
        /^[0-9a-f-]{36}$/i,
      );
    },
    30000,
  );
});
