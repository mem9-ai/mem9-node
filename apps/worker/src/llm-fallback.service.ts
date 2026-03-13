import type { AnalysisLlmMessage } from '@mem9/contracts';
import { Injectable } from '@nestjs/common';


@Injectable()
export class LlmFallbackService {
  public async enqueue(message: AnalysisLlmMessage): Promise<void> {
    void message;
    // TODO: wire the low-confidence subset into the llm queue once a provider is selected.
  }
}
