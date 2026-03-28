import type { AppConfig } from '@mem9/config';
import { APP_CONFIG } from '@mem9/config';
import { Inject, Injectable, Logger } from '@nestjs/common';

export type QwenAuditStage = 'chunk_analysis' | 'global_synthesis';

export interface QwenUsageRecord {
  model: string;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  usageMissing: boolean;
}

export interface QwenRawResponse {
  source: 'message_content' | 'response_payload';
  preview: string;
  truncated: boolean;
}

export interface QwenRequestMeta {
  stage: QwenAuditStage;
  success: boolean;
  requested: boolean;
  httpStatus: number | null;
  parseSucceeded: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  requestedAt: string;
  finishedAt: string;
}

export interface QwenJsonResult<T> {
  parsed: T | null;
  usage: QwenUsageRecord | null;
  requestMeta: QwenRequestMeta;
  rawResponse: QwenRawResponse | null;
}

const RAW_RESPONSE_PREVIEW_LIMIT = 6000;

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function buildRawResponse(value: unknown, source: QwenRawResponse['source']): QwenRawResponse | null {
  if (value === null || value === undefined) {
    return null;
  }

  let serialized: string;
  if (typeof value === 'string') {
    serialized = value;
  } else {
    try {
      serialized = JSON.stringify(value);
    } catch {
      serialized = String(value);
    }
  }

  if (serialized.length === 0) {
    return null;
  }

  return {
    source,
    preview: serialized.slice(0, RAW_RESPONSE_PREVIEW_LIMIT),
    truncated: serialized.length > RAW_RESPONSE_PREVIEW_LIMIT,
  };
}

@Injectable()
export class QwenDeepAnalysisService {
  private readonly logger = new Logger(QwenDeepAnalysisService.name);

  public constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  public getConfiguredModel(): string {
    return this.config.analysis.qwenModel ?? 'unconfigured';
  }

  public async createJson<T>(
    stage: QwenAuditStage,
    systemPrompt: string,
    userPrompt: string,
  ): Promise<QwenJsonResult<T>> {
    const requestedAt = new Date().toISOString();
    if (!this.config.analysis.qwenApiKey) {
      return {
        parsed: null,
        usage: null,
        rawResponse: null,
        requestMeta: {
          stage,
          success: false,
          requested: false,
          httpStatus: null,
          parseSucceeded: false,
          errorCode: 'QWEN_NOT_CONFIGURED',
          errorMessage: 'Qwen API key is not configured',
          requestedAt,
          finishedAt: new Date().toISOString(),
        },
      };
    }

    if (!this.config.analysis.qwenModel) {
      return {
        parsed: null,
        usage: null,
        rawResponse: null,
        requestMeta: {
          stage,
          success: false,
          requested: false,
          httpStatus: null,
          parseSucceeded: false,
          errorCode: 'QWEN_NOT_CONFIGURED',
          errorMessage: 'Qwen model is not configured',
          requestedAt,
          finishedAt: new Date().toISOString(),
        },
      };
    }

    const timeoutMs = this.config.analysis.qwenRequestTimeoutMs;
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    timeout.unref?.();

    try {
      const response = await fetch(`${this.config.analysis.qwenApiBaseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.config.analysis.qwenApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.analysis.qwenModel,
          temperature: 0.2,
          enable_thinking: false,
          response_format: {
            type: 'json_object',
          },
          messages: [
            {
              role: 'system',
              content: systemPrompt,
            },
            {
              role: 'user',
              content: userPrompt,
            },
          ],
        }),
      });
      const payload = await response.json().catch(() => null) as
        | {
          model?: string;
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            total_tokens?: number;
            promptTokens?: number;
            completionTokens?: number;
            totalTokens?: number;
          };
          choices?: Array<{
            message?: {
              content?: string;
            };
          }>;
          error?: {
            code?: string;
            message?: string;
          };
        }
        | null;
      const finishedAt = new Date().toISOString();
      const usage = this.buildUsage(payload);
      const content = payload?.choices?.[0]?.message?.content;

      if (!response.ok) {
        this.logger.warn(`Qwen request failed with status ${response.status}`);
        return {
          parsed: null,
          usage,
          rawResponse: buildRawResponse(payload, 'response_payload'),
          requestMeta: {
            stage,
            success: false,
            requested: true,
            httpStatus: response.status,
            parseSucceeded: false,
            errorCode: payload?.error?.code ?? 'QWEN_HTTP_ERROR',
            errorMessage: payload?.error?.message ?? `Qwen request failed with status ${response.status}`,
            requestedAt,
            finishedAt,
          },
        };
      }

      if (!content) {
        return {
          parsed: null,
          usage,
          rawResponse: buildRawResponse(payload, 'response_payload'),
          requestMeta: {
            stage,
            success: false,
            requested: true,
            httpStatus: response.status,
            parseSucceeded: false,
            errorCode: 'QWEN_EMPTY_RESPONSE',
            errorMessage: 'Qwen response did not include a JSON message content',
            requestedAt,
            finishedAt,
          },
        };
      }

      try {
        return {
          parsed: JSON.parse(content) as T,
          usage,
          rawResponse: null,
          requestMeta: {
            stage,
            success: true,
            requested: true,
            httpStatus: response.status,
            parseSucceeded: true,
            errorCode: null,
            errorMessage: null,
            requestedAt,
            finishedAt,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown error';
        this.logger.warn(`Failed to parse Qwen JSON response: ${message}`);
        return {
          parsed: null,
          usage,
          rawResponse: buildRawResponse(content, 'message_content'),
          requestMeta: {
            stage,
            success: false,
            requested: true,
            httpStatus: response.status,
            parseSucceeded: false,
            errorCode: 'QWEN_JSON_PARSE_FAILED',
            errorMessage: message,
            requestedAt,
            finishedAt,
          },
        };
      }
    } catch (error) {
      const finishedAt = new Date().toISOString();
      const timedOut = controller.signal.aborted || isAbortError(error);
      const message = error instanceof Error ? error.message : 'unknown error';
      this.logger.warn(
        timedOut
          ? `Qwen request timed out after ${timeoutMs}ms`
          : `Qwen request threw before completion: ${message}`,
      );
      return {
        parsed: null,
        usage: {
          model: this.config.analysis.qwenModel,
          promptTokens: null,
          completionTokens: null,
          totalTokens: null,
          usageMissing: true,
        },
        rawResponse: null,
        requestMeta: {
          stage,
          success: false,
          requested: true,
          httpStatus: null,
          parseSucceeded: false,
          errorCode: timedOut ? 'QWEN_REQUEST_TIMEOUT' : 'QWEN_REQUEST_FAILED',
          errorMessage: timedOut ? `Qwen request timed out after ${timeoutMs}ms` : message,
          requestedAt,
          finishedAt,
        },
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildUsage(payload: {
    model?: string;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
    };
  } | null): QwenUsageRecord {
    return {
      model: payload?.model ?? this.config.analysis.qwenModel ?? 'unknown',
      promptTokens: payload?.usage?.prompt_tokens ?? payload?.usage?.promptTokens ?? null,
      completionTokens: payload?.usage?.completion_tokens ?? payload?.usage?.completionTokens ?? null,
      totalTokens: payload?.usage?.total_tokens ?? payload?.usage?.totalTokens ?? null,
      usageMissing: payload?.usage === undefined,
    };
  }
}
