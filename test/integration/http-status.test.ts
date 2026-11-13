
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

// =====================================
// HTTP RESPONSE TYPES
// =====================================

interface MoneyResponse {
  amount: string;
  currency: string;
}

interface WalletResponse {
  id: string;
  playerId: string;
  balance: MoneyResponse;
}

interface WagerResponse {
  transactionId: string;
  status: string;
  balance: MoneyResponse;
  failureCode?: string | null;
  idempotentReplay: boolean;
}

// =====================================
// TEST APPLICATION
// =====================================

let app: INestApplication;
let baseUrl: string;

const originalSettings = {
  pending:
    process.env.PENDING_REFERENCE_WORKER_ENABLED,

  outbox:
    process.env.OUTBOX_PUBLISHER_ENABLED,

  consumer:
    process.env.WAGER_SQS_CONSUMER_ENABLED,
};

function restoreSetting(
  name: string,
  value: string | undefined,
): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function readJson<T>(
  response: Response,
): Promise<T> {
  return (await response.json()) as T;
}

async function postJson(
  path: string,
  body: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (idempotencyKey) {
    headers['Idempotency-Key'] =
      idempotencyKey;
  }

  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

async function createWallet(): Promise<WalletResponse> {
  const playerId = randomUUID();

  const response = await postJson(
    '/wallets',
    {
      playerId,
      initialBalance: {
        amount: '100.00',
        currency: 'BRL',
      },
    },
  );

  expect(response.status).toBe(201);

  return readJson<WalletResponse>(
    response,
  );
}

function makeTransaction(
  wallet: WalletResponse,
  kind: 'BET' | 'REFUND',
  amount: string,
) {
  const externalTransactionId = randomUUID();

  return {
    providerId: 'http-status-provider',
    externalTransactionId,
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: 'http-status-round',
    gameId: 'http-status-game',
    kind,
    money: {
      amount,
      currency: 'BRL',
    },
  };
}

// =====================================
// APPLICATION SETUP
// =====================================

beforeAll(async () => {
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
    restoreSetting(
      'PENDING_REFERENCE_WORKER_ENABLED',
      originalSettings.pending,
    );

    restoreSetting(
      'OUTBOX_PUBLISHER_ENABLED',
      originalSettings.outbox,
    );

    restoreSetting(
      'WAGER_SQS_CONSUMER_ENABLED',
      originalSettings.consumer,
    );
  }
});

// =====================================
// TESTS
// =====================================

describe('HTTP financial status mapping', () => {
  test(
    'returns 200 for a processed BET',
    async () => {
      const wallet = await createWallet();

      const body = makeTransaction(
        wallet,
        'BET',
        '25.00',
      );

      const response = await postJson(
        '/wagering/transactions',
        body,
        randomUUID(),
      );

      expect(response.status).toBe(200);

      const result =
        await readJson<WagerResponse>(
          response,
        );

      expect(result.status).toBe(
        'PROCESSED',
      );

      expect(result.balance.amount).toBe(
        '75.00',
      );

      expect(result.idempotentReplay).toBe(
        false,
      );
    },
    30000,
  );

  test(
    'returns 422 for a rejected BET without balance',
    async () => {
      const wallet = await createWallet();

      const body = makeTransaction(
        wallet,
        'BET',
        '150.00',
      );

      const response = await postJson(
        '/wagering/transactions',
        body,
        randomUUID(),
      );

      expect(response.status).toBe(422);

      const result =
        await readJson<WagerResponse>(
          response,
        );

      expect(result.status).toBe(
        'REJECTED',
      );

      expect(
        typeof result.failureCode,
      ).toBe('string');

      expect(
        result.failureCode?.length,
      ).toBeGreaterThan(0);

      const storedResponse = await fetch(
        `${baseUrl}/wallets/${wallet.id}`,
      );

      expect(storedResponse.status).toBe(
        200,
      );

      const stored =
        await readJson<WalletResponse>(
          storedResponse,
        );

      expect(stored.balance.amount).toBe(
        '100.00',
      );
    },
    30000,
  );

  test(
    'returns 202 for a REFUND awaiting reference',
    async () => {
      const wallet = await createWallet();

      const body = {
        ...makeTransaction(
          wallet,
          'REFUND',
          '25.00',
        ),

        // Referencia ainda inexistente.
        referenceExternalTransactionId:
          randomUUID(),
      };

      const response = await postJson(
        '/wagering/transactions',
        body,
        randomUUID(),
      );

      expect(response.status).toBe(202);

      const result =
        await readJson<WagerResponse>(
          response,
        );

      expect(result.status).toBe(
        'PENDING_REFERENCE',
      );

      expect(
        result.transactionId,
      ).toBeDefined();

      const storedResponse = await fetch(
        `${baseUrl}/wallets/${wallet.id}`,
      );

      const stored =
        await readJson<WalletResponse>(
          storedResponse,
        );

      // Uma transacao pendente nao altera
      // imediatamente o saldo.
      expect(stored.balance.amount).toBe(
        '100.00',
      );
    },
    30000,
  );
});
