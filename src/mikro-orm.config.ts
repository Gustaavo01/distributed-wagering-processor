
import 'reflect-metadata';
import 'dotenv/config';

import { defineConfig } from '@mikro-orm/postgresql';
import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';
import { Migrator } from '@mikro-orm/migrations';

import {
  WalletEntity,
} from './infrastructure/persistence/entities/wallet.entity.js';

import {
  WagerTransactionEntity,
} from './infrastructure/persistence/wager-transaction.entity.js';

import {
  WalletLedgerEntryEntity,
} from './infrastructure/persistence/entities/wallet-ledger-entry.entity.js';

import {
  OutboxMessageEntity,
} from './infrastructure/persistence/outbox-message.entity.js';

import {
  InboxMessageEntity,
} from './infrastructure/persistence/inbox-message.entity.js';

export default defineConfig({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  dbName: process.env.DB_NAME,

  entities: [
    WalletEntity,
    WagerTransactionEntity,
    WalletLedgerEntryEntity,
    OutboxMessageEntity,
    InboxMessageEntity,
  ],

  metadataProvider: ReflectMetadataProvider,

  extensions: [Migrator],

  migrations: {
    path: './dist/migrations',
    pathTs: './src/migrations',
    emit: 'ts',
    transactional: true,
    allOrNothing: true,
  },
});
