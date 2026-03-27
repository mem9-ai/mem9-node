import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PrismaClient } from '@prisma/client';

import { createPrefixedId } from '../packages/shared/src';

process.env.DATABASE_URL ??= 'mysql://mem9:mem9@127.0.0.1:3306/mem9';

const prisma = new PrismaClient();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TAXONOMY_SQL_PATH = path.resolve(__dirname, './taxonomy-v3.sql');

async function seedTaxonomy(): Promise<void> {
  const sql = await readFile(TAXONOMY_SQL_PATH, 'utf8');
  const sanitizedSql = sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
  const statements = sanitizedSql
    .split(/;\s*\n/g)
    .map((statement) => statement.trim())
    .filter(
      (statement) =>
        statement.length > 0 &&
        !statement.toUpperCase().startsWith('SELECT '),
    );

  for (const statement of statements) {
    await prisma.$executeRawUnsafe(`${statement};`);
  }
}

async function main(): Promise<void> {
  await prisma.rateLimitPolicy.upsert({
    where: { planCode: 'default' },
    update: {
      rpmLimit: 120,
      dailyLimit: 10000,
      burstLimit: 30,
      maxActiveJobs: 5,
      maxBatchesPerJob: 500,
      enabled: true,
    },
    create: {
      id: createPrefixedId('rlp'),
      planCode: 'default',
      rpmLimit: 120,
      dailyLimit: 10000,
      burstLimit: 30,
      maxActiveJobs: 5,
      maxBatchesPerJob: 500,
      enabled: true,
    },
  });

  await prisma.analysisPipelineConfig.upsert({
    where: { version: 'v1' },
    update: {
      maxMemoriesPerRequest: 100,
      maxBodyBytes: 524288,
      resultCacheEnabled: true,
      llmFallbackEnabled: false,
      defaultBatchSize: 100,
      partialResultTtlSeconds: 86400,
      payloadRetentionDays: 7,
    },
    create: {
      id: createPrefixedId('apc'),
      version: 'v1',
      maxMemoriesPerRequest: 100,
      maxBodyBytes: 524288,
      resultCacheEnabled: true,
      llmFallbackEnabled: false,
      defaultBatchSize: 100,
      partialResultTtlSeconds: 86400,
      payloadRetentionDays: 7,
    },
  });

  await seedTaxonomy();
}

main()
  .catch(async (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
