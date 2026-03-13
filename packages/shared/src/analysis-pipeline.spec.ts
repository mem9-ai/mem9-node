import type { TaxonomyRuleDefinition } from '@mem9/contracts';

import { analyzeBatch, canonicalizeBatchPayload, classifyMemory, normalizeMemory } from './analysis-pipeline';
import { sha256Hex } from './hash';

const rules: TaxonomyRuleDefinition[] = [
  {
    id: 'tr_1',
    version: 'v1',
    category: 'identity',
    label: 'Profession',
    lang: 'zh-CN',
    matchType: 'keyword',
    pattern: 'engineer',
    weight: 5,
    enabled: true,
  },
  {
    id: 'tr_2',
    version: 'v1',
    category: 'emotion',
    label: 'Happiness',
    lang: 'zh-CN',
    matchType: 'keyword',
    pattern: '开心',
    weight: 4,
    enabled: true,
  },
];

describe('analysis pipeline', () => {
  it('classifies memories by taxonomy rules', () => {
    const memory = normalizeMemory({
      id: 'm1',
      content: 'I am an engineer building agents',
      createdAt: '2026-03-01T00:00:00.000Z',
      metadata: {},
    });

    const analyzed = classifyMemory(memory, rules, 'en-US');

    expect(analyzed.category).toBe('identity');
    expect(analyzed.tags).toContain('engineer');
  });

  it('builds aggregate counts for a batch', () => {
    const result = analyzeBatch({
      batchIndex: 1,
      lang: 'zh-CN',
      rules,
      memories: [
        normalizeMemory({
          id: 'm1',
          content: '今天很开心',
          createdAt: '2026-03-01T00:00:00.000Z',
          metadata: {},
        }),
      ],
    });

    expect(result.categoryCounts.emotion).toBe(1);
    expect(result.batchResult.topCategories[0]?.category).toBe('emotion');
  });

  it('creates deterministic batch hashes', () => {
    const payload = canonicalizeBatchPayload(1, [
      {
        id: 'm1',
        content: 'abc',
        createdAt: '2026-03-01T00:00:00.000Z',
        metadata: {},
      },
    ]);

    expect(sha256Hex(payload)).toBe(sha256Hex(payload));
  });
});
