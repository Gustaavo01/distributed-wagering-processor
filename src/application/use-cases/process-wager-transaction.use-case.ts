
import { randomUUID } from 'node:crypto';
import { LockMode } from '@mikro-orm/core';

import {
  MikroORM,
  type EntityManager,
} from '@mikro-orm/postgresql';

import {
  Money,
  type MoneyProps,
} from '../../domain/value-objects/money.js';

import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  FailureCode,
  InvalidWagerReferenceError,
  InvalidWagerTransactionError,
} from '../../domain/entities/wager-transaction.js';

import {
  InsufficientBalanceError,
} from '../../domain/entities/wallet.js';

import {
  LedgerDirection,
  type WalletLedgerEntry,
} from '../../domain/entities/wallet-ledger-entry.js';

import {
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WagerTransactionPendingReference,
  WalletBalanceChanged,
  type IntegrationEvent,
} from '../../domain/events/integration-event.js';

import {
  WalletEntity,
} from '../../infrastructure/persistence/entities/wallet.entity.js';

import {
  WagerTransactionEntity,
} from '../../infrastructure/persistence/wager-transaction.entity.js';

import {
  WalletLedgerEntryEntity,
} from '../../infrastructure/persistence/entities/wallet-ledger-entry.entity.js';

import {
  OutboxMessageEntity,
} from '../../infrastructure/persistence/outbox-message.entity.js';

import {
  InboxMessageEntity,
} from '../../infrastructure/persistence/inbox-message.entity.js';

import {
  WalletMapper,
} from '../../infrastructure/mappers/wallet.mapper.js';

import {
  calculatePayloadHash,
} from '../services/payload-hash.js';

// =====================================
// CONTRACTS
// =====================================

export interface ProcessWagerInput {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

export interface ProcessWagerOutput {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  idempotentReplay: boolean;
  failureCode?: FailureCode;
}

export interface InboxReceipt {
  consumerName: string;
  messageId: string;
}

export class IdempotencyConflictError extends Error {
  constructor() {
    super('Idempotency key or transaction identity conflict');
    this.name = 'IdempotencyConflictError';
  }
}

export class WalletNotFoundError extends Error {
  constructor() {
    super('Wallet not found');
    this.name = 'WalletNotFoundError';
  }
}

// =====================================
// USE CASE
// =====================================

export class ProcessWagerTransactionUseCase {
  private static readonly MAX_REFERENCE_ATTEMPTS = 12;

  private static readonly REFERENCE_TTL_MS =
    24 * 60 * 60 * 1000;

  constructor(
    private readonly orm: MikroORM,
  ) {}

  // =====================================
  // EXECUTE - HTTP OR SQS
  // =====================================

