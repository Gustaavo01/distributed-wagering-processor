
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';

import { Observable } from 'rxjs';

import {
  finalize,
  tap,
} from 'rxjs/operators';

import {
  MetricsService,
} from './metrics.service.js';

interface HttpRequestInfo {
  method?: string;
  url?: string;
}

function findSqlErrorCode(
  error: unknown,
  depth = 0,
): string | undefined {
  if (
    depth > 4 ||
    typeof error !== 'object' ||
    error === null
  ) {
    return undefined;
  }

  const data = error as Record<
    string,
    unknown
  >;

  if (typeof data.code === 'string') {
    return data.code;
  }

  return (
    findSqlErrorCode(
      data.driverException,
      depth + 1,
    ) ??
    findSqlErrorCode(
      data.cause,
      depth + 1,
    )
  );
}

@Injectable()
export class MetricsInterceptor
  implements NestInterceptor {

  constructor(
    private readonly metrics: MetricsService,
  ) {}

  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const request =
      context.switchToHttp()
        .getRequest<HttpRequestInfo>();

    const path =
      request.url?.split('?')[0];

    if (
      request.method !== 'POST' ||
      path !== '/wagering/transactions'
    ) {
      return next.handle();
    }

    const started = process.hrtime.bigint();

    return next.handle().pipe(
      tap({
        error: (error: unknown) => {
          const code = findSqlErrorCode(
            error,
          );

          // deadlock_detected
          // lock_not_available
          // serialization_failure
          if (
            code === '40P01' ||
            code === '55P03' ||
            code === '40001'
          ) {
            this.metrics.recordLockConflict();
          }
        },
      }),

      finalize(() => {
        const elapsedNanoseconds =
          process.hrtime.bigint() - started;

        const seconds =
          Number(elapsedNanoseconds) / 1e9;

        this.metrics.observeHttpDuration(
          seconds,
        );
      }),
    );
  }
}
