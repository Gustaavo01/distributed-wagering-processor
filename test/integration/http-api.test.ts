
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

import { AppModule } from '../../src/app.module.js';

import {
  ApiExceptionFilter,
} from '../../src/presentation/http/api-exception.filter.js';

import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/domain/entities/wager-transaction.js';

// =====================================
// RESPONSE TYPES
// =====================================

interface MoneyResponse {
  amount: string;
  currency: string;
}

interface WalletResponse {
  id: string;
  playerId: string;
  balance: MoneyResponse;
  version: number;
  createdAt?: string;
  updatedAt?: string;
}

interface WagerResponse {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyResponse;
  idempotentReplay: boolean;
  failureCode?: string;
}

interface TransactionResponse {
  id: string;
  walletId: string;
  playerId: string;
  kind: WagerTransactionKind;
  status: WagerTransactionStatus;
  money: MoneyResponse;
  resultBalance: MoneyResponse | null;
}

interface LedgerEntryResponse {
  id: string;
  transactionId: string;
  direction: string;
  money: MoneyResponse;
  balanceBefore: MoneyResponse;
  balanceAfter: MoneyResponse;
  createdAt: string;
}

interface LedgerResponse {
  items: LedgerEntryResponse[];
  nextCursor: string | null;
  hasMore: boolean;
}

interface ReconciliationResponse {
  walletId: string;
  currency: string;
  storedBalance: string;
  ledgerBalance: string;
  entryCount: number;
  matches: boolean;
  status: string;
  checkedAt: string;
}

interface HealthResponse {
  status: string;
  service?: string;
  dependencies?: {
    postgres: boolean;
    sqs: boolean;
  };
}

interface ApiErrorResponse {
  statusCode: number;
  message: string | string[];
  traceId?: string;
}

// =====================================
// APPLICATION INSTANCE
// =====================================

let app: INestApplication;
let baseUrl: string;

// Evita que workers consumam mensagens
// ou publiquem eventos durante estes testes.
const previousWorkerSettings = {
  pending:
    process.env.PENDING_REFERENCE_WORKER_ENABLED,
  outbox:
    process.env.OUTBOX_PUBLISHER_ENABLED,
  consumer:
    process.env.WAGER_SQS_CONSUMER_ENABLED,
};

function restoreEnvironment(
  name: string,
  value: string | undefined,
): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

// =====================================
// HTTP HELPERS
// =====================================

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

async function getJson(
  path: string,
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'GET',
  });
}

// =====================================
// TEST DATA FACTORIES
// =====================================

async function createWallet(
  amount = '100.00',
): Promise<WalletResponse> {
  const playerId = randomUUID();

  const response = await postJson('/wallets', {
    playerId,

    initialBalance: {
      amount,
      currency: 'BRL',
    },
  });

  expect(response.status).toBe(201);

  const wallet = await readJson<WalletResponse>(
    response,
  );

  expect(wallet.id).toBeDefined();
  expect(wallet.playerId).toBe(playerId);
  expect(wallet.balance.amount).toBe(amount);
  expect(wallet.balance.currency).toBe('BRL');

  return wallet;
}

function createBetBody(
  wallet: WalletResponse,
  amount = '80.00',
) {
  return {
    providerId: 'http-integration-test',
    externalTransactionId: randomUUID(),
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: `round-${randomUUID()}`,
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,

    money: {
      amount,
      currency: 'BRL',
    },
  };
}

// =====================================
// START APPLICATION
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

  // Mesmas validacoes do main.ts.
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

  // Usa uma porta livre.
  // Nao interfere com a aplicacao na porta 3000.
  await app.listen(
    0,
    '127.0.0.1',
  );

  baseUrl = (
    await app.getUrl()
  ).replace(/\/$/, '');
});

// =====================================
// CLOSE APPLICATION
// =====================================

afterAll(async () => {
  try {
    if (app) {
      await app.close();
    }
  } finally {
    restoreEnvironment(
      'PENDING_REFERENCE_WORKER_ENABLED',
      previousWorkerSettings.pending,
    );

    restoreEnvironment(
      'OUTBOX_PUBLISHER_ENABLED',
      previousWorkerSettings.outbox,
    );

    restoreEnvironment(
      'WAGER_SQS_CONSUMER_ENABLED',
      previousWorkerSettings.consumer,
    );
  }
});

// =====================================
// HTTP API INTEGRATION TESTS
// =====================================

