import { Readable } from 'node:stream';

import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { SQSClientConfig } from '@aws-sdk/client-sqs';
import type { Message } from '@aws-sdk/client-sqs';
import { ChangeMessageVisibilityCommand, DeleteMessageCommand, ReceiveMessageCommand, SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { AppConfig } from '@mem9/config';
import { APP_CONFIG } from '@mem9/config';
import type { AnalysisBatchMessage, AnalysisLlmQueueMessage } from '@mem9/contracts';
import { Inject, Injectable } from '@nestjs/common';

import { AppError } from './errors';

function invalidQueueMessage(): AppError {
  return new AppError('Invalid queue message', {
    statusCode: 400,
    code: 'INVALID_QUEUE_MESSAGE',
  });
}

function assertNoRawQueueCredential(value: unknown, visited = new WeakSet<object>()): void {
  if (value === null || typeof value !== 'object' || visited.has(value)) {
    return;
  }

  visited.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if ('rawApiKey' in value) {
    throw invalidQueueMessage();
  }

  for (const descriptor of Object.values(descriptors)) {
    // Queue payloads are data objects. Accessors must not hide credentials from inspection.
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      throw invalidQueueMessage();
    }
    assertNoRawQueueCredential(descriptor.value, visited);
  }
}

function serializeQueueMessage(message: AnalysisBatchMessage | AnalysisLlmQueueMessage): string {
  try {
    assertNoRawQueueCredential(message);
    let payload: AnalysisBatchMessage | AnalysisLlmQueueMessage = message;
    if ('messageType' in message && message.messageType === 'memory_analysis_report') {
      if (
        typeof message.encryptedApiKey !== 'string' || message.encryptedApiKey.length === 0 ||
        !Number.isSafeInteger(message.reportId) || message.reportId <= 0 ||
        typeof message.apiKeyFingerprintHex !== 'string' ||
        typeof message.createdAfter !== 'string' || typeof message.createdBefore !== 'string' ||
        typeof message.traceId !== 'string'
      ) {
        throw invalidQueueMessage();
      }
      // Explicitly select the wire fields so extra request/context properties cannot enter SQS.
      payload = {
        messageType: 'memory_analysis_report',
        reportId: message.reportId,
        apiKeyFingerprintHex: message.apiKeyFingerprintHex,
        encryptedApiKey: message.encryptedApiKey,
        createdAfter: message.createdAfter,
        createdBefore: message.createdBefore,
        traceId: message.traceId,
      };
    }

    return JSON.stringify(payload, (key: string, value: unknown) => {
      // Check the serialized form too, including values returned by toJSON.
      if (key === 'rawApiKey') {
        throw invalidQueueMessage();
      }
      return value;
    });
  } catch {
    // Do not attach the original error: it may contain a credential or a serialized payload.
    throw invalidQueueMessage();
  }
}

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
        MessageBody: serializeQueueMessage(message),
      }),
    );
  }

  public async enqueueLlmMessage(message: AnalysisLlmQueueMessage): Promise<void> {
    await this.factory.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.factory.settings.aws.sqsAnalysisLlmQueueUrl,
        MessageBody: serializeQueueMessage(message),
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