  async execute(
    input: ProcessWagerInput,
    inbox?: InboxReceipt,
  ): Promise<ProcessWagerOutput> {
    const uuidPattern =
      /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

    if (
      !uuidPattern.test(input.walletId) ||
      !uuidPattern.test(input.playerId)
    ) {
      throw new InvalidWagerTransactionError('Invalid walletId or playerId');
    }

    const required: Array<[string, number]> = [
      [input.providerId, 100],
      [input.externalTransactionId, 160],
      [input.idempotencyKey, 256],
      [input.roundId, 160],
      [input.gameId, 160],
    ];

    if (
      required.some(
        ([value, max]) =>
          typeof value !== 'string' ||
          !value.trim() ||
          value.length > max,
      )
    ) {
      throw new InvalidWagerTransactionError('Invalid transaction identifiers');
    }

    if (
      input.referenceExternalTransactionId !== undefined &&
      (
        typeof input.referenceExternalTransactionId !== 'string' ||
        !input.referenceExternalTransactionId.trim() ||
        input.referenceExternalTransactionId.length > 160
      )
    ) {
      throw new InvalidWagerTransactionError('Invalid reference identifier');
    }

    if (inbox) {
      if (
        !inbox.consumerName.trim() ||
        inbox.consumerName.length > 100 ||
        !inbox.messageId.trim() ||
        inbox.messageId.length > 200
      ) {
        throw new InvalidWagerTransactionError('Invalid inbox identifiers');
      }
    }

    const money = Money.from(input.money);

    if (!money.isPositive()) {
      throw new InvalidWagerTransactionError('Transaction amount must be positive');
    }

    const payloadHash = calculatePayloadHash({
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      walletId: input.walletId,
      playerId: input.playerId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind: input.kind,
      money: money.toJSON(),
      referenceExternalTransactionId:
        input.referenceExternalTransactionId ?? null,
    });

    const em = this.orm.em.fork();

    return em.transactional(
      async (tx) => {
        // Locks transacionais com ordem fixa.
        // O lock da Inbox impede que o mesmo messageId
        // seja processado simultaneamente em wallets
        // diferentes.

        const identityLocks = [
          `external:${input.providerId}:${input.externalTransactionId}`,
          `idempotency:${input.idempotencyKey}`,
          ...(inbox
            ? [
                `inbox:${inbox.consumerName}:${inbox.messageId}`,
              ]
            : []),
        ].sort();

        for (const key of identityLocks) {
          await tx.execute(
            'SELECT pg_advisory_xact_lock(hashtextextended(?::text, 0))',
            [key],
          );
        }

        // Bloqueio por carteira.
        const walletRow = await tx.findOne(
          WalletEntity,
          { id: input.walletId },
          { lockMode: LockMode.PESSIMISTIC_WRITE },
        );

        if (!walletRow) {
          throw new WalletNotFoundError();
        }

        // Consulta a Inbox na mesma transacao.
        const existingInbox = inbox
          ? await tx.findOne(
              InboxMessageEntity,
              {
                consumerName: inbox.consumerName,
                messageId: inbox.messageId,
              },
            )
          : null;

        if (
          existingInbox &&
          existingInbox.payloadHash !== payloadHash
        ) {
          throw new IdempotencyConflictError();
        }

        // Fonte da verdade para idempotencia HTTP/SQS.
        const existingByKey = await tx.findOne(
          WagerTransactionEntity,
          { idempotencyKey: input.idempotencyKey },
        );

        if (existingByKey) {
          if (
            existingByKey.payloadHash !== payloadHash ||
            existingByKey.providerId !== input.providerId ||
            existingByKey.externalTransactionId !==
              input.externalTransactionId
          ) {
            throw new IdempotencyConflictError();
          }

          const output = this.toOutput(
            existingByKey,
            true,
          );

          // Uma nova mensagem SQS pode ser um replay
          // de uma transacao ja confirmada pela API.
          await this.persistInbox(
            tx,
            inbox,
            payloadHash,
            existingInbox,
          );

          return output;
        }

        // Uma Inbox processada sempre deve possuir
        // uma transacao financeira correspondente.
        if (existingInbox?.processedAt) {
          throw new Error(
            'Processed inbox has no matching transaction',
          );
        }

        const existingExternal = await tx.findOne(
          WagerTransactionEntity,
          {
            providerId: input.providerId,
            externalTransactionId:
              input.externalTransactionId,
          },
        );

        if (existingExternal) {
          throw new IdempotencyConflictError();
        }

        const wallet = WalletMapper.toDomain(walletRow);

        if (wallet.playerId !== input.playerId) {
          throw new InvalidWagerTransactionError(
            'Wallet does not belong to player',
          );
        }

        if (wallet.currency !== money.currency) {
          throw new InvalidWagerTransactionError(
            'Wallet currency mismatch',
          );
        }

        const wager = WagerTransaction.create({
          id: randomUUID(),
          providerId: input.providerId,
          externalTransactionId:
            input.externalTransactionId,
          idempotencyKey: input.idempotencyKey,
          payloadHash,
          walletId: input.walletId,
          playerId: input.playerId,
          roundId: input.roundId,
          gameId: input.gameId,
          kind: input.kind,
          money,
          referenceExternalTransactionId:
            input.referenceExternalTransactionId,
        });

        const output = await this.applyAndPersist(
          tx,
          walletRow,
          wager,
        );

        // Wallet, Wager, Ledger, Outbox e Inbox
        // estao dentro da MESMA transacao SQL.
        await this.persistInbox(
          tx,
          inbox,
          payloadHash,
          existingInbox,
        );

        return output;
      },
      { clear: true },
    );
  }

  // =====================================
  // PERSIST INBOX
  // =====================================

