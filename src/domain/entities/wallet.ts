
import { Money } from '../value-objects/money.js';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from './wallet-ledger-entry.js';

export class InsufficientBalanceError extends Error {
  constructor() {
    super('Insufficient wallet balance');
    this.name = 'InsufficientBalanceError';
  }
}

export class InvalidWalletOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWalletOperationError';
  }
}

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WalletMovementProps {
  ledgerEntryId: string;
  transactionId: string;
  money: Money;
  at: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    private readonly _createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
  }): Wallet {
    if (!props.id || !props.playerId) {
      throw new InvalidWalletOperationError(
        'Wallet identifiers are required',
      );
    }

    if (props.initialBalance.isNegative()) {
      throw new InvalidWalletOperationError(
        'Initial balance cannot be negative',
      );
    }

    const now = new Date();

    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      now,
      now,
    );
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      new Date(state.createdAt),
      new Date(state.updatedAt),
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get createdAt(): Date {
    return new Date(this._createdAt);
  }

  get updatedAt(): Date {
    return new Date(this._updatedAt);
  }

  debit(props: WalletMovementProps): WalletLedgerEntry {
    this.assertValidMovement(props.money);

    if (this._balance.isLessThan(props.money)) {
      throw new InsufficientBalanceError();
    }

    const balanceBefore = this._balance;
    const balanceAfter = balanceBefore.subtract(props.money);

    const entry = WalletLedgerEntry.create({
      id: props.ledgerEntryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction: LedgerDirection.Debit,
      money: props.money,
      balanceBefore,
      balanceAfter,
      createdAt: props.at,
    });

    this._balance = balanceAfter;
    this._version++;
    this._updatedAt = new Date(props.at);

    return entry;
  }

  credit(props: WalletMovementProps): WalletLedgerEntry {
    this.assertValidMovement(props.money);

    const balanceBefore = this._balance;
    const balanceAfter = balanceBefore.add(props.money);

    const entry = WalletLedgerEntry.create({
      id: props.ledgerEntryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction: LedgerDirection.Credit,
      money: props.money,
      balanceBefore,
      balanceAfter,
      createdAt: props.at,
    });

    this._balance = balanceAfter;
    this._version++;
    this._updatedAt = new Date(props.at);

    return entry;
  }

  private assertValidMovement(money: Money): void {
    if (money.currency !== this.currency) {
      throw new InvalidWalletOperationError(
        'Currency mismatch',
      );
    }

    if (!money.isPositive()) {
      throw new InvalidWalletOperationError(
        'Movement amount must be positive',
      );
    }
  }
}
