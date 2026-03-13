import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { SqsConsumerService } from './sqs-consumer.service';
import { WorkerHealthServer } from './worker-health.server';
import { WorkerModule } from './worker.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    bufferLogs: true,
  });
  const healthServer = app.get(WorkerHealthServer);
  const consumer = app.get(SqsConsumerService);

  healthServer.start();
  await consumer.start();
}

void bootstrap();
