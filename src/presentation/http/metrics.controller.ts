
import {
  Controller,
  Get,
  Header,
  Headers,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

import {
  createHash,
  timingSafeEqual,
} from 'node:crypto';

import {
  MetricsService,
} from '../../infrastructure/observability/metrics.service.js';

function secureEquals(
  received: string,
  expected: string,
): boolean {
  const left = createHash('sha256')
    .update(received)
    .digest();

  const right = createHash('sha256')
    .update(expected)
    .digest();

  return timingSafeEqual(left, right);
}

@Controller('metrics')
export class MetricsController {
  constructor(
    private readonly metrics: MetricsService,
  ) {}

  @Get()
  @Header(
    'Content-Type',
    'text/plain; version=0.0.4; charset=utf-8',
  )
  async getMetrics(
    @Headers('authorization')
    authorization?: string,
  ): Promise<string> {
    const configuredToken =
      process.env.METRICS_TOKEN?.trim();

    if (
      !configuredToken &&
      process.env.NODE_ENV === 'production'
    ) {
      throw new ServiceUnavailableException(
        'METRICS_TOKEN must be configured in production',
      );
    }

    if (configuredToken) {
      const prefix = 'Bearer ';

      if (
        !authorization?.startsWith(prefix) ||
        !secureEquals(
          authorization.slice(prefix.length),
          configuredToken,
        )
      ) {
        throw new UnauthorizedException(
          'Invalid metrics authorization',
        );
      }
    }

    return this.metrics.renderPrometheus();
  }
}
