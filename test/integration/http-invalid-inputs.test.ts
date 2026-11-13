
import { randomUUID } from 'node:crypto';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';

import {
  type INestApplication,
  ValidationPipe,
} from '@nestjs/common';

import { NestFactory } from '@nestjs/core';

import { AppModule } from '../../src/app.module.js';

import {
  ApiExceptionFilter,
} from '../../src/presentation/http/api-exception.filter.js';

interface MoneyResponse {
  amount: string;
  currency: string;
}

interface WalletResponse {
  id: string;
  playerId: string;
  balance: MoneyResponse;
}

interface ApiError {
  statusCode: number;
  message: string | string[];
}

let app: INestApplication;
let baseUrl: string;

const previous = {
  pending: process.env.PENDING_REFERENCE_WORKER_ENABLED,
  outbox: process.env.OUTBOX_PUBLISHER_ENABLED,
  consumer: process.env.WAGER_SQS_CONSUMER_ENABLED,
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
  process.env.PENDING_REFERENCE_WORKER_ENABLED = 'false';
  process.env.OUTBOX_PUBLISHER_ENABLED = 'false';
  process.env.WAGER_SQS_CONSUMER_ENABLED = 'false';

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

  app.useGlobalFilters(new ApiExceptionFilter());

  await app.listen(0, '127.0.0.1');

  baseUrl = (await app.getUrl()).replace(/\/$/, '');
});

afterAll(async () => {
  try {
    if (app) {
      await app.close();
    }
  } finally {
    restore(
      'PENDING_REFERENCE_WORKER_ENABLED',
      previous.pending,
    );
    restore(
      'OUTBOX_PUBLISHER_ENABLED',
      previous.outbox,
    );
    restore(
      'WAGER_SQS_CONSUMER_ENABLED',
      previous.consumer,
    );
  }
});

async function post(
  path: string,
  body: unknown,
  key?: string,
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function createWallet(): Promise<WalletResponse> {
  const response = await post('/wallets', {
    playerId: randomUUID(),
    initialBalance: {
      amount: '100.00',
      currency: 'BRL',
    },
  });

  expect(response.status).toBe(201);

  return (await response.json()) as WalletResponse;
}

function wagerBody(
  wallet: WalletResponse,
): Record<string, unknown> {
  return {
    providerId: 'validation-test',
    externalTransactionId: randomUUID(),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'validation-round',
    gameId: 'validation-game',
    kind: 'BET',
    money: {
      amount: '10.00',
      currency: 'BRL',
    },
  };
}

async function expectError(
  response: Response,
  status: number,
  text?: string,
): Promise<void> {
  expect(response.status).toBe(status);

  const error = (await response.json()) as ApiError;

  expect(error.statusCode).toBe(status);

  if (text) {
    expect(
      JSON.stringify(error.message),
    ).toContain(text);
  }
}

async function expectUnchanged(
  wallet: WalletResponse,
): Promise<void> {
  const response = await fetch(
    `${baseUrl}/wallets/${wallet.id}`,
  );

  expect(response.status).toBe(200);

  const stored = (
    await response.json()
  ) as WalletResponse;

  expect(stored.balance.amount).toBe('100.00');
  expect(stored.balance.currency).toBe('BRL');
}

describe('HTTP business validation', () => {
  test(
    'returns 422 for zero-value BET without changing balance',
    async () => {
      const wallet = await createWallet();
      const body = wagerBody(wallet);

      body.money = {
        amount: '0.00',
        currency: 'BRL',
      };

      await expectError(
        await post(
          '/wagering/transactions',
          body,
          randomUUID(),
        ),
        422,
        'Transaction amount must be positive',
      );

      await expectUnchanged(wallet);
    },
  );

  test(
    'returns 422 when wallet belongs to another player',
    async () => {
      const wallet = await createWallet();
      const body = wagerBody(wallet);

      body.playerId = randomUUID();

      await expectError(
        await post(
          '/wagering/transactions',
          body,
          randomUUID(),
        ),
        422,
        'Wallet does not belong to player',
      );

      await expectUnchanged(wallet);
    },
  );

  test(
    'returns 422 for wallet currency mismatch',
    async () => {
      const wallet = await createWallet();
      const body = wagerBody(wallet);

      body.money = {
        amount: '10.00',
        currency: 'USD',
      };

      await expectError(
        await post(
          '/wagering/transactions',
          body,
          randomUUID(),
        ),
        422,
        'Wallet currency mismatch',
      );

      await expectUnchanged(wallet);
    },
  );

  test(
    'returns 422 for REFUND without reference',
    async () => {
      const wallet = await createWallet();
      const body = wagerBody(wallet);

      body.kind = 'REFUND';

      await expectError(
        await post(
          '/wagering/transactions',
          body,
          randomUUID(),
        ),
        422,
        'Reference transaction is required',
      );

      await expectUnchanged(wallet);
    },
  );

  test(
    'returns 400 for invalid wallet UUID',
    async () => {
      const wallet = await createWallet();
      const body = wagerBody(wallet);

      body.walletId = 'invalid-wallet-id';

      await expectError(
        await post(
          '/wagering/transactions',
          body,
          randomUUID(),
        ),
        400,
      );

      await expectUnchanged(wallet);
    },
  );

  test(
    'returns 400 for negative opening balance',
    async () => {
      const response = await post('/wallets', {
        playerId: randomUUID(),
        initialBalance: {
          amount: '-1.00',
          currency: 'BRL',
        },
      });

      await expectError(response, 400);
    },
  );
});
