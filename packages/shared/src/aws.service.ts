import { Readable } from 'node:stream';

import { PutObjectCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Message } from '@aws-sdk/client-sqs';
import { ChangeMessageVisibilityCommand, DeleteMessageCommand, ReceiveMessageCommand, SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { AppConfig } from '@mem9/config';
import { APP_CONFIG } from '@mem9/config';
import type { AnalysisBatchMessage, AnalysisLlmQueueMessage } from '@mem9/contracts';
import { Inject, Injectable } from '@nestjs/common';

@Injectable()
export class AwsClientFactory {
  private readonly s3Client: S3Client;
  private readonly sqsClient: SQSClient;

  public constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    const options: {
      region: string;
      endpoint?: string;
      forcePathStyle: boolean;
      credentials?: {
        accessKeyId: string;
        secretAccessKey: string;
        sessionToken?: string;
      };
    } = {
      region: config.aws.region,
      endpoint: config.aws.endpointUrl,
      forcePathStyle: config.aws.forcePathStyle,
    };

    if (config.aws.accessKeyId !== undefined && config.aws.secretAccessKey !== undefined) {
      options.credentials = {
        accessKeyId: config.aws.accessKeyId,
        secretAccessKey: config.aws.secretAccessKey,
        sessionToken: config.aws.sessionToken,
      };
    }

    this.s3Client = new S3Client(options);
    this.sqsClient = new SQSClient(options);
  }

  public get s3(): S3Client {
    return this.s3Client;
  }

  public get sqs(): SQSClient {
    return this.sqsClient;
  }

  public get settings(): AppConfig {
    return this.config;
  }
}

@Injectable()
export class S3PayloadStorageService {
  public constructor(private readonly factory: AwsClientFactory) {}

  public async putCompressedJson(key: string, payload: Buffer): Promise<void> {
    await this.factory.s3.send(
      new PutObjectCommand({
        Bucket: this.factory.settings.aws.s3BucketAnalysisPayloads,
        Key: key,
        Body: payload,
        ContentType: 'application/json',
        ContentEncoding: 'gzip',
      }),
    );
  }

  public async getObjectBuffer(key: string): Promise<Buffer> {
    const response = await this.factory.s3.send(
      new GetObjectCommand({
        Bucket: this.factory.settings.aws.s3BucketAnalysisPayloads,
        Key: key,
      }),
    );
    const body = response.Body;

    if (
      body === undefined ||
      (!(body instanceof Readable) &&
        typeof (body as { transformToByteArray?: () => Promise<Uint8Array> }).transformToByteArray !== 'function')
    ) {
      throw new Error('Unsupported S3 body stream');
    }

    if (body instanceof Readable) {
      const chunks: Buffer[] = [];

      for await (const chunk of body) {
        if (Buffer.isBuffer(chunk)) {
          chunks.push(chunk);
          continue;
        }

        if (typeof chunk === 'string') {
          chunks.push(Buffer.from(chunk));
          continue;
        }

        chunks.push(Buffer.from(chunk as Uint8Array));
      }

      return Buffer.concat(chunks);
    }

    const bytes = await body.transformToByteArray();
    return Buffer.from(bytes);
  }

  public async putJson(key: string, payload: unknown): Promise<void> {
    await this.factory.s3.send(
      new PutObjectCommand({
        Bucket: this.factory.settings.aws.s3BucketAnalysisPayloads,
        Key: key,
        Body: JSON.stringify(payload),
        ContentType: 'application/json',
      }),
    );
  }
}

@Injectable()
export class SqsQueueService {
  public constructor(private readonly factory: AwsClientFactory) {}

  public async enqueueBatch(message: AnalysisBatchMessage): Promise<void> {
    await this.factory.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.factory.settings.aws.sqsAnalysisBatchQueueUrl,
        MessageBody: JSON.stringify(message),
      }),
    );
  }

  public async enqueueLlmMessage(message: AnalysisLlmQueueMessage): Promise<void> {
    await this.factory.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.factory.settings.aws.sqsAnalysisLlmQueueUrl,
        MessageBody: JSON.stringify(message),
      }),
    );
  }

  public async receiveBatchMessages(maxNumberOfMessages: number): Promise<Message[] | undefined> {
    const response = await this.factory.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: this.factory.settings.aws.sqsAnalysisBatchQueueUrl,
        MaxNumberOfMessages: maxNumberOfMessages,
        WaitTimeSeconds: this.factory.settings.sqs.waitTimeSeconds,
        VisibilityTimeout: this.factory.settings.sqs.visibilityTimeoutSeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }),
    );

    return response.Messages;
  }

  public async receiveLlmMessages(maxNumberOfMessages: number): Promise<Message[] | undefined> {
    const response = await this.factory.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: this.factory.settings.aws.sqsAnalysisLlmQueueUrl,
        MaxNumberOfMessages: maxNumberOfMessages,
        WaitTimeSeconds: this.factory.settings.sqs.waitTimeSeconds,
        VisibilityTimeout: this.factory.settings.sqs.visibilityTimeoutSeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }),
    );

    return response.Messages;
  }

  public async extendVisibility(receiptHandle: string): Promise<void> {
    await this.factory.sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.factory.settings.aws.sqsAnalysisBatchQueueUrl,
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: this.factory.settings.sqs.visibilityTimeoutSeconds,
      }),
    );
  }

  public async extendLlmVisibility(receiptHandle: string): Promise<void> {
    await this.factory.sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.factory.settings.aws.sqsAnalysisLlmQueueUrl,
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: this.factory.settings.sqs.visibilityTimeoutSeconds,
      }),
    );
  }

  public async deleteMessage(receiptHandle: string): Promise<void> {
    await this.factory.sqs.send(
      new DeleteMessageCommand({
        QueueUrl: this.factory.settings.aws.sqsAnalysisBatchQueueUrl,
        ReceiptHandle: receiptHandle,
      }),
    );
  }

  public async deleteLlmMessage(receiptHandle: string): Promise<void> {
    await this.factory.sqs.send(
      new DeleteMessageCommand({
        QueueUrl: this.factory.settings.aws.sqsAnalysisLlmQueueUrl,
        ReceiptHandle: receiptHandle,
      }),
    );
  }
}
