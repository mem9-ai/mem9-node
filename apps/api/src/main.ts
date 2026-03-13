import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Http2ServerRequest } from 'node:http2';

import { loadConfig } from '@mem9/config';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';


import { AppModule } from './app.module';
import { AppExceptionFilter } from './common/app-exception.filter';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      logger: false,
      bodyLimit: config.analysis.maxBatchBytes * 2,
      genReqId: (request: IncomingMessage | Http2ServerRequest) =>
        String(request.headers['x-request-id'] ?? randomUUID()),
    }),
    {
      bufferLogs: true,
    },
  );
  const logger = app.get(Logger);

  app.useLogger(logger);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidUnknownValues: true,
    }),
  );
  app.useGlobalFilters(new AppExceptionFilter());

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Memories Dashboard Analysis Service')
      .setDescription('Async dashboard analysis backend for MEM9 browser-uploaded memories.')
      .setVersion('1.0.0')
      .addApiKey(
        {
          type: 'apiKey',
          in: 'header',
          name: 'x-mem9-api-key',
        },
        'x-mem9-api-key',
      )
      .build(),
  );

  SwaggerModule.setup('docs', app, document);
  await app.listen(config.app.port, '0.0.0.0');
}

void bootstrap();