  private async persistInbox(
    tx: EntityManager,
    inbox: InboxReceipt | undefined,
    payloadHash: string,
    existing: InboxMessageEntity | null,
  ): Promise<void> {
    if (!inbox) {
      return;
    }

    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        throw new IdempotencyConflictError();
      }

      if (!existing.processedAt) {
        existing.processedAt = new Date();
        await tx.flush();
      }

      return;
    }

    const now = new Date();

    const row = Object.assign(
      new InboxMessageEntity(),
      {
        consumerName: inbox.consumerName,
        messageId: inbox.messageId,
        payloadHash,
        receivedAt: now,
        processedAt: now,
      },
    );

    tx.persist(row);
    await tx.flush();
  }

  // =====================================
  // RETRY PENDING REFERENCE
  // =====================================

  async retryPendingReference(
    transactionId: string,
  ): Promise<ProcessWagerOutput | null> {
    const snapshot = await this.orm.em.fork().findOne(
      WagerTransactionEntity,
      { id: transactionId },
    );

    if (
      !snapshot ||
      snapshot.status !==
        WagerTransactionStatus.PendingReference
    ) {
      return null;
    }

    const em = this.orm.em.fork();

    return em.transactional(
      async (tx) => {
        const walletRow = await tx.findOne(
          WalletEntity,
          { id: snapshot.walletId },
          { lockMode: LockMode.PESSIMISTIC_WRITE },
        );

        if (!walletRow) {
          throw new WalletNotFoundError();
        }

        const existing = await tx.findOne(
          WagerTransactionEntity,
          { id: transactionId },
          { lockMode: LockMode.PESSIMISTIC_WRITE },
        );

        if (!existing) {
          return null;
        }

        if (
          existing.status !==
          WagerTransactionStatus.PendingReference
        ) {
          return this.toOutput(existing, true);
        }

        const currentTime = Date.now();

        const retryNotDue =
          existing.referenceNextRetryAt != null &&
          existing.referenceNextRetryAt.getTime() >
            currentTime;

        const referenceNotExpired =
          existing.referenceExpiresAt == null ||
          existing.referenceExpiresAt.getTime() >
            currentTime;

        if (retryNotDue && referenceNotExpired) {
          return this.toOutput(existing, true);
        }

        const wager = this.rehydrateWager(existing);

        return this.applyAndPersist(
          tx,
          walletRow,
          wager,
          existing,
        );
      },
      { clear: true },
    );
  }

  // =====================================
  // REHYDRATION
  // =====================================

  private rehydrateWager(
    row: WagerTransactionEntity,
  ): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: row.id,
      providerId: row.providerId,
      externalTransactionId: row.externalTransactionId,
      idempotencyKey: row.idempotencyKey,
      payloadHash: row.payloadHash,
      walletId: row.walletId,
      playerId: row.playerId,
      roundId: row.roundId,
      gameId: row.gameId,
      kind: row.kind,
      money: Money.from({
        amount: row.amount,
        currency: row.currency,
      }),
      referenceExternalTransactionId:
        row.referenceExternalTransactionId ?? undefined,
      createdAt: row.createdAt,
      status: row.status,
      referenceTransactionId:
        row.referenceTransactionId ?? undefined,
      failureCode: row.failureCode ?? undefined,
      processedAt: row.processedAt ?? undefined,
    });
  }

  private toOutput(
    row: WagerTransactionEntity,
    idempotentReplay: boolean,
  ): ProcessWagerOutput {
    if (row.resultBalance == null) {
      throw new Error(
        'Stored transaction result is missing',
      );
    }

    return {
      transactionId: row.id,
      status: row.status,
      balance: {
        amount: row.resultBalance,
        currency: row.currency,
      },
      idempotentReplay,
      failureCode: row.failureCode ?? undefined,
    };
  }

  private static retryDelayMs(
    attempt: number,
  ): number {
    return Math.min(
      10_000 * (2 ** Math.min(attempt, 10)),
      3_600_000,
    );
  }

  // =====================================
  // APPLY FINANCIAL OPERATION
  // =====================================

  private async applyAndPersist(
    tx: EntityManager,
    walletRow: WalletEntity,
    wager: WagerTransaction,
    existingRow?: WagerTransactionEntity,
  ): Promise<ProcessWagerOutput> {
    const wallet = WalletMapper.toDomain(walletRow);
    const now = new Date();

    const isRetry = existingRow !== undefined;

    const attempts =
      (existingRow?.referenceAttempts ?? 0) +
      (isRetry ? 1 : 0);

    const expiresAt =
      existingRow?.referenceExpiresAt ??
      new Date(
        now.getTime() +
        ProcessWagerTransactionUseCase.REFERENCE_TTL_MS,
      );

    let referenceRow: WagerTransactionEntity | null = null;
    let reference: WagerTransaction | undefined;
    let ledger: WalletLedgerEntry | undefined;
    let awaitingReference = false;

    // Expiracao de referencia.
    if (
      isRetry &&
      now.getTime() >= expiresAt.getTime()
    ) {
      wager.reject(FailureCode.ReferenceNotFound);
    }

    // =====================================
    // RESOLVE REFERENCE
    // =====================================

    if (
      wager.status !== WagerTransactionStatus.Rejected &&
      wager.referenceExternalTransactionId
    ) {
      referenceRow = await tx.findOne(
        WagerTransactionEntity,
        {
          providerId: wager.providerId,
          externalTransactionId:
            wager.referenceExternalTransactionId,
        },
      );

      if (
        referenceRow?.status ===
        WagerTransactionStatus.Processed
      ) {
        reference = this.rehydrateWager(referenceRow);
      } else if (
        referenceRow?.status ===
          WagerTransactionStatus.Rejected ||
        referenceRow?.status ===
          WagerTransactionStatus.Failed
      ) {
        wager.reject(FailureCode.InvalidReference);
      } else if (
        isRetry &&
        attempts >=
          ProcessWagerTransactionUseCase.MAX_REFERENCE_ATTEMPTS
      ) {
        wager.reject(FailureCode.ReferenceNotFound);
      } else {
        wager.markPendingReference();
        awaitingReference = true;
      }
    }

    // =====================================
    // PROCESS
    // =====================================

    if (
      wager.status !== WagerTransactionStatus.Rejected &&
      !awaitingReference
    ) {
      try {
        if (wager.kind === WagerTransactionKind.Loss) {
          wager.markProcessed(undefined, now);
        } else {
          const direction =
            wager.ledgerDirectionFor(reference);

          let isDuplicateReversal = false;

          if (
            wager.requiresReference() &&
            referenceRow
          ) {
            const previousReversal = await tx.findOne(
              WagerTransactionEntity,
              {
                referenceTransactionId: referenceRow.id,
                kind: wager.kind,
                status: WagerTransactionStatus.Processed,
              },
            );

            if (
              previousReversal &&
              previousReversal.id !== wager.id
            ) {
              isDuplicateReversal = true;

              wager.reject(
                FailureCode.DuplicateReversal,
              );
            }
          }

          if (!isDuplicateReversal) {
            const movement = {
              ledgerEntryId: randomUUID(),
              transactionId: wager.id,
              money: wager.money,
              at: now,
            };

            ledger =
              direction === LedgerDirection.Debit
                ? wallet.debit(movement)
                : wallet.credit(movement);

            wager.markProcessed(referenceRow?.id, now);

            const updated =
              WalletMapper.toPersistence(wallet);

            walletRow.balance = updated.balance;
            walletRow.version = updated.version;
            walletRow.updatedAt = updated.updatedAt;
          }
        }
      } catch (error: unknown) {
        if (error instanceof InsufficientBalanceError) {
          wager.reject(
            wager.kind === WagerTransactionKind.Rollback
              ? FailureCode.ReversalWouldOverdraw
              : FailureCode.InsufficientBalance,
          );
        } else if (
          error instanceof InvalidWagerReferenceError
        ) {
          wager.reject(FailureCode.InvalidReference);
        } else {
          throw error;
        }
      }
    }

    // =====================================
    // RETRY SCHEDULE
    // =====================================

    const nextRetryAt =
      wager.status === WagerTransactionStatus.PendingReference
        ? new Date(
            now.getTime() +
            ProcessWagerTransactionUseCase.retryDelayMs(
              attempts,
            ),
          )
        : null;

    // =====================================
    // PERSIST TRANSACTION
    // =====================================

    const wagerRow =
      existingRow ?? new WagerTransactionEntity();

    Object.assign(wagerRow, {
      id: wager.id,
      providerId: wager.providerId,
      externalTransactionId: wager.externalTransactionId,
      idempotencyKey: wager.idempotencyKey,
      payloadHash: wager.payloadHash,
      walletId: wager.walletId,
      playerId: wager.playerId,
      roundId: wager.roundId,
      gameId: wager.gameId,
      kind: wager.kind,
      amount: wager.money.toJSON().amount,
      currency: wager.money.currency,
      referenceExternalTransactionId:
        wager.referenceExternalTransactionId ?? null,
      referenceTransactionId:
        wager.referenceTransactionId ?? null,
      status: wager.status,
      failureCode: wager.failureCode ?? null,
      resultBalance: wallet.balance.toJSON().amount,
      resultWalletVersion: wallet.version,
      createdAt: wager.createdAt,
      processedAt: wager.processedAt ?? null,
      referenceAttempts: attempts,
      referenceNextRetryAt: nextRetryAt,
      referenceExpiresAt:
        wager.requiresReference() ||
        wager.referenceExternalTransactionId !== undefined
          ? expiresAt
          : null,
    });

    if (!existingRow) {
      tx.persist(wagerRow);
    }

    await tx.flush();

    // =====================================
    // INTEGRATION EVENTS
    // =====================================

    const context = {
      aggregateId: wallet.id,
      correlationId: wager.id,
      causationId: wager.id,
      occurredAt: now,
    };

    const events: IntegrationEvent<object>[] = [];

    if (
      wager.status === WagerTransactionStatus.Processed
    ) {
      events.push(
        WagerTransactionProcessed.from({
          ...context,
          eventId: randomUUID(),
          data: {
            transactionId: wager.id,
            walletId: wallet.id,
            kind: wager.kind,
            status: 'PROCESSED',
            money: wager.money.toJSON(),
            balance: wallet.balance.toJSON(),
          },
        }),
      );

      if (ledger) {
        const entryRow = Object.assign(
          new WalletLedgerEntryEntity(),
          {
            id: ledger.id,
            walletId: ledger.walletId,
            transactionId: ledger.transactionId,
            direction: ledger.direction,
            amount: ledger.money.toJSON().amount,
            currency: ledger.money.currency,
            balanceBefore:
              ledger.balanceBefore.toJSON().amount,
            balanceAfter:
              ledger.balanceAfter.toJSON().amount,
            createdAt: ledger.createdAt,
          },
        );

        tx.persist(entryRow);

        events.push(
          WalletBalanceChanged.from({
            ...context,
            eventId: randomUUID(),
            data: {
              walletId: wallet.id,
              transactionId: wager.id,
              direction: ledger.direction,
              money: ledger.money.toJSON(),
              balanceBefore: ledger.balanceBefore.toJSON(),
              balanceAfter: ledger.balanceAfter.toJSON(),
              walletVersion: wallet.version,
            },
          }),
        );
      }
    } else if (
      wager.status === WagerTransactionStatus.Rejected
    ) {
      events.push(
        WagerTransactionRejected.from({
          ...context,
          eventId: randomUUID(),
          data: {
            transactionId: wager.id,
            walletId: wallet.id,
            providerId: wager.providerId,
            kind: wager.kind,
            status: 'REJECTED',
            failureCode: wager.failureCode!,
          },
        }),
      );
    } else if (
      wager.status ===
        WagerTransactionStatus.PendingReference &&
      !isRetry
    ) {
      events.push(
        WagerTransactionPendingReference.from({
          ...context,
          eventId: randomUUID(),
          data: {
            transactionId: wager.id,
            walletId: wallet.id,
            providerId: wager.providerId,
            referenceExternalTransactionId:
              wager.referenceExternalTransactionId!,
            status: 'PENDING_REFERENCE',
          },
        }),
      );
    }

    // =====================================
    // OUTBOX
    // =====================================

    if (events.length > 0) {
      const rows = events.map((event) =>
        Object.assign(
          new OutboxMessageEntity(),
          {
            id: event.eventId,
            aggregateId: event.aggregateId,
            eventType: event.eventType,
            payload: event.toJSON(),
            occurredAt: event.occurredAt,
            attempts: 0,
            nextAttemptAt: null,
            publishedAt: null,
          },
        ),
      );

      tx.persist(rows);
    }

    await tx.flush();

    return this.toOutput(wagerRow, isRetry);
  }
}
