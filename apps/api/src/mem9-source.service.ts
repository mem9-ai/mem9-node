import type { AppConfig } from '@mem9/config';
import { APP_CONFIG } from '@mem9/config';
import type { DeepAnalysisMemorySnapshot } from '@mem9/contracts';
import { AppError } from '@mem9/shared';
import { Inject, Injectable } from '@nestjs/common';

interface Mem9MemoryListResponse {
  memories: Array<{
    id: string;
    content: string;
    created_at: string;
    updated_at?: string;
    memory_type?: string;
    tags?: string[];
    metadata?: Record<string, unknown> | null;
  }>;
  total: number;
  limit: number;
  offset: number;
}

@Injectable()
export class Mem9SourceService {
  public constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  public async countMemories(apiKey: string): Promise<number> {
    const page = await this.fetchPage(apiKey, 1, 0);
    return page.total;
  }

  public async fetchAllMemories(apiKey: string): Promise<DeepAnalysisMemorySnapshot[]> {
    const memories: DeepAnalysisMemorySnapshot[] = [];
    const pageSize = this.config.analysis.mem9SourcePageSize;
    let total = Number.POSITIVE_INFINITY;
    let offset = 0;

    while (offset < total) {
      const page = await this.fetchPage(apiKey, pageSize, offset);
      total = page.total;
      offset += page.limit;

      for (const memory of page.memories) {
        memories.push({
          id: memory.id,
          content: memory.content,
          createdAt: memory.created_at,
          updatedAt: memory.updated_at,
          memoryType: memory.memory_type,
          tags: Array.isArray(memory.tags) ? memory.tags : [],
          metadata: memory.metadata ?? null,
        });
      }

      if (page.memories.length === 0) {
        break;
      }
    }

    return memories;
  }

  public async deleteMemories(apiKey: string, memoryIds: string[]): Promise<{
    deletedMemoryIds: string[];
    failedMemoryIds: string[];
  }> {
    const uniqueMemoryIds = [...new Set(memoryIds.filter((value) => value.trim().length > 0))];
    const results = await this.mapWithConcurrency(
      uniqueMemoryIds,
      this.config.analysis.mem9SourceDeleteConcurrency,
      async (memoryId) => ({
        memoryId,
        deleted: await this.deleteMemory(apiKey, memoryId),
      }),
    );

    return {
      deletedMemoryIds: results.filter((item) => item.deleted).map((item) => item.memoryId),
      failedMemoryIds: results.filter((item) => !item.deleted).map((item) => item.memoryId),
    };
  }

  private async fetchPage(
    apiKey: string,
    limit: number,
    offset: number,
  ): Promise<Mem9MemoryListResponse> {
    const query = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
      state: 'active',
      memory_type: 'pinned,insight',
    });
    const response = await this.requestWithRetry({
      url: `${this.baseUrl()}/memories?${query.toString()}`,
      init: {
        headers: this.buildHeaders(apiKey),
      },
      isSuccess: (value) => value.ok,
    });

    if (!response || !response.ok) {
      throw new AppError('Failed to fetch memories from mem9 source API', {
        statusCode: 502,
        code: 'DEEP_ANALYSIS_SOURCE_FETCH_FAILED',
        details: {
          status: response?.status,
        },
      });
    }

    const payload = (await response.json()) as Partial<Mem9MemoryListResponse>;
    return {
      memories: Array.isArray(payload.memories) ? payload.memories : [],
      total: Number(payload.total ?? 0),
      limit: Number(payload.limit ?? limit),
      offset: Number(payload.offset ?? offset),
    };
  }

  private async deleteMemory(apiKey: string, memoryId: string): Promise<boolean> {
    const response = await this.requestWithRetry({
      url: `${this.baseUrl()}/memories/${encodeURIComponent(memoryId)}`,
      init: {
        method: 'DELETE',
        headers: this.buildHeaders(apiKey),
      },
      isSuccess: (value) => value.status === 204 || value.status === 404,
      allowNonRetryableFailure: true,
    });

    return response?.status === 204 || response?.status === 404;
  }

  private async requestWithRetry({
    url,
    init,
    isSuccess,
    allowNonRetryableFailure = false,
  }: {
    url: string;
    init: RequestInit;
    isSuccess: (response: Response) => boolean;
    allowNonRetryableFailure?: boolean;
  }): Promise<Response | null> {
    const maxAttempts = this.config.analysis.mem9SourceFetchRetries + 1;
    let attempt = 0;

    while (attempt < maxAttempts) {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        this.config.analysis.mem9SourceRequestTimeoutMs,
      );

      try {
        const response = await fetch(url, {
          ...init,
          signal: controller.signal,
        });

        if (isSuccess(response)) {
          return response;
        }

        if (!this.shouldRetryStatus(response.status) || attempt === maxAttempts - 1) {
          if (allowNonRetryableFailure) {
            return response;
          }
          return response;
        }
      } catch (error) {
        if (!this.shouldRetryError(error) || attempt === maxAttempts - 1) {
          if (allowNonRetryableFailure) {
            return null;
          }

          throw new AppError('Failed to fetch memories from mem9 source API', {
            statusCode: 502,
            code: 'DEEP_ANALYSIS_SOURCE_FETCH_FAILED',
            details: {
              reason: error instanceof Error ? error.message : String(error),
            },
          });
        }
      } finally {
        clearTimeout(timeout);
      }

      attempt += 1;
      await this.sleep(this.getRetryDelayMs(attempt));
    }

    if (allowNonRetryableFailure) {
      return null;
    }

    throw new AppError('Failed to fetch memories from mem9 source API', {
      statusCode: 502,
      code: 'DEEP_ANALYSIS_SOURCE_FETCH_FAILED',
      details: {
        reason: 'exhausted retries without a terminal response',
      },
    });
  }

  private shouldRetryStatus(status: number): boolean {
    return status === 408 || status === 429 || status >= 500;
  }

  private shouldRetryError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    return error.name === 'AbortError' || error.name === 'TypeError';
  }

  private getRetryDelayMs(attempt: number): number {
    return this.config.analysis.mem9SourceFetchRetryBaseMs * attempt;
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  private async mapWithConcurrency<TItem, TResult>(
    items: TItem[],
    concurrency: number,
    worker: (item: TItem) => Promise<TResult>,
  ): Promise<TResult[]> {
    const results = new Array<TResult>(items.length);
    let nextIndex = 0;

    const runWorker = async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await worker(items[currentIndex]!);
      }
    };

    await Promise.all(
      Array.from(
        { length: Math.min(concurrency, items.length) },
        () => runWorker(),
      ),
    );

    return results;
  }

  private buildHeaders(apiKey: string): Record<string, string> {
    return {
      'X-API-Key': apiKey,
      'X-Mnemo-Agent-Id': 'mem9-deep-analysis',
    };
  }

  private baseUrl(): string {
    return this.config.analysis.mem9SourceApiBaseUrl.replace(/\/+$/, '');
  }
}
