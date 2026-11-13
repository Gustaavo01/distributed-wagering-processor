
import {
  Controller,
  Get,
  ServiceUnavailableException,
} from '@nestjs/common';

import { MikroORM } from '@mikro-orm/postgresql';

import {
  SqsService,
} from '../../infrastructure/messaging/sqs.service.js';

@Controller('health')
export class HealthController {
  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SqsService,
  ) {}

  @Get('live')
  live() {
    return {
      status: 'ok',
      service: 'distributed-wagering-processor',
      timestamp: new Date().toISOString(),
    };
  }

  @Get('ready')
  async ready() {
    const dependencies = {
      postgres: false,
      sqs: false,
    };

    try {
      const result = await this.orm.em
        .fork()
        .execute<Array<{ ok: number }>>(
          'SELECT 1 AS ok',
        );

      dependencies.postgres =
        result[0]?.ok === 1;
    } catch {
      dependencies.postgres = false;
    }

    try {
      dependencies.sqs =
        await this.sqs.checkConnection();
    } catch {
      dependencies.sqs = false;
    }

    if (
      !dependencies.postgres ||
      !dependencies.sqs
    ) {
      throw new ServiceUnavailableException({
        status: 'not_ready',
        dependencies,
      });
    }

    return {
      status: 'ready',
      dependencies,
      timestamp: new Date().toISOString(),
    };
  }
}