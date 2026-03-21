import fs from 'node:fs';
import path from 'node:path';

const TAXONOMY_SQL_PATH = path.resolve(__dirname, '../../../prisma/taxonomy-v3.sql');
const HIGH_VALUE_REGEX_CATEGORIES = new Set([
  'policy',
  'plan',
  'debugging',
  'automation',
  'system_config',
  'environment_runtime',
  'artifact',
  'status_metric',
]);

function parseSqlRules() {
  const content = fs.readFileSync(TAXONOMY_SQL_PATH, 'utf8');
  const rules: Array<{
    id: string;
    version: string;
    category: string;
    label: string;
    lang: string;
    matchType: string;
    pattern: string;
    weight: number;
  }> = [];
  const regex = /^\s+\('([^']+)', '([^']+)', '([^']+)', '([^']+)', '([^']+)', '([^']+)', '((?:[^']|'')*)', (\d+), true\)[,;]$/;

  for (const line of content.split('\n')) {
    const match = line.match(regex);

    if (match === null) {
      continue;
    }

    const [, rawId, rawVersion, rawCategory, rawLabel, rawLang, rawMatchType, rawPattern, rawWeight] = match;
    const id = rawId ?? '';
    const version = rawVersion ?? '';
    const category = rawCategory ?? '';
    const label = rawLabel ?? '';
    const lang = rawLang ?? '';
    const matchType = rawMatchType ?? '';
    const pattern = rawPattern ?? '';
    const weight = rawWeight ?? '0';

    rules.push({
      id,
      version,
      category,
      label,
      lang,
      matchType,
      pattern: pattern.replaceAll("''", "'"),
      weight: Number(weight),
    });
  }

  return rules;
}

describe('taxonomy v3 sql', () => {
  it('keeps every category within the expanded rule-count band', () => {
    const rules = parseSqlRules();
    const counts = new Map<string, number>();

    for (const rule of rules) {
      counts.set(rule.category, (counts.get(rule.category) ?? 0) + 1);
    }

    for (const [category, count] of counts.entries()) {
      expect(count).toBeGreaterThanOrEqual(100);
      expect(count).toBeLessThanOrEqual(150);
    }
  });

  it('keeps bilingual keyword and phrase coverage for every category', () => {
    const rules = parseSqlRules();
    const categories = [...new Set(rules.map((rule) => rule.category))];

    for (const category of categories) {
      const categoryRules = rules.filter((rule) => rule.category === category);

      expect(categoryRules.some((rule) => rule.lang === 'zh-CN')).toBe(true);
      expect(categoryRules.some((rule) => rule.lang === 'en-US')).toBe(true);
      expect(categoryRules.some((rule) => rule.matchType === 'keyword')).toBe(true);
      expect(categoryRules.some((rule) => rule.matchType === 'phrase')).toBe(true);
    }
  });

  it('keeps regex coverage for high-value operational categories', () => {
    const rules = parseSqlRules();

    for (const category of HIGH_VALUE_REGEX_CATEGORIES) {
      expect(rules.some((rule) => rule.category === category && rule.matchType === 'regex')).toBe(true);
    }
  });
});
