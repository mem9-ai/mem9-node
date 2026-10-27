import { validate } from 'class-validator';

import { MemoryDto } from './upload-analysis-batch.dto';

it('accepts historical long content without imposing a per-memory length limit', async () => {
  const memory = Object.assign(new MemoryDto(), {
    id: 'id',
    content: 'a'.repeat(12001),
    createdAt: '2026-10-26T00:00:00Z',
    metadata: {},
  });
  expect(await validate(memory)).toEqual([]);
});
