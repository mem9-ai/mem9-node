import type {
  DeepAnalysisMemorySnapshot,
  UserProfileAttributeKind,
  UserProfileEvidence,
  UserProfileImageItem,
  UserProfileItemKind,
  UserProfileRelationshipItem,
  UserProfileResponse,
} from '@mem9/contracts';
import { Injectable } from '@nestjs/common';

import type { Mem9RequestContext } from './common/request-context';
import { Mem9SourceService } from './mem9-source.service';

const MAX_RELATIONSHIPS = 10;
const MAX_ITEMS_PER_KIND = 10;
const SUMMARY_EVIDENCE_LIMIT = 5;
const ITEM_EVIDENCE_LIMIT = 3;
const STABLE_SUMMARY_FACET_COUNT = 3;

const ATTRIBUTE_KIND_LABELS: Record<UserProfileAttributeKind, string> = {
  long_term_interest: '长期兴趣',
  professional_skill: '专业技能',
  current_project: '当前项目',
  long_term_goal: '长期目标',
  work_habit: '工作习惯',
  communication_style: '沟通风格',
};

const ITEM_KIND_LABELS: Record<UserProfileItemKind, string> = {
  current_priority: '当前优先处理事项',
  companion_style: '喜欢的陪伴方式',
  robot_constraint: '对机器人的约束',
};

const KIND_KEYWORDS: Record<UserProfileItemKind, RegExp> = {
  current_priority: /(优先|当前|现在|近期|明年|待办|处理|计划|规划|目标|任务|备考|考试|健康|工作|岗位|职业|方向|能力|资格证|法务|律师|priority|prioritize|task|plan|goal|todo|focus|career|role|skill)/iu,
  companion_style: /(陪伴|回应|回复|沟通|建议|鼓励|提醒|直接|具体|少说教|风格|偏好|喜欢|preference|companion|communication|style|direct|specific)/iu,
  robot_constraint: /(机器人|助手|agent|AI|约束|限制|边界|不要|不能|避免|禁止|不得|constraint|avoid|should not|never)/iu,
};

const ROBOT_TARGET_KEYWORDS = /(机器人|助手|agent|AI|模型|系统|你|bot|assistant)/iu;
const ROBOT_BEHAVIOR_KEYWORDS = /(回复|回应|回答|建议|提醒|解释|输出|格式|称呼|语气|引用|召回|记住|忽略|自动|respond|reply|answer|suggest|remind|format|tone|memory|recall)/iu;
const CONSTRAINT_KEYWORDS = /(约束|限制|边界|不要|不能|避免|禁止|不得|只从|必须基于|只能|不允许|constraint|avoid|should not|never|only|must use)/iu;

const PERSONA_SUMMARY_KEYWORDS = /(是什么样的人|用户是|性格|特质|特点|画像|persona|trait|profile)/iu;
const PREFERENCE_SUMMARY_KEYWORDS = /(偏好|喜欢|倾向|重视|看重|prefer|preference|likes|values)/iu;
const DISLIKE_SUMMARY_KEYWORDS = /(不喜欢|讨厌|反感|避免|不希望|dislike|hates|avoid)/iu;
const WORK_STYLE_SUMMARY_KEYWORDS = /(做事风格|工作风格|决策|习惯|执行方式|推进方式|结构化推进|style|habit|decision|structured)/iu;
const TEMPORAL_PLAN_KEYWORDS = /(当前|现在|近期|明年|优先事项|优先处理|待办|备考|考试|换.*岗位|资格证|需要补上|priority|todo|exam)/iu;

const RELATION_KEYWORDS =
  /(父母|爸爸|妈妈|女儿|儿子|伴侣|朋友|同事|老师|导师|客户|老板|leader|manager|colleague|teammate|partner|daughter|son|parent|friend|teacher|mentor|customer|stakeholder)/iu;

