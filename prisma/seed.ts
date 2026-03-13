import { PrismaClient, TaxonomyMatchType } from '@prisma/client';

import { createPrefixedId } from '../packages/shared/src';

process.env.DATABASE_URL ??= 'mysql://mem9:mem9@127.0.0.1:3306/mem9';

const prisma = new PrismaClient();

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

  const rules = [
    ['identity', '职业身份', 'zh-CN', TaxonomyMatchType.keyword, '工程师', 5],
    ['identity', 'Role', 'en-US', TaxonomyMatchType.keyword, 'engineer', 5],
    ['emotion', 'Positive emotion', 'zh-CN', TaxonomyMatchType.keyword, '开心', 4],
    ['emotion', 'Negative emotion', 'zh-CN', TaxonomyMatchType.keyword, '焦虑', 4],
    ['preference', 'Preference', 'zh-CN', TaxonomyMatchType.keyword, '喜欢', 4],
    ['preference', 'Preference', 'en-US', TaxonomyMatchType.keyword, 'prefer', 4],
    ['experience', 'Travel', 'zh-CN', TaxonomyMatchType.keyword, '旅行', 4],
    ['experience', 'Experience', 'en-US', TaxonomyMatchType.keyword, 'experience', 4],
    ['activity', 'Work activity', 'zh-CN', TaxonomyMatchType.keyword, '做', 3],
    ['activity', 'Building', 'en-US', TaxonomyMatchType.keyword, 'building', 3],
  ] as const;

  for (const [category, label, lang, matchType, pattern, weight] of rules) {
    await prisma.taxonomyRule.upsert({
      where: {
        id: `${lang}-${category}-${pattern}`,
      },
      update: {
        enabled: true,
        label,
        matchType,
        pattern,
        version: 'v1',
        weight,
      },
      create: {
        id: `${lang}-${category}-${pattern}`,
        version: 'v1',
        category,
        label,
        lang,
        matchType,
        pattern,
        weight,
        enabled: true,
      },
    });
  }
}

main()
  .catch(async (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
