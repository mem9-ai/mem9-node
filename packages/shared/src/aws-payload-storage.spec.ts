import { Readable } from 'node:stream';

import { S3PayloadStorageService } from './aws.service';

function fixture(body: unknown, contentLength?: number) {
  const send = jest.fn<Promise<{ Body: unknown; ContentLength?: number }>, [unknown, { abortSignal: AbortSignal }?]>().mockResolvedValue({ Body: body, ContentLength: contentLength });
  const storage = new S3PayloadStorageService({
    s3: { send }, settings: { aws: { s3BucketAnalysisPayloads: 'test' } },
  } as never);
  return { storage, send };
}

describe('bounded S3 snapshot downloads', () => {
  it('reads an exact-limit stream including multiple chunks', async () => {
    const { storage } = fixture(Readable.from([Buffer.from('abc'), Buffer.from('def')]));
    await expect(storage.getObjectBuffer('snapshot', 6)).resolves.toEqual(Buffer.from('abcdef'));
  });

  it.each([undefined, 1, 7])('rejects over-limit bodies with ContentLength %s', async length => {
    const body = Readable.from([Buffer.from('abc'), Buffer.from('defg')]);
    const { storage, send } = fixture(body, length);
    await expect(storage.getObjectBuffer('snapshot', 6)).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    expect(body.destroyed).toBe(true);
    expect(send.mock.calls[0]![1]!.abortSignal.aborted).toBe(true);
  });

  it('rejects a declared oversized body before reading it', async () => {
    const read = jest.fn();
    const body = new Readable({ read });
    const { storage } = fixture(body, 100);
    await expect(storage.getObjectBuffer('snapshot', 6)).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    expect(read).not.toHaveBeenCalled();
  });

  it('never uses an unbounded buffering fallback', async () => {
    const transformToByteArray = jest.fn();
    const { storage } = fixture({ transformToByteArray });
    await expect(storage.getObjectBuffer('snapshot')).rejects.toThrow('Unsupported S3 body stream');
    expect(transformToByteArray).not.toHaveBeenCalled();
  });

  it('aborts on stream failure and propagates the failure', async () => {
    const error = new Error('stream interrupted');
    const body = new Readable({ read() { this.destroy(error); } });
    const { storage, send } = fixture(body);
    await expect(storage.getObjectBuffer('snapshot')).rejects.toBe(error);
    expect(send.mock.calls[0]![1]!.abortSignal.aborted).toBe(true);
  });
});
