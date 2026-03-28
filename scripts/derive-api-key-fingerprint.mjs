#!/usr/bin/env node

import { createHmac } from 'node:crypto';
import process from 'node:process';

async function readStdin() {
  if (process.stdin.isTTY) {
    return '';
  }

  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function main() {
  const pepper = process.env.APP_PEPPER?.trim();
  if (!pepper) {
    console.error('APP_PEPPER is required');
    process.exitCode = 1;
    return;
  }

  const cliArgs = process.argv
    .slice(2)
    .filter((value) => value !== '--');
  const apiKey = (cliArgs[0] ?? (await readStdin())).trim();
  if (!apiKey) {
    console.error('Usage: APP_PEPPER=... pnpm deep-analysis:fingerprint -- <x-mem9-api-key>');
    process.exitCode = 1;
    return;
  }

  const fingerprint = createHmac('sha256', pepper).update(apiKey, 'utf8').digest('hex');
  process.stdout.write(`${fingerprint}\n`);
}

await main();