describe('HTTP Financial API', () => {

  // =====================================
  // TEST 1 - HEALTH CHECKS
  // =====================================

  test(
    'returns liveness and readiness status',
    async () => {
      const liveResponse = await getJson(
        '/health/live',
      );

      expect(liveResponse.status).toBe(200);

      const live = await readJson<HealthResponse>(
        liveResponse,
      );

      expect(live.status).toBe('ok');

      const readyResponse = await getJson(
        '/health/ready',
      );

      expect(readyResponse.status).toBe(200);

      const ready = await readJson<HealthResponse>(
        readyResponse,
      );

      expect(ready.status).toBe('ready');

      expect(
        ready.dependencies?.postgres,
      ).toBe(true);

      expect(
        ready.dependencies?.sqs,
      ).toBe(true);
    },
    30000,
  );

  // =====================================
  // TEST 2 - CREATE AND QUERY WALLET
  // =====================================

  test(
    'creates wallet and returns ledger and reconciliation',
    async () => {
      const wallet = await createWallet('100.00');

      // GET WALLET
      const getResponse = await getJson(
        `/wallets/${wallet.id}`,
      );

      expect(getResponse.status).toBe(200);

      const stored = await readJson<WalletResponse>(
        getResponse,
      );

      expect(stored.id).toBe(wallet.id);
      expect(stored.playerId).toBe(wallet.playerId);
      expect(stored.balance.amount).toBe('100.00');
      expect(stored.balance.currency).toBe('BRL');
      expect(stored.version).toBe(1);

      // GET LEDGER
      const ledgerResponse = await getJson(
        `/wallets/${wallet.id}/ledger`,
      );

      expect(ledgerResponse.status).toBe(200);

      const ledger = await readJson<LedgerResponse>(
        ledgerResponse,
      );

      // Uma carteira com saldo positivo
      // deve conter o credito OPENING.
      expect(ledger.items).toHaveLength(1);

      expect(
        ledger.items[0]!.direction,
      ).toBe('CREDIT');

      expect(
        ledger.items[0]!.money.amount,
      ).toBe('100.00');

      expect(
        ledger.items[0]!.balanceBefore.amount,
      ).toBe('0.00');

      expect(
        ledger.items[0]!.balanceAfter.amount,
      ).toBe('100.00');

      expect(ledger.hasMore).toBe(false);
      expect(ledger.nextCursor).toBeNull();

      // GET RECONCILIATION
      const reconciliationResponse = await getJson(
        `/wallets/${wallet.id}/reconciliation`,
      );

      expect(
        reconciliationResponse.status,
      ).toBe(200);

      const reconciliation =
        await readJson<ReconciliationResponse>(
          reconciliationResponse,
        );

      expect(
        reconciliation.walletId,
      ).toBe(wallet.id);

      expect(
        reconciliation.storedBalance,
      ).toBe('100.00');

      expect(
        reconciliation.ledgerBalance,
      ).toBe('100.00');

      expect(
        reconciliation.matches,
      ).toBe(true);

      expect(
        reconciliation.status,
      ).toBe('MATCH');

      expect(
        reconciliation.entryCount,
      ).toBe(1);
    },
    30000,
  );

  // =====================================
  // TEST 3 - BET AND IDEMPOTENCY
  // =====================================

  test(
    'processes BET and replays identical request',
    async () => {
      const wallet = await createWallet();

      const body = createBetBody(
        wallet,
        '80.00',
      );

      const idempotencyKey =
        `http-test:${randomUUID()}`;

      const headers = {
        'Idempotency-Key': idempotencyKey,
      };

      // FIRST BET
      const firstResponse = await postJson(
        '/wagering/transactions',
        body,
        headers,
      );

      expect(firstResponse.status).toBe(200);

      const first = await readJson<WagerResponse>(
        firstResponse,
      );

      expect(first.status).toBe(
        WagerTransactionStatus.Processed,
      );

      expect(first.balance.amount).toBe('20.00');

      expect(first.idempotentReplay).toBe(false);

      // EXACT SAME REQUEST
      const secondResponse = await postJson(
        '/wagering/transactions',
        body,
        headers,
      );

      expect(secondResponse.status).toBe(200);

      const second = await readJson<WagerResponse>(
        secondResponse,
      );

      expect(second.transactionId).toBe(
        first.transactionId,
      );

      expect(second.status).toBe(
        WagerTransactionStatus.Processed,
      );

      expect(second.balance.amount).toBe('20.00');

      expect(second.idempotentReplay).toBe(true);

      // GET TRANSACTION
      const transactionResponse = await getJson(
        `/wagering/transactions/${first.transactionId}`,
      );

      expect(transactionResponse.status).toBe(200);

      const transaction =
        await readJson<TransactionResponse>(
          transactionResponse,
        );

      expect(transaction.id).toBe(
        first.transactionId,
      );

      expect(transaction.kind).toBe(
        WagerTransactionKind.Bet,
      );

      expect(transaction.status).toBe(
        WagerTransactionStatus.Processed,
      );

      expect(transaction.money.amount).toBe('80.00');

      // GET STORED WALLET
      const walletResponse = await getJson(
        `/wallets/${wallet.id}`,
      );

      const storedWallet =
        await readJson<WalletResponse>(
          walletResponse,
        );

      expect(storedWallet.balance.amount).toBe(
        '20.00',
      );

      expect(storedWallet.version).toBe(2);

      // LEDGER PAGINATION
      const firstPageResponse = await getJson(
        `/wallets/${wallet.id}/ledger?limit=1`,
      );

      expect(firstPageResponse.status).toBe(200);

      const firstPage =
        await readJson<LedgerResponse>(
          firstPageResponse,
        );

      expect(firstPage.items).toHaveLength(1);
      expect(firstPage.hasMore).toBe(true);
      expect(firstPage.nextCursor).not.toBeNull();

      const cursor = encodeURIComponent(
        firstPage.nextCursor!,
      );

      const secondPageResponse = await getJson(
        `/wallets/${wallet.id}/ledger?limit=1&cursor=${cursor}`,
      );

      expect(secondPageResponse.status).toBe(200);

      const secondPage =
        await readJson<LedgerResponse>(
          secondPageResponse,
        );

      expect(secondPage.items).toHaveLength(1);
      expect(secondPage.hasMore).toBe(false);

      expect(
        firstPage.items[0]!.id,
      ).not.toBe(
        secondPage.items[0]!.id,
      );

      // LEDGER RECONCILIATION
      const reconciliationResponse = await getJson(
        `/wallets/${wallet.id}/reconciliation`,
      );

      const reconciliation =
        await readJson<ReconciliationResponse>(
          reconciliationResponse,
        );

      expect(reconciliation.matches).toBe(true);

      expect(
        reconciliation.storedBalance,
      ).toBe('20.00');

      expect(
        reconciliation.ledgerBalance,
      ).toBe('20.00');

      expect(
        reconciliation.entryCount,
      ).toBe(2);
    },
    60000,
  );

  // =====================================
  // TEST 4 - VALIDATION AND CONFLICTS
  // =====================================

  test(
    'rejects invalid payloads and idempotency conflicts',
    async () => {
      const wallet = await createWallet();

      const validBody = createBetBody(
        wallet,
        '40.00',
      );

      // INVALID DECIMAL INPUT
      const invalidMoneyResponse = await postJson(
        '/wagering/transactions',
        {
          ...validBody,
          money: {
            amount: '40.123',
            currency: 'BRL',
          },
        },
        {
          'Idempotency-Key': randomUUID(),
        },
      );

      expect(invalidMoneyResponse.status).toBe(
        400,
      );

      // MISSING IDEMPOTENCY KEY
      const missingKeyResponse = await postJson(
        '/wagering/transactions',
        validBody,
      );

      expect(missingKeyResponse.status).toBe(
        400,
      );

      // VALID REQUEST
      const idempotencyKey =
        `http-conflict:${randomUUID()}`;

      const headers = {
        'Idempotency-Key': idempotencyKey,
      };

      const validResponse = await postJson(
        '/wagering/transactions',
        validBody,
        headers,
      );

      expect(validResponse.status).toBe(200);

      const processed = await readJson<WagerResponse>(
        validResponse,
      );

      expect(processed.status).toBe(
        WagerTransactionStatus.Processed,
      );

      expect(processed.balance.amount).toBe(
        '60.00',
      );

      // SAME KEY WITH DIFFERENT AMOUNT
      const conflictResponse = await postJson(
        '/wagering/transactions',
        {
          ...validBody,
          money: {
            amount: '30.00',
            currency: 'BRL',
          },
        },
        headers,
      );

      expect(conflictResponse.status).toBe(
        409,
      );

      const conflict = await readJson<ApiErrorResponse>(
        conflictResponse,
      );

      expect(conflict.statusCode).toBe(409);

      expect(conflict.traceId).toBeDefined();

      // BALANCE MUST REMAIN UNCHANGED
      const walletResponse = await getJson(
        `/wallets/${wallet.id}`,
      );

      expect(walletResponse.status).toBe(200);

      const storedWallet =
        await readJson<WalletResponse>(
          walletResponse,
        );

      expect(storedWallet.balance.amount).toBe(
        '60.00',
      );

      expect(storedWallet.version).toBe(2);

      // INVALID WALLET IDENTIFIER
      const invalidWalletResponse = await getJson(
        '/wallets/invalid-wallet-id',
      );

      expect(invalidWalletResponse.status).toBe(
        400,
      );
    },
    60000,
  );
});
