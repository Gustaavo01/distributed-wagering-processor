
import { Decimal } from 'decimal.js';

export interface MoneyProps {
  amount: string;
  currency: string;
}

export class InvalidMoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMoneyError';
  }
}

export class CurrencyMismatchError extends Error {
  constructor() {
    super('Cannot operate with different currencies');
    this.name = 'CurrencyMismatchError';
  }
}

const ExactDecimal = Decimal.clone({
  precision: 40,
});

export class Money {
  private static readonly AMOUNT_PATTERN =
    /^-?(?:0|[1-9]\d*)\.\d{2}$/;

  private static readonly MAX_AMOUNT =
    new ExactDecimal('999999999999999999.99');

  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {
    if (
      !value.isFinite() ||
      value.decimalPlaces() > 2 ||
      value.abs().greaterThan(Money.MAX_AMOUNT)
    ) {
      throw new InvalidMoneyError(
        'Invalid monetary amount',
      );
    }
  }

  static from(props: MoneyProps): Money {
    if (
      !props ||
      typeof props.amount !== 'string' ||
      !Money.AMOUNT_PATTERN.test(props.amount) ||
      props.amount === '-0.00'
    ) {
      throw new InvalidMoneyError(
        'Amount must be a decimal string with 2 places',
      );
    }

    if (
      typeof props.currency !== 'string' ||
      !/^[A-Z]{3}$/.test(props.currency)
    ) {
      throw new InvalidMoneyError(
        'Invalid currency format',
      );
    }

    return new Money(
      new ExactDecimal(props.amount),
      props.currency,
    );
  }

  static zero(currency: string): Money {
    return Money.from({
      amount: '0.00',
      currency,
    });
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);

    return new Money(
      this.value.plus(other.value),
      this.currency,
    );
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);

    return new Money(
      this.value.minus(other.value),
      this.currency,
    );
  }

  negate(): Money {
    return new Money(
      this.value.negated(),
      this.currency,
    );
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);

    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);

    return this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return {
      amount: this.value.toFixed(2),
      currency: this.currency,
    };
  }

  toString(): string {
    return `${this.value.toFixed(2)} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError();
    }
  }
}
