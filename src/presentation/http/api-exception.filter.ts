
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';

import {
  randomUUID,
} from 'node:crypto';

import {
  IdempotencyConflictError,
  WalletNotFoundError,
} from '../../application/use-cases/process-wager-transaction.use-case.js';

import {
  InvalidMoneyError,
  CurrencyMismatchError,
} from '../../domain/value-objects/money.js';

import {
  InvalidWalletOperationError,
} from '../../domain/entities/wallet.js';

import {
  InvalidWagerTransactionError,
  InvalidWagerReferenceError,
  InvalidTransactionStateError,
} from '../../domain/entities/wager-transaction.js';

interface HttpResponse {
  status(code: number): {
    json(body: unknown): void;
  };
}

interface HttpRequest {
  method?: string;
  url?: string;
}

function isUniqueViolation(
  exception: unknown,
): boolean {
  if (
    exception instanceof Error &&
    exception.name ===
      'UniqueConstraintViolationException'
  ) {
    return true;
  }

  if (
    typeof exception !== 'object' ||
    exception === null
  ) {
    return false;
  }

  const value = exception as {
    code?: unknown;
    cause?: {
      code?: unknown;
    };
    driverException?: {
      code?: unknown;
    };
  };

  return (
    value.code === '23505' ||
    value.cause?.code === '23505' ||
    value.driverException?.code === '23505'
  );
}

@Catch()
export class ApiExceptionFilter
  implements ExceptionFilter {

  private readonly logger =
    new Logger(ApiExceptionFilter.name);

  catch(
    exception: unknown,
    host: ArgumentsHost,
  ): void {
    const context = host.switchToHttp();

    const response =
      context.getResponse<HttpResponse>();

    const request =
      context.getRequest<HttpRequest>();

    const traceId = randomUUID();

    let status: number =
      HttpStatus.INTERNAL_SERVER_ERROR;

    let message: string | string[] =
      'Internal server error';

    if (exception instanceof HttpException) {
      status = exception.getStatus();

      const payload: unknown =
        exception.getResponse();

      if (typeof payload === 'string') {
        message = payload;
      } else if (
        typeof payload === 'object' &&
        payload !== null &&
        'message' in payload
      ) {
        const value = payload.message;

        if (
          typeof value === 'string' ||
          (
            Array.isArray(value) &&
            value.every(
              (item) => typeof item === 'string',
            )
          )
        ) {
          message = value as string | string[];
        } else {
          message = exception.message;
        }
      } else {
        message = exception.message;
      }
    } else if (
      exception instanceof IdempotencyConflictError ||
      isUniqueViolation(exception)
    ) {
      status = HttpStatus.CONFLICT;
      message = 'Resource or idempotency conflict';
    } else if (
      exception instanceof WalletNotFoundError
    ) {
      status = HttpStatus.NOT_FOUND;
      message = exception.message;
    } else if (
      exception instanceof InvalidMoneyError ||
      exception instanceof CurrencyMismatchError ||
      exception instanceof InvalidWalletOperationError ||
      exception instanceof InvalidWagerTransactionError ||
      exception instanceof InvalidWagerReferenceError ||
      exception instanceof InvalidTransactionStateError
    ) {
      status = HttpStatus.UNPROCESSABLE_ENTITY;
      message = exception.message;
    }

    if (status >= 500) {
      this.logger.error(
        JSON.stringify({
          event: 'http_request_failed',
          traceId,
          method: request.method,
          path: request.url,
          errorName:
            exception instanceof Error
              ? exception.name
              : 'UnknownError',
        }),
      );
    }

    response.status(status).json({
      statusCode: status,
      message,
      traceId,
      timestamp: new Date().toISOString(),
      path: request.url ?? '',
    });
  }
}