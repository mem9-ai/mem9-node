import { Readable } from 'node:stream';

import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { SQSClientConfig, Message } from '@aws-sdk/client-sqs';
import { ChangeMessageVisibilityCommand, DeleteMessageCommand, ReceiveMessageCommand, SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { AppConfig } from '@mem9/config';
import { APP_CONFIG } from '@mem9/config';
import type { AnalysisBatchMessage, AnalysisLlmQueueMessage } from '@mem9/contracts';
import { Inject, Injectable } from '@nestjs/common';

import { assertSnapshotSize, MAX_SNAPSHOT_STORED_BYTES } from './gzip';

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

    const sqsOptions: SQSClientConfig = {
      ...options,
      md5: config.aws.endpointUrl === undefined ? undefined : false,
    };

    this.s3Client = new S3Client(options);
    this.sqsClient = new SQSClient(sqsOptions);
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
    assertSnapshotSize(payload.length, MAX_SNAPSHOT_STORED_BYTES);
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

  public async getObjectBuffer(key: string, maxBytes = MAX_SNAPSHOT_STORED_BYTES): Promise<Buffer> {
    const controller = new AbortController();
    const response = await this.factory.s3.send(
      new GetObjectCommand({
        Bucket: this.factory.settings.aws.s3BucketAnalysisPayloads,
        Key: key,
      }),
      { abortSignal: controller.signal },
    );
    const body = response.Body;
    // Node S3 responses are Readable. Never fall back to an unbounded buffering helper.
    if (!(body instanceof Readable)) {
      controller.abort();
      throw new Error('Unsupported S3 body stream');
    }
    try {
      assertSnapshotSize(response.ContentLength ?? 0, maxBytes);
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      for await (const chunk of body) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        totalBytes += bytes.length;
        assertSnapshotSize(totalBytes, maxBytes);
        chunks.push(bytes);
      }
      return Buffer.concat(chunks, totalBytes);
    } catch (error) {
      controller.abort();
      body.destroy();
      throw error;
    }
  }

  public async putJson(key: string, payload: unknown): Promise<void> {
    const json = JSON.stringify(payload);
    assertSnapshotSize(Buffer.byteLength(json), MAX_SNAPSHOT_STORED_BYTES);
    await this.factory.s3.send(
      new PutObjectCommand({
        Bucket: this.factory.settings.aws.s3BucketAnalysisPayloads,
        Key: key,
        Body: json,
        ContentType: 'application/json',
      }),
    );
  }

  public async deleteObject(key: string): Promise<void> {
    await this.factory.s3.send(
      new DeleteObjectCommand({
        Bucket: this.factory.settings.aws.s3BucketAnalysisPayloads,
        Key: key,
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
