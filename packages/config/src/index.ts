import { z } from 'zod';

const booleanish = z.union([z.boolean(), z.string()]).transform((value) => {
  if (typeof value === 'boolean') {
    return value;
  }

  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
});

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  WORKER_HEALTH_PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().min(1).default('mysql://mem9:mem9@127.0.0.1:3306/mem9'),
  REDIS_URL: z.string().min(1).default('redis://127.0.0.1:6379'),
  APP_PEPPER: z.string().min(16).default('local-dev-pepper-1234567890'),
  AWS_REGION: z.string().min(1).default('us-east-1'),
  AWS_ENDPOINT_URL: z.string().url().optional(),
  AWS_ACCESS_KEY_ID: z.string().default('test'),
  AWS_SECRET_ACCESS_KEY: z.string().default('test'),
  AWS_FORCE_PATH_STYLE: booleanish.default(true),
  S3_BUCKET_ANALYSIS_PAYLOADS: z.string().min(1).default('mem9-analysis-payloads'),
  SQS_ANALYSIS_BATCH_QUEUE_URL: z.string().min(1).default('http://127.0.0.1:4566/000000000000/analysis-batch'),
  SQS_ANALYSIS_BATCH_DLQ_URL: z.string().min(1).default('http://127.0.0.1:4566/000000000000/analysis-batch-dlq'),
  SQS_ANALYSIS_LLM_QUEUE_URL: z.string().min(1).default('http://127.0.0.1:4566/000000000000/analysis-llm'),
  SQS_ANALYSIS_LLM_DLQ_URL: z.string().min(1).default('http://127.0.0.1:4566/000000000000/analysis-llm-dlq'),
  JOB_RESULT_TTL_SECONDS: z.coerce.number().int().positive().default(86400),
  PAYLOAD_RETENTION_DAYS: z.coerce.number().int().positive().default(7),
  DEFAULT_BATCH_SIZE: z.coerce.number().int().positive().default(100),
  MAX_BATCH_MEMORIES: z.coerce.number().int().positive().default(100),
  MAX_BATCH_BYTES: z.coerce.number().int().positive().default(524288),
  MAX_MEMORIES_PER_REQUEST: z.coerce.number().int().positive().default(100),
  GO_VERIFY_MODE: z.enum(['noop', 'remote']).default('noop'),
  GO_VERIFY_BASE_URL: z.string().url().default('http://127.0.0.1:8080'),
  GO_INTERNAL_SHARED_SECRET: z.string().min(8).default('local-secret'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  PIPELINE_VERSION: z.string().default('v1'),
  TAXONOMY_VERSION: z.string().default('v1'),
  SQS_WAIT_TIME_SECONDS: z.coerce.number().int().min(1).max(20).default(10),
  SQS_VISIBILITY_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(30),
  SQS_VISIBILITY_HEARTBEAT_SECONDS: z.coerce.number().int().positive().default(10),
});

export type AppEnv = z.infer<typeof envSchema>;

export interface AppConfig {
  app: {
    env: AppEnv['NODE_ENV'];
    port: number;
    workerHealthPort: number;
    logLevel: AppEnv['LOG_LEVEL'];
    pepper: string;
  };
  database: {
    url: string;
  };
  redis: {
    url: string;
  };
  aws: {
    region: string;
    endpointUrl?: string;
    accessKeyId: string;
    secretAccessKey: string;
    forcePathStyle: boolean;
    s3BucketAnalysisPayloads: string;
    sqsAnalysisBatchQueueUrl: string;
    sqsAnalysisBatchDlqUrl: string;
    sqsAnalysisLlmQueueUrl: string;
    sqsAnalysisLlmDlqUrl: string;
  };
  analysis: {
    jobResultTtlSeconds: number;
    payloadRetentionDays: number;
    defaultBatchSize: number;
    maxBatchMemories: number;
    maxBatchBytes: number;
    maxMemoriesPerRequest: number;
    pipelineVersion: string;
    taxonomyVersion: string;
  };
  goVerify: {
    mode: AppEnv['GO_VERIFY_MODE'];
    baseUrl: string;
    sharedSecret: string;
  };
  sqs: {
    waitTimeSeconds: number;
    visibilityTimeoutSeconds: number;
    visibilityHeartbeatSeconds: number;
  };
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const env = envSchema.parse(environment);

  return {
    app: {
      env: env.NODE_ENV,
      port: env.PORT,
      workerHealthPort: env.WORKER_HEALTH_PORT,
      logLevel: env.LOG_LEVEL,
      pepper: env.APP_PEPPER,
    },
    database: {
      url: env.DATABASE_URL,
    },
    redis: {
      url: env.REDIS_URL,
    },
    aws: {
      region: env.AWS_REGION,
      endpointUrl: env.AWS_ENDPOINT_URL,
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      forcePathStyle: env.AWS_FORCE_PATH_STYLE,
      s3BucketAnalysisPayloads: env.S3_BUCKET_ANALYSIS_PAYLOADS,
      sqsAnalysisBatchQueueUrl: env.SQS_ANALYSIS_BATCH_QUEUE_URL,
      sqsAnalysisBatchDlqUrl: env.SQS_ANALYSIS_BATCH_DLQ_URL,
      sqsAnalysisLlmQueueUrl: env.SQS_ANALYSIS_LLM_QUEUE_URL,
      sqsAnalysisLlmDlqUrl: env.SQS_ANALYSIS_LLM_DLQ_URL,
    },
    analysis: {
      jobResultTtlSeconds: env.JOB_RESULT_TTL_SECONDS,
      payloadRetentionDays: env.PAYLOAD_RETENTION_DAYS,
      defaultBatchSize: env.DEFAULT_BATCH_SIZE,
      maxBatchMemories: env.MAX_BATCH_MEMORIES,
      maxBatchBytes: env.MAX_BATCH_BYTES,
      maxMemoriesPerRequest: env.MAX_MEMORIES_PER_REQUEST,
      pipelineVersion: env.PIPELINE_VERSION,
      taxonomyVersion: env.TAXONOMY_VERSION,
    },
    goVerify: {
      mode: env.GO_VERIFY_MODE,
      baseUrl: env.GO_VERIFY_BASE_URL,
      sharedSecret: env.GO_INTERNAL_SHARED_SECRET,
    },
    sqs: {
      waitTimeSeconds: env.SQS_WAIT_TIME_SECONDS,
      visibilityTimeoutSeconds: env.SQS_VISIBILITY_TIMEOUT_SECONDS,
      visibilityHeartbeatSeconds: env.SQS_VISIBILITY_HEARTBEAT_SECONDS,
    },
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');
