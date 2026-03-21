import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CATEGORY_PRIORITY } from './taxonomy-v3-source.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SQL_PATH = path.resolve(__dirname, '../prisma/taxonomy-v3.sql');

const exportPath = process.argv[2];

if (exportPath === undefined) {
  console.error('Usage: node scripts/analyze-taxonomy-v3-coverage.mjs /absolute/path/to/export.json [--markdown]');
  process.exit(1);
}

const markdown = process.argv.includes('--markdown');

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

function compareCategories(left, right) {
  const leftIndex = CATEGORY_PRIORITY.indexOf(left);
  const rightIndex = CATEGORY_PRIORITY.indexOf(right);

  return (leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex) - (rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex);
}

function matchesRule(content, rule) {
  const haystack = content.toLowerCase();

  if (rule.matchType === 'regex') {
    return new RegExp(rule.pattern, 'iu').test(content);
  }

  return haystack.includes(rule.pattern.toLowerCase());
}

function tokenize(content) {
  return content
    .toLowerCase()
    .match(/[a-z][a-z0-9_./+-]{2,}|[\p{Script=Han}]{2,}/gu) ?? [];
}

function classify(content, rules) {
  const scores = new Map();

  for (const rule of rules) {
    if (!matchesRule(content, rule)) {
      continue;
    }

    scores.set(rule.category, (scores.get(rule.category) ?? 0) + rule.weight);
  }

  if (scores.size === 0) {
    return null;
  }

  return [...scores.entries()]
    .sort((left, right) => right[1] - left[1] || compareCategories(left[0], right[0]))[0]?.[0] ?? null;
}

function renderMarkdown(summary) {
  const lines = [
    '# Taxonomy v3 Coverage Sample',
    '',
    `- Export: \`${summary.exportPath}\``,
    `- Total memories: \`${summary.total}\``,
    `- Matched memories: \`${summary.matched}\``,
    `- Unmatched memories: \`${summary.unmatched}\``,
    '',
    '## Top Categories',
    '',
  ];

  for (const [category, count] of summary.categoryCounts) {
    lines.push(`- \`${category}\`: ${count}`);
  }

  lines.push('', '## Top Unmatched Tokens', '');

  for (const [token, count] of summary.unmatchedTokens) {
    lines.push(`- \`${token}\`: ${count}`);
  }

  return `${lines.join('\n')}\n`;
}

function main() {
  const sql = fs.readFileSync(SQL_PATH, 'utf8');
  const rules = parseSqlRules(sql);
  const exportJson = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
  const memories = exportJson.memories ?? [];
  const categoryCounts = new Map();
  const unmatchedTokenCounts = new Map();
  let matched = 0;

  for (const memory of memories) {
    const content = String(memory.content ?? '');
    const category = classify(content, rules);

    if (category !== null) {
      matched += 1;
      categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
      continue;
    }

    for (const token of tokenize(content)) {
      unmatchedTokenCounts.set(token, (unmatchedTokenCounts.get(token) ?? 0) + 1);
    }
  }

  const summary = {
    exportPath,
    total: memories.length,
    matched,
    unmatched: memories.length - matched,
    categoryCounts: [...categoryCounts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 20),
    unmatchedTokens: [...unmatchedTokenCounts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 30),
  };

  if (markdown) {
    process.stdout.write(renderMarkdown(summary));
    return;
  }

  console.log(JSON.stringify(summary, null, 2));
}

main();
