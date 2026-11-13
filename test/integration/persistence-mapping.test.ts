
import { describe, expect, test } from 'bun:test';

import { MikroORM } from '@mikro-orm/postgresql';

import config from '../../src/mikro-orm.config.js';

import { WalletEntity } from '../../src/infrastructure/persistence/entities/wallet.entity.js';

import { WagerTransactionEntity } from '../../src/infrastructure/persistence/wager-transaction.entity.js';

import { WalletLedgerEntryEntity } from '../../src/infrastructure/persistence/entities/wallet-ledger-entry.entity.js';

describe('PostgreSQL persistence mapping', () => {
  test('reads the three existing tables', async () => {
    const orm = await MikroORM.init(config);

    try {
      const em = orm.em.fork();

      const wallets = await em.find(
        WalletEntity,
        {},
        { limit: 1 },
      );

      const transactions = await em.find(
        WagerTransactionEntity,
        {},
        { limit: 1 },
      );

      const ledger = await em.find(
        WalletLedgerEntryEntity,
        {},
        { limit: 1 },
      );

      expect(Array.isArray(wallets)).toBe(true);
      expect(Array.isArray(transactions)).toBe(true);
      expect(Array.isArray(ledger)).toBe(true);
    } finally {
      await orm.close();
    }
  });
});
