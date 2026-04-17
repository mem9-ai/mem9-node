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
import { LoggerModule } from 'nestjs-pino';
import { SentryModule } from '@sentry/nestjs/setup';

import { BatchProcessorService } from './batch-processor.service';
import { DeepAnalysisMetricsService } from './deep-analysis-metrics.service';
import { DeepAnalysisReportProcessorService } from './deep-analysis-report-processor.service';
import { LlmFallbackService } from './llm-fallback.service';
import { QwenDeepAnalysisService } from './qwen-deep-analysis.service';
import { SqsConsumerService } from './sqs-consumer.service';
import { WorkerHealthServer } from './worker-health.server';

const appConfig = loadConfig();

@Module({
  imports: [
    SentryModule.forRoot(),
    LoggerModule.forRoot({
      pinoHttp: {
        level: appConfig.app.logLevel,
      },
    }),
  ],
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
    BatchProcessorService,
    DeepAnalysisMetricsService,
    DeepAnalysisReportProcessorService,
    SqsConsumerService,
    LlmFallbackService,
    QwenDeepAnalysisService,
    WorkerHealthServer,
  ],
})
export class WorkerModule {}
