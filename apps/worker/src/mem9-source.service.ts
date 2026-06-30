import type { AppConfig } from '@mem9/config';
import { APP_CONFIG } from '@mem9/config';
import type { DeepAnalysisMemorySnapshot } from '@mem9/contracts';
import { AppError } from '@mem9/shared';
import { Inject, Injectable } from '@nestjs/common';

interface Mem9MemoryListResponse {
  memories: {
    id: string;
    content: string;
    created_at: string;
    updated_at?: string;
    memory_type?: string;
    tags?: string[];
    metadata?: Record<string, unknown> | null;
  }[];
  total: number;
  limit: number;
  offset: number;
}

interface FetchSessionMemoriesOptions {
  createdAfter: string;
  createdBefore: string;
}

@Injectable()
export class Mem9SourceService {
  public constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  public async fetchSessionMemories(
    apiKey: string,
    options: FetchSessionMemoriesOptions,
  ): Promise<DeepAnalysisMemorySnapshot[]> {
    const memories: DeepAnalysisMemorySnapshot[] = [];
    const pageSize = this.config.analysis.mem9SourcePageSize;
    let total = Number.POSITIVE_INFINITY;
    let offset = 0;

    while (offset < total) {
      const page = await this.fetchPage(apiKey, pageSize, offset, options);
      total = page.total;
      offset += page.limit;

      for (const memory of page.memories) {
        const snapshot = this.toMemorySnapshot(memory);
        if (this.isIncorrectSessionMemory(snapshot)) {
          continue;
        }
        memories.push(snapshot);
      }

      if (page.memories.length === 0) {
        break;
      }
    }

    return memories;
  }

  private async fetchPage(
    apiKey: string,
    limit: number,
    offset: number,
    options: FetchSessionMemoriesOptions,
  ): Promise<Mem9MemoryListResponse> {
    const query = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
      state: 'active',
      memory_type: 'session',
      created_after: options.createdAfter,
      created_before: options.createdBefore,
    });

    const response = await this.requestWithRetry(
      `${this.baseUrl()}/memories?${query.toString()}`,
      {
        headers: this.buildHeaders(apiKey),
      },
    );

    if (response?.ok !== true) {
      const errorBody = await this.readErrorBody(response);
      throw new AppError('Failed to fetch memories from mem9 source API', {
        statusCode: 502,
        code: 'DEEP_ANALYSIS_SOURCE_FETCH_FAILED',
        details: {
          status: response?.status,
          body: errorBody,
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

  private async requestWithRetry(url: string, init: RequestInit): Promise<Response | null> {
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

        if (response.ok || !this.shouldRetryStatus(response.status) || attempt === maxAttempts - 1) {
          return response;
        }
      } catch (error) {
        if (!this.shouldRetryError(error) || attempt === maxAttempts - 1) {
          throw new AppError('Failed to fetch memories from mem9 source API', {
            statusCode: 502,
            code: 'DEEP_ANALYSIS_SOURCE_FETCH_FAILED',
            details: {
              reason: error instanceof Error ? error.message : String(error),
              timeoutMs: error instanceof Error && error.name === 'AbortError'
                ? this.config.analysis.mem9SourceRequestTimeoutMs
                : undefined,
              url: this.redactUrl(url),
            },
          });
        }
      } finally {
        clearTimeout(timeout);
      }

      attempt += 1;
      await this.sleep(this.config.analysis.mem9SourceFetchRetryBaseMs * attempt);
    }

    return null;
  }

  private shouldRetryStatus(status: number): boolean {
    return status === 408 || status === 429 || status >= 500;
  }

  private shouldRetryError(error: unknown): boolean {
    return error instanceof Error && (error.name === 'AbortError' || error.name === 'TypeError');
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  private buildHeaders(apiKey: string): Record<string, string> {
    return {
      'X-API-Key': apiKey,
      'X-Mnemo-Agent-Id': 'mem9-memory-analysis-worker',
    };
  }

  private async readErrorBody(response: Response | null): Promise<unknown> {
    if (!response) {
      return undefined;
    }

    const text = await response.text().catch(() => '');
    if (!text) {
      return undefined;
    }

    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text.slice(0, 1000);
    }
  }

  private baseUrl(): string {
    return this.config.analysis.mem9SourceApiBaseUrl.replace(/\/+$/, '');
  }

  private redactUrl(url: string): string {
    try {
      const parsed = new URL(url);
      if (parsed.searchParams.has('api_key')) {
        parsed.searchParams.set('api_key', '[REDACTED]');
      }
      return parsed.toString();
    } catch {
      return url;
    }
  }

  private toMemorySnapshot(memory: Mem9MemoryListResponse['memories'][number]): DeepAnalysisMemorySnapshot {
    return {
      id: memory.id,
      content: memory.content,
      createdAt: memory.created_at,
      updatedAt: memory.updated_at,
      memoryType: memory.memory_type,
      tags: Array.isArray(memory.tags) ? memory.tags : [],
      metadata: memory.metadata ?? null,
    };
  }

  private isIncorrectSessionMemory(memory: DeepAnalysisMemorySnapshot): boolean {
    return (
      memory.memoryType === 'session'
      && memory.metadata !== null
      && typeof memory.metadata === 'object'
      && memory.metadata.correctness === 'incorrect'
    );
  }
}
