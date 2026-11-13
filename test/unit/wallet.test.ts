
import { describe, expect, test } from 'bun:test';

import { Money } from '../../src/domain/value-objects/money';

import {
  Wallet,
  InsufficientBalanceError,
  InvalidWalletOperationError,
} from '../../src/domain/entities/wallet';

import {
  LedgerDirection,
} from '../../src/domain/entities/wallet-ledger-entry';

function createWallet(): Wallet {
  return Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: Money.from({
      amount: '100.00',
      currency: 'BRL',
    }),
  });
}

describe('Wallet Aggregate Root', () => {
  test('opens with version 1', () => {
    const wallet = createWallet();

    expect(wallet.version).toBe(1);
    expect(wallet.balance.toJSON().amount)
      .toBe('100.00');
  });

  test('debits balance and creates ledger entry', () => {
    const wallet = createWallet();

    const entry = wallet.debit({
      ledgerEntryId: 'ledger-1',
      transactionId: 'transaction-1',
      money: Money.from({
        amount: '80.00',
        currency: 'BRL',
      }),
      at: new Date(),
    });

    expect(wallet.balance.toJSON().amount)
      .toBe('20.00');

    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.isBalanced()).toBe(true);
  });

  test('rejects debit with insufficient balance', () => {
    const wallet = createWallet();

    expect(() =>
      wallet.debit({
        ledgerEntryId: 'ledger-2',
        transactionId: 'transaction-2',
        money: Money.from({
          amount: '150.00',
          currency: 'BRL',
        }),
        at: new Date(),
      }),
    ).toThrow(InsufficientBalanceError);

    expect(wallet.balance.toJSON().amount)
      .toBe('100.00');

    expect(wallet.version).toBe(1);
  });

  test('credits balance and creates ledger entry', () => {
    const wallet = createWallet();

    const entry = wallet.credit({
      ledgerEntryId: 'ledger-3',
      transactionId: 'transaction-3',
      money: Money.from({
        amount: '50.00',
        currency: 'BRL',
      }),
      at: new Date(),
    });

    expect(wallet.balance.toJSON().amount)
      .toBe('150.00');

    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.isBalanced()).toBe(true);
  });

  test('rejects a movement in another currency', () => {
    const wallet = createWallet();

    expect(() =>
      wallet.credit({
        ledgerEntryId: 'ledger-4',
        transactionId: 'transaction-4',
        money: Money.from({
          amount: '10.00',
          currency: 'USD',
        }),
        at: new Date(),
      }),
    ).toThrow(InvalidWalletOperationError);
  });

  test('rejects zero-value movement', () => {
    const wallet = createWallet();

    expect(() =>
      wallet.debit({
        ledgerEntryId: 'ledger-5',
        transactionId: 'transaction-5',
        money: Money.zero('BRL'),
        at: new Date(),
      }),
    ).toThrow(InvalidWalletOperationError);
  });
});
