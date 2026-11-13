
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';

import {
  ProcessWagerTransactionUseCase,
} from '../../application/use-cases/process-wager-transaction.use-case.js';

import {
  FinancialQueryService,
} from '../../application/queries/financial-query.services.js';

import {
  WagerTransactionStatus,
} from '../../domain/entities/wager-transaction.js';

import {
  MetricsService,
} from '../../infrastructure/observability/metrics.service.js';

import {
  ProcessWagerDto,
} from './dto/financial.dto.js';

interface HttpStatusResponse {
  status(statusCode: number): unknown;
}

function getHttpStatus(
  status: WagerTransactionStatus,
): number {
  switch (status) {
    case WagerTransactionStatus.Processed:
      return HttpStatus.OK;

    case WagerTransactionStatus.Pending:
    case WagerTransactionStatus.PendingReference:
      return HttpStatus.ACCEPTED;

    case WagerTransactionStatus.Rejected:
      return HttpStatus.UNPROCESSABLE_ENTITY;

    case WagerTransactionStatus.Failed:
      return HttpStatus.SERVICE_UNAVAILABLE;

    default:
      throw new InternalServerErrorException(
        'Unexpected transaction status',
      );
  }
}

@Controller('wagering')
export class WageringController {
  constructor(
    private readonly processor:
      ProcessWagerTransactionUseCase,

    private readonly queries:
      FinancialQueryService,

    private readonly metrics:
      MetricsService,
  ) {}

  @Post('transactions')
  @HttpCode(HttpStatus.OK)
  async process(
    @Body()
    body: ProcessWagerDto,

    @Headers('idempotency-key')
    idempotencyKey: string | undefined,

    @Res({ passthrough: true })
    response: HttpStatusResponse,
  ) {
    if (
      !idempotencyKey ||
      !idempotencyKey.trim() ||
      idempotencyKey.length > 256
    ) {
      throw new BadRequestException(
        'Idempotency-Key header is required',
      );
    }

    const result = await this.processor.execute({
      providerId: body.providerId,

      externalTransactionId:
        body.externalTransactionId,

      idempotencyKey: idempotencyKey.trim(),

      walletId: body.walletId,
      playerId: body.playerId,
      roundId: body.roundId,
      gameId: body.gameId,
      kind: body.kind,

      money: {
        amount: body.money.amount,
        currency: body.money.currency,
      },

      referenceExternalTransactionId:
        body.referenceExternalTransactionId,
    });

    this.metrics.recordHttpWager(
      result.status,
      result.idempotentReplay,
    );

    response.status(
      getHttpStatus(result.status),
    );

    return result;
  }

  @Get('transactions/:transactionId')
  async getTransaction(
    @Param('transactionId', ParseUUIDPipe)
    transactionId: string,
  ) {
    return this.queries.getTransaction(
      transactionId,
    );
  }
}
