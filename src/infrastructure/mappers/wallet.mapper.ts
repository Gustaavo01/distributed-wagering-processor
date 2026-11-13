
import {
  Wallet,
} from '../../domain/entities/wallet.js';

import {
  Money,
} from '../../domain/value-objects/money.js';

import {
  WalletEntity,
} from '../persistence/entities/wallet.entity.js';

export type WalletPersistenceData = Pick<
  WalletEntity,
  | 'id'
  | 'playerId'
  | 'currency'
  | 'balance'
  | 'version'
  | 'createdAt'
  | 'updatedAt'
>;

export class WalletMapper {
  static toDomain(
    entity: WalletEntity,
  ): Wallet {
    const balance = Money.from({
      amount: entity.balance,
      currency: entity.currency,
    });

    return Wallet.rehydrate({
      id: entity.id,
      playerId: entity.playerId,
      currency: entity.currency,
      balance,
      version: entity.version,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    });
  }

  static toPersistence(
    wallet: Wallet,
  ): WalletPersistenceData {
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance.toJSON().amount,
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    };
  }
}
