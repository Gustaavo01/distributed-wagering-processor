
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';

import { randomUUID } from 'node:crypto';

import {
  spawn,
} from 'node:child_process';

import {
  createInterface,
} from 'node:readline';

import {
  resolve,
} from 'node:path';

import {
  MikroORM,
} from '@mikro-orm/postgresql';

import config from '../../src/mikro-orm.config.js';

import {
  CreateWalletUseCase,
} from '../../src/application/use-cases/create-wallet.use-case.js';

import {
  ProcessWagerTransactionUseCase,
  type ProcessWagerInput,
  type ProcessWagerOutput,
  type InboxReceipt,
} from '../../src/application/use-cases/process-wager-transaction.use-case.js';

import {
  WagerTransactionKind,
  WagerTransactionStatus,
  FailureCode,
} from '../../src/domain/entities/wager-transaction.js';

import {
  WalletEntity,
} from '../../src/infrastructure/persistence/entities/wallet.entity.js';

import {
  WagerTransactionEntity,
} from '../../src/infrastructure/persistence/wager-transaction.entity.js';

import {
  WalletLedgerEntryEntity,
} from '../../src/infrastructure/persistence/entities/wallet-ledger-entry.entity.js';

import {
  InboxMessageEntity,
} from '../../src/infrastructure/persistence/inbox-message.entity.js';

import {
  OutboxMessageEntity,
} from '../../src/infrastructure/persistence/outbox-message.entity.js';

// =====================================
// TYPES
// =====================================

interface WorkerJob {
  mode: 'normal' | 'crash-after-commit';
  input: ProcessWagerInput;
  deliveries: number;
  inbox?: InboxReceipt;
}

interface WorkerOutcome {
  code: number | null;
  results: ProcessWagerOutput[] | null;
  stderr: string;
}

interface WorkerHandle {
  ready: Promise<void>;
  completed: Promise<WorkerOutcome>;
  start(): void;
  stop(): void;
}

interface TestWallet {
  id: string;
  playerId: string;
}

// =====================================
// DATABASE
// =====================================

let orm: MikroORM;

beforeAll(async () => {
  orm = await MikroORM.init(config);
});

afterAll(async () => {
  if (orm) {
    await orm.close();
  }
});

async function createWallet(): Promise<TestWallet> {
  const playerId = randomUUID();

  const wallet = await new CreateWalletUseCase(
    orm,
  ).execute({
    playerId,
    initialBalance: {
      amount: '100.00',
      currency: 'BRL',
    },
  });

  return {
    id: wallet.id,
    playerId: wallet.playerId,
  };
}

function makeBet(
  wallet: TestWallet,
  amount = '80.00',
): ProcessWagerInput {
  const externalTransactionId = randomUUID();

  return {
    providerId: 'distributed-test-provider',
    externalTransactionId,
    idempotencyKey:
      `distributed:${externalTransactionId}`,
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: 'distributed-round',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: {
      amount,
      currency: 'BRL',
    },
  };
}

// =====================================
// START ONE INDEPENDENT PROCESS
// =====================================

