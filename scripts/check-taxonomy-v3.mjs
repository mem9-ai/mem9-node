import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HIGH_VALUE_REGEX_CATEGORIES, taxonomyV3Source } from './taxonomy-v3-source.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SQL_PATH = path.resolve(__dirname, '../prisma/taxonomy-v3.sql');
const MIN_RULES_PER_CATEGORY = 100;
const MAX_RULES_PER_CATEGORY = 150;

function parseSqlRules(content) {
  const rules = [];
  const regex = /^\s+\('([^']+)', '([^']+)', '([^']+)', '([^']+)', '([^']+)', '([^']+)', '((?:[^']|'')*)', (\d+), true\)[,;]$/;

  for (const line of content.split('\n')) {
    const match = line.match(regex);

    if (match === null) {
      continue;
    }

    rules.push({
      id: match[1],
      version: match[2],
      category: match[3],
      label: match[4],
      lang: match[5],
      matchType: match[6],
      pattern: match[7].replaceAll("''", "'"),
      weight: Number(match[8]),
    });
  }

  return rules;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function main() {
  const content = fs.readFileSync(SQL_PATH, 'utf8');
  const rules = parseSqlRules(content);
  const expectedCategories = taxonomyV3Source.map((item) => item.category);

  if (rules.length === 0) {
    fail(`No rules parsed from ${SQL_PATH}`);
  }

  for (const category of expectedCategories) {
    const categoryRules = rules.filter((rule) => rule.category === category);
    const zhRules = categoryRules.filter((rule) => rule.lang === 'zh-CN');
    const enRules = categoryRules.filter((rule) => rule.lang === 'en-US');

    if (categoryRules.length < MIN_RULES_PER_CATEGORY || categoryRules.length > MAX_RULES_PER_CATEGORY) {
      fail(`Category ${category} has ${categoryRules.length} rules; expected ${MIN_RULES_PER_CATEGORY}-${MAX_RULES_PER_CATEGORY}`);
    }

    if (zhRules.length === 0 || enRules.length === 0) {
      fail(`Category ${category} is missing bilingual coverage`);
    }

    if (!categoryRules.some((rule) => rule.matchType === 'keyword')) {
      fail(`Category ${category} has no keyword rules`);
    }

    if (!categoryRules.some((rule) => rule.matchType === 'phrase')) {
      fail(`Category ${category} has no phrase rules`);
    }

    if (HIGH_VALUE_REGEX_CATEGORIES.has(category) && !categoryRules.some((rule) => rule.matchType === 'regex')) {
      fail(`High-value category ${category} has no regex rules`);
    }
  }

  console.log(`taxonomy-v3.sql validation passed with ${rules.length} rules across ${expectedCategories.length} categories.`);
}

main();