const ATTRIBUTE_KEYWORDS: Record<UserProfileAttributeKind, RegExp> = {
  long_term_interest: /(长期兴趣|兴趣|关注领域|关注方向|持续关注|interest|interested|focus area)/iu,
  professional_skill: /(专业技能|技能|能力|擅长|经验|技术栈|法务|律师|资格证|skill|expertise|capability|proficiency)/iu,
  current_project: /(当前项目|正在做|项目|产品|repo|应用|project|working on|current work)/iu,
  long_term_goal: /(长期目标|目标|愿景|长期规划|成长方向|goal|long-term|long term|aspiration)/iu,
  work_habit: /(工作习惯|做事风格|工作风格|习惯|流程|节奏|结构化推进|推进方式|habit|workflow|work style|routine)/iu,
  communication_style: /(沟通风格|沟通|表达|回复|直接|具体|少说教|语气|communication|tone|direct|specific)/iu,
};

interface ProfileCandidate {
  title: string;
  summary: string;
  importance: number;
  evidence: UserProfileEvidence[];
}

interface RelationshipCandidate {
  name: string;
  relation?: string;
  importance: number;
  evidence: UserProfileEvidence[];
}

@Injectable()
export class UserProfileService {
  public constructor(private readonly source: Mem9SourceService) {}

  public async getProfile(context: Mem9RequestContext): Promise<UserProfileResponse> {
    const memories = await this.source.fetchProfileMemories(context.rawApiKey);
    const activeMemories = memories.filter((memory) => this.isProfileMemory(memory));
    const items = this.buildItems(activeMemories);

    return {
      generatedAt: new Date().toISOString(),
      source: {
        memoryTypes: ['fact', 'insight', 'pinned'],
        memoryCount: activeMemories.length,
      },
      summary: this.buildSummary(activeMemories),
      attributes: [],
      changes: [],
      relationships: this.buildRelationships(activeMemories),
      items,
    };
  }

  private buildSummary(memories: DeepAnalysisMemorySnapshot[]): UserProfileResponse['summary'] {
    const descriptions = this.extractProfileDescriptions(memories);
    if (descriptions.length > 0) {
      const selectedDescriptions = descriptions.slice(0, SUMMARY_EVIDENCE_LIMIT);
      return {
        text: this.synthesizeProfileDescriptions(selectedDescriptions),
        message: this.buildSummaryMessage(memories, selectedDescriptions.length),
        evidence: this.uniqueEvidence(selectedDescriptions.map((description) => description.evidence))
          .slice(0, SUMMARY_EVIDENCE_LIMIT),
      };
    }

    const facets = [
      this.buildSummaryFacet(memories, PERSONA_SUMMARY_KEYWORDS, '整体画像'),
      this.buildSummaryFacet(memories, PREFERENCE_SUMMARY_KEYWORDS, '偏好', DISLIKE_SUMMARY_KEYWORDS),
      this.buildSummaryFacet(memories, DISLIKE_SUMMARY_KEYWORDS, '不喜欢'),
      this.buildSummaryFacet(memories, WORK_STYLE_SUMMARY_KEYWORDS, '做事风格'),
    ].filter((value): value is { text: string; memory: DeepAnalysisMemorySnapshot } => value !== null);
    const fallback = facets.length === 0 ? this.buildFallbackSummary(memories) : null;
    const evidenceMemories = facets.length > 0
      ? facets.map((facet) => facet.memory)
      : fallback?.memories ?? [];

    return {
      text: facets.length > 0
        ? facets.map((facet) => facet.text).join('；')
        : fallback?.text ?? '',
      message: this.buildSummaryMessage(memories, facets.length),
      evidence: this.uniqueMemories(evidenceMemories)
        .slice(0, SUMMARY_EVIDENCE_LIMIT)
        .map((memory) => this.toEvidence(memory)),
    };
  }

