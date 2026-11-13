
import type { MoneyProps } from '../value-objects/money.js';

import type {
  LedgerDirection,
} from '../entities/wallet-ledger-entry.js';

import type {
  FailureCode,
  WagerTransactionKind,
} from '../entities/wager-transaction.js';

// ===============================
// BASE EVENT
// ===============================

export interface IntegrationEventProps<T extends object> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: T;
}

export abstract class IntegrationEvent<T extends object> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = new Date(props.occurredAt);
    this.data = Object.freeze({ ...props.data });
  }

  toJSON(): Record<string, unknown> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      causationId: this.causationId,
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data,
    };
  }
}

// ===============================
// WALLET BALANCE CHANGED
// ===============================

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged
  extends IntegrationEvent<WalletBalanceChangedData> {

  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(
    props: IntegrationEventProps<WalletBalanceChangedData>,
  ): WalletBalanceChanged {
    return new WalletBalanceChanged(props);
  }
}

// ===============================
// WAGER TRANSACTION PROCESSED
// ===============================

export interface WagerTransactionProcessedData {
  transactionId: string;
  walletId: string;
  kind: WagerTransactionKind;
  status: 'PROCESSED';
  money: MoneyProps;
  balance: MoneyProps;
}

export class WagerTransactionProcessed
  extends IntegrationEvent<WagerTransactionProcessedData> {

  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(
    props: IntegrationEventProps<WagerTransactionProcessedData>,
  ): WagerTransactionProcessed {
    return new WagerTransactionProcessed(props);
  }
}

// ===============================
// WAGER TRANSACTION REJECTED
// ===============================

export interface WagerTransactionRejectedData {
  transactionId: string;
  walletId: string;
  providerId: string;
  kind: WagerTransactionKind;
  status: 'REJECTED';
  failureCode: FailureCode;
}

export class WagerTransactionRejected
  extends IntegrationEvent<WagerTransactionRejectedData> {

  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(
    props: IntegrationEventProps<WagerTransactionRejectedData>,
  ): WagerTransactionRejected {
    return new WagerTransactionRejected(props);
  }
}

// ===============================
// WAGER TRANSACTION PENDING REFERENCE
// ===============================

export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  walletId: string;
  providerId: string;
  referenceExternalTransactionId: string;
  status: 'PENDING_REFERENCE';
}

export class WagerTransactionPendingReference
  extends IntegrationEvent<WagerTransactionPendingReferenceData> {

  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(
    props: IntegrationEventProps<WagerTransactionPendingReferenceData>,
  ): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference(props);
  }
}
