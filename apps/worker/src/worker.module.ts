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


import { BatchProcessorService } from './batch-processor.service';
import { LlmFallbackService } from './llm-fallback.service';
import { SqsConsumerService } from './sqs-consumer.service';
import { WorkerHealthServer } from './worker-health.server';

const appConfig = loadConfig();

@Module({
  imports: [
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
    SqsConsumerService,
    LlmFallbackService,
    WorkerHealthServer,
  ],
})
export class WorkerModule {}