  private synthesizeProfileDescriptions(descriptions: Array<{
    kind: UserProfileAttributeKind;
    value: string;
  }>): string {
    const byKind = new Map(descriptions.map((description) => [description.kind, description.value] as const));
    const sentences: string[] = [];
    const longTermGoal = byKind.get('long_term_goal');
    const currentProject = byKind.get('current_project');
    const professionalSkill = byKind.get('professional_skill');
    const longTermInterest = byKind.get('long_term_interest');
    const workHabit = byKind.get('work_habit');
    const communicationStyle = byKind.get('communication_style');

    if (longTermGoal || currentProject) {
      sentences.push(`用户目标导向较明确${longTermGoal ? `，长期目标是${this.toInlineClause(longTermGoal)}` : ''}${currentProject ? `，当前重心在${this.toInlineClause(currentProject)}` : ''}。`);
    }

    if (professionalSkill) {
      sentences.push(`用户会主动关注或补充专业能力，当前涉及${this.toInlineClause(professionalSkill)}。`);
    }

    if (longTermInterest) {
      sentences.push(`兴趣上，用户关注${this.toInlineClause(longTermInterest)}，整体投入方式较为理性。`);
    }

    if (workHabit) {
      sentences.push(`做事上更偏向${this.toInlineClause(workHabit)}。`);
    }

    if (communicationStyle) {
      sentences.push(`沟通偏效率型，更希望${this.toInlineClause(communicationStyle)}。`);
    }

    if (sentences.length > 0) {
      return sentences.join('');
    }

    return `基于现有信息，用户目前体现出：${descriptions
      .map((description) => this.toInlineClause(description.value))
      .join('；')}`;
  }

  private extractProfileDescriptions(memories: DeepAnalysisMemorySnapshot[]): Array<{
    kind: UserProfileAttributeKind;
    value: string;
    evidence: UserProfileEvidence;
  }> {
    const descriptions = new Map<UserProfileAttributeKind, {
      kind: UserProfileAttributeKind;
      value: string;
      evidence: UserProfileEvidence;
    }>();

    for (const memory of memories) {
      const kind = this.matchAttributeKind(memory);
      if (!kind || this.isSummaryMemory(memory)) {
        continue;
      }

      if (descriptions.has(kind)) {
        continue;
      }

      descriptions.set(kind, {
        kind,
        value: this.extractAttributeValue(memory, kind),
        evidence: this.toEvidence(memory),
      });
    }

    return (Object.keys(ATTRIBUTE_KIND_LABELS) as UserProfileAttributeKind[])
      .flatMap((kind) => descriptions.get(kind) ?? []);
  }

  private buildSummaryMessage(memories: DeepAnalysisMemorySnapshot[], facetCount: number): string | undefined {
    if (facetCount === 0) {
      return memories.length === 0
        ? '当前没有可用于生成用户画像总结的 facts、insights 或 pinned。'
        : '当前 facts、insights 和 pinned 中稳定画像信号较少，已根据现有信息生成初步总结，但画像可能不稳定。';
    }

    if (facetCount < STABLE_SUMMARY_FACET_COUNT) {
      return '当前可用画像信息较少，已根据现有 facts、insights 和 pinned 生成初步总结，但画像可能不稳定。';
    }

    return undefined;
  }

  private buildFallbackSummary(memories: DeepAnalysisMemorySnapshot[]): {
    text: string;
    memories: DeepAnalysisMemorySnapshot[];
  } | null {
    const candidates = memories
      .filter((memory) => !this.isSummaryMemory(memory))
      .sort((left, right) => this.memoryScore(right) - this.memoryScore(left))
      .slice(0, 2);

    if (candidates.length === 0) {
      return null;
    }

    return {
      text: `基于现有信息，用户目前体现出：${candidates
        .map((memory) => this.extractSummaryClause(memory.content))
        .join('；')}`,
      memories: candidates,
    };
  }

  private buildSummaryFacet(
    memories: DeepAnalysisMemorySnapshot[],
    pattern: RegExp,
    label: string,
    excludePattern?: RegExp,
  ): { text: string; memory: DeepAnalysisMemorySnapshot } | null {
    const memory = memories
      .filter((item) => !this.isOperationalItemMemory(item))
      .filter((item) => !this.isTemporalPlanMemory(item))
      .filter((item) => pattern.test(item.content) || this.matchesMetadataValue(item, pattern))
      .filter((item) => !excludePattern || (!excludePattern.test(item.content) && !this.matchesMetadataValue(item, excludePattern)))
      .sort((left, right) => this.memoryScore(right) - this.memoryScore(left))[0];

    if (!memory) {
      return null;
    }

    return {
      text: `${label}：${this.extractSummaryClause(memory.content)}`,
      memory,
    };
  }

