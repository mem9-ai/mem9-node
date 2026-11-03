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
  const cliArgs = process.argv.slice(2).filter((value) => value !== '--');
  if (cliArgs.length > 0) {
    console.error('Supply the API key through standard input; command-line key arguments are not accepted.');
    process.exitCode = 1;
    return;
  }

  const pepper = process.env.APP_PEPPER?.trim();
  if (!pepper) {
    console.error('APP_PEPPER is required');
    process.exitCode = 1;
    return;
  }

  const apiKey = await readStdin();
  if (!apiKey) {
    console.error('Set APP_PEPPER in the environment and supply the API key through standard input to pnpm deep-analysis:fingerprint.');
    process.exitCode = 1;
    return;
  }

  const fingerprint = createHmac('sha256', pepper).update(apiKey, 'utf8').digest('hex');
  process.stdout.write(`${fingerprint}\n`);
}

await main();
