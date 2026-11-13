
import { Type } from 'class-transformer';

import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

import {
  WagerTransactionKind,
} from '../../../domain/entities/wager-transaction.js';

export class MoneyHttpDto {
  @IsString()
  @Matches(/^(0|[1-9]\d*)\.\d{2}$/)
  amount!: string;

  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency!: string;
}

export class CreateWalletDto {
  @IsUUID()
  playerId!: string;

  @ValidateNested()
  @Type(() => MoneyHttpDto)
  initialBalance!: MoneyHttpDto;
}

export class ProcessWagerDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  providerId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(160)
  externalTransactionId!: string;

  @IsUUID()
  walletId!: string;

  @IsUUID()
  playerId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(160)
  roundId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(160)
  gameId!: string;

  @IsEnum(WagerTransactionKind)
  kind!: WagerTransactionKind;

  @ValidateNested()
  @Type(() => MoneyHttpDto)
  money!: MoneyHttpDto;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  referenceExternalTransactionId?: string;
}
