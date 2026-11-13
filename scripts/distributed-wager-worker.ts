
import 'dotenv/config';

import { MikroORM } from '@mikro-orm/postgresql';

import config from '../src/mikro-orm.config.js';

import {
  ProcessWagerTransactionUseCase,
  type ProcessWagerInput,
  type InboxReceipt,
} from '../src/application/use-cases/process-wager-transaction.use-case.js';

interface DistributedWorkerJob {
  mode: 'normal' | 'crash-after-commit';
  input: ProcessWagerInput;
  deliveries: number;
  inbox?: InboxReceipt;
}

function readJob(): DistributedWorkerJob {
  const encoded = process.argv[2];

  if (!encoded) {
    throw new Error('Worker job argument is required');
  }

  const json = Buffer.from(
    encoded,
    'base64url',
  ).toString('utf8');

  const job = JSON.parse(json) as DistributedWorkerJob;

  if (
    !job.input ||
    !Number.isInteger(job.deliveries) ||
    job.deliveries < 1 ||
    job.deliveries > 50
  ) {
    throw new Error('Invalid distributed worker job');
  }

  return job;
}

function waitForStart(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onData = (chunk: string | Buffer): void => {
      cleanup();

      if (String(chunk).trim() === 'START') {
        resolve();
      } else {
        reject(new Error('Unexpected start signal'));
      }
    };

    const onEnd = (): void => {
      cleanup();
      reject(new Error('Parent closed standard input'));
    };

    const cleanup = (): void => {
      process.stdin.off('data', onData);
      process.stdin.off('end', onEnd);
    };

    process.stdin.once('data', onData);
    process.stdin.once('end', onEnd);
    process.stdin.resume();
  });
}

async function main(): Promise<void> {
  const job = readJob();

  const orm = await MikroORM.init(config);

  try {
    const processor =
      new ProcessWagerTransactionUseCase(orm);

    // Registra o listener antes de avisar
    // ao processo principal que esta pronto.
    const startSignal = waitForStart();

    process.stdout.write('READY\n');

    await startSignal;

    if (job.mode === 'crash-after-commit') {
      if (!job.inbox) {
        throw new Error(
          'Inbox receipt required for crash test',
        );
      }

      // O execute() somente resolve apos
      // o commit no PostgreSQL.
      await processor.execute(
        job.input,
        job.inbox,
      );

      // Simula uma falha abrupta:
      // o commit ocorreu, mas nao houve
      // reconhecimento da mensagem no SQS.
      process.exit(73);
    }

    const results = await Promise.all(
      Array.from(
        { length: job.deliveries },
        () => processor.execute(job.input),
      ),
    );

    process.stdout.write(
      `RESULT:${JSON.stringify(results)}\n`,
    );
  } finally {
    await orm.close();
  }
}

void main().catch((error: unknown) => {
  console.error(
    'DISTRIBUTED_WORKER_ERROR',
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : String(error),
  );

  process.exitCode = 1;
});
