import { loadConfig } from './index';

describe('loadConfig', () => {
  const baseEnv = {
    DATABASE_URL: 'mysql://mem9:mem9@127.0.0.1:3306/mem9',
    REDIS_URL: 'redis://127.0.0.1:6379',
    APP_PEPPER: 'local-dev-pepper-1234567890',
    S3_BUCKET_ANALYSIS_PAYLOADS: 'mem9-analysis-payloads',
    SQS_ANALYSIS_BATCH_QUEUE_URL: 'http://127.0.0.1:4566/000000000000/analysis-batch',
    SQS_ANALYSIS_BATCH_DLQ_URL: 'http://127.0.0.1:4566/000000000000/analysis-batch-dlq',
    SQS_ANALYSIS_LLM_QUEUE_URL: 'http://127.0.0.1:4566/000000000000/analysis-llm',
    SQS_ANALYSIS_LLM_DLQ_URL: 'http://127.0.0.1:4566/000000000000/analysis-llm-dlq',
    GO_INTERNAL_SHARED_SECRET: 'local-secret',
  } satisfies NodeJS.ProcessEnv;

  it('allows AWS credentials to be omitted so the SDK can use the default provider chain', () => {
    const config = loadConfig(baseEnv);

    expect(config.aws.accessKeyId).toBeUndefined();
    expect(config.aws.secretAccessKey).toBeUndefined();
    expect(config.aws.sessionToken).toBeUndefined();
    expect(config.aws.forcePathStyle).toBe(false);
  });

  it('accepts a complete static credential set', () => {
    const config = loadConfig({
      ...baseEnv,
      AWS_ACCESS_KEY_ID: 'test',
      AWS_SECRET_ACCESS_KEY: 'test',
      AWS_SESSION_TOKEN: 'session-token',
      AWS_FORCE_PATH_STYLE: 'true',
    });

    expect(config.aws.accessKeyId).toBe('test');
    expect(config.aws.secretAccessKey).toBe('test');
    expect(config.aws.sessionToken).toBe('session-token');
    expect(config.aws.forcePathStyle).toBe(true);
  });

  it('rejects partial static AWS credentials', () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        AWS_ACCESS_KEY_ID: 'test',
      }),
    ).toThrow('AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be provided together');
  });
});
