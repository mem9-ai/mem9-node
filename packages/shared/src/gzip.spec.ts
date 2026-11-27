import { gzipSync } from 'node:zlib';

import { gunzipJson, gzipJson, MAX_SNAPSHOT_STORED_BYTES } from './gzip';

describe('bounded snapshot decompression', () => {
  it('round trips Unicode JSON at the exact decoded byte limit', async () => {
    const value = { content: '中文 memory' };
    const size = Buffer.byteLength(JSON.stringify(value));
    await expect(gunzipJson(gzipJson(value), size)).resolves.toEqual(value);
    await expect(gunzipJson(gzipJson(value), size - 1)).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  });

  it('rejects a highly compressed payload without returning partial JSON', async () => {
    const compressed = gzipSync(JSON.stringify({ content: 'x'.repeat(1024 * 1024) }));
    expect(compressed.length).toBeLessThan(2048);
    await expect(gunzipJson(compressed, 4096)).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  });

  it('rejects oversized compressed inputs before decoding', async () => {
    await expect(gunzipJson(Buffer.alloc(MAX_SNAPSHOT_STORED_BYTES + 1))).rejects.toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
    });
  });

  it('rejects corrupt gzip and invalid JSON', async () => {
    await expect(gunzipJson(Buffer.from('invalid gzip'))).rejects.toThrow();
    await expect(gunzipJson(gzipSync('invalid JSON'))).rejects.toThrow();
    await expect(gunzipJson(gzipJson({ ok: true }).subarray(0, 10))).rejects.toThrow();
  });
});
