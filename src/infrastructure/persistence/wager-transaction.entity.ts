
import {
  Entity,
  PrimaryKey,
  Property,
} from '@mikro-orm/decorators/legacy';

import { DecimalType } from '@mikro-orm/core';

import type {
  WagerTransactionKind,
  WagerTransactionStatus,
  FailureCode,
} from '../../domain/entities/wager-transaction.js';

@Entity({ tableName: 'wager_transactions' })
export class WagerTransactionEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({
    fieldName: 'provider_id',
    length: 100,
  })
  providerId!: string;

  @Property({
    fieldName: 'external_transaction_id',
    length: 160,
  })
  externalTransactionId!: string;

  @Property({
    fieldName: 'idempotency_key',
    length: 256,
  })
  idempotencyKey!: string;

  @Property({
    fieldName: 'payload_hash',
    length: 64,
  })
  payloadHash!: string;

  @Property({
    fieldName: 'wallet_id',
    type: 'uuid',
  })
  walletId!: string;

  @Property({
    fieldName: 'player_id',
    type: 'uuid',
  })
  playerId!: string;

  @Property({
    fieldName: 'round_id',
    length: 160,
  })
  roundId!: string;

  @Property({
    fieldName: 'game_id',
    length: 160,
  })
  gameId!: string;

  @Property({
    type: 'string',
    length: 20,
  })
  kind!: WagerTransactionKind;

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
    fieldName: 'reference_external_transaction_id',
    type: 'string',
    length: 160,
    nullable: true,
  })
  referenceExternalTransactionId?: string | null;

  @Property({
    fieldName: 'reference_transaction_id',
    type: 'uuid',
    nullable: true,
  })
  referenceTransactionId?: string | null;

  @Property({
    type: 'string',
    length: 30,
  })
  status!: WagerTransactionStatus;

  @Property({
    fieldName: 'failure_code',
    type: 'string',
    length: 100,
    nullable: true,
  })
  failureCode?: FailureCode | null;

  @Property({
    fieldName: 'result_balance',
    type: DecimalType,
    columnType: 'numeric(20,2)',
    nullable: true,
  })
  resultBalance?: string | null;

  @Property({
    fieldName: 'result_wallet_version',
    type: 'integer',
    nullable: true,
  })
  resultWalletVersion?: number | null;

  @Property({
    fieldName: 'created_at',
    type: 'datetime',
    columnType: 'timestamptz',
  })
  createdAt!: Date;

  @Property({
    fieldName: 'processed_at',
    type: 'datetime',
    columnType: 'timestamptz',
    nullable: true,
  })
  processedAt?: Date | null;

  // Migration202611130003
  // Controle de reprocessamento de referencias

  @Property({
    fieldName: 'reference_attempts',
    type: 'integer',
  })
  referenceAttempts: number = 0;

  @Property({
    fieldName: 'reference_next_retry_at',
    type: 'datetime',
    columnType: 'timestamptz',
    nullable: true,
  })
  referenceNextRetryAt?: Date | null;

  @Property({
    fieldName: 'reference_expires_at',
    type: 'datetime',
    columnType: 'timestamptz',
    nullable: true,
  })
  referenceExpiresAt?: Date | null;
}
