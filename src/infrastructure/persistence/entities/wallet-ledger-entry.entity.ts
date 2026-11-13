
import {
  Entity,
  PrimaryKey,
  Property,
} from '@mikro-orm/decorators/legacy';

import { DecimalType } from '@mikro-orm/core';

import type {
  LedgerDirection,
} from '../../../domain/entities/wallet-ledger-entry.js';

@Entity({ tableName: 'wallet_ledger_entries' })
export class WalletLedgerEntryEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({
    fieldName: 'wallet_id',
    type: 'uuid',
  })
  walletId!: string;

  @Property({
    fieldName: 'transaction_id',
    type: 'uuid',
  })
  transactionId!: string;

  @Property({
    type: 'string',
    length: 10,
  })
  direction!: LedgerDirection;

  @Property({
    type: DecimalType,
    columnType: 'numeric(20,2)',
  })
  amount!: string;

  @Property({
    type: 'string',
    length: 3,
  })
  currency!: string;

  @Property({
    fieldName: 'balance_before',
    type: DecimalType,
    columnType: 'numeric(20,2)',
  })
  balanceBefore!: string;

  @Property({
    fieldName: 'balance_after',
    type: DecimalType,
    columnType: 'numeric(20,2)',
  })
  balanceAfter!: string;

  @Property({
    fieldName: 'created_at',
    type: 'datetime',
    columnType: 'timestamptz',
  })
  createdAt!: Date;
}
