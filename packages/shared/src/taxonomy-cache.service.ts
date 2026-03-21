
import type { AppConfig } from '@mem9/config';
import { APP_CONFIG } from '@mem9/config';
import type { TaxonomyResponse, TaxonomyRuleDefinition } from '@mem9/contracts';
import { Inject, Injectable } from '@nestjs/common';

import { AnalysisRepository } from './analysis-repository';
import { redisKeys } from './redis-keys';
import { RedisService } from './redis.service';
import { deriveTaxonomyCategories } from './taxonomy-categories';

@Injectable()
export class TaxonomyCacheService {
  public constructor(
    private readonly repository: AnalysisRepository,
    private readonly redis: RedisService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  public async getRules(version = this.config.analysis.taxonomyVersion): Promise<TaxonomyRuleDefinition[]> {
    const cacheKey = redisKeys.taxonomy(version);
    const cached = await this.redis.get(cacheKey);

    if (cached !== null) {
      return JSON.parse(cached) as TaxonomyRuleDefinition[];
    }

    const rules = await this.repository.getTaxonomyRules(version);
    const mapped = rules.map((rule) => ({
      id: rule.id,
      version: rule.version,
      category: rule.category as TaxonomyRuleDefinition['category'],
      label: rule.label,
      lang: rule.lang,
      matchType: rule.matchType,
      pattern: rule.pattern,
      weight: rule.weight,
      enabled: rule.enabled,
    }));

    await this.redis.set(cacheKey, JSON.stringify(mapped), 'EX', 300);
    return mapped;
  }

  public async getResponse(version = this.config.analysis.taxonomyVersion): Promise<TaxonomyResponse> {
    const source = await this.repository.getTaxonomyVersion(version);
    const rules = await this.getRules(version);

    return {
      version: source.version,
      updatedAt: source.updatedAt.toISOString(),
      categories: deriveTaxonomyCategories(rules),
      rules,
    };
  }
}