  private buildItems(memories: DeepAnalysisMemorySnapshot[]): UserProfileImageItem[] {
    const items: UserProfileImageItem[] = [];

    for (const kind of Object.keys(ITEM_KIND_LABELS) as UserProfileItemKind[]) {
      const candidates = new Map<string, ProfileCandidate>();

      for (const memory of memories) {
        if (this.isSummaryMemory(memory)) {
          continue;
        }
        if (!this.matchesKind(memory, kind)) {
          continue;
        }

        const title = this.extractTitle(memory, kind);
        const key = this.normalizeKey(title);
        const existing = candidates.get(key);
        const evidence = this.toEvidence(memory);

        if (existing) {
          existing.importance += this.memoryScore(memory);
          existing.evidence.push(evidence);
        } else {
          candidates.set(key, {
            title,
            summary: this.extractSummary(memory),
            importance: this.memoryScore(memory),
            evidence: [evidence],
          });
        }
      }

      items.push(
        ...[...candidates.values()]
          .sort((left, right) => right.importance - left.importance)
          .slice(0, MAX_ITEMS_PER_KIND)
          .map((candidate) => ({
            kind,
            title: candidate.title,
            summary: candidate.summary,
            importance: Math.round(candidate.importance),
            evidenceCount: candidate.evidence.length,
            evidence: candidate.evidence.slice(0, ITEM_EVIDENCE_LIMIT),
          })),
      );
    }

    return items;
  }

  private buildRelationships(memories: DeepAnalysisMemorySnapshot[]): UserProfileRelationshipItem[] {
    const candidates = new Map<string, RelationshipCandidate>();

    for (const memory of memories) {
      if (this.isSummaryMemory(memory)) {
        continue;
      }
      const relation = this.extractMetadataString(memory, ['relation', 'relationship', 'relationshipType']);
      const person = this.extractMetadataString(memory, ['person', 'name', 'target', 'entity']);
      const inferred = person ? { name: person, relation: relation ?? undefined } : this.inferRelationship(memory.content);

      if (!inferred || !this.isRelationshipMemory(memory, inferred.relation)) {
        continue;
      }

      const key = this.normalizeKey(`${inferred.relation ?? ''}:${inferred.name}`);
      const evidence = this.toEvidence(memory);
      const existing = candidates.get(key);

      if (existing) {
        existing.importance += this.memoryScore(memory);
        existing.evidence.push(evidence);
      } else {
        candidates.set(key, {
          name: inferred.name,
          relation: inferred.relation ?? undefined,
          importance: this.memoryScore(memory),
          evidence: [evidence],
        });
      }
    }

    return [...candidates.values()]
      .sort((left, right) => right.importance - left.importance)
      .slice(0, MAX_RELATIONSHIPS)
      .map((candidate) => ({
        name: candidate.name,
        relation: candidate.relation,
        importance: Math.round(candidate.importance),
        evidenceCount: candidate.evidence.length,
        evidence: candidate.evidence.slice(0, ITEM_EVIDENCE_LIMIT),
      }));
  }

  private isProfileMemory(memory: DeepAnalysisMemorySnapshot): boolean {
    const type = memory.memoryType?.toLowerCase();
    return type === 'fact' || type === 'insight' || type === 'pinned';
  }

  private matchesKind(memory: DeepAnalysisMemorySnapshot, kind: UserProfileItemKind): boolean {
    const explicitKind = this.explicitItemKind(memory);
    if (explicitKind) {
      return explicitKind === kind;
    }

    if (kind === 'robot_constraint') {
      return this.matchesRobotConstraint(memory);
    }

    return KIND_KEYWORDS[kind].test(memory.content);
  }

  private matchesRobotConstraint(memory: DeepAnalysisMemorySnapshot): boolean {
    const text = memory.content;
    const hasConstraint = CONSTRAINT_KEYWORDS.test(text);
    if (!hasConstraint) {
      return false;
    }

    return ROBOT_TARGET_KEYWORDS.test(text) || ROBOT_BEHAVIOR_KEYWORDS.test(text);
  }

  private explicitItemKind(memory: DeepAnalysisMemorySnapshot): UserProfileItemKind | null {
    for (const kind of Object.keys(ITEM_KIND_LABELS) as UserProfileItemKind[]) {
      if (this.hasAnyToken(memory, [kind, ITEM_KIND_LABELS[kind]])) {
        return kind;
      }
    }

    return null;
  }

