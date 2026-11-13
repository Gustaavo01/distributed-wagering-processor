
import { createHash, randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';

import { Wallet, InvalidWalletOperationError } from '../../domain/entities/wallet.js';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../../domain/entities/wallet-ledger-entry.js';
import { WagerTransaction } from '../../domain/entities/wager-transaction.js';
import { Money } from '../../domain/value-objects/money.js';
import type { MoneyProps } from '../../domain/value-objects/money.js';

import {
  WalletBalanceChanged,
  WagerTransactionProcessed,
  type IntegrationEvent,
} from '../../domain/events/integration-event.js';

import { WalletEntity } from '../../infrastructure/persistence/entities/wallet.entity.js';
import { WagerTransactionEntity } from '../../infrastructure/persistence/wager-transaction.entity.js';
import { WalletLedgerEntryEntity } from '../../infrastructure/persistence/entities/wallet-ledger-entry.entity.js';
import { OutboxMessageEntity } from '../../infrastructure/persistence/outbox-message.entity.js';
import { WalletMapper } from '../../infrastructure/mappers/wallet.mapper.js';

export interface CreateWalletInput {
  playerId: string;
  initialBalance: MoneyProps;
}

export interface CreateWalletOutput {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export class CreateWalletUseCase {
  constructor(private readonly orm: MikroORM) {}

  async execute(
    input: CreateWalletInput,
  ): Promise<CreateWalletOutput> {
    const uuidPattern =
      /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

    if (!uuidPattern.test(input.playerId)) {
      throw new InvalidWalletOperationError('Invalid playerId');
    }

    const initialBalance = Money.from(input.initialBalance);

    if (initialBalance.isNegative()) {
      throw new InvalidWalletOperationError('Initial balance cannot be negative');
    }

    const wallet = Wallet.open({
      id: randomUUID(),
      playerId: input.playerId,
      initialBalance,
    });

    const em = this.orm.em.fork();

    return em.transactional(async (tx) => {
      const walletRow = Object.assign(
        new WalletEntity(),
        WalletMapper.toPersistence(wallet),
      );

      tx.persist(walletRow);
      await tx.flush();

      if (initialBalance.isPositive()) {
        const at = new Date();

        const openingId = randomUUID();

        const hashInput = {
          amount: initialBalance.toJSON().amount,
          currency: initialBalance.currency,
          kind: 'OPENING',
          playerId: wallet.playerId,
          walletId: wallet.id,
        };

        const payloadHash = createHash('sha256')
          .update(JSON.stringify(hashInput))
          .digest('hex');

        const opening = WagerTransaction.createOpening({
          id: openingId,
          providerId: 'system',
          externalTransactionId: `opening:${wallet.id}`,
          idempotencyKey: `system:opening:${wallet.id}`,
          payloadHash,
          walletId: wallet.id,
          playerId: wallet.playerId,
          roundId: `opening:${wallet.id}`,
          gameId: 'wallet',
          money: initialBalance,
        });

        opening.markProcessed(undefined, at);

        const openingRow = Object.assign(
          new WagerTransactionEntity(),
          {
            id: opening.id,
            providerId: opening.providerId,
            externalTransactionId:
              opening.externalTransactionId,
            idempotencyKey: opening.idempotencyKey,
            payloadHash: opening.payloadHash,
            walletId: opening.walletId,
            playerId: opening.playerId,
            roundId: opening.roundId,
            gameId: opening.gameId,
            kind: opening.kind,
            amount: opening.money.toJSON().amount,
            currency: opening.money.currency,
            referenceExternalTransactionId: null,
            referenceTransactionId: null,
            status: opening.status,
            failureCode: null,
            resultBalance: wallet.balance.toJSON().amount,
            resultWalletVersion: wallet.version,
            createdAt: opening.createdAt,
            processedAt: opening.processedAt ?? null,
          },
        );

        tx.persist(openingRow);
        await tx.flush();

        const ledger = WalletLedgerEntry.create({
          id: randomUUID(),
          walletId: wallet.id,
          transactionId: opening.id,
         direction: LedgerDirection.Credit,
          money: initialBalance,
          balanceBefore: Money.zero(wallet.currency),
          balanceAfter: initialBalance,
          createdAt: at,
        });

        const ledgerRow = Object.assign(
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

        const common = {
          aggregateId: wallet.id,
          correlationId: wallet.id,
          causationId: opening.id,
          occurredAt: at,
        };

        const balanceChanged = WalletBalanceChanged.from({
          ...common,
          eventId: randomUUID(),
          data: {
            walletId: wallet.id,
            transactionId: opening.id,
            direction: LedgerDirection.Credit,
            money: initialBalance.toJSON(),
            balanceBefore: Money.zero(
              wallet.currency,
            ).toJSON(),
            balanceAfter: wallet.balance.toJSON(),
            walletVersion: wallet.version,
          },
        });

        const transactionProcessed =
          WagerTransactionProcessed.from({
            ...common,
            eventId: randomUUID(),
            data: {
              transactionId: opening.id,
              walletId: wallet.id,
              kind: opening.kind,
              status: 'PROCESSED',
              money: opening.money.toJSON(),
              balance: wallet.balance.toJSON(),
            },
          });

        const events: IntegrationEvent<object>[] = [
          balanceChanged,
          transactionProcessed,
        ];

        const outboxRows = events.map((event) =>
          Object.assign(new OutboxMessageEntity(), {
            id: event.eventId,
            aggregateId: event.aggregateId,
            eventType: event.eventType,
            payload: event.toJSON(),
            occurredAt: event.occurredAt,
            attempts: 0,
            nextAttemptAt: null,
            publishedAt: null,
          }),
        );

        tx.persist(ledgerRow);
        tx.persist(outboxRows);
        await tx.flush();
      }

      return {
        id: wallet.id,
        playerId: wallet.playerId,
        balance: wallet.balance.toJSON(),
        version: wallet.version,
      };
    }, { clear: true });
  }
}
