
import {
  describe,
  expect,
  test,
} from 'bun:test';

import {
  Money,
  InvalidMoneyError,
  CurrencyMismatchError,
} from '../../src/domain/value-objects/money';

describe('Money Value Object', () => {
  test('creates money with exact decimal value', () => {
    const money = Money.from({
      amount: '100.00',
      currency: 'BRL',
    });

    expect(money.toJSON()).toEqual({
      amount: '100.00',
      currency: 'BRL',
    });
  });

  test('adds monetary values exactly', () => {
    const a = Money.from({
      amount: '0.10',
      currency: 'BRL',
    });

    const b = Money.from({
      amount: '0.20',
      currency: 'BRL',
    });

    const result = a.add(b);

    expect(result.toString()).toBe('0.30 BRL');
  });

  test('subtracts monetary values', () => {
    const balance = Money.from({
      amount: '100.00',
      currency: 'BRL',
    });

    const bet = Money.from({
      amount: '80.00',
      currency: 'BRL',
    });

    expect(balance.subtract(bet).toJSON().amount)
      .toBe('20.00');
  });

  test('does not mutate original money', () => {
    const original = Money.from({
      amount: '100.00',
      currency: 'BRL',
    });

    const result = original.add(
      Money.from({
        amount: '50.00',
        currency: 'BRL',
      }),
    );

    expect(original.toJSON().amount).toBe('100.00');
    expect(result.toJSON().amount).toBe('150.00');
  });

  test('rejects different currencies', () => {
    const brl = Money.from({
      amount: '10.00',
      currency: 'BRL',
    });

    const usd = Money.from({
      amount: '10.00',
      currency: 'USD',
    });

    expect(() => brl.add(usd))
      .toThrow(CurrencyMismatchError);
  });

  test('rejects invalid decimal input', () => {
    const invalidAmounts = [
      '',
      '10.123',
      '1e3',
      'NaN',
      'Infinity',
      '10',
      '10.5',
      '-0.00',
    ];

    for (const amount of invalidAmounts) {
      expect(() =>
        Money.from({
          amount,
          currency: 'BRL',
        }),
      ).toThrow(InvalidMoneyError);
    }
  });

  test('rejects values exceeding database range', () => {
    expect(() =>
      Money.from({
        amount: '1000000000000000000.00',
        currency: 'BRL',
      }),
    ).toThrow(InvalidMoneyError);
  });

  test('supports zero and negative calculations', () => {
    const zero = Money.zero('BRL');

    const negative = zero.subtract(
      Money.from({
        amount: '10.00',
        currency: 'BRL',
      }),
    );

    expect(zero.isZero()).toBe(true);
    expect(zero.isPositive()).toBe(false);
    expect(negative.isNegative()).toBe(true);
    expect(negative.negate().toJSON().amount)
      .toBe('10.00');
  });
});
