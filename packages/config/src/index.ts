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
  AWS_ACCESS_KEY_ID: z.string().min(1).optional(),
  AWS_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  AWS_SESSION_TOKEN: z.string().min(1).optional(),
  AWS_FORCE_PATH_STYLE: booleanish.default(false),
  S3_BUCKET_ANALYSIS_PAYLOADS: z.string().min(1).default('mem9-analysis-payloads'),
  SQS_ANALYSIS_BATCH_QUEUE_URL: z.string().min(1).default('http://127.0.0.1:4566/000000000000/analysis-batch'),
  SQS_ANALYSIS_BATCH_DLQ_URL: z.string().min(1).default('http://127.0.0.1:4566/000000000000/analysis-batch-dlq'),
  SQS_ANALYSIS_LLM_QUEUE_URL: z.string().min(1).default('http://127.0.0.1:4566/000000000000/analysis-llm'),
  SQS_ANALYSIS_LLM_DLQ_URL: z.string().min(1).default('http://127.0.0.1:4566/000000000000/analysis-llm-dlq'),
  MEM9_SOURCE_API_BASE_URL: z.string().url().default('http://127.0.0.1:8080/v1alpha2/mem9s'),
  MEM9_SOURCE_PAGE_SIZE: z.coerce.number().int().positive().max(200).default(200),
  MEM9_SOURCE_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  MEM9_SOURCE_FETCH_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  MEM9_SOURCE_FETCH_RETRY_BASE_MS: z.coerce.number().int().positive().default(250),
  MEM9_SOURCE_DELETE_CONCURRENCY: z.coerce.number().int().positive().max(20).default(4),
  DEEP_ANALYSIS_DAILY_LIMIT_BYPASS_FINGERPRINTS: z.string().optional(),
  QWEN_API_BASE_URL: z.string().url().default('https://dashscope.aliyuncs.com/compatible-mode/v1'),
  QWEN_API_KEY: z.string().min(1).optional(),
  QWEN_MODEL: z.string().min(1).default('qwen3.5-pro'),
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
  TAXONOMY_VERSION: z.string().default('v3'),
  SQS_WAIT_TIME_SECONDS: z.coerce.number().int().min(1).max(20).default(10),
  SQS_VISIBILITY_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(30),
  SQS_VISIBILITY_HEARTBEAT_SECONDS: z.coerce.number().int().positive().default(10),
}).superRefine((env, ctx) => {
  const hasAccessKey = env.AWS_ACCESS_KEY_ID !== undefined;
  const hasSecretKey = env.AWS_SECRET_ACCESS_KEY !== undefined;

  if (hasAccessKey !== hasSecretKey) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be provided together',
      path: hasAccessKey ? ['AWS_SECRET_ACCESS_KEY'] : ['AWS_ACCESS_KEY_ID'],
    });
  }

  if (env.AWS_SESSION_TOKEN !== undefined && !(hasAccessKey && hasSecretKey)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'AWS_SESSION_TOKEN requires AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY',
      path: ['AWS_SESSION_TOKEN'],
    });
  }
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
    accessKeyId?: string;
    secretAccessKey?: string;
    sessionToken?: string;
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
    mem9SourceApiBaseUrl: string;
    mem9SourcePageSize: number;
    mem9SourceRequestTimeoutMs: number;
    mem9SourceFetchRetries: number;
    mem9SourceFetchRetryBaseMs: number;
    mem9SourceDeleteConcurrency: number;
    deepAnalysisDailyLimitBypassFingerprints: string[];
    qwenApiBaseUrl: string;
    qwenApiKey?: string;
    qwenModel: string;
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
      sessionToken: env.AWS_SESSION_TOKEN,
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
      mem9SourceApiBaseUrl: env.MEM9_SOURCE_API_BASE_URL,
      mem9SourcePageSize: env.MEM9_SOURCE_PAGE_SIZE,
      mem9SourceRequestTimeoutMs: env.MEM9_SOURCE_REQUEST_TIMEOUT_MS,
      mem9SourceFetchRetries: env.MEM9_SOURCE_FETCH_RETRIES,
      mem9SourceFetchRetryBaseMs: env.MEM9_SOURCE_FETCH_RETRY_BASE_MS,
      mem9SourceDeleteConcurrency: env.MEM9_SOURCE_DELETE_CONCURRENCY,
      deepAnalysisDailyLimitBypassFingerprints: env.DEEP_ANALYSIS_DAILY_LIMIT_BYPASS_FINGERPRINTS
        ?.split(',')
        .map((value) => value.trim().toLowerCase())
        .filter((value) => value.length > 0) ?? [],
      qwenApiBaseUrl: env.QWEN_API_BASE_URL,
      qwenApiKey: env.QWEN_API_KEY,
      qwenModel: env.QWEN_MODEL,
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
