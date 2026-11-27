import type { DeepAnalysisReportPreview } from '@mem9/contracts';

import { publicStoredError } from './errors';

/** Also masks raw errors in reports saved before error sanitization was deployed. */
export function publicReportPreview(value: unknown): DeepAnalysisReportPreview | null {
  if (!value || typeof value !== 'object') return null;
  const preview = value as DeepAnalysisReportPreview;
  return {
    ...preview,
    ...(preview.duplicateCleanup ? {
      duplicateCleanup: {
        ...preview.duplicateCleanup,
        errorMessage: publicStoredError(preview.duplicateCleanup.errorMessage),
      },
    } : {}),
  };
}
