
import { Module } from '@nestjs/common';

import {
  APP_INTERCEPTOR,
} from '@nestjs/core';

import {
  MikroOrmModule,
} from '@mikro-orm/nestjs';

import {
  MikroORM,
} from '@mikro-orm/postgresql';

import mikroOrmConfig from './mikro-orm.config.js';

import {
  AppController,
} from './app.controller.js';

import {
  AppService,
} from './app.service.js';

import {
  CreateWalletUseCase,
} from './application/use-cases/create-wallet.use-case.js';

import {
  ProcessWagerTransactionUseCase,
} from './application/use-cases/process-wager-transaction.use-case.js';

import {
  FinancialQueryService,
} from './application/queries/financial-query.services.js';

import {
  WalletsController,
} from './presentation/http/wallets.controller.js';

import {
  WageringController,
} from './presentation/http/wagering.controller.js';

import {
  ProvidersController,
} from './presentation/http/providers.controller.js';

import {
  HealthController,
} from './presentation/http/health.controller.js';

import {
  MetricsController,
} from './presentation/http/metrics.controller.js';

import {
  MetricsService,
} from './infrastructure/observability/metrics.service.js';

import {
  MetricsInterceptor,
} from './infrastructure/observability/metrics.interceptor.js';

import {
  CorrelationInterceptor,
} from './infrastructure/observability/correlation.interceptor.js';

import {
  PendingReferenceWorker,
} from './infrastructure/workers/pending-reference.worker.js';

import {
  OutboxPublisher,
} from './infrastructure/workers/outbox.publisher.js';

import {
  SqsService,
} from './infrastructure/messaging/sqs.service.js';

import {
  WagerSqsConsumer,
} from './infrastructure/messaging/wager-sqs.consumer.js';

@Module({
  imports: [
    MikroOrmModule.forRoot(mikroOrmConfig),
  ],

  controllers: [
    AppController,
    WalletsController,
    WageringController,
    ProvidersController,
    HealthController,
    MetricsController,
  ],

  providers: [
    AppService,

    FinancialQueryService,

    MetricsService,

    {
      provide: APP_INTERCEPTOR,
      useClass: CorrelationInterceptor,
    },

    {
      provide: APP_INTERCEPTOR,
      useClass: MetricsInterceptor,
    },

    {
      provide: CreateWalletUseCase,
      useFactory: (orm: MikroORM) =>
        new CreateWalletUseCase(orm),
      inject: [MikroORM],
    },

    {
      provide: ProcessWagerTransactionUseCase,
      useFactory: (orm: MikroORM) =>
        new ProcessWagerTransactionUseCase(orm),
      inject: [MikroORM],
    },

    SqsService,
    PendingReferenceWorker,
    OutboxPublisher,
    WagerSqsConsumer,
  ],
})
export class AppModule {}