  private isSummaryMemory(memory: DeepAnalysisMemorySnapshot): boolean {
    return this.hasAnyToken(memory, [
      'profile_summary',
      'persona_summary',
      'summary',
      '用户画像',
      '画像总结',
    ]);
  }

  private isOperationalItemMemory(memory: DeepAnalysisMemorySnapshot): boolean {
    return Boolean(this.explicitItemKind(memory)) || this.matchesRobotConstraint(memory);
  }

  private isTemporalPlanMemory(memory: DeepAnalysisMemorySnapshot): boolean {
    return TEMPORAL_PLAN_KEYWORDS.test(memory.content);
  }

  private isRelationshipMemory(memory: DeepAnalysisMemorySnapshot, relation?: string): boolean {
    return Boolean(relation) || this.hasAnyToken(memory, ['relationship', '关系', '人物关系']) || RELATION_KEYWORDS.test(memory.content);
  }

  private inferRelationship(content: string): { name: string; relation?: string } | null {
    const relationMatch = content.match(RELATION_KEYWORDS);
    if (!relationMatch?.[0]) {
      return null;
    }

    const relation = relationMatch[0];
    const namePatterns = [
      new RegExp(`${this.escapeRegExp(relation)}(?:是|叫|为|:|：)?\\s*([\\p{Script=Han}A-Za-z0-9_\\- ]{1,24})`, 'iu'),
      new RegExp(`([\\p{Script=Han}A-Za-z0-9_\\- ]{1,24})(?:是|为|作为|担任)?\\s*${this.escapeRegExp(relation)}`, 'iu'),
    ];

    for (const pattern of namePatterns) {
      const match = content.match(pattern);
      const name = this.cleanName(match?.[1] ?? '');
      if (name) {
        return { name, relation };
      }
    }

    return { name: relation, relation };
  }

  private extractTitle(memory: DeepAnalysisMemorySnapshot, kind: UserProfileItemKind): string {
    return this.extractMetadataString(memory, ['title', 'label', 'name', 'summary'])
      ?? this.firstSentence(this.stripLeadingLabel(memory.content))
      ?? ITEM_KIND_LABELS[kind];
  }

  private extractSummary(memory: DeepAnalysisMemorySnapshot): string {
    return this.extractMetadataString(memory, ['summary', 'description', 'content'])
      ?? this.cleanText(memory.content);
  }

  private memoryScore(memory: DeepAnalysisMemorySnapshot): number {
    const confidence = this.extractMetadataNumber(memory, ['confidence', 'score', 'importance']);
    const evidenceCount = this.extractMetadataNumber(memory, ['evidenceCount', 'evidence_count']) ?? 1;
    const typeWeight = memory.memoryType === 'fact' ? 1.2 : 1;
    const tagWeight = (memory.tags?.length ?? 0) > 0 ? 0.2 : 0;
    return ((confidence ?? 0.7) * 10 + Math.min(evidenceCount, 5)) * typeWeight + tagWeight;
  }

  private toEvidence(memory: DeepAnalysisMemorySnapshot): UserProfileEvidence {
    return {
      memoryId: memory.id,
      memoryType: memory.memoryType,
      quote: this.cleanText(memory.content).slice(0, 180),
      createdAt: memory.createdAt,
    };
  }

  private hasAnyToken(memory: DeepAnalysisMemorySnapshot, tokens: string[]): boolean {
    const haystack = [
      memory.content,
      ...(memory.tags ?? []),
      ...Object.entries(memory.metadata ?? {}).flatMap(([key, value]) => [key, String(value)]),
    ].join(' ').toLowerCase();

    return tokens.some((token) => haystack.includes(token.toLowerCase()));
  }

  private matchesMetadataValue(memory: DeepAnalysisMemorySnapshot, pattern: RegExp): boolean {
    return Object.entries(memory.metadata ?? {}).some(([key, value]) => (
      pattern.test(key) || pattern.test(String(value))
    ));
  }

