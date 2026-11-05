import { loadConfig, loadDatabaseUrl } from './index';

describe('loadConfig', () => {
  const baseEnv = {
    DATABASE_URL: 'mysql://mem9:mem9@127.0.0.1:3306/mem9',
    REDIS_URL: 'redis://127.0.0.1:6379',
    APP_PEPPER: 'local-dev-pepper-1234567890',
    S3_BUCKET_ANALYSIS_PAYLOADS: 'mem9-analysis-payloads',
    SQS_ANALYSIS_BATCH_QUEUE_URL:
      'http://127.0.0.1:4566/000000000000/analysis-batch',
    SQS_ANALYSIS_BATCH_DLQ_URL:
      'http://127.0.0.1:4566/000000000000/analysis-batch-dlq',
    SQS_ANALYSIS_LLM_QUEUE_URL:
      'http://127.0.0.1:4566/000000000000/analysis-llm',
    SQS_ANALYSIS_LLM_DLQ_URL:
      'http://127.0.0.1:4566/000000000000/analysis-llm-dlq',
    GO_INTERNAL_SHARED_SECRET: 'local-secret',
  } satisfies NodeJS.ProcessEnv;

  const productionEnv = {
    ...baseEnv,
    NODE_ENV: 'production',
    DATABASE_URL: 'mysql://service:existing-password@db.internal:3306/mem9',
    APP_PEPPER: 'existing-production-pepper-1234567890',
    GO_INTERNAL_SHARED_SECRET: 'existing-production-shared-secret',
    MEM9_SOURCE_API_BASE_URL: 'https://api.mem9.example/v1alpha2/mem9s',
    GO_VERIFY_BASE_URL: 'https://api.mem9.example',
  } satisfies NodeJS.ProcessEnv;

  it.each(['DATABASE_URL', 'APP_PEPPER', 'GO_INTERNAL_SHARED_SECRET'] as const)(
    'requires explicit %s in every environment',
    (key) => {
      for (const NODE_ENV of ['development', 'test', 'production']) {
        for (const value of [undefined, '']) {
          expect(() =>
            loadConfig({ ...productionEnv, NODE_ENV, [key]: value }),
          ).toThrow(key);
        }
      }
    },
  );

  it.each([
    ['APP_PEPPER', 'local-dev-pepper-1234567890'],
    ['APP_PEPPER', 'replace-with-32-char-random-secret'],
    ['GO_INTERNAL_SHARED_SECRET', 'local-secret'],
    ['GO_INTERNAL_SHARED_SECRET', 'replace-me'],
    ['DATABASE_URL', baseEnv.DATABASE_URL],
    ['DATABASE_URL', 'mysql://mem9:mem9@db.internal:3306/production'],
    ['DATABASE_URL', 'mysql://%6dem9:%6dem9@db.internal:3306/production'],
  ])('rejects production example credentials for %s (%s)', (key, value) => {
    expect(() => loadConfig({ ...productionEnv, [key]: value })).toThrow(key);
  });

  it('preserves existing production credentials exactly', () => {
    const config = loadConfig(productionEnv);
    expect(config.app.pepper).toBe(productionEnv.APP_PEPPER);
    expect(config.database.url).toBe(productionEnv.DATABASE_URL);
    expect(config.goVerify.sharedSecret).toBe(
      productionEnv.GO_INTERNAL_SHARED_SECRET,
    );
  });

  it('allows explicitly configured local development credentials', () => {
    expect(loadConfig(baseEnv).database.url).toBe(baseEnv.DATABASE_URL);
  });

  it('validates seed database configuration without requiring API credentials', () => {
    expect(
      loadDatabaseUrl({
        NODE_ENV: 'production',
        DATABASE_URL: productionEnv.DATABASE_URL,
      }),
    ).toBe(productionEnv.DATABASE_URL);
    expect(loadDatabaseUrl({ DATABASE_URL: baseEnv.DATABASE_URL })).toBe(
      baseEnv.DATABASE_URL,
    );
    for (const DATABASE_URL of [
      undefined,
      '',
      'not-a-url',
      baseEnv.DATABASE_URL,
    ]) {
      expect(() =>
        loadDatabaseUrl({ NODE_ENV: 'production', DATABASE_URL }),
      ).toThrow(/DATABASE_URL/);
    }
  });

  it('does not include rejected database credentials in error messages', () => {
    const DATABASE_URL = 'invalid://service:private-password@db.internal';
    for (const load of [loadConfig, loadDatabaseUrl]) {
      try {
        load({ ...productionEnv, DATABASE_URL });
        throw new Error('Expected validation to fail');
      } catch (error) {
        expect(String(error)).toContain('DATABASE_URL');
        expect(String(error)).not.toContain('private-password');
      }
    }
  });

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

  it('exposes the optional sentry dsn', () => {
    const config = loadConfig({
      ...baseEnv,
      SENTRY_DSN: 'https://examplePublicKey@o0.ingest.sentry.io/0',
    });

    expect(config.sentry.dsn).toBe(
      'https://examplePublicKey@o0.ingest.sentry.io/0',
    );
  });

  it('treats an empty sentry dsn as disabled', () => {
    const config = loadConfig({
      ...baseEnv,
      SENTRY_DSN: '',
    });

    expect(config.sentry.dsn).toBeUndefined();
  });

  it('rejects partial static AWS credentials', () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        AWS_ACCESS_KEY_ID: 'test',
      }),
    ).toThrow(
      'AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be provided together',
    );
  });

  it('defaults API key verification to remote with a short timeout', () => {
    const config = loadConfig(baseEnv);

    expect(config.goVerify.mode).toBe('remote');
    expect(config.goVerify.timeoutMs).toBe(3000);
  });

  it('rejects noop API key verification in production', () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        NODE_ENV: 'production',
        GO_VERIFY_MODE: 'noop',
      }),
    ).toThrow(/GO_VERIFY_MODE/);
  });

  it('allows remote API key verification in production', () => {
    const config = loadConfig({
      ...productionEnv,
      GO_VERIFY_MODE: 'remote',
      APP_PEPPER: 'production-test-pepper-1234567890',
      GO_VERIFY_BASE_URL: 'https://api.mem9.example',
      MEM9_SOURCE_API_BASE_URL: 'https://api.mem9.example/v1alpha2/mem9s',
      GO_VERIFY_TIMEOUT_MS: '1500',
    });

    expect(config.goVerify.mode).toBe('remote');
    expect(config.goVerify.baseUrl).toBe('https://api.mem9.example');
    expect(config.goVerify.timeoutMs).toBe(1500);
  });

  it('still allows noop verification for local development', () => {
    const config = loadConfig({ ...baseEnv, GO_VERIFY_MODE: 'noop' });

    expect(config.goVerify.mode).toBe('noop');
  });

  it.each(['MEM9_SOURCE_API_BASE_URL', 'GO_VERIFY_BASE_URL'] as const)(
    'rejects plaintext credential transport in production for %s',
    (key) => {
      expect(() =>
        loadConfig({
          ...baseEnv,
          NODE_ENV: 'production',
          APP_PEPPER: 'production-test-pepper-1234567890',
          MEM9_SOURCE_API_BASE_URL: 'https://api.mem9.example/v1alpha2/mem9s',
          GO_VERIFY_BASE_URL: 'https://api.mem9.example',
          [key]: 'http://api.mem9.ai/v1alpha2/mem9s',
        }),
      ).toThrow(new RegExp(`${key} must use HTTPS`));
    },
  );

  it('keeps an explicit staging HTTP exception separate from the production default', () => {
    const config = loadConfig({
      ...productionEnv,
      MEM9_SOURCE_API_BASE_URL: 'http://staging.example/v1alpha2/mem9s',
      GO_VERIFY_BASE_URL: 'http://staging.example',
      APP_PEPPER: 'staging-test-pepper-1234567890',
      UPSTREAM_HTTPS_REQUIRED: 'false',
    });
    expect(config.analysis.mem9SourceApiBaseUrl).toMatch(/^http:/);
  });

  it('rejects a misspelled upstream TLS policy instead of silently disabling it', () => {
    expect(() =>
      loadConfig({ ...baseEnv, UPSTREAM_HTTPS_REQUIRED: 'treu' }),
    ).toThrow(/UPSTREAM_HTTPS_REQUIRED/);
  });

  it('exposes mem9 source hardening defaults', () => {
    const config = loadConfig(baseEnv);

    expect(config.analysis.mem9SourceRequestTimeoutMs).toBe(10000);
    expect(config.analysis.mem9SourceFetchRetries).toBe(2);
    expect(config.analysis.mem9SourceFetchRetryBaseMs).toBe(250);
    expect(config.analysis.mem9SourceDeleteConcurrency).toBe(4);
  });
});
