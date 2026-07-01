import type {
  DeepAnalysisMemorySnapshot,
  UserProfileAttributeKind,
  UserProfileEvidence,
  UserProfileImageItem,
  UserProfileItemKind,
  UserProfileResponse,
} from '@mem9/contracts';
import { Injectable } from '@nestjs/common';

import type { Mem9RequestContext } from './common/request-context';
import { Mem9SourceService } from './mem9-source.service';

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
const COMPANION_TARGET_KEYWORDS = /(陪伴|回应|回复|回答|建议|提醒|沟通|语气|表达|说教|鼓励|assistant|companion|respond|reply|answer|suggest|communication|tone)/iu;

const PERSONA_SUMMARY_KEYWORDS = /(是什么样的人|用户是|性格|特质|特点|画像|trait)/iu;
const PREFERENCE_SUMMARY_KEYWORDS = /(偏好|喜欢|倾向|重视|看重|prefer|preference|likes|values)/iu;
const DISLIKE_SUMMARY_KEYWORDS = /(不喜欢|讨厌|反感|避免|不希望|dislike|hates|avoid)/iu;
const WORK_STYLE_SUMMARY_KEYWORDS = /(做事风格|工作风格|决策|习惯|执行方式|推进方式|结构化推进|style|habit|decision|structured)/iu;
const TEMPORAL_PLAN_KEYWORDS = /(当前|现在|近期|明年|优先事项|优先处理|待办|备考|考试|换.*岗位|资格证|需要补上|priority|todo|exam)/iu;
const EPHEMERAL_SUMMARY_KEYWORDS = /(今天|昨天|明天|刚才|本次|这次|当前对话|随口|临时|一次性|暂时|已失效|过期|today|yesterday|tomorrow|temporary|one-off|expired)/iu;
const STABLE_PERSONA_KEYWORDS = /(长期|经常|常用|持续|稳定|习惯|偏好|不喜欢|讨厌|兴趣|领域|技能|目标|学习方向|消费|决策|沟通|思维|工具|工作内容|家庭角色|创业|AI使用|性格|特质|做事风格|long[- ]term|often|usually|habit|preference|skill|goal|trait)/iu;
const PRODUCT_OR_DOC_MEMORY_KEYWORDS = /\b(PRD|RFC|module|modules|covers|including|backend|server|endpoint|API|CRUD|Letta|MemGPT|referenced|concept|concepts|partitioning|archival|recall|comparison|inspiration|foundation|foundations)\b|模块|接口|后端|服务端|返回字段|实现|支持|缺少|不支持|参考|概念|分区|竞品|对比|启发|资料/iu;
const PROFILE_FACT_ONLY_KEYWORDS = /\b(?:\d+(?:\.\d+)?\s*(?:cm|kg)|height|weighs?|weight)\b|身高|体重/iu;
const FILE_OR_DEMO_OPERATION_KEYWORDS = /\b(?:created|create|containing|folder|directory|path|README|requirements\.txt|\.env|script|demo|SDK|Cloud SDK|seed_[\w-]+\.py|[\w-]+-demo)\b|\/Users\/|文件夹|目录|路径|脚本|创建|包含/iu;

