import { ValidationPipe } from '@nestjs/common';

import { CreateDeepAnalysisReportDto } from './create-deep-analysis-report.dto';

const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidUnknownValues: true });
const metadata = { type: 'body' as const, metatype: CreateDeepAnalysisReportDto };

describe('deep analysis report input validation', () => {
  it.each([
    { lang: 'zh-CN', timezone: 'Asia/Shanghai' },
    { lang: 'a'.repeat(32), timezone: 'b'.repeat(64) },
  ])('accepts strings within the database column limits', async (body) => {
    await expect(pipe.transform(body, metadata)).resolves.toEqual(body);
  });

  it.each([
    { lang: 'a'.repeat(33), timezone: 'UTC' },
    { lang: 'en', timezone: 'a'.repeat(65) },
    { lang: '', timezone: 'UTC' },
    { lang: 'en', timezone: '' },
    { lang: 123, timezone: 'UTC' },
    { timezone: 'UTC' },
  ])('rejects invalid input with 400 before reaching persistence', async (body) => {
    await expect(pipe.transform(body, metadata)).rejects.toMatchObject({ status: 400 });
  });
});
