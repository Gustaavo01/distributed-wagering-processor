
import { describe, expect, test } from 'bun:test';

import { Money } from '../../src/domain/value-objects/money.js';

import { LedgerDirection } from '../../src/domain/entities/wallet-ledger-entry.js';

import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  FailureCode,
  InvalidTransactionStateError,
  InvalidWagerReferenceError,
  InvalidWagerTransactionError,
  type CreateWagerTransactionProps,
} from '../../src/domain/entities/wager-transaction.js';

const HASH = 'a'.repeat(64);

function money(amount = '80.00'): Money {
  return Money.from({
    amount,
    currency: 'BRL',
  });
}

function createTransaction(
  kind: WagerTransactionKind,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  return WagerTransaction.create({
    id: 'transaction-1',
    providerId: 'provider-a',
    externalTransactionId: 'bet-1',
    idempotencyKey: 'provider-a:bet-1',
    payloadHash: HASH,
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: money(),
    ...overrides,
  });
}

function processedBet(): WagerTransaction {
  const bet = createTransaction(WagerTransactionKind.Bet);
  bet.markProcessed(undefined, new Date());
  return bet;
}

describe('WagerTransaction', () => {
  test('starts in PENDING', () => {
    const transaction = createTransaction(
      WagerTransactionKind.Bet,
    );

    expect(transaction.status)
      .toBe(WagerTransactionStatus.Pending);

    expect(transaction.isTerminal()).toBe(false);
  });

  test('BET generates a debit direction', () => {
    const transaction = createTransaction(
      WagerTransactionKind.Bet,
    );

    expect(transaction.ledgerDirectionFor())
      .toBe(LedgerDirection.Debit);
  });

  test('WIN generates a credit direction', () => {
    const transaction = createTransaction(
      WagerTransactionKind.Win,
    );

    expect(transaction.ledgerDirectionFor())
      .toBe(LedgerDirection.Credit);
  });

  test('LOSS does not affect balance', () => {
    const transaction = createTransaction(
      WagerTransactionKind.Loss,
    );

    expect(transaction.affectsBalance()).toBe(false);

    expect(() => transaction.ledgerDirectionFor())
      .toThrow(InvalidWagerTransactionError);
  });

  test('REFUND requires reference', () => {
    expect(() =>
      createTransaction(WagerTransactionKind.Refund),
    ).toThrow(InvalidWagerTransactionError);
  });

  test('REFUND reverses processed BET', () => {
    const bet = processedBet();

    const refund = createTransaction(
      WagerTransactionKind.Refund,
      {
        id: 'refund-1',
        externalTransactionId: 'refund-1',
        referenceExternalTransactionId: 'bet-1',
      },
    );

    expect(refund.ledgerDirectionFor(bet))
      .toBe(LedgerDirection.Credit);
  });

  test('ROLLBACK of BET generates credit', () => {
    const bet = processedBet();

    const rollback = createTransaction(
      WagerTransactionKind.Rollback,
      {
        id: 'rollback-1',
        externalTransactionId: 'rollback-1',
        referenceExternalTransactionId: 'bet-1',
      },
    );

    expect(rollback.ledgerDirectionFor(bet))
      .toBe(LedgerDirection.Credit);
  });

  test('ROLLBACK of WIN generates debit', () => {
    const win = createTransaction(
      WagerTransactionKind.Win,
      {
        id: 'win-1',
        externalTransactionId: 'win-1',
      },
    );

    win.markProcessed(undefined, new Date());

    const rollback = createTransaction(
      WagerTransactionKind.Rollback,
      {
        id: 'rollback-2',
        externalTransactionId: 'rollback-2',
        referenceExternalTransactionId: 'win-1',
      },
    );

    expect(rollback.ledgerDirectionFor(win))
      .toBe(LedgerDirection.Debit);
  });

  test('rejects reference from another wallet', () => {
    const bet = processedBet();

    const refund = createTransaction(
      WagerTransactionKind.Refund,
      {
        id: 'refund-2',
        walletId: 'another-wallet',
        referenceExternalTransactionId: 'bet-1',
      },
    );

    expect(() => refund.ledgerDirectionFor(bet))
      .toThrow(InvalidWagerReferenceError);
  });

  test('rejects a partial refund', () => {
    const bet = processedBet();

    const refund = createTransaction(
      WagerTransactionKind.Refund,
      {
        id: 'refund-3',
        money: money('40.00'),
        referenceExternalTransactionId: 'bet-1',
      },
    );

    expect(() => refund.ledgerDirectionFor(bet))
      .toThrow(InvalidWagerReferenceError);
  });

  test('supports PENDING_REFERENCE', () => {
    const refund = createTransaction(
      WagerTransactionKind.Refund,
      {
        referenceExternalTransactionId: 'missing-bet',
      },
    );

    refund.markPendingReference();

    expect(refund.status)
      .toBe(WagerTransactionStatus.PendingReference);

    expect(refund.isTerminal()).toBe(false);
  });

  test('processes after reference is resolved', () => {
    const refund = createTransaction(
      WagerTransactionKind.Refund,
      {
        referenceExternalTransactionId: 'bet-1',
      },
    );

    refund.markPendingReference();
    refund.markProcessed('internal-bet-id', new Date());

    expect(refund.status)
      .toBe(WagerTransactionStatus.Processed);

    expect(refund.referenceTransactionId)
      .toBe('internal-bet-id');
  });

  test('terminal status cannot change', () => {
    const transaction = createTransaction(
      WagerTransactionKind.Bet,
    );

    transaction.markProcessed(undefined, new Date());

    expect(() =>
      transaction.reject(FailureCode.InsufficientBalance),
    ).toThrow(InvalidTransactionStateError);
  });

  test('rejection stores failure code', () => {
    const transaction = createTransaction(
      WagerTransactionKind.Bet,
    );

    transaction.reject(FailureCode.InsufficientBalance);

    expect(transaction.status)
      .toBe(WagerTransactionStatus.Rejected);

    expect(transaction.failureCode)
      .toBe(FailureCode.InsufficientBalance);

    expect(transaction.isTerminal()).toBe(true);
  });

  test('detects a different payload hash', () => {
    const transaction = createTransaction(
      WagerTransactionKind.Bet,
    );

    expect(transaction.matchesPayload(HASH)).toBe(true);
    expect(transaction.matchesPayload('b'.repeat(64)))
      .toBe(false);
  });

  test('does not allow external OPENING', () => {
    expect(() =>
      createTransaction(WagerTransactionKind.Opening),
    ).toThrow(InvalidWagerTransactionError);
  });
});
