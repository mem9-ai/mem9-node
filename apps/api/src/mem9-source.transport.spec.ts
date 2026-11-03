import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { loadConfig } from '@mem9/config';

import { Mem9SourceService as WorkerSourceService } from '../../worker/src/mem9-source.service';

import { Mem9SourceService } from './mem9-source.service';

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

describe('MEM9 source credential transport', () => {
  it.each(['api', 'worker'] as const)('%s does not forward an API key to a redirect destination', async (client) => {
    const leakedKeys: string[] = [];
    const destination = createServer((request, response) => {
      leakedKeys.push(String(request.headers['x-api-key']));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ memories: [], total: 0, limit: 200, offset: 0 }));
    });
    const destinationUrl = await listen(destination);
    const source = createServer((_request, response) => {
      response.writeHead(302, { location: `${destinationUrl}/memories` });
      response.end();
    });
    const sourceUrl = await listen(source);
    try {
      const config = loadConfig({
        NODE_ENV: 'test',
        MEM9_SOURCE_API_BASE_URL: sourceUrl,
        MEM9_SOURCE_FETCH_RETRIES: '0',
      });
      const request = client === 'api'
        ? new Mem9SourceService(config).countMemories('transport-test-key')
        : new WorkerSourceService(config).fetchSessionMemories('transport-test-key', {
          createdAfter: '2026-11-01T00:00:00Z', createdBefore: '2026-11-02T00:00:00Z',
        });
      await expect(request).rejects.toMatchObject({ code: 'DEEP_ANALYSIS_SOURCE_FETCH_FAILED' });
      expect(leakedKeys).toEqual([]);
    } finally {
      await Promise.all([close(source), close(destination)]);
    }
  });
});
