
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';

import { randomUUID } from 'node:crypto';

import {
  Observable,
  tap,
} from 'rxjs';

// ======================================
// HTTP TYPES
// ======================================

interface HttpRequestInfo {
  method?: string;
  url?: string;

  headers: Record<
    string,
    string | string[] | undefined
  >;

  params?: Record<string, unknown>;
  body?: unknown;

  route?: {
    path?: string;
  };

  correlationId?: string;
}

interface HttpResponseInfo {
  statusCode: number;

  setHeader(
    name: string,
    value: string,
  ): void;

  once(
    event: 'finish' | 'close',
    callback: () => void,
  ): unknown;
}

// ======================================
// HELPERS
// ======================================

const CORRELATION_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const IDENTIFIER_PATTERN =
  /^[A-Za-z0-9._:-]+$/;

function asRecord(
  value: unknown,
): Record<string, unknown> {
  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
  ) {
    return value as Record<
      string,
      unknown
    >;
  }

  return {};
}

function safeIdentifier(
  value: unknown,
): string | null {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 160 ||
    !IDENTIFIER_PATTERN.test(value)
  ) {
    return null;
  }

  return value;
}

function resolveCorrelationId(
  value: string | string[] | undefined,
): string {
  if (
    typeof value === 'string' &&
    CORRELATION_PATTERN.test(value)
  ) {
    return value;
  }

  return randomUUID();
}

// ======================================
// INTERCEPTOR
// ======================================

@Injectable()
export class CorrelationInterceptor
  implements NestInterceptor {

  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const http =
      context.switchToHttp();

    const request =
      http.getRequest<HttpRequestInfo>();

    const response =
      http.getResponse<HttpResponseInfo>();

    // ==================================
    // CORRELATION ID
    // ==================================

    const correlationId =
      resolveCorrelationId(
        request.headers[
          'x-correlation-id'
        ],
      );

    request.correlationId =
      correlationId;

    response.setHeader(
      'X-Correlation-Id',
      correlationId,
    );

    // ==================================
    // REQUEST METADATA
    // ==================================

    const startedAt =
      process.hrtime.bigint();

    const body =
      asRecord(request.body);

    const params =
      asRecord(request.params);

    const method =
      request.method ?? 'UNKNOWN';

    const route = (
      request.route?.path ??
      request.url ??
      ''
    ).split('?')[0] ?? '';

    let responseData: unknown = null;
    let errorName: string | null = null;

    let finished = false;
    let logged = false;

    // ==================================
    // LOG ONLY ON RESPONSE COMPLETION
    // ==================================

    const writeCompletionLog = (
      aborted: boolean,
    ): void => {
      if (logged) {
        return;
      }

      logged = true;

      const data =
        asRecord(responseData);

      const walletId =
        safeIdentifier(
          body.walletId,
        ) ??
        safeIdentifier(
          params.walletId,
        ) ??
        safeIdentifier(
          data.walletId,
        ) ??
        (
          method === 'POST' &&
          route === '/wallets'
            ? safeIdentifier(data.id)
            : null
        );

      const providerId =
        safeIdentifier(
          body.providerId,
        ) ??
        safeIdentifier(
          params.providerId,
        ) ??
        safeIdentifier(
          data.providerId,
        );

      const transactionId =
        safeIdentifier(
          data.transactionId,
        ) ??
        safeIdentifier(
          params.transactionId,
        ) ??
        (
          route.includes(
            'transactions',
          )
            ? safeIdentifier(data.id)
            : null
        );

      const elapsed =
        Number(
          process.hrtime.bigint() -
          startedAt,
        ) / 1e9;

      const event = {
        timestamp:
          new Date().toISOString(),

        event:
          'http_request_completed',

        correlationId,

        messageId: null,

        transactionId,
        walletId,
        providerId,

        method,
        route,

        // Em finish, este eh o codigo
        // definitivo apos o exception filter.
        //
        // Em close prematuro, nao inventamos
        // um codigo HTTP de resposta.
        statusCode: aborted
          ? null
          : response.statusCode,

        aborted,

        durationSeconds:
          Number(
            elapsed.toFixed(6),
          ),

        ...(errorName
          ? { errorName }
          : {}),
      };

      // Uma unica linha JSON.
      // Sem dados financeiros completos
      // ou cabecalhos sensiveis.
      console.log(
        JSON.stringify(event),
      );
    };

    // "finish" significa que a resposta
    // HTTP terminou de ser escrita.
    response.once(
      'finish',
      () => {
        finished = true;

        writeCompletionLog(false);
      },
    );

    // "close" tambem pode ocorrer quando
    // o cliente desconecta antecipadamente.
    response.once(
      'close',
      () => {
        if (!finished) {
          writeCompletionLog(true);
        }
      },
    );

    // ==================================
    // CAPTURE RESULT / ERROR
    // ==================================

    return next.handle().pipe(
      tap({
        next: (
          result: unknown,
        ) => {
          responseData = result;
        },

        error: (
          error: unknown,
        ) => {
          errorName =
            error instanceof Error
              ? error.name
              : 'UnknownError';
        },
      }),
    );
  }
}
