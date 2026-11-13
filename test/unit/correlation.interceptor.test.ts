
import {
  describe,
  expect,
  spyOn,
  test,
} from 'bun:test';

import {
  EventEmitter,
} from 'node:events';

import {
  type CallHandler,
  type ExecutionContext,
} from '@nestjs/common';

import {
  throwError,
} from 'rxjs';

import {
  CorrelationInterceptor,
} from '../../src/infrastructure/observability/correlation.interceptor.js';

class FakeResponse extends EventEmitter {
  statusCode = 200;

  readonly headers =
    new Map<string, string>();

  setHeader(
    name: string,
    value: string,
  ): void {
    this.headers.set(
      name.toLowerCase(),
      value,
    );
  }
}

interface LoggedEvent {
  event: string;
  correlationId: string;
  statusCode: number | null;
  aborted: boolean;
  errorName?: string;
}

describe('CorrelationInterceptor', () => {
  test(
    'logs the final HTTP 409 after exception handling',
    () => {
      const response =
        new FakeResponse();

      const request = {
        method: 'POST',

        url:
          '/wagering/transactions',

        route: {
          path:
            '/wagering/transactions',
        },

        headers: {
          'x-correlation-id':
            'test-conflict-123',
        },

        params: {},

        body: {
          walletId:
            'wallet-test-123',

          providerId:
            'provider-test',
        },
      };

      const context = {
        getType: () => 'http',

        switchToHttp: () => ({
          getRequest: () => request,
          getResponse: () => response,
        }),
      } as unknown as ExecutionContext;

      const error =
        new Error(
          'Idempotency conflict',
        );

      error.name =
        'IdempotencyConflictError';

      const next = {
        handle: () =>
          throwError(
            () => error,
          ),
      } as CallHandler;

      const capturedLogs: string[] = [];

      const logger = spyOn(
        console,
        'log',
      ).mockImplementation(
        (...values: unknown[]) => {
          const value = values[0];

          if (
            typeof value === 'string'
          ) {
            capturedLogs.push(value);
          }
        },
      );

      try {
        const interceptor =
          new CorrelationInterceptor();

        // O interceptor recebe primeiro
        // o erro do caso de uso.
        interceptor.intercept(
          context,
          next,
        ).subscribe({
          error: () => {
            // O exception filter do NestJS
            // trataria esse erro em seguida.
          },
        });

        // Simulamos o filtro convertendo
        // o erro de dominio para HTTP 409.
        response.statusCode = 409;

        // Somente agora a resposta terminou.
        response.emit('finish');

        // Um close posterior nao pode
        // gerar um segundo log.
        response.emit('close');

        expect(
          capturedLogs,
        ).toHaveLength(1);

        const event = JSON.parse(
          capturedLogs[0]!,
        ) as LoggedEvent;

        expect(
          event.event,
        ).toBe(
          'http_request_completed',
        );

        expect(
          event.correlationId,
        ).toBe(
          'test-conflict-123',
        );

        expect(
          event.statusCode,
        ).toBe(409);

        expect(
          event.aborted,
        ).toBe(false);

        expect(
          event.errorName,
        ).toBe(
          'IdempotencyConflictError',
        );

        expect(
          response.headers.get(
            'x-correlation-id',
          ),
        ).toBe(
          'test-conflict-123',
        );
      } finally {
        logger.mockRestore();
      }
    },
  );
});
