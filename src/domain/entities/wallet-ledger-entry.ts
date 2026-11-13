
import { Money } from '../value-objects/money.js';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export class InvalidLedgerEntryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidLedgerEntryError';
  }
}

export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    private readonly _createdAt: Date,
  ) {}

  get createdAt(): Date {
    return new Date(this._createdAt);
  }

  static create(
    props: LedgerEntryState,
  ): WalletLedgerEntry {
    if (
      !props.id ||
      !props.walletId ||
      !props.transactionId
    ) {
      throw new InvalidLedgerEntryError(
        'Ledger identifiers are required',
      );
    }

    if (!props.money.isPositive()) {
      throw new InvalidLedgerEntryError(
        'Ledger amount must be positive',
      );
    }

    if (
      props.direction !== LedgerDirection.Debit &&
      props.direction !== LedgerDirection.Credit
    ) {
      throw new InvalidLedgerEntryError(
        'Invalid ledger direction',
      );
    }

    const entry = new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      new Date(props.createdAt),
    );

    if (!entry.isBalanced()) {
      throw new InvalidLedgerEntryError(
        'Ledger arithmetic is inconsistent',
      );
    }

    return entry;
  }

  static rehydrate(
    state: LedgerEntryState,
  ): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      new Date(state.createdAt),
    );
  }

  isBalanced(): boolean {
    const sameCurrency =
      this.money.currency === this.balanceBefore.currency &&
      this.money.currency === this.balanceAfter.currency;

    if (!sameCurrency) {
      return false;
    }

    if (this.balanceBefore.isNegative() ||
        this.balanceAfter.isNegative()) {
      return false;
    }

    const expectedBalance =
      this.direction === LedgerDirection.Debit
        ? this.balanceBefore.subtract(this.money)
        : this.balanceBefore.add(this.money);

    return expectedBalance.equals(this.balanceAfter);
  }
}
