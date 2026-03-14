import type { TaxonomyRuleDefinition } from '@mem9/contracts';

import {
  analyzeBatch,
  canonicalizeBatchPayload,
  classifyMemory,
  isMeaningfulFacetToken,
  normalizeMemory,
} from './analysis-pipeline';
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

  it('filters high-frequency English stopwords from facet tags', () => {
    const memory = normalizeMemory({
      id: 'm2',
      content: 'It is for your my his agent memory roadmap',
      createdAt: '2026-03-01T00:00:00.000Z',
      metadata: {},
    });

    const analyzed = classifyMemory(memory, rules, 'en-US');

    expect(analyzed.tags).toEqual(expect.arrayContaining(['agent', 'memory', 'roadmap']));
    expect(analyzed.tags).not.toEqual(expect.arrayContaining(['it', 'is', 'for', 'your', 'my', 'his']));
  });

  it('retains meaningful tokens after stricter facet filtering', () => {
    expect(isMeaningfulFacetToken('agent')).toBe(true);
    expect(isMeaningfulFacetToken('search')).toBe(true);
    expect(isMeaningfulFacetToken(' is ')).toBe(false);
    expect(isMeaningfulFacetToken('Your')).toBe(false);
  });

  it('keeps mixed Chinese and English facet filtering stable', () => {
    const filteredTokens = [' 我的 ', 'AI', 'agent', '记忆', '系统', '稳定', 'Your']
      .filter(isMeaningfulFacetToken)
      .map((token) => token.trim().toLowerCase());

    expect(filteredTokens).toEqual(['ai', 'agent', '记忆', '系统', '稳定']);
  });
});
