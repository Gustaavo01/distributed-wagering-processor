
import { describe, expect, test } from 'bun:test';

import { Money } from '../../src/domain/value-objects/money.js';

import { Wallet } from '../../src/domain/entities/wallet.js';

import { WalletEntity } from '../../src/infrastructure/persistence/entities/wallet.entity.js';

import { WalletMapper } from '../../src/infrastructure/mappers/wallet.mapper.js';

describe('WalletMapper', () => {
  test('converts Wallet to persistence data', () => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: Money.from({
        amount: '100.00',
        currency: 'BRL',
      }),
    });

    const data = WalletMapper.toPersistence(wallet);

    expect(data.balance).toBe('100.00');
    expect(data.currency).toBe('BRL');
    expect(data.version).toBe(1);
  });

  test('rehydrates Wallet from persistence data', () => {
    const now = new Date();

    const record = Object.assign(
      new WalletEntity(),
      {
        id: 'wallet-1',
        playerId: 'player-1',
        currency: 'BRL',
        balance: '250.00',
        version: 5,
        createdAt: now,
        updatedAt: now,
      },
    );

    const wallet = WalletMapper.toDomain(record);

    expect(wallet.balance.toJSON().amount)
      .toBe('250.00');

    expect(wallet.version).toBe(5);
    expect(wallet.currency).toBe('BRL');
  });
});
