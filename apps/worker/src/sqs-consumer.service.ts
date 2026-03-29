import type { Message } from '@aws-sdk/client-sqs';
import type { AppConfig } from '@mem9/config';
import { APP_CONFIG } from '@mem9/config';
import type {
  AnalysisBatchMessage,
  AnalysisLlmQueueMessage,
} from '@mem9/contracts';
import { SqsQueueService } from '@mem9/shared';
import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';

import { BatchProcessorService } from './batch-processor.service';
import { DeepAnalysisReportProcessorService } from './deep-analysis-report-processor.service';

@Injectable()
export class SqsConsumerService implements OnModuleDestroy {
  private readonly logger = new Logger(SqsConsumerService.name);
  private running = false;

  public constructor(
    private readonly queue: SqsQueueService,
    private readonly batchProcessor: BatchProcessorService,
    private readonly deepAnalysisProcessor: DeepAnalysisReportProcessorService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  public async start(): Promise<void> {
    this.running = true;
    await Promise.all([this.consumeBatchLoop(), this.consumeLlmLoop()]);
  }

  public async onModuleDestroy(): Promise<void> {
    this.running = false;
  }

  private async consumeBatchLoop(): Promise<void> {
    await this.consumeLoop<AnalysisBatchMessage>({
      receive: () => this.queue.receiveBatchMessages(5),
      extendVisibility: (receiptHandle) =>
        this.queue.extendVisibility(receiptHandle),
      deleteMessage: (receiptHandle) => this.queue.deleteMessage(receiptHandle),
      parseBody: (body) => JSON.parse(body) as AnalysisBatchMessage,
      processMessage: (payload, message) => {
        const receiveCount = Number(
          message.Attributes?.ApproximateReceiveCount ?? '1',
        );
        return this.batchProcessor.process(payload, receiveCount);
      },
      loopName: 'batch',
    });
  }

  private async consumeLlmLoop(): Promise<void> {
    await this.consumeLoop<AnalysisLlmQueueMessage>({
      receive: () => this.queue.receiveLlmMessages(5),
      extendVisibility: (receiptHandle) =>
        this.queue.extendLlmVisibility(receiptHandle),
      deleteMessage: (receiptHandle) =>
        this.queue.deleteLlmMessage(receiptHandle),
      parseBody: (body) => JSON.parse(body) as AnalysisLlmQueueMessage,
      processMessage: async (payload) => {
        if (payload.messageType === 'deep_report') {
          await this.deepAnalysisProcessor.process(payload);
        }
      },
      loopName: 'llm',
    });
  }

  private async consumeLoop<TPayload>({
    receive,
    extendVisibility,
    deleteMessage,
    parseBody,
    processMessage,
    loopName,
  }: {
    receive: () => Promise<Message[] | undefined>;
    extendVisibility: (receiptHandle: string) => Promise<void>;
    deleteMessage: (receiptHandle: string) => Promise<void>;
    parseBody: (body: string) => TPayload;
    processMessage: (payload: TPayload, message: Message) => Promise<void>;
    loopName: string;
  }): Promise<void> {
    while (this.running) {
      const messages = (await receive()) ?? [];

      if (messages.length === 0) {
        continue;
      }

      for (const message of messages) {
        await this.handleMessage({
          message,
          extendVisibility,
          deleteMessage,
          parseBody,
          processMessage,
          loopName,
        });
      }
    }
  }

  private async handleMessage<TPayload>({
    message,
    extendVisibility,
    deleteMessage,
    parseBody,
    processMessage,
    loopName,
  }: {
    message: Message;
    extendVisibility: (receiptHandle: string) => Promise<void>;
    deleteMessage: (receiptHandle: string) => Promise<void>;
    parseBody: (body: string) => TPayload;
    processMessage: (payload: TPayload, message: Message) => Promise<void>;
    loopName: string;
  }): Promise<void> {
    if (message.Body === undefined || message.ReceiptHandle === undefined) {
      return;
    }

    let payload: TPayload;
    try {
      payload = parseBody(message.Body);
    } catch (error) {
      Sentry.captureException(error);
      this.logger.error(
        `Failed to parse ${loopName} queue message`,
        error instanceof Error ? error.stack : undefined,
      );
      return;
    }

    const heartbeat = setInterval(() => {
      void extendVisibility(message.ReceiptHandle!);
    }, this.config.sqs.visibilityHeartbeatSeconds * 1000);

    try {
      await processMessage(payload, message);
      await deleteMessage(message.ReceiptHandle);
    } catch (error) {
      Sentry.captureException(error);
      this.logger.error(error);
    } finally {
      clearInterval(heartbeat);
    }
  }
}
