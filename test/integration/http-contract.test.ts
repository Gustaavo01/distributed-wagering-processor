
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

// ======================================
// RESPONSE CONTRACTS
// ======================================

interface MoneyResponse {
  amount: string;
  currency: string;
}

interface WalletResponse {
  id: string;
  playerId: string;
  balance: MoneyResponse;
  version: number;
}

interface ReconciliationResponse {
  walletId: string;
  storedBalance: MoneyResponse;
  calculatedBalance: MoneyResponse;
  difference: MoneyResponse;
  consistent: boolean;
  checkedEntries: number;
}

interface WagerResponse {
  transactionId: string;
  status: string;
  balance: MoneyResponse;
  idempotentReplay: boolean;
}

interface TransactionResponse {
  id: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  kind: string;
  status: string;
  money: MoneyResponse;
}

// ======================================
// TEST APPLICATION
// ======================================

let app: INestApplication;
let baseUrl: string;

const previousSettings = {
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

// ======================================
// HTTP HELPERS
// ======================================

async function readJson<T>(
  response: Response,
): Promise<T> {
  const data: unknown = await response.json();
  return data as T;
}

async function postJson(
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function createWallet(): Promise<WalletResponse> {
  const playerId = randomUUID();

  const response = await postJson('/wallets', {
    playerId,
    initialBalance: {
      amount: '100.00',
      currency: 'BRL',
    },
  });

  expect(response.status).toBe(201);

  const wallet = await readJson<WalletResponse>(
    response,
  );

  expect(wallet.id).toBeDefined();
  expect(wallet.playerId).toBe(playerId);
  expect(wallet.balance.amount).toBe('100.00');
  expect(wallet.balance.currency).toBe('BRL');

  return wallet;
}

// ======================================
// SETUP
// ======================================

beforeAll(async () => {
  // O teste HTTP usa o mesmo PostgreSQL,
  // mas nao deve iniciar workers automaticos.
  process.env.PENDING_REFERENCE_WORKER_ENABLED =
    'false';

  process.env.OUTBOX_PUBLISHER_ENABLED =
    'false';

  process.env.WAGER_SQS_CONSUMER_ENABLED =
    'false';

  app = await NestFactory.create(AppModule, {
    logger: false,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: false,
      },
      stopAtFirstError: true,
    }),
  );

  app.useGlobalFilters(
    new ApiExceptionFilter(),
  );

  // Porta dinamica para evitar conflitos.
  await app.listen(0, '127.0.0.1');

  baseUrl = (
    await app.getUrl()
  ).replace(/\/$/, '');
});

// ======================================
// CLEANUP
// ======================================

afterAll(async () => {
  try {
    if (app) {
      await app.close();
    }
  } finally {
    restoreSetting(
      'PENDING_REFERENCE_WORKER_ENABLED',
      previousSettings.pending,
    );

    restoreSetting(
      'OUTBOX_PUBLISHER_ENABLED',
      previousSettings.outbox,
    );

    restoreSetting(
      'WAGER_SQS_CONSUMER_ENABLED',
      previousSettings.consumer,
    );
  }
});

// ======================================
// OFFICIAL HTTP CONTRACT TESTS
// ======================================

describe('Official HTTP Contracts', () => {
  // ====================================
  // TEST 1 - RECONCILIATION
  // ====================================

  test(
    'POST reconciliation returns structured monetary values',
    async () => {
      const wallet = await createWallet();

      const response = await fetch(
        `${baseUrl}/wallets/${wallet.id}/reconciliation`,
        {
          method: 'POST',
        },
      );

      expect(response.status).toBe(200);

      const result =
        await readJson<ReconciliationResponse>(
          response,
        );

      expect(result.walletId).toBe(wallet.id);

      expect(result.storedBalance).toEqual({
        amount: '100.00',
        currency: 'BRL',
      });

      expect(result.calculatedBalance).toEqual({
        amount: '100.00',
        currency: 'BRL',
      });

      expect(result.difference).toEqual({
        amount: '0.00',
        currency: 'BRL',
      });

      expect(result.consistent).toBe(true);
      expect(result.checkedEntries).toBe(1);

      // Confirma que a rota GET antiga
      // continua funcionando.
      const legacyResponse = await fetch(
        `${baseUrl}/wallets/${wallet.id}/reconciliation`,
      );

      expect(legacyResponse.status).toBe(200);
    },
    30000,
  );

  // ====================================
  // TEST 2 - PROVIDER LOOKUP
  // ====================================

  test(
    'GET provider transaction returns the processed wager',
    async () => {
      const wallet = await createWallet();

      const providerId =
        `provider-${randomUUID()}`;

      const externalTransactionId =
        randomUUID();

      const idempotencyKey =
        `contract:${externalTransactionId}`;

      const body = {
        providerId,
        externalTransactionId,
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId: 'contract-round',
        gameId: 'contract-game',
        kind: 'BET',

        money: {
          amount: '25.00',
          currency: 'BRL',
        },
      };

      // Primeiro processamos uma aposta.
      const wagerResponse = await postJson(
        '/wagering/transactions',
        body,
        {
          'Idempotency-Key': idempotencyKey,
        },
      );

      expect(wagerResponse.status).toBe(200);

      const wager = await readJson<WagerResponse>(
        wagerResponse,
      );

      expect(wager.status).toBe('PROCESSED');

      expect(wager.balance.amount).toBe('75.00');

      expect(wager.idempotentReplay).toBe(false);

      // Consulta pela identidade externa.
      const lookupUrl =
        `${baseUrl}/providers/${providerId}` +
        `/wagering/transactions/${externalTransactionId}`;

      const lookupResponse = await fetch(lookupUrl);

      expect(lookupResponse.status).toBe(200);

      const transaction =
        await readJson<TransactionResponse>(
          lookupResponse,
        );

      expect(transaction.id).toBe(
        wager.transactionId,
      );

      expect(transaction.providerId).toBe(
        providerId,
      );

      expect(transaction.externalTransactionId).toBe(
        externalTransactionId,
      );

      expect(transaction.walletId).toBe(wallet.id);
      expect(transaction.kind).toBe('BET');
      expect(transaction.status).toBe('PROCESSED');

      expect(transaction.money).toEqual({
        amount: '25.00',
        currency: 'BRL',
      });

      // Uma transacao inexistente deve retornar 404.
      const missingResponse = await fetch(
        `${baseUrl}/providers/${providerId}` +
        `/wagering/transactions/${randomUUID()}`,
      );

      expect(missingResponse.status).toBe(404);
    },
    30000,
  );
});
