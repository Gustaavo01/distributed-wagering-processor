
import 'reflect-metadata';
import 'dotenv/config';

import {
  ValidationPipe,
} from '@nestjs/common';

import {
  NestFactory,
} from '@nestjs/core';

import {
  AppModule,
} from './app.module.js';

import {
  ApiExceptionFilter,
} from './presentation/http/api-exception.filter.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(
    AppModule,
  );

  app.enableShutdownHooks();

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: false,
      },
      stopAtFirstError: true,
    }),
  );

  app.useGlobalFilters(
    new ApiExceptionFilter(),
  );

  const port = Number(
    process.env.PORT ?? 3000,
  );

  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new Error(
      'Invalid application port',
    );
  }

  await app.listen(
    port,
    '0.0.0.0',
  );

  console.log(
    JSON.stringify({
      event: 'application_started',
      port,
    }),
  );
}

void bootstrap().catch(
  (error: unknown) => {
    console.error(
      'Application startup failed:',
      error,
    );

    process.exitCode = 1;
  },
);