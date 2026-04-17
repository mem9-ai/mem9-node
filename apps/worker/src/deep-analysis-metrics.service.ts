import { Injectable } from '@nestjs/common';

import type {
  QwenAuditStage,
  QwenJsonResult,
} from './qwen-deep-analysis.service';

type RequestStatus = 'success' | 'error';
type TokenType = 'input' | 'output' | 'total';

@Injectable()
export class DeepAnalysisMetricsService {
  private readonly requestCounts = new Map<string, number>();
  private readonly tokenCounts = new Map<string, number>();

  public recordQwenResult(result: QwenJsonResult<unknown>): void {
    if (!result.requestMeta.requested) {
      return;
    }

    const phase = result.requestMeta.stage;
    const model = result.usage?.model ?? 'unknown';
    const status: RequestStatus = result.requestMeta.success
      ? 'success'
      : 'error';
    const usageMissing = result.usage?.usageMissing ?? true;

    this.incrementRequest(phase, model, status, usageMissing);

    if (
      result.usage?.promptTokens !== null &&
      result.usage?.promptTokens !== undefined
    ) {
      this.incrementToken(phase, model, 'input', result.usage.promptTokens);
    }
    if (
      result.usage?.completionTokens !== null &&
      result.usage?.completionTokens !== undefined
    ) {
      this.incrementToken(
        phase,
        model,
        'output',
        result.usage.completionTokens,
      );
    }
    if (
      result.usage?.totalTokens !== null &&
      result.usage?.totalTokens !== undefined
    ) {
      this.incrementToken(phase, model, 'total', result.usage.totalTokens);
    }
  }

  public renderPrometheusMetrics(): string {
    const lines: string[] = [
      '# HELP mnemo_deep_analysis_requests_total Total number of deep analysis Qwen requests.',
      '# TYPE mnemo_deep_analysis_requests_total counter',
      ...this.renderSeries(
        'mnemo_deep_analysis_requests_total',
        this.requestCounts,
      ),
      '# HELP mnemo_deep_analysis_tokens_total Total number of deep analysis Qwen tokens consumed.',
      '# TYPE mnemo_deep_analysis_tokens_total counter',
      ...this.renderSeries(
        'mnemo_deep_analysis_tokens_total',
        this.tokenCounts,
      ),
    ];

    return `${lines.join('\n')}\n`;
  }

  private incrementRequest(
    phase: QwenAuditStage,
    model: string,
    status: RequestStatus,
    usageMissing: boolean,
  ): void {
    const key = this.buildKey({
      model,
      phase,
      status,
      usage_missing: String(usageMissing),
    });
    this.requestCounts.set(key, (this.requestCounts.get(key) ?? 0) + 1);
  }

  private incrementToken(
    phase: QwenAuditStage,
    model: string,
    type: TokenType,
    value: number,
  ): void {
    const key = this.buildKey({
      model,
      phase,
      type,
    });
    this.tokenCounts.set(key, (this.tokenCounts.get(key) ?? 0) + value);
  }

  private renderSeries(
    metricName: string,
    values: Map<string, number>,
  ): string[] {
    return [...values.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([labels, value]) => `${metricName}{${labels}} ${value}`);
  }

  private buildKey(labels: Record<string, string>): string {
    return Object.entries(labels)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}="${this.escapeLabelValue(value)}"`)
      .join(',');
  }

  private escapeLabelValue(value: string): string {
    return value
      .replaceAll('\\', '\\\\')
      .replaceAll('\n', '\\n')
      .replaceAll('"', '\\"');
  }
}
