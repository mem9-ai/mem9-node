import type { Message } from '@aws-sdk/client-sqs';
import type { AppConfig } from '@mem9/config';
import { APP_CONFIG } from '@mem9/config';
import type {
  AnalysisBatchMessage,
  AnalysisLlmQueueMessage,
} from '@mem9/contracts';
import { AppError, SqsQueueService } from '@mem9/shared';
import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';

import { BatchProcessorService } from './batch-processor.service';
import { DeepAnalysisReportProcessorService } from './deep-analysis-report-processor.service';
import { MemoryAnalysisReportProcessorService } from './memory-analysis-report-processor.service';

type QueueLoopName = 'batch' | 'llm';
type QueueFailureEvent =
  | 'queue_message_parse_failed'
  | 'queue_message_processing_failed'
  | 'queue_visibility_extension_failed';

const SAFE_PROCESSING_ERROR_CODES = new Set([
  'INVALID_QUEUE_CREDENTIAL',
  'INVALID_QUEUE_OWNER',
  'INVALID_REPORT_MESSAGE',
  'INVALID_BATCH_MESSAGE',
  'INVALID_BATCH_PAYLOAD',
  'PAYLOAD_HASH_VALIDATION_FAILED',
  'ANALYSIS_JOB_NOT_FOUND',
  'ANALYSIS_BATCH_NOT_FOUND',
  'DEEP_ANALYSIS_REPORT_NOT_FOUND',
  'DEEP_ANALYSIS_LEASE_LOST',
]);

@Injectable()
export class SqsConsumerService implements OnModuleDestroy {
  private readonly logger = new Logger(SqsConsumerService.name);
  private running = false;

  public constructor(
    private readonly queue: SqsQueueService,
    private readonly batchProcessor: BatchProcessorService,
    private readonly deepAnalysisProcessor: DeepAnalysisReportProcessorService,
    private readonly memoryAnalysisProcessor: MemoryAnalysisReportProcessorService,
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
          return;
        }
        if (payload.messageType === 'memory_analysis_report') {
          await this.memoryAnalysisProcessor.process(payload);
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
    loopName: QueueLoopName;
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
    loopName: QueueLoopName;
  }): Promise<void> {
    if (message.Body === undefined || message.ReceiptHandle === undefined) {
      return;
    }

    let payload: TPayload;
    try {
      payload = parseBody(message.Body);
    } catch {
      // JSON.parse errors can embed the queue body, including legacy credentials.
      this.reportQueueFailure(loopName, 'queue_message_parse_failed', 'QUEUE_MESSAGE_INVALID_JSON');
      return;
    }

    const heartbeat = setInterval(() => {
      void extendVisibility(message.ReceiptHandle!).catch(() => {
        this.reportQueueFailure(loopName, 'queue_visibility_extension_failed', 'QUEUE_VISIBILITY_EXTENSION_FAILED');
      });
    }, this.config.sqs.visibilityHeartbeatSeconds * 1000);

    try {
      await processMessage(payload, message);
      await deleteMessage(message.ReceiptHandle);
    } catch (error) {
      const code = error instanceof AppError && SAFE_PROCESSING_ERROR_CODES.has(error.code)
        ? error.code
        : 'QUEUE_MESSAGE_PROCESSING_FAILED';
      this.reportQueueFailure(loopName, 'queue_message_processing_failed', code);
    } finally {
      clearInterval(heartbeat);
    }
  }

  private reportQueueFailure(queue: QueueLoopName, event: QueueFailureEvent, code: string): void {
    // Do not forward the original error, stack, cause, body, or receipt handle.
    // Structured logger redaction cannot sanitize arbitrary exception strings.
    const error = new AppError('Queue operation failed', { statusCode: 500, code });
    Sentry.captureException(error, { tags: { event, queue } });
    this.logger.error(JSON.stringify({ event, queue, code }));
  }
}
