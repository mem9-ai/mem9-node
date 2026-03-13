import { loadConfig, APP_CONFIG } from '@mem9/config';
import {
  AnalysisRepository,
  AwsClientFactory,
  GoVerifyService,
  PrismaService,
  RateLimitWindowService,
  RedisService,
  S3PayloadStorageService,
  SqsQueueService,
  TaxonomyCacheService,
} from '@mem9/shared';
import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';


import { AnalysisJobsController } from './analysis-jobs.controller';
import { AnalysisJobsService } from './analysis-jobs.service';
import { ApiKeyGuard } from './common/api-key.guard';
import { HealthService } from './common/health.service';
import { RateLimitGuard } from './common/rate-limit.guard';
import { RequestAuditInterceptor } from './common/request-audit.interceptor';
import { HealthController } from './health.controller';

const appConfig = loadConfig();

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: appConfig.app.logLevel,
        redact: {
          paths: ['req.headers.x-mem9-api-key', 'req.headers.authorization'],
          censor: '[REDACTED]',
        },
        transport:
          appConfig.app.env === 'development'
            ? {
                target: 'pino-pretty',
                options: {
                  singleLine: true,
                  translateTime: 'SYS:standard',
                },
              }
            : undefined,
      },
    }),
  ],
  controllers: [AnalysisJobsController, HealthController],
  providers: [
    {
      provide: APP_CONFIG,
      useValue: appConfig,
    },
    PrismaService,
    RedisService,
    AnalysisRepository,
    AwsClientFactory,
    S3PayloadStorageService,
    SqsQueueService,
    TaxonomyCacheService,
    GoVerifyService,
    RateLimitWindowService,
    AnalysisJobsService,
    ApiKeyGuard,
    RateLimitGuard,
    HealthService,
    {
      provide: APP_INTERCEPTOR,
      useClass: RequestAuditInterceptor,
    },
  ],
})
export class AppModule {}