function spawnWorker(
  job: WorkerJob,
): WorkerHandle {
  const scriptPath = resolve(
    process.cwd(),
    'scripts',
    'distributed-wager-worker.ts',
  );

  const encoded = Buffer.from(
    JSON.stringify(job),
  ).toString('base64url');

  const child = spawn(
    process.execPath,
    [
      'run',
      scriptPath,
      encoded,
    ],
    {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PENDING_REFERENCE_WORKER_ENABLED: 'false',
        OUTBOX_PUBLISHER_ENABLED: 'false',
        WAGER_SQS_CONSUMER_ENABLED: 'false',
      },
    },
  );

  let readyReceived = false;
  let results: ProcessWagerOutput[] | null = null;
  let stderr = '';

  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;

  const ready = new Promise<void>(
    (resolvePromise, rejectPromise) => {
      resolveReady = resolvePromise;
      rejectReady = rejectPromise;
    },
  );

  let resolveCompleted!: (
    outcome: WorkerOutcome,
  ) => void;

  let rejectCompleted!: (error: Error) => void;

  const completed = new Promise<WorkerOutcome>(
    (resolvePromise, rejectPromise) => {
      resolveCompleted = resolvePromise;
      rejectCompleted = rejectPromise;
    },
  );

  // Impede rejection nao observada caso
  // um subprocesso falhe durante o setup.
  void completed.catch(() => undefined);

  child.stdout.setEncoding('utf8');

  const lines = createInterface({
    input: child.stdout,
  });

  lines.on('line', (line: string) => {
    if (line.trim() === 'READY') {
      readyReceived = true;
      resolveReady();
      return;
    }

    if (line.startsWith('RESULT:')) {
      try {
        results = JSON.parse(
          line.substring('RESULT:'.length),
        ) as ProcessWagerOutput[];
      } catch (error: unknown) {
        stderr += `Invalid RESULT JSON: ${String(error)}`;
      }
    }
  });

  child.stderr.setEncoding('utf8');

  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;

    if (stderr.length > 20000) {
      stderr = stderr.slice(-20000);
    }
  });

  child.once('error', (error: Error) => {
    if (!readyReceived) {
      rejectReady(error);
    }

    rejectCompleted(error);
  });

  child.once('close', (code: number | null) => {
    if (!readyReceived) {
      rejectReady(
        new Error(
          `Worker exited before READY. Code: ${code}\n${stderr}`,
        ),
      );
    }

    resolveCompleted({
      code,
      results,
      stderr,
    });
  });

  return {
    ready,
    completed,

    start(): void {
      child.stdin.write('START\n');
      child.stdin.end();
    },

    stop(): void {
      if (
        child.exitCode === null &&
        !child.killed
      ) {
        child.kill();
      }
    },
  };
}

// =====================================
// RUN MULTIPLE PROCESSES TOGETHER
// =====================================

async function runWorkers(
  jobs: WorkerJob[],
): Promise<WorkerOutcome[]> {
  const workers = jobs.map(spawnWorker);

  try {
    // Todos precisam conectar ao banco
    // antes de receber o sinal START.
    await Promise.all(
      workers.map((worker) => worker.ready),
    );

    // Dispara as operacoes simultaneamente.
    for (const worker of workers) {
      worker.start();
    }

    return await Promise.all(
      workers.map((worker) => worker.completed),
    );
  } finally {
    for (const worker of workers) {
      worker.stop();
    }
  }
}

function requireResults(
  outcome: WorkerOutcome,
): ProcessWagerOutput[] {
  expect(outcome.code).toBe(0);

  if (!outcome.results) {
    throw new Error(
      `Worker did not return results:\n${outcome.stderr}`,
    );
  }

  return outcome.results;
}

// =====================================
// DATABASE VERIFICATION
// =====================================

async function inspectWallet(walletId: string) {
  const em = orm.em.fork();

  const wallet = await em.findOneOrFail(
    WalletEntity,
    { id: walletId },
  );

  const ledger = await em.find(
    WalletLedgerEntryEntity,
    { walletId },
  );

  return {
    balance: wallet.balance,
    version: wallet.version,
    ledger,
  };
}

// =====================================
// DISTRIBUTED TESTS
// =====================================

