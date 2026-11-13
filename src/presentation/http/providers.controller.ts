
import {
  BadRequestException,
  Controller,
  Get,
  Param,
} from '@nestjs/common';

import {
  FinancialQueryService,
} from '../../application/queries/financial-query.services.js';

@Controller('providers')
export class ProvidersController {
  constructor(
    private readonly queries:
      FinancialQueryService,
  ) {}

  @Get(
    ':providerId/wagering/transactions/:externalTransactionId',
  )
  async getProviderTransaction(
    @Param('providerId')
    providerId: string,

    @Param('externalTransactionId')
    externalTransactionId: string,
  ) {
    if (
      !providerId.trim() ||
      providerId.length > 100 ||
      !externalTransactionId.trim() ||
      externalTransactionId.length > 160
    ) {
      throw new BadRequestException(
        'Invalid transaction identifiers',
      );
    }

    return this.queries.getTransactionByExternalId(
      providerId,
      externalTransactionId,
    );
  }
}
