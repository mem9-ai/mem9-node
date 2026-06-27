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

interface Mem9MemoryResponse {
  id: string;
  content: string;
  created_at: string;
  updated_at?: string;
  memory_type?: string;
  tags?: string[];
  metadata?: Record<string, unknown> | null;
}

interface Mem9SessionEditResponse {
  id?: string;
  appId?: string;
  session_id?: string;
  seq?: number;
  agent_id?: string;
  original_content?: string;
  edited_content?: string;
  edited_tags?: string[];
  correctness?: string;
  edited_by?: string;
  reason?: string;
  version?: number;
  state?: string;
  created_at?: string;
  updated_at?: string;
}

interface Mem9EditSessionMessageResponse {
  edit_id?: string;
  version?: number;
  edit?: Mem9SessionEditResponse;
  session?: Mem9MemoryResponse;
}

interface Mem9MarkSessionMessageResponse {
  id?: string;
  correctness?: string;
  version?: number;
}

interface Mem9DeleteSessionMessageEditResponse {
  id?: string;
  reverted?: boolean;
}

interface FetchPageOptions {
  createdAfter?: string;
  createdBefore?: string;
  memoryType?: string;
}

export interface Mem9MemoryPage {
  memories: DeepAnalysisMemorySnapshot[];
  total: number;
  limit: number;
  offset: number;
}

export interface FetchSessionMemoriesOptions {
  createdAfter: string;
  createdBefore: string;
}

export type SessionMessageCorrectness = 'correct' | 'incorrect';

export interface SessionMessageView {
  id: string;
  content: string;
  createdAt?: string;
  updatedAt?: string;
  memoryType?: string;
  tags?: string[];
  metadata?: Record<string, unknown> | null;
}

export interface SessionMessageEditView {
  id: string;
  version: number;
  correctness?: SessionMessageCorrectness | null;
  originalContent: string;
  editedContent?: string | null;
  tags?: string[] | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface EditSessionMessageResult {
  id: string;
  editId: string;
  version: number;
  correctness?: SessionMessageCorrectness | null;
  originalContent: string;
  editedContent: string;
  tags?: string[] | null;
  session: SessionMessageView;
}

export interface MarkSessionMessageResult {
  id: string;
  correctness: SessionMessageCorrectness;
  version: number;
}

export interface DeleteSessionMessageEditResult {
  id: string;
  reverted: boolean;
}

@Injectable()
export class Mem9SourceService {
  public constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  public async countMemories(apiKey: string): Promise<number> {
    const page = await this.fetchPage(apiKey, 1, 0, {
      memoryType: 'pinned,insight',
    });
    return page.total;
  }

  public async fetchMemories(
    apiKey: string,
    limit: number,
    offset: number,
  ): Promise<Mem9MemoryPage> {
    const page = await this.fetchPage(apiKey, limit, offset, {
      memoryType: 'session',
    });
    return {
      memories: page.memories.map((memory) => this.toMemorySnapshot(memory)),
      total: page.total,
      limit: page.limit,
      offset: page.offset,
    };
  }