describe('Distributed financial resilience', () => {
  test(
    'three processes cannot overdraw the same wallet',
    async () => {
      const wallet = await createWallet();

      const jobs: WorkerJob[] = Array.from(
        { length: 3 },
        () => ({
          mode: 'normal',
          input: makeBet(wallet),
          deliveries: 1,
        }),
      );

      const outcomes = await runWorkers(jobs);

      const results = outcomes.flatMap(
        requireResults,
      );

      expect(results).toHaveLength(3);

      const processed = results.filter(
        (result) =>
          result.status ===
          WagerTransactionStatus.Processed,
      );

      const rejected = results.filter(
        (result) =>
          result.status ===
          WagerTransactionStatus.Rejected,
      );

      expect(processed).toHaveLength(1);
      expect(rejected).toHaveLength(2);

      expect(
        rejected.every(
          (result) =>
            result.failureCode ===
            FailureCode.InsufficientBalance,
        ),
      ).toBe(true);

      const stored = await inspectWallet(
        wallet.id,
      );

      expect(stored.balance).toBe('20.00');
      expect(stored.version).toBe(2);

      // OPENING + exatamente um BET.
      expect(stored.ledger).toHaveLength(2);

      expect(
        stored.ledger.filter(
          (entry) =>
            entry.direction === 'DEBIT',
        ),
      ).toHaveLength(1);

      const transactions = await orm.em
        .fork()
        .find(
          WagerTransactionEntity,
          {
            walletId: wallet.id,
            kind: WagerTransactionKind.Bet,
          },
        );

      expect(transactions).toHaveLength(3);
    },
    120000,
  );

  test(
    'fifty identical requests across three processes debit once',
    async () => {
      const wallet = await createWallet();

      const input = makeBet(wallet);

      const outcomes = await runWorkers([
        {
          mode: 'normal',
          input,
          deliveries: 17,
        },
        {
          mode: 'normal',
          input,
          deliveries: 17,
        },
        {
          mode: 'normal',
          input,
          deliveries: 16,
        },
      ]);

      const results = outcomes.flatMap(
        requireResults,
      );

      expect(results).toHaveLength(50);

      expect(
        results.every(
          (result) =>
            result.status ===
            WagerTransactionStatus.Processed,
        ),
      ).toBe(true);

      const transactionIds = new Set(
        results.map(
          (result) => result.transactionId,
        ),
      );

      expect(transactionIds.size).toBe(1);

      expect(
        results.filter(
          (result) => !result.idempotentReplay,
        ),
      ).toHaveLength(1);

      expect(
        results.filter(
          (result) => result.idempotentReplay,
        ),
      ).toHaveLength(49);

      const stored = await inspectWallet(
        wallet.id,
      );

      expect(stored.balance).toBe('20.00');
      expect(stored.version).toBe(2);
      expect(stored.ledger).toHaveLength(2);

      const bets = await orm.em.fork().find(
        WagerTransactionEntity,
        {
          providerId: input.providerId,
          externalTransactionId:
            input.externalTransactionId,
        },
      );

      expect(bets).toHaveLength(1);

      const outbox = await orm.em.fork().find(
        OutboxMessageEntity,
        {
          aggregateId: wallet.id,
          eventType:
            'WagerTransactionProcessed',
        },
      );

      const wagerEvents = outbox.filter(
        (event) => {
          const data = event.payload.data as {
            transactionId?: string;
          };

          return (
            data.transactionId ===
            bets[0]!.id
          );
        },
      );

      expect(wagerEvents).toHaveLength(1);
    },
    120000,
  );

  test(
    'recovers after crash following DB commit without duplicate debit',
    async () => {
      const wallet = await createWallet();

      const input = makeBet(
        wallet,
        '35.00',
      );

      const inbox: InboxReceipt = {
        consumerName:
          'distributed-crash-recovery-test',
        messageId: randomUUID(),
      };

      // Processo filho faz o commit
      // e encerra com codigo 73.
      const [outcome] = await runWorkers([
        {
          mode: 'crash-after-commit',
          input,
          inbox,
          deliveries: 1,
        },
      ]);

      expect(outcome!.code).toBe(73);

      // O processo terminou, mas o PostgreSQL
      // deve preservar o commit anterior.
      const beforeReplay = await inspectWallet(
        wallet.id,
      );

      expect(beforeReplay.balance).toBe(
        '65.00',
      );

      expect(beforeReplay.version).toBe(2);

      expect(beforeReplay.ledger).toHaveLength(
        2,
      );

      const em = orm.em.fork();

      const savedInbox = await em.findOneOrFail(
        InboxMessageEntity,
        {
          consumerName: inbox.consumerName,
          messageId: inbox.messageId,
        },
      );

      expect(
        savedInbox.processedAt,
      ).toBeInstanceOf(Date);

      const original = await em.findOneOrFail(
        WagerTransactionEntity,
        {
          providerId: input.providerId,
          externalTransactionId:
            input.externalTransactionId,
        },
      );

      // Simula a reentrega da mesma mensagem
      // depois de um ACK que nao aconteceu.
      const processor =
        new ProcessWagerTransactionUseCase(orm);

      const replay = await processor.execute(
        input,
        inbox,
      );

      expect(replay.idempotentReplay).toBe(
        true,
      );

      expect(replay.transactionId).toBe(
        original.id,
      );

      expect(replay.balance.amount).toBe(
        '65.00',
      );

      const afterReplay = await inspectWallet(
        wallet.id,
      );

      expect(afterReplay.balance).toBe(
        '65.00',
      );

      expect(afterReplay.version).toBe(2);

      expect(afterReplay.ledger).toHaveLength(
        2,
      );

      expect(
        afterReplay.ledger.filter(
          (entry) =>
            entry.direction === 'DEBIT',
        ),
      ).toHaveLength(1);
    },
    120000,
  );
});
