import type { AppConfig } from '@mem9/config';
import { APP_CONFIG } from '@mem9/config';
import { Inject, Injectable, Logger } from '@nestjs/common';

@Injectable()
export class QwenDeepAnalysisService {
  private readonly logger = new Logger(QwenDeepAnalysisService.name);

  public constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  public async createJson<T>(
    systemPrompt: string,
    userPrompt: string,
  ): Promise<T | null> {
    if (!this.config.analysis.qwenApiKey) {
      return null;
    }

    const response = await fetch(`${this.config.analysis.qwenApiBaseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.analysis.qwenApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.config.analysis.qwenModel,
        temperature: 0.2,
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

    if (!response.ok) {
      this.logger.warn(`Qwen request failed with status ${response.status}`);
      return null;
    }

    const payload = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: string;
        };
      }>;
    };
    const content = payload.choices?.[0]?.message?.content;

    if (!content) {
      return null;
    }

    try {
      return JSON.parse(content) as T;
    } catch (error) {
      this.logger.warn(`Failed to parse Qwen JSON response: ${error instanceof Error ? error.message : 'unknown error'}`);
      return null;
    }
  }
}
