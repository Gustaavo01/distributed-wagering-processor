
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';

import {
  CreateWalletUseCase,
} from '../../application/use-cases/create-wallet.use-case.js';

import {
  FinancialQueryService,
} from '../../application/queries/financial-query.services.js';

import {
  MetricsService,
} from '../../infrastructure/observability/metrics.service.js';

import {
  CreateWalletDto,
} from './dto/financial.dto.js';

@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly createWallet:
      CreateWalletUseCase,

    private readonly queries:
      FinancialQueryService,

    private readonly metrics:
      MetricsService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body()
    body: CreateWalletDto,
  ) {
    return this.createWallet.execute({
      playerId: body.playerId,
      initialBalance: {
        amount: body.initialBalance.amount,
        currency: body.initialBalance.currency,
      },
    });
  }

  @Get(':walletId/ledger')
  async getLedger(
    @Param('walletId', ParseUUIDPipe)
    walletId: string,

    @Query('limit')
    limitValue?: string,

    @Query('cursor')
    cursor?: string,
  ) {
    let limit = 20;

    if (limitValue !== undefined) {
      if (
        !/^[1-9]\d*$/.test(limitValue) ||
        Number(limitValue) > 100
      ) {
        throw new BadRequestException(
          'limit must be an integer between 1 and 100',
        );
      }

      limit = Number(limitValue);
    }

    return this.queries.getLedger(
      walletId,
      limit,
      cursor,
    );
  }

  @Post(':walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  async reconcile(
    @Param('walletId', ParseUUIDPipe)
    walletId: string,
  ) {
    const result =
      await this.queries.reconcileWalletContract(
        walletId,
      );

    this.metrics.recordReconciliation(
      result.consistent,
    );

    return result;
  }

  // Mantido para os testes anteriores.
  @Get(':walletId/reconciliation')
  async legacyReconciliation(
    @Param('walletId', ParseUUIDPipe)
    walletId: string,
  ) {
    return this.queries.reconcileWallet(
      walletId,
    );
  }

  @Get(':walletId')
  async getWallet(
    @Param('walletId', ParseUUIDPipe)
    walletId: string,
  ) {
    return this.queries.getWallet(
      walletId,
    );
  }
}