  private matchAttributeKind(memory: DeepAnalysisMemorySnapshot): UserProfileAttributeKind | null {
    const explicitKind = this.extractMetadataString(memory, [
      'attributeKind',
      'profileKind',
      'profile_attribute',
      'category',
      'kind',
    ]);

    if (explicitKind) {
      const normalizedKind = this.normalizeKey(explicitKind).replace(/[\s-]+/gu, '_');
      for (const kind of Object.keys(ATTRIBUTE_KIND_LABELS) as UserProfileAttributeKind[]) {
        if (
          normalizedKind === kind ||
          explicitKind === ATTRIBUTE_KIND_LABELS[kind]
        ) {
          return kind;
        }
      }
    }

    if (DISLIKE_SUMMARY_KEYWORDS.test(memory.content)) {
      return null;
    }

    for (const kind of Object.keys(ATTRIBUTE_KIND_LABELS) as UserProfileAttributeKind[]) {
      if (ATTRIBUTE_KEYWORDS[kind].test(memory.content) || this.matchesMetadataValue(memory, ATTRIBUTE_KEYWORDS[kind])) {
        return kind;
      }
    }

    return null;
  }

  private extractAttributeValue(
    memory: DeepAnalysisMemorySnapshot,
    kind: UserProfileAttributeKind,
  ): string {
    return this.extractMetadataString(memory, ['value', 'summary', 'description', 'content'])
      ?? this.firstSentence(this.stripLeadingLabel(memory.content))
      ?? ATTRIBUTE_KIND_LABELS[kind];
  }

  private uniqueEvidence(evidence: UserProfileEvidence[]): UserProfileEvidence[] {
    const seen = new Set<string>();
    return evidence.filter((item) => {
      if (seen.has(item.memoryId)) {
        return false;
      }
      seen.add(item.memoryId);
      return true;
    });
  }

  private extractMetadataString(memory: DeepAnalysisMemorySnapshot, keys: string[]): string | null {
    const metadata = memory.metadata ?? {};
    for (const key of keys) {
      const value = metadata[key];
      if (typeof value === 'string' && value.trim()) {
        return this.cleanText(value);
      }
    }
    return null;
  }

  private extractMetadataNumber(memory: DeepAnalysisMemorySnapshot, keys: string[]): number | null {
    const metadata = memory.metadata ?? {};
    for (const key of keys) {
      const value = metadata[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
      }
      if (typeof value === 'string' && Number.isFinite(Number(value))) {
        return Number(value);
      }
    }
    return null;
  }

  private firstSentence(value: string): string | null {
    const sentence = this.cleanText(value).split(/[。.!?\n]/u)[0]?.trim();
    return sentence || null;
  }

  private extractSummaryClause(value: string): string {
    const text = this.firstSentence(this.stripLeadingLabel(value)) ?? this.cleanText(value);
    return text
      .replace(/^(用户|这个用户|TA|ta)?\s*(做事风格|工作风格)(是|为)?\s*/u, '')
      .replace(/^(用户|这个用户|TA|ta)\s*(是|偏好|喜欢|不喜欢|讨厌|倾向于|重视|看重)?\s*/u, '')
      .trim();
  }

  private toInlineClause(value: string): string {
    return this.cleanText(value)
      .replace(/[。.!?？！]+$/u, '')
      .replace(/^(用户|这个用户|TA|ta)\s*/u, '')
      .replace(/^(目标是|长期目标是|当前重心是|当前重心在|偏好|喜欢|更喜欢|希望|想要)\s*/u, '')
      .trim();
  }

  private uniqueMemories(memories: DeepAnalysisMemorySnapshot[]): DeepAnalysisMemorySnapshot[] {
    const seen = new Set<string>();
    return memories.filter((memory) => {
      if (seen.has(memory.id)) {
        return false;
      }
      seen.add(memory.id);
      return true;
    });
  }

  private stripLeadingLabel(value: string): string {
    return value.replace(/^\s*[\w\s\u4e00-\u9fff-]{1,24}\s*[:：]\s*/u, '');
  }

  private cleanText(value: string): string {
    return value.replace(/\s+/gu, ' ').trim();
  }

  private cleanName(value: string): string | null {
    const name = this.cleanText(value)
      .replace(/[，。,.!！?？；;].*$/u, '')
      .replace(/^(用户的?|我的?|其|他|她)\s*/u, '')
      .trim();
    return name.length > 0 ? name : null;
  }

  private normalizeKey(value: string): string {
    return this.cleanText(value).toLowerCase();
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
