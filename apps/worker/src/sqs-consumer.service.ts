
import type { AnalysisBatchMessage } from '@mem9/contracts';
import { SqsQueueService } from '@mem9/shared';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';

import { BatchProcessorService } from './batch-processor.service';

@Injectable()
export class SqsConsumerService implements OnModuleDestroy {
  private readonly logger = new Logger(SqsConsumerService.name);
  private running = false;

  public constructor(
    private readonly queue: SqsQueueService,
    private readonly batchProcessor: BatchProcessorService,
  ) {}

  public async start(): Promise<void> {
    this.running = true;

    while (this.running) {
      const messages = (await this.queue.receiveBatchMessages(5)) ?? [];

      if (messages.length === 0) {
        continue;
      }

      for (const message of messages) {
        if (message.Body === undefined || message.ReceiptHandle === undefined) {
          continue;
        }

        const payload = JSON.parse(message.Body) as AnalysisBatchMessage;
        const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
        const heartbeat = setInterval(() => {
          void this.queue.extendVisibility(message.ReceiptHandle!);
        }, 10000);

        try {
          await this.batchProcessor.process(payload, receiveCount);
          await this.queue.deleteMessage(message.ReceiptHandle);
        } catch (error) {
          this.logger.error(error);
        } finally {
          clearInterval(heartbeat);
        }
      }
    }
  }

  public async onModuleDestroy(): Promise<void> {
    this.running = false;
  }
}
