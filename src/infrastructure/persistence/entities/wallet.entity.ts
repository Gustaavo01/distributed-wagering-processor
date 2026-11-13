
import {
  Entity,
  PrimaryKey,
  Property,
} from '@mikro-orm/decorators/legacy';

import { DecimalType } from '@mikro-orm/core';

@Entity({ tableName: 'wallets' })
export class WalletEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({
    fieldName: 'player_id',
    type: 'uuid',
  })
  playerId!: string;

  @Property({
    type: 'string',
    length: 3,
  })
  currency!: string;

  @Property({
    type: DecimalType,
    columnType: 'numeric(20,2)',
  })
  balance!: string;

  @Property({ type: 'integer' })
  version!: number;

  @Property({
    fieldName: 'created_at',
    type: 'datetime',
    columnType: 'timestamptz',
  })
  createdAt!: Date;

  @Property({
    fieldName: 'updated_at',
    type: 'datetime',
    columnType: 'timestamptz',
  })
  updatedAt!: Date;
}