  public async fetchSessionMemories(
    apiKey: string,
    options: FetchSessionMemoriesOptions,
  ): Promise<DeepAnalysisMemorySnapshot[]> {
    const memories: DeepAnalysisMemorySnapshot[] = [];
    const pageSize = this.config.analysis.mem9SourcePageSize;
    let total = Number.POSITIVE_INFINITY;
    let offset = 0;

    while (offset < total) {
      const page = await this.fetchPage(apiKey, pageSize, offset, {
        createdAfter: options.createdAfter,
        createdBefore: options.createdBefore,
        memoryType: 'session',
      });
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

  public async fetchAllMemories(apiKey: string): Promise<DeepAnalysisMemorySnapshot[]> {
    const memories: DeepAnalysisMemorySnapshot[] = [];
    const pageSize = this.config.analysis.mem9SourcePageSize;
    let total = Number.POSITIVE_INFINITY;
    let offset = 0;

    while (offset < total) {
      const page = await this.fetchPage(apiKey, pageSize, offset, {
        memoryType: 'pinned,insight',
      });
      total = page.total;
      offset += page.limit;

      for (const memory of page.memories) {
        memories.push(this.toMemorySnapshot(memory));
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

  public async fetchMemoryById(apiKey: string, memoryId: string): Promise<DeepAnalysisMemorySnapshot> {
    const response = await this.requestWithRetry({
      url: `${this.baseUrl()}/memories/${encodeURIComponent(memoryId)}`,
      init: {
        headers: this.buildHeaders(apiKey),
      },
      isSuccess: (value) => value.ok,
    }).catch((error: unknown) => {
      throw this.toSessionMessageUpstreamError(error);
    });

    if (response?.ok !== true) {
      throw await this.toSessionMessageResponseError(response, {
        notFoundCode: 'SESSION_MESSAGE_NOT_FOUND',
        notFoundMessage: 'Session message not found',
      });
    }

    const payload = (await response.json()) as Mem9MemoryResponse;
    return this.toMemorySnapshot(payload);
  }

  public async editSessionMessage(
    apiKey: string,
    id: string,
    input: {
      content: string;
      tags?: string[];
      reason?: string;
    },
  ): Promise<EditSessionMessageResult> {
    const response = await this.requestWithRetry({
      url: `${this.baseUrl()}/session-messages/${encodeURIComponent(id)}`,
      init: {
        method: 'PUT',
        headers: {
          ...this.buildHeaders(apiKey),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(input),
      },
      isSuccess: (value) => value.ok,
    }).catch((error: unknown) => {
      throw this.toSessionMessageUpstreamError(error);
    });

    if (response?.ok !== true) {
      throw await this.toSessionMessageResponseError(response, {
        validationCode: 'SESSION_MESSAGE_EDIT_INVALID',
        validationMessage: 'Invalid session message edit request',
        notFoundCode: 'SESSION_MESSAGE_NOT_FOUND',
        notFoundMessage: 'Session message not found',
      });
    }

    return this.normalizeEditSessionMessageResponse(
      (await response.json()) as Mem9EditSessionMessageResponse,
      id,
    );
  }

  public async getSessionMessageEdit(
    apiKey: string,
    id: string,
  ): Promise<SessionMessageEditView> {
    const response = await this.requestWithRetry({
      url: `${this.baseUrl()}/session-messages/${encodeURIComponent(id)}/edit`,
      init: {
        headers: this.buildHeaders(apiKey),
      },
      isSuccess: (value) => value.ok,
    }).catch((error: unknown) => {
      throw this.toSessionMessageUpstreamError(error);
    });

    if (response?.ok !== true) {
      throw await this.toSessionMessageResponseError(response, {
        notFoundCode: 'SESSION_MESSAGE_EDIT_NOT_FOUND',
        notFoundMessage: 'Session message edit not found',
      });
    }

    return this.normalizeSessionEdit(
      (await response.json()) as Mem9SessionEditResponse,
      id,
    );
  }

  public async deleteSessionMessageEdit(
    apiKey: string,
    id: string,
  ): Promise<DeleteSessionMessageEditResult> {
    const response = await this.requestWithRetry({
      url: `${this.baseUrl()}/session-messages/${encodeURIComponent(id)}/edit`,
      init: {
        method: 'DELETE',
        headers: this.buildHeaders(apiKey),
      },
      isSuccess: (value) => value.ok,
    }).catch((error: unknown) => {
      throw this.toSessionMessageUpstreamError(error);
    });

    if (response?.ok !== true) {
      throw await this.toSessionMessageResponseError(response, {
        notFoundCode: 'SESSION_MESSAGE_NOT_FOUND',
        notFoundMessage: 'Session message not found',
      });
    }

    const payload = (await response.json()) as Mem9DeleteSessionMessageEditResponse;
    return {
      id: this.normalizeString(payload.id) || id,
      reverted: payload.reverted === true,
    };
  }

  public async markSessionMessage(
    apiKey: string,
    id: string,
    correctness: SessionMessageCorrectness,
  ): Promise<MarkSessionMessageResult> {
    const response = await this.requestWithRetry({
      url: `${this.baseUrl()}/session-messages/${encodeURIComponent(id)}/mark`,
      init: {
        method: 'PUT',
        headers: {
          ...this.buildHeaders(apiKey),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ correctness }),
      },
      isSuccess: (value) => value.ok,
    }).catch((error: unknown) => {
      throw this.toSessionMessageUpstreamError(error);
    });

    if (response?.ok !== true) {
      throw await this.toSessionMessageResponseError(response, {
        validationCode: 'SESSION_MESSAGE_MARK_INVALID',
        validationMessage: 'Invalid session message mark request',
        notFoundCode: 'SESSION_MESSAGE_NOT_FOUND',
        notFoundMessage: 'Session message not found',
      });
    }

    const payload = (await response.json()) as Mem9MarkSessionMessageResponse;
    const normalizedCorrectness = this.normalizeCorrectness(payload.correctness) ?? correctness;
    return {
      id: this.normalizeString(payload.id) || id,
      correctness: normalizedCorrectness,
      version: Number(payload.version ?? 0),
    };
  }

  private async fetchPage(
    apiKey: string,
    limit: number,
    offset: number,
    options: FetchPageOptions = {},
  ): Promise<Mem9MemoryListResponse> {
    const query = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
      state: 'active',
    });

    if (options.memoryType) {
      query.set('memory_type', options.memoryType);
    }
    if (options.createdAfter) {
      query.set('created_after', options.createdAfter);
    }
    if (options.createdBefore) {
      query.set('created_before', options.createdBefore);
    }

    const response = await this.requestWithRetry({
      url: `${this.baseUrl()}/memories?${query.toString()}`,
      init: {
        headers: this.buildHeaders(apiKey),
      },
      isSuccess: (value) => value.ok,
    });

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

  private async readErrorBody(response: Response | null): Promise<unknown> {
    if (!response) {
      return undefined;
    }

    if (typeof response.text !== 'function') {
      if (typeof response.json === 'function') {
        return await response.json().catch(() => undefined);
      }
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

  private normalizeEditSessionMessageResponse(
    payload: Mem9EditSessionMessageResponse,
    fallbackId: string,
  ): EditSessionMessageResult {
    const edit = this.normalizeSessionEdit(payload.edit ?? {}, fallbackId);
    const session = this.normalizeSessionMessage(payload.session, edit.id);
    return {
      id: session.id || edit.id,
      editId: this.normalizeString(payload.edit_id) || edit.id,
      version: Number(payload.version ?? edit.version),
      correctness: edit.correctness,
      originalContent: edit.originalContent,
      editedContent: edit.editedContent ?? session.content,
      tags: edit.tags,
      session,
    };
  }

  private normalizeSessionEdit(
    payload: Mem9SessionEditResponse,
    fallbackId: string,
  ): SessionMessageEditView {
    return {
      id: this.normalizeString(payload.id) || fallbackId,
      version: Number(payload.version ?? 0),
      correctness: this.normalizeCorrectness(payload.correctness),
      originalContent: this.normalizeString(payload.original_content),
      editedContent: payload.edited_content === undefined
        ? null
        : this.normalizeString(payload.edited_content),
      tags: Array.isArray(payload.edited_tags) ? payload.edited_tags : null,
      createdAt: this.normalizeString(payload.created_at) || undefined,
      updatedAt: this.normalizeString(payload.updated_at) || undefined,
    };
  }

  private normalizeSessionMessage(
    payload: Mem9MemoryResponse | undefined,
    fallbackId: string,
  ): SessionMessageView {
    return {
      id: this.normalizeString(payload?.id) || fallbackId,
      content: this.normalizeString(payload?.content),
      createdAt: this.normalizeString(payload?.created_at) || undefined,
      updatedAt: this.normalizeString(payload?.updated_at) || undefined,
      memoryType: this.normalizeString(payload?.memory_type) || undefined,
      tags: Array.isArray(payload?.tags) ? payload.tags : [],
      metadata: payload?.metadata ?? null,
    };
  }

  private normalizeCorrectness(value: unknown): SessionMessageCorrectness | null {
    return value === 'correct' || value === 'incorrect' ? value : null;
  }

  private normalizeString(value: unknown): string {
    return typeof value === 'string' ? value : '';
  }

  private async toSessionMessageResponseError(
    response: Response | null,
    options: {
      validationCode?: string;
      validationMessage?: string;
      notFoundCode: string;
      notFoundMessage: string;
    },
  ): Promise<AppError> {
    const body = await this.readErrorBody(response);
    const upstreamError = this.extractUpstreamError(body);
    const details = {
      upstreamStatus: response?.status,
      upstreamError,
    };

    if (response?.status === 400) {
      return new AppError(options.validationMessage ?? 'Invalid session message request', {
        statusCode: 400,
        code: options.validationCode ?? 'SESSION_MESSAGE_INVALID',
        details,
      });
    }

    if (response?.status === 401 || response?.status === 403) {
      return new AppError('Invalid MEM9 API key', {
        statusCode: 401,
        code: 'INVALID_API_KEY',
        details,
      });
    }

    if (response?.status === 404) {
      return new AppError(options.notFoundMessage, {
        statusCode: 404,
        code: options.notFoundCode,
        details,
      });
    }

    if (response?.status === 409) {
      return new AppError('Session message edit conflict', {
        statusCode: 409,
        code: 'SESSION_MESSAGE_EDIT_CONFLICT',
        details,
      });
    }

    return new AppError('Failed to call mem9 session message API', {
      statusCode: 502,
      code: 'SESSION_MESSAGE_UPSTREAM_FAILED',
      details,
    });
  }

  private toSessionMessageUpstreamError(error: unknown): AppError {
    if (error instanceof AppError) {
      return new AppError('Failed to call mem9 session message API', {
        statusCode: 502,
        code: 'SESSION_MESSAGE_UPSTREAM_FAILED',
        details: error.details,
        cause: error,
      });
    }

    return new AppError('Failed to call mem9 session message API', {
      statusCode: 502,
      code: 'SESSION_MESSAGE_UPSTREAM_FAILED',
      details: {
        reason: error instanceof Error ? error.message : String(error),
      },
      cause: error,
    });
  }

  private extractUpstreamError(body: unknown): string | undefined {
    if (body && typeof body === 'object' && 'error' in body) {
      const value = (body as { error?: unknown }).error;
      return typeof value === 'string' ? value.slice(0, 512) : undefined;
    }
    return typeof body === 'string' ? body.slice(0, 512) : undefined;
  }
}