interface PersonaSummarySignals {
  identities: string[];
  domains: string[];
  traits: string[];
  workStyles: string[];
  longTermPlans: string[];
  evidence: UserProfileEvidence[];
}

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
      summary: this.buildSummary(activeMemories, items),
      attributes: [],
      changes: [],
      items,
    };
  }

  private buildSummary(
    memories: DeepAnalysisMemorySnapshot[],
    items: UserProfileImageItem[],
  ): UserProfileResponse['summary'] {
    const stableMemories = memories.filter((memory) => this.isStablePersonaMemory(memory));
    const personaSignals = this.collectPersonaSummarySignals(stableMemories, items);
    const personaSummary = this.synthesizePersonaSummary(personaSignals);

    if (personaSummary) {
      const signalCount = new Set([
        ...personaSignals.identities,
        ...personaSignals.domains,
        ...personaSignals.traits,
        ...personaSignals.workStyles,
        ...personaSignals.longTermPlans,
      ]).size;
      return {
        text: personaSummary,
        message: this.buildSummaryMessage(memories, signalCount),
        evidence: this.uniqueEvidence(personaSignals.evidence)
          .slice(0, SUMMARY_EVIDENCE_LIMIT),
      };
    }

    const descriptions = this.extractProfileDescriptions(stableMemories).slice(0, SUMMARY_EVIDENCE_LIMIT);

    const baseFacets = [
      this.buildSummaryFacet(stableMemories, PERSONA_SUMMARY_KEYWORDS, '整体画像'),
      this.buildSummaryFacet(stableMemories, PREFERENCE_SUMMARY_KEYWORDS, '偏好', DISLIKE_SUMMARY_KEYWORDS),
      this.buildSummaryFacet(stableMemories, DISLIKE_SUMMARY_KEYWORDS, '不喜欢'),
      this.buildSummaryFacet(stableMemories, WORK_STYLE_SUMMARY_KEYWORDS, '做事风格'),
    ].filter((value): value is { text: string; memory: DeepAnalysisMemorySnapshot } => value !== null);
    const genericFacet = descriptions.length === 0 && baseFacets.length === 0
      ? this.buildSummaryFacet(stableMemories, STABLE_PERSONA_KEYWORDS, '长期特征')
      : null;
    const facets = genericFacet ? [genericFacet] : baseFacets;

    const descriptionEvidence = descriptions.map((description) => description.evidence);
    const facetEvidence = this.uniqueMemories(facets.map((facet) => facet.memory))
      .map((memory) => this.toEvidence(memory));
    const signalCount = descriptions.length + facets.length;

    if (signalCount === 0) {
      return {
        text: '',
        message: this.buildSummaryMessage(memories, 0),
        evidence: [],
      };
    }

    return {
      text: this.limitSummaryText([
        ...facets.map((facet) => facet.text),
        descriptions.length > 0 ? this.synthesizeProfileDescriptions(descriptions) : '',
      ].filter(Boolean).join('；')),
      message: this.buildSummaryMessage(memories, signalCount),
      evidence: this.uniqueEvidence([...descriptionEvidence, ...facetEvidence])
        .slice(0, SUMMARY_EVIDENCE_LIMIT),
    };
  }

  private synthesizeProfileDescriptions(descriptions: Array<{
    kind: UserProfileAttributeKind;
    value: string;
  }>): string {
    const byKind = new Map(descriptions.map((description) => [description.kind, description.value] as const));
    const clauses: string[] = [];
    const longTermGoal = byKind.get('long_term_goal');
    const professionalSkill = byKind.get('professional_skill');
    const longTermInterest = byKind.get('long_term_interest');
    const workHabit = byKind.get('work_habit');
    const communicationStyle = byKind.get('communication_style');

    if (longTermGoal) {
      clauses.push(`长期目标是${this.toInlineClause(longTermGoal)}`);
    }

    if (professionalSkill) {
      clauses.push(`专业能力涉及${this.toInlineClause(professionalSkill)}`);
    }

    if (longTermInterest) {
      clauses.push(`兴趣上关注${this.toInlineClause(longTermInterest)}`);
    }

    if (workHabit) {
      clauses.push(`做事偏${this.toInlineClause(workHabit)}`);
    }

    if (communicationStyle) {
      clauses.push(`沟通偏${this.toInlineClause(communicationStyle)}`);
    }

    if (clauses.length > 0) {
      return this.limitSummaryText(`你${clauses.join('，')}`);
    }

    return this.limitSummaryText(`你${descriptions
      .map((description) => this.toInlineClause(description.value))
      .join('，')}`);
  }

  private collectPersonaSummarySignals(
    memories: DeepAnalysisMemorySnapshot[],
    items: UserProfileImageItem[],
  ): PersonaSummarySignals {
    const signals: PersonaSummarySignals = {
      identities: [],
      domains: [],
      traits: [],
      workStyles: [],
      longTermPlans: [],
      evidence: [],
    };

    for (const memory of memories) {
      const text = this.cleanText(memory.content);
      this.collectSignalsFromText(signals, text, this.toEvidence(memory));
    }

    for (const item of items) {
      const text = this.cleanText(`${item.title} ${item.summary}`);
      if (item.kind === 'current_priority') {
        this.collectPlanSignals(signals, text);
      }
      if (item.kind === 'companion_style' || item.kind === 'robot_constraint') {
        this.collectStyleSignals(signals, text);
      }
      signals.evidence.push(...item.evidence);
    }

    signals.identities = this.uniqueStrings(signals.identities);
    signals.domains = this.uniqueStrings(signals.domains);
    signals.traits = this.uniqueStrings(signals.traits);
    signals.workStyles = this.uniqueStrings(signals.workStyles);
    signals.longTermPlans = this.uniqueStrings(signals.longTermPlans);
    signals.evidence = this.uniqueEvidence(signals.evidence);
    return signals;
  }

  private collectSignalsFromText(
    signals: PersonaSummarySignals,
    text: string,
    evidence: UserProfileEvidence,
  ): void {
    if (/(前端|React|TypeScript|工程实践|开发工程师|frontend|front-end)/iu.test(text)) {
      signals.identities.push(/AI|Agent|Memory|用户画像|长期记忆/iu.test(text)
        ? 'AI 产品与前端工程实践者'
        : '前端工程实践者');
      signals.evidence.push(evidence);
    } else if (/(产品|PRD|用户研究|用户画像|治理系统|可视化方案)/iu.test(text) && /AI|mem9|Memory|Agent|长期记忆/iu.test(text)) {
      signals.identities.push('AI 产品实践者');
      signals.evidence.push(evidence);
    }

    if (/(AI|Agent|Memory|长期记忆|用户画像|mem9)/iu.test(text)) {
      signals.domains.push('AI、用户画像、Memory、Agent');
      signals.evidence.push(evidence);
    }
    if (/(TiDB|数据库|database)/iu.test(text)) {
      signals.domains.push('数据库');
      signals.evidence.push(evidence);
    }

    if (/(目标驱动|目标导向|成长驱动力|执行力|持续推进|长期目标)/iu.test(text)) {
      signals.traits.push('目标驱动');
      signals.evidence.push(evidence);
    }
    if (/(系统化|结构化|拆解|可落地|工程化|模板|自动化|复用)/iu.test(text)) {
      signals.traits.push('擅长系统化思考');
      signals.workStyles.push('习惯将复杂问题拆解为可落地方案');
      signals.evidence.push(evidence);
    }
    if (/(效率|直接给结论|简洁高效|少说教|可执行)/iu.test(text)) {
      signals.workStyles.push('重视效率与可执行建议');
      signals.evidence.push(evidence);
    }

    this.collectPlanSignals(signals, text);
  }

  private collectPlanSignals(signals: PersonaSummarySignals, text: string): void {
    if (/(英语|KET|CET|六级|单词|备考)/iu.test(text)) {
      signals.longTermPlans.push('英语学习');
    }
    if (/(健康|减脂|饮食|步数|运动|睡眠)/iu.test(text)) {
      signals.longTermPlans.push('健康管理');
    }
    if (/(家庭教育|孩子|女儿|亲子)/iu.test(text)) {
      signals.longTermPlans.push('家庭教育');
    }
    if (/(AI Agent|Agent|Memory|长期记忆)/iu.test(text) && /(学习|深入|关注|推进|研究)/iu.test(text)) {
      signals.longTermPlans.push('AI Agent 与 Memory 学习');
    }
    if (/(TiDB Cloud|项目开发|开发)/iu.test(text) && /(推进|持续|长期|工作)/iu.test(text)) {
      signals.longTermPlans.push('项目开发');
    }
  }

  private collectStyleSignals(signals: PersonaSummarySignals, text: string): void {
    if (/(直接|结论|结构化|可执行|完整|模板|风险|优化|跟进|规划|决策)/iu.test(text)) {
      signals.workStyles.push('偏好结构化、直接且可执行的协作方式');
    }
  }

  private synthesizePersonaSummary(signals: PersonaSummarySignals): string {
    const signalCount = new Set([
      ...signals.identities,
      ...signals.domains,
      ...signals.traits,
      ...signals.workStyles,
      ...signals.longTermPlans,
    ]).size;
    if (signalCount < 2) {
      return '';
    }

    const hasFrontendIdentity = signals.identities.some((value) => /前端/u.test(value));
    const hasAiDomain = signals.domains.some((value) => /AI|Memory|Agent|用户画像/iu.test(value));
    const identity = hasFrontendIdentity && hasAiDomain
      ? 'AI 产品与前端工程实践者'
      : signals.identities[0] ?? '目标驱动的长期成长型用户';
    const clauses: string[] = [`你是一位${identity}`];
    if (signals.traits.length > 0) {
      clauses.push(signals.traits.slice(0, 2).join('、'));
    }
    if (signals.domains.length > 0) {
      clauses.push(`关注${signals.domains.slice(0, 2).join('、')}`);
    }
    if (signals.workStyles.length > 0) {
      clauses.push(signals.workStyles.some((value) => /拆解|落地/u.test(value))
        ? '擅长系统化拆解并落地方案'
        : signals.workStyles[0]!);
    }
    if (signals.longTermPlans.length > 0) {
      clauses.push(`持续推进${signals.longTermPlans.slice(0, 3).join('、')}`);
    }

    return this.limitSummaryText(`${clauses.join('，')}。`);
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

      const synthesizedCandidates = this.synthesizeItemCandidates(kind, [...candidates.values()], memories);
      const finalCandidates = synthesizedCandidates.length > 0 ? synthesizedCandidates : [...candidates.values()];

      items.push(
        ...finalCandidates
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

  private synthesizeItemCandidates(
    kind: UserProfileItemKind,
    candidates: ProfileCandidate[],
    memories: DeepAnalysisMemorySnapshot[],
  ): ProfileCandidate[] {
    if (kind === 'companion_style') {
      return this.synthesizeCompanionStyleCandidates(candidates, memories);
    }

    if (kind === 'robot_constraint') {
      return this.synthesizeRobotConstraintCandidates(candidates, memories);
    }

    return [];
  }

  private synthesizeCompanionStyleCandidates(
    candidates: ProfileCandidate[],
    memories: DeepAnalysisMemorySnapshot[],
  ): ProfileCandidate[] {
    const planCandidates = memories
      .filter((memory) => this.isProfileMemory(memory) && !this.isSummaryMemory(memory))
      .filter((memory) => !this.isProductOrDocumentMemory(memory) && !this.isFileOrDemoOperationMemory(memory))
      .filter((memory) => /(目标|计划|拆解|任务|进展|提醒|复盘|跟进|调整|KET|英语|健康|减脂|长期|goal|plan|progress|follow|review)/iu.test(memory.content))
      .map((memory) => ({
        title: this.firstSentence(memory.content) ?? '长期陪伴信号',
        summary: this.cleanText(memory.content),
        importance: this.memoryScore(memory),
        evidence: [this.toEvidence(memory)],
      }));
    const sourceCandidates = [...candidates, ...planCandidates];
    if (sourceCandidates.length === 0) {
      return [];
    }

    const sourceText = sourceCandidates.map((candidate) => `${candidate.title} ${candidate.summary}`).join(' ');
    const summaryParts: string[] = [];

    if (/(目标|计划|进展|跟进|复盘|提醒|调整|长期|goal|plan|progress|follow|review)/iu.test(sourceText)) {
      summaryParts.push('用户偏好目标导向、主动跟进型陪伴，而非单纯情绪安慰型');
    }
    if (/(制定计划|拆解|任务|步骤|清单|模板|可执行|具体|plan|step|task|actionable)/iu.test(sourceText)) {
      summaryParts.push('希望通过制定计划、拆解任务、记录进展、定期提醒和复盘获得持续支持');
    }
    if (/(直接|结论|简洁|高效|结构化|数据|反馈|少说教|direct|concise|structured|data)/iu.test(sourceText)) {
      summaryParts.push('交流风格简洁直接，重视结构化输出、可执行建议和数据反馈');
    }
    if (/(记住|长期目标|历史|上下文|动态|调整|进度|memory|context|adjust)/iu.test(sourceText)) {
      summaryParts.push('期待 AI 记住目标并根据进度动态调整计划');
    }

    if (summaryParts.length === 0) {
      return [];
    }

    return [this.toSyntheticCandidate(
      '目标导向陪伴',
      this.limitSummaryText(summaryParts.join('；'), 150),
      sourceCandidates,
    )];
  }

  private synthesizeRobotConstraintCandidates(
    candidates: ProfileCandidate[],
    memories: DeepAnalysisMemorySnapshot[],
  ): ProfileCandidate[] {
    const memoryCandidates = memories
        .filter((memory) => this.isProfileMemory(memory) && !this.isSummaryMemory(memory))
        .map((memory) => ({
          title: this.firstSentence(memory.content) ?? '长期约束',
          summary: this.cleanText(memory.content),
          importance: this.memoryScore(memory),
          evidence: [this.toEvidence(memory)],
        }));
    const sourceCandidates = [...candidates, ...memoryCandidates];
    const sourceText = sourceCandidates.map((candidate) => `${candidate.title} ${candidate.summary}`).join(' ');
    const results: ProfileCandidate[] = [];

    if (/(空泛|说教|重复背景|绕太多|冗长|直接|结论|结构化|可执行|vague|verbose|direct|structured)/iu.test(sourceText)) {
      results.push(this.toSyntheticCandidate(
        '避免空泛冗长',
        '回答要直接、结构化、具体可执行，避免空泛建议、重复背景和说教式表达。',
        sourceCandidates,
      ));
    }

    if (/(facts|insights|证据|基于|不要编造|无依据|确认|纠错|evidence|grounded)/iu.test(sourceText)) {
      results.push(this.toSyntheticCandidate(
        '基于证据回答',
        '重要判断需基于已有 facts、insights 或明确证据，不要无依据推断。',
        sourceCandidates,
      ));
    }

    if (/(React|TypeScript|TiDB Cloud|TiDB|PRD|AI Agent|Agent|Memory|长期记忆|mem9|英文 PRD)/iu.test(sourceText)) {
      results.push(this.toSyntheticCandidate(
        '结合长期背景',
        '回答需结合用户在 AI、Memory、Agent、前端工程和相关产品设计中的长期背景。',
        sourceCandidates,
      ));
    }

    if (/(英语|KET|CET|六级|健康|减脂|饮食|家庭教育|长期目标|持续推进)/iu.test(sourceText)) {
      results.push(this.toSyntheticCandidate(
        '衔接长期目标',
        '涉及学习、健康、家庭教育等主题时，应衔接长期目标并避免只按单次问题处理。',
        sourceCandidates,
      ));
    }

    return results;
  }

  private toSyntheticCandidate(
    title: string,
    summary: string,
    candidates: ProfileCandidate[],
  ): ProfileCandidate {
    const evidence = this.uniqueEvidence(candidates.flatMap((candidate) => candidate.evidence))
      .slice(0, ITEM_EVIDENCE_LIMIT);
    const importance = candidates.reduce((total, candidate) => total + candidate.importance, 0);
    return {
      title,
      summary,
      importance,
      evidence,
    };
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

    if (
      (kind === 'companion_style' || kind === 'robot_constraint') &&
      (this.isProductOrDocumentMemory(memory) || this.isFileOrDemoOperationMemory(memory))
    ) {
      return false;
    }

    if (kind === 'robot_constraint') {
      return this.matchesRobotConstraint(memory);
    }

    if (kind === 'companion_style') {
      return this.matchesCompanionStyle(memory);
    }

    return KIND_KEYWORDS[kind].test(memory.content);
  }

  private matchesCompanionStyle(memory: DeepAnalysisMemorySnapshot): boolean {
    const text = memory.content;
    const hasPreference = PREFERENCE_SUMMARY_KEYWORDS.test(text) || /prefer|preference|likes?|喜欢|偏好|希望|更希望/iu.test(text);
    return hasPreference && COMPANION_TARGET_KEYWORDS.test(text);
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
    const content = this.cleanText(memory.content);
    if (/^(profile_summary|persona_summary|summary|用户画像总结|画像总结)\s*[:：]/iu.test(content)) {
      return true;
    }

    const metadataAndTags = [
      ...(memory.tags ?? []),
      ...Object.entries(memory.metadata ?? {}).flatMap(([key, value]) => [key, String(value)]),
    ].join(' ').toLowerCase();
    return ['profile_summary', 'persona_summary', '画像总结'].some((token) => metadataAndTags.includes(token.toLowerCase()));
  }

  private isOperationalItemMemory(memory: DeepAnalysisMemorySnapshot): boolean {
    return Boolean(this.explicitItemKind(memory)) || this.matchesRobotConstraint(memory);
  }

  private isTemporalPlanMemory(memory: DeepAnalysisMemorySnapshot): boolean {
    return TEMPORAL_PLAN_KEYWORDS.test(memory.content);
  }

  private isStablePersonaMemory(memory: DeepAnalysisMemorySnapshot): boolean {
    if (this.isSummaryMemory(memory) || this.isOperationalItemMemory(memory)) {
      return false;
    }

    if (
      this.isProductOrDocumentMemory(memory) ||
      this.isProfileFactOnlyMemory(memory) ||
      this.isFileOrDemoOperationMemory(memory)
    ) {
      return false;
    }

    const explicitAttributeKind = this.matchExplicitAttributeKind(memory);
    if (explicitAttributeKind && explicitAttributeKind !== 'current_project') {
      return !EPHEMERAL_SUMMARY_KEYWORDS.test(memory.content);
    }

    if (this.isTemporalPlanMemory(memory) || EPHEMERAL_SUMMARY_KEYWORDS.test(memory.content)) {
      return false;
    }

    return this.hasStablePersonaSignal(memory);
  }

  private isProductOrDocumentMemory(memory: DeepAnalysisMemorySnapshot): boolean {
    return PRODUCT_OR_DOC_MEMORY_KEYWORDS.test(memory.content) &&
      !/(用户|你|user)\s*(经常|常用|长期|偏好|不喜欢|喜欢|习惯|擅长|从事|使用|uses?|prefers?|likes?|dislikes?|often|usually)/iu.test(memory.content);
  }

  private isFileOrDemoOperationMemory(memory: DeepAnalysisMemorySnapshot): boolean {
    return FILE_OR_DEMO_OPERATION_KEYWORDS.test(memory.content);
  }

  private isProfileFactOnlyMemory(memory: DeepAnalysisMemorySnapshot): boolean {
    return PROFILE_FACT_ONLY_KEYWORDS.test(memory.content);
  }

  private hasStablePersonaSignal(memory: DeepAnalysisMemorySnapshot): boolean {
    return STABLE_PERSONA_KEYWORDS.test(memory.content) ||
      this.matchesMetadataValue(memory, STABLE_PERSONA_KEYWORDS) ||
      Object.values(ATTRIBUTE_KEYWORDS).some((pattern) => pattern.test(memory.content) || this.matchesMetadataValue(memory, pattern)) ||
      [
        PERSONA_SUMMARY_KEYWORDS,
        PREFERENCE_SUMMARY_KEYWORDS,
        DISLIKE_SUMMARY_KEYWORDS,
        WORK_STYLE_SUMMARY_KEYWORDS,
      ].some((pattern) => pattern.test(memory.content) || this.matchesMetadataValue(memory, pattern));
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
    const explicitAttributeKind = this.matchExplicitAttributeKind(memory);
    if (explicitAttributeKind) {
      return explicitAttributeKind;
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

  private matchExplicitAttributeKind(memory: DeepAnalysisMemorySnapshot): UserProfileAttributeKind | null {
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

  private uniqueStrings(values: string[]): string[] {
    const seen = new Set<string>();
    return values.filter((value) => {
      const key = this.normalizeKey(value);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
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

  private limitSummaryText(value: string, maxLength = 100): string {
    const text = this.cleanText(value)
      .replace(/[；，、。,.，:：;]+$/u, '');
    if (text.length <= maxLength) {
      return text;
    }

    const head = text.slice(0, maxLength);
    const sentenceBoundary = Math.max(
      head.lastIndexOf('。'),
      head.lastIndexOf('！'),
      head.lastIndexOf('？'),
      head.lastIndexOf('.'),
      head.lastIndexOf('!'),
      head.lastIndexOf('?'),
      head.lastIndexOf('；'),
      head.lastIndexOf(';'),
    );
    const shortened = (sentenceBoundary > 0 ? head.slice(0, sentenceBoundary + 1) : head)
      .replace(/[；，、。,.，:：;]+$/u, '')
      .trim();
    return shortened || text.slice(0, maxLength).trim();
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

  private normalizeKey(value: string): string {
    return this.cleanText(value).toLowerCase();
  }
}
