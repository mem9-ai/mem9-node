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
  current_priority:
    /(优先|当前|现在|近期|明年|待办|处理|计划|规划|目标|任务|备考|考试|健康|工作|岗位|职业|方向|能力|资格证|法务|律师|優先|現在|計画|目標|タスク|試験|健康|仕事|職業|方向性|能力|資格|priority|prioritize|task|plan|goal|todo|focus|career|role|skill)/iu,
  companion_style:
    /(陪伴|回应|回复|沟通|建议|鼓励|提醒|直接|具体|少说教|风格|偏好|喜欢|伴走|応答|回答|コミュニケーション|提案|励まし|リマインド|直接|具体的|スタイル|好み|preference|companion|communication|style|direct|specific)/iu,
  robot_constraint:
    /(机器人|助手|agent|AI|约束|限制|边界|不要|不能|避免|禁止|不得|ロボット|アシスタント|制約|制限|境界|避ける|禁止|constraint|avoid|should not|never)/iu,
};

const ROBOT_TARGET_KEYWORDS =
  /(机器人|助手|agent|AI|模型|系统|你|ロボット|アシスタント|モデル|システム|あなた|bot|assistant)/iu;
const ROBOT_BEHAVIOR_KEYWORDS =
  /(回复|回应|回答|建议|提醒|解释|输出|格式|称呼|语气|引用|召回|记住|忽略|自动|応答|回答|提案|リマインド|説明|出力|形式|呼び方|口調|引用|想起|記憶|無視|自動|respond|reply|answer|suggest|remind|format|tone|memory|recall)/iu;
const CONSTRAINT_KEYWORDS =
  /(约束|限制|边界|不要|不能|避免|禁止|不得|只从|必须基于|只能|不允许|制約|制限|境界|しない|できない|避ける|禁止|基づく|のみ|許可しない|constraint|avoid|should not|never|only|must use)/iu;
const COMPANION_TARGET_KEYWORDS =
  /(陪伴|回应|回复|回答|建议|提醒|沟通|语气|表达|说教|鼓励|伴走|応答|回答|提案|リマインド|コミュニケーション|口調|表現|説教|励まし|assistant|companion|respond|reply|answer|suggest|communication|tone)/iu;

const PERSONA_SUMMARY_KEYWORDS =
  /(是什么样的人|用户是|性格|特质|特点|画像|どんな人|ユーザーは|性格|特性|特徴|プロファイル|trait)/iu;
const PREFERENCE_SUMMARY_KEYWORDS =
  /(偏好|喜欢|倾向|重视|看重|好み|好む|傾向|重視|大切にする|prefer|preference|likes|values)/iu;
const DISLIKE_SUMMARY_KEYWORDS =
  /(不喜欢|讨厌|反感|避免|不希望|好まない|嫌い|苦手|避ける|望まない|dislike|hates|avoid)/iu;
const WORK_STYLE_SUMMARY_KEYWORDS =
  /(做事风格|工作风格|决策|习惯|执行方式|推进方式|结构化推进|仕事の進め方|働き方|意思決定|習慣|実行方法|体系的|style|habit|decision|structured)/iu;
const TEMPORAL_PLAN_KEYWORDS =
  /(当前|现在|近期|明年|优先事项|优先处理|待办|备考|考试|换.*岗位|资格证|需要补上|現在|最近|来年|優先事項|やること|試験対策|試験|転職|資格|補う|priority|todo|exam)/iu;
const EPHEMERAL_SUMMARY_KEYWORDS =
  /(今天|昨天|明天|刚才|本次|这次|当前对话|随口|临时|一次性|暂时|已失效|过期|今日|昨日|明日|先ほど|今回|現在の会話|一時的|単発|期限切れ|today|yesterday|tomorrow|temporary|one-off|expired)/iu;
const STABLE_PERSONA_KEYWORDS =
  /(长期|经常|常用|持续|稳定|习惯|偏好|不喜欢|讨厌|兴趣|领域|技能|目标|学习方向|消费|决策|沟通|思维|工具|工作内容|家庭角色|创业|AI使用|性格|特质|做事风格|長期|よく|継続|安定|習慣|好み|好まない|嫌い|関心|分野|スキル|目標|学習|消費|意思決定|コミュニケーション|思考|ツール|仕事内容|家族|起業|AI活用|性格|特性|仕事の進め方|long[- ]term|often|usually|habit|preference|skill|goal|trait)/iu;
const PRODUCT_OR_DOC_MEMORY_KEYWORDS =
  /\b(PRD|RFC|module|modules|covers|including|backend|server|endpoint|API|CRUD|Letta|MemGPT|referenced|concept|concepts|partitioning|archival|recall|comparison|inspiration|foundation|foundations)\b|模块|接口|后端|服务端|返回字段|实现|支持|缺少|不支持|参考|概念|分区|竞品|对比|启发|资料/iu;
const PROFILE_FACT_ONLY_KEYWORDS =
  /\b(?:\d+(?:\.\d+)?\s*(?:cm|kg)|height|weighs?|weight)\b|身高|体重/iu;
const FILE_OR_DEMO_OPERATION_KEYWORDS =
  /\b(?:created|create|containing|folder|directory|path|README|requirements\.txt|\.env|script|demo|SDK|Cloud SDK|seed_[\w-]+\.py|[\w-]+-demo)\b|\/Users\/|文件夹|目录|路径|脚本|创建|包含/iu;

type ProfileLanguage = 'zh' | 'en' | 'ja';
type PersonaIdentity = 'ai_product_frontend' | 'frontend' | 'ai_product';
type PersonaDomain = 'ai_memory_profile' | 'database';
type PersonaTrait = 'goal_driven' | 'systematic_thinking';
type PersonaWorkStyle =
  | 'actionable_breakdown'
  | 'efficient_actionable'
  | 'structured_collaboration';
type PersonaPlan =
  | 'english_learning'
  | 'health_management'
  | 'family_education'
  | 'ai_memory_learning'
  | 'project_development';

interface PersonaSummarySignals {
  identities: PersonaIdentity[];
  domains: PersonaDomain[];
  traits: PersonaTrait[];
  workStyles: PersonaWorkStyle[];
  longTermPlans: PersonaPlan[];
  evidence: UserProfileEvidence[];
}

const PERSONA_TEXT: Record<
  ProfileLanguage,
  {
    identities: Record<PersonaIdentity, string>;
    domains: Record<PersonaDomain, string>;
    traits: Record<PersonaTrait, string>;
    workStyles: Record<PersonaWorkStyle, string>;
    plans: Record<PersonaPlan, string>;
    defaultIdentity: string;
    systematicDelivery: string;
  }
> = {
  zh: {
    identities: {
      ai_product_frontend: 'AI 产品与前端工程实践者',
      frontend: '前端工程实践者',
      ai_product: 'AI 产品实践者',
    },
    domains: {
      ai_memory_profile: 'AI、用户画像、Memory、Agent',
      database: '数据库',
    },
    traits: {
      goal_driven: '目标驱动',
      systematic_thinking: '擅长系统化思考',
    },
    workStyles: {
      actionable_breakdown: '习惯将复杂问题拆解为可落地方案',
      efficient_actionable: '重视效率与可执行建议',
      structured_collaboration: '偏好结构化、直接且可执行的协作方式',
    },
    plans: {
      english_learning: '英语学习',
      health_management: '健康管理',
      family_education: '家庭教育',
      ai_memory_learning: 'AI Agent 与 Memory 学习',
      project_development: '项目开发',
    },
    defaultIdentity: '目标驱动的长期成长型用户',
    systematicDelivery: '擅长系统化拆解并落地方案',
  },
  en: {
    identities: {
      ai_product_frontend:
        'an AI product and frontend engineering practitioner',
      frontend: 'a frontend engineering practitioner',
      ai_product: 'an AI product practitioner',
    },
    domains: {
      ai_memory_profile: 'AI, user profiles, Memory, and Agent',
      database: 'databases',
    },
    traits: {
      goal_driven: 'goal-driven',
      systematic_thinking: 'systematic in your thinking',
    },
    workStyles: {
      actionable_breakdown: 'turn complex problems into actionable plans',
      efficient_actionable: 'value efficiency and actionable advice',
      structured_collaboration:
        'prefer structured, direct, and actionable collaboration',
    },
    plans: {
      english_learning: 'English learning',
      health_management: 'health management',
      family_education: 'family education',
      ai_memory_learning: 'AI Agent and Memory learning',
      project_development: 'project development',
    },
    defaultIdentity: 'a goal-driven person committed to long-term growth',
    systematicDelivery:
      'systematically break down problems into actionable plans',
  },
  ja: {
    identities: {
      ai_product_frontend:
        'AIプロダクトとフロントエンドエンジニアリングの実践者',
      frontend: 'フロントエンドエンジニアリングの実践者',
      ai_product: 'AIプロダクトの実践者',
    },
    domains: {
      ai_memory_profile: 'AI、ユーザープロファイル、Memory、Agent',
      database: 'データベース',
    },
    traits: {
      goal_driven: '目標志向',
      systematic_thinking: '体系的に考える傾向があります',
    },
    workStyles: {
      actionable_breakdown: '複雑な問題を実行可能な計画に分解します',
      efficient_actionable: '効率と実行可能な提案を重視します',
      structured_collaboration: '構造化された直接的で実行可能な協働を好みます',
    },
    plans: {
      english_learning: '英語学習',
      health_management: '健康管理',
      family_education: '家庭教育',
      ai_memory_learning: 'AI AgentとMemoryの学習',
      project_development: 'プロジェクト開発',
    },
    defaultIdentity: '長期的な成長を重視する目標志向の人',
    systematicDelivery: '問題を体系的に分解し、実行可能な計画に落とし込みます',
  },
};

const PROFILE_TEXT: Record<
  ProfileLanguage,
  {
    facets: Record<
      'persona' | 'preference' | 'dislike' | 'work_style' | 'long_term',
      string
    >;
    emptySummary: string;
    unstableSummary: string;
    sparseSummary: string;
    itemLabels: Record<UserProfileItemKind, string>;
    companion: {
      signal: string;
      title: string;
      goalOriented: string;
      planning: string;
      communication: string;
      continuity: string;
    };
    constraints: {
      signal: string;
      vagueTitle: string;
      vagueSummary: string;
      evidenceTitle: string;
      evidenceSummary: string;
      contextTitle: string;
      contextSummary: string;
      goalsTitle: string;
      goalsSummary: string;
    };
  }
> = {
  zh: {
    facets: {
      persona: '整体画像',
      preference: '偏好',
      dislike: '不喜欢',
      work_style: '做事风格',
      long_term: '长期特征',
    },
    emptySummary: '当前没有可用于生成用户画像总结的记忆。',
    unstableSummary:
      '当前记忆中稳定画像信号较少，已根据现有信息生成初步总结，但画像可能不稳定。',
    sparseSummary:
      '当前可用记忆信息较少，已根据现有记忆生成初步总结，但画像可能不稳定。',
    itemLabels: ITEM_KIND_LABELS,
    companion: {
      signal: '长期陪伴信号',
      title: '目标导向陪伴',
      goalOriented: '用户偏好目标导向、主动跟进型陪伴，而非单纯情绪安慰型',
      planning:
        '希望通过制定计划、拆解任务、记录进展、定期提醒和复盘获得持续支持',
      communication: '交流风格简洁直接，重视结构化输出、可执行建议和数据反馈',
      continuity: '期待 AI 记住目标并根据进度动态调整计划',
    },
    constraints: {
      signal: '长期约束',
      vagueTitle: '避免空泛冗长',
      vagueSummary:
        '回答要直接、结构化、具体可执行，避免空泛建议、重复背景和说教式表达。',
      evidenceTitle: '基于证据回答',
      evidenceSummary:
        '重要判断需基于已有 facts、insights 或明确证据，不要无依据推断。',
      contextTitle: '结合长期背景',
      contextSummary:
        '回答需结合用户在 AI、Memory、Agent、前端工程和相关产品设计中的长期背景。',
      goalsTitle: '衔接长期目标',
      goalsSummary:
        '涉及学习、健康、家庭教育等主题时，应衔接长期目标并避免只按单次问题处理。',
    },
  },
  en: {
    facets: {
      persona: 'Overall profile',
      preference: 'Preferences',
      dislike: 'Dislikes',
      work_style: 'Work style',
      long_term: 'Long-term traits',
    },
    emptySummary:
      'There are currently no memories available for generating a user profile summary.',
    unstableSummary:
      'The current memories contain few stable profile signals, so this preliminary summary may not yet be reliable.',
    sparseSummary:
      'Few memories are currently available, so this preliminary summary may not yet be reliable.',
    itemLabels: {
      current_priority: 'Current priority',
      companion_style: 'Preferred companion style',
      robot_constraint: 'AI constraint',
    },
    companion: {
      signal: 'Long-term companionship signal',
      title: 'Goal-oriented companionship',
      goalOriented:
        'They prefer goal-oriented, proactive follow-up rather than purely emotional comfort',
      planning:
        'They value planning, task breakdowns, progress tracking, regular reminders, and reviews',
      communication:
        'Communication should be concise and direct, with structured output, actionable advice, and data-informed feedback',
      continuity:
        'AI should remember their goals and dynamically adjust plans based on progress',
    },
    constraints: {
      signal: 'Long-term constraint',
      vagueTitle: 'Avoid vague verbosity',
      vagueSummary:
        'Answers should be direct, structured, specific, and actionable, while avoiding vague advice, repeated context, and lecturing.',
      evidenceTitle: 'Ground answers in evidence',
      evidenceSummary:
        'Important judgments should be grounded in existing facts, insights, or explicit evidence rather than unsupported inference.',
      contextTitle: 'Use long-term context',
      contextSummary:
        'Answers should use their long-term context in AI, Memory, Agent, frontend engineering, and related product design.',
      goalsTitle: 'Connect long-term goals',
      goalsSummary:
        'When discussing learning, health, or family education, connect the answer to long-term goals instead of treating it as a one-off question.',
    },
  },
  ja: {
    facets: {
      persona: '全体像',
      preference: '好み',
      dislike: '好まないこと',
      work_style: '仕事の進め方',
      long_term: '長期的な特徴',
    },
    emptySummary: 'ユーザープロファイルの要約に使用できるメモリがありません。',
    unstableSummary:
      '安定したプロファイル情報が少ないため、この暫定的な要約はまだ不安定な可能性があります。',
    sparseSummary:
      '利用可能なメモリが少ないため、この暫定的な要約はまだ不安定な可能性があります。',
    itemLabels: {
      current_priority: '現在の優先事項',
      companion_style: '好ましい伴走スタイル',
      robot_constraint: 'AIへの重要な制約',
    },
    companion: {
      signal: '長期的な伴走の手がかり',
      title: '目標志向の伴走',
      goalOriented:
        '単なる感情的な慰めよりも、目標志向で能動的にフォローする伴走を好みます',
      planning:
        '計画作成、タスク分解、進捗記録、定期的なリマインドと振り返りによる継続的な支援を重視します',
      communication:
        '簡潔で直接的な対話を好み、構造化された出力、実行可能な提案、データに基づくフィードバックを重視します',
      continuity:
        'AIが目標を記憶し、進捗に応じて計画を動的に調整することを期待します',
    },
    constraints: {
      signal: '長期的な制約',
      vagueTitle: '曖昧で冗長な回答を避ける',
      vagueSummary:
        '回答は直接的、構造的、具体的で実行可能なものとし、曖昧な提案、背景の繰り返し、説教調の表現を避けます。',
      evidenceTitle: '根拠に基づいて回答する',
      evidenceSummary:
        '重要な判断は既存のfacts、insights、または明確な根拠に基づき、根拠のない推測を避けます。',
      contextTitle: '長期的な背景を活用する',
      contextSummary:
        'AI、Memory、Agent、フロントエンド開発、関連するプロダクト設計の長期的な背景を回答に反映します。',
      goalsTitle: '長期目標につなげる',
      goalsSummary:
        '学習、健康、家庭教育などの話題では、単発の質問として扱わず長期目標につなげます。',
    },
  },
};

const ATTRIBUTE_KEYWORDS: Record<UserProfileAttributeKind, RegExp> = {
  long_term_interest:
    /(长期兴趣|兴趣|关注领域|关注方向|持续关注|interest|interested|focus area)/iu,
  professional_skill:
    /(专业技能|技能|能力|擅长|经验|技术栈|法务|律师|资格证|skill|expertise|capability|proficiency)/iu,
  current_project:
    /(当前项目|正在做|项目|产品|repo|应用|project|working on|current work)/iu,
  long_term_goal:
    /(长期目标|目标|愿景|长期规划|成长方向|goal|long-term|long term|aspiration)/iu,
  work_habit:
    /(工作习惯|做事风格|工作风格|习惯|流程|节奏|结构化推进|推进方式|habit|workflow|work style|routine)/iu,
  communication_style:
    /(沟通风格|沟通|表达|回复|直接|具体|少说教|语气|communication|tone|direct|specific)/iu,
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

  public async getProfile(
    context: Mem9RequestContext,
  ): Promise<UserProfileResponse> {
    const memories = await this.source.fetchProfileMemories(context.rawApiKey);
    const activeMemories = memories.filter((memory) =>
      this.isProfileMemory(memory),
    );
    const language = this.detectProfileLanguage(activeMemories);
    const items = this.buildItems(activeMemories, language);

    return {
      generatedAt: new Date().toISOString(),
      source: {
        memoryTypes: ['fact', 'insight', 'pinned'],
        memoryCount: activeMemories.length,
      },
      summary: this.buildSummary(activeMemories, items, language),
      attributes: [],
      changes: [],
      items,
    };
  }

  private detectProfileLanguage(
    memories: DeepAnalysisMemorySnapshot[],
  ): ProfileLanguage {
    const text = memories.map((memory) => memory.content).join(' ');
    const hanCount = text.match(/[\u3400-\u9fff]/gu)?.length ?? 0;
    const kanaCount = text.match(/[\u3040-\u30ff\u31f0-\u31ff]/gu)?.length ?? 0;
    const latinLetterCount = text.match(/[A-Za-z]/gu)?.length ?? 0;
    if (kanaCount > 0 && kanaCount + hanCount > latinLetterCount) {
      return 'ja';
    }
    return latinLetterCount > hanCount ? 'en' : 'zh';
  }

  private buildSummary(
    memories: DeepAnalysisMemorySnapshot[],
    items: UserProfileImageItem[],
    language: ProfileLanguage,
  ): UserProfileResponse['summary'] {
    const stableMemories = memories.filter((memory) =>
      this.isStablePersonaMemory(memory),
    );
    const personaSignals = this.collectPersonaSummarySignals(
      stableMemories,
      items,
    );
    const personaSummary = this.synthesizePersonaSummary(
      personaSignals,
      language,
    );

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
        message: this.buildSummaryMessage(memories, signalCount, language),
        evidence: this.uniqueEvidence(personaSignals.evidence).slice(
          0,
          SUMMARY_EVIDENCE_LIMIT,
        ),
      };
    }

    const descriptions = this.extractProfileDescriptions(stableMemories).slice(
      0,
      SUMMARY_EVIDENCE_LIMIT,
    );

    const baseFacets = [
      this.buildSummaryFacet(
        stableMemories,
        PERSONA_SUMMARY_KEYWORDS,
        this.summaryFacetLabel('persona', language),
        language,
      ),
      this.buildSummaryFacet(
        stableMemories,
        PREFERENCE_SUMMARY_KEYWORDS,
        this.summaryFacetLabel('preference', language),
        language,
        DISLIKE_SUMMARY_KEYWORDS,
      ),
      this.buildSummaryFacet(
        stableMemories,
        DISLIKE_SUMMARY_KEYWORDS,
        this.summaryFacetLabel('dislike', language),
        language,
      ),
      this.buildSummaryFacet(
        stableMemories,
        WORK_STYLE_SUMMARY_KEYWORDS,
        this.summaryFacetLabel('work_style', language),
        language,
      ),
    ].filter(
      (value): value is { text: string; memory: DeepAnalysisMemorySnapshot } =>
        value !== null,
    );
    const genericFacet =
      descriptions.length === 0 && baseFacets.length === 0
        ? this.buildSummaryFacet(
            stableMemories,
            STABLE_PERSONA_KEYWORDS,
            this.summaryFacetLabel('long_term', language),
            language,
          )
        : null;
    const facets = genericFacet ? [genericFacet] : baseFacets;

    const descriptionEvidence = descriptions.map(
      (description) => description.evidence,
    );
    const facetEvidence = this.uniqueMemories(
      facets.map((facet) => facet.memory),
    ).map((memory) => this.toEvidence(memory));
    const signalCount = descriptions.length + facets.length;

    if (signalCount === 0) {
      return {
        text: '',
        message: this.buildSummaryMessage(memories, 0, language),
        evidence: [],
      };
    }

    return {
      text: this.limitSummaryText(
        [
          ...facets.map((facet) => facet.text),
          descriptions.length > 0
            ? this.synthesizeProfileDescriptions(descriptions, language)
            : '',
        ]
          .filter(Boolean)
          .join(language === 'en' ? '; ' : '；'),
        this.localizedTextLimit(language, 100),
      ),
      message: this.buildSummaryMessage(memories, signalCount, language),
      evidence: this.uniqueEvidence([
        ...descriptionEvidence,
        ...facetEvidence,
      ]).slice(0, SUMMARY_EVIDENCE_LIMIT),
    };
  }

  private synthesizeProfileDescriptions(
    descriptions: Array<{
      kind: UserProfileAttributeKind;
      value: string;
    }>,
    language: ProfileLanguage,
  ): string {
    const byKind = new Map(
      descriptions.map(
        (description) => [description.kind, description.value] as const,
      ),
    );
    const clauses: string[] = [];
    const longTermGoal = byKind.get('long_term_goal');
    const professionalSkill = byKind.get('professional_skill');
    const longTermInterest = byKind.get('long_term_interest');
    const workHabit = byKind.get('work_habit');
    const communicationStyle = byKind.get('communication_style');

    if (language === 'en') {
      if (longTermGoal)
        clauses.push(
          `Your long-term goal is ${this.toInlineClause(longTermGoal)}`,
        );
      if (professionalSkill)
        clauses.push(
          `your professional skills include ${this.toInlineClause(professionalSkill)}`,
        );
      if (longTermInterest)
        clauses.push(
          `your interests include ${this.toInlineClause(longTermInterest)}`,
        );
      if (workHabit)
        clauses.push(`your work style is ${this.toInlineClause(workHabit)}`);
      if (communicationStyle)
        clauses.push(
          `your communication style is ${this.toInlineClause(communicationStyle)}`,
        );
      return this.limitSummaryText(
        clauses.length > 0
          ? `${clauses.join('; ')}.`
          : `You ${descriptions.map((description) => this.toInlineClause(description.value)).join(', ')}.`,
        this.localizedTextLimit(language, 100),
      );
    }

    if (language === 'ja') {
      if (longTermGoal)
        clauses.push(`長期目標は${this.toInlineClause(longTermGoal)}です`);
      if (professionalSkill)
        clauses.push(
          `専門スキルには${this.toInlineClause(professionalSkill)}が含まれます`,
        );
      if (longTermInterest)
        clauses.push(`関心領域は${this.toInlineClause(longTermInterest)}です`);
      if (workHabit)
        clauses.push(`仕事の進め方は${this.toInlineClause(workHabit)}です`);
      if (communicationStyle)
        clauses.push(
          `コミュニケーションは${this.toInlineClause(communicationStyle)}を好みます`,
        );
      return this.limitSummaryText(
        clauses.length > 0
          ? `あなたの${clauses.join('。')}。`
          : `あなたは${descriptions.map((description) => this.toInlineClause(description.value)).join('、')}。`,
        this.localizedTextLimit(language, 100),
      );
    }

    if (longTermGoal)
      clauses.push(`长期目标是${this.toInlineClause(longTermGoal)}`);
    if (professionalSkill)
      clauses.push(`专业能力涉及${this.toInlineClause(professionalSkill)}`);
    if (longTermInterest)
      clauses.push(`兴趣上关注${this.toInlineClause(longTermInterest)}`);
    if (workHabit) clauses.push(`做事偏${this.toInlineClause(workHabit)}`);
    if (communicationStyle)
      clauses.push(`沟通偏${this.toInlineClause(communicationStyle)}`);

    return this.limitSummaryText(
      clauses.length > 0
        ? `你${clauses.join('，')}`
        : `你${descriptions.map((description) => this.toInlineClause(description.value)).join('，')}`,
      this.localizedTextLimit(language, 100),
    );
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
    if (
      /(前端|React|TypeScript|工程实践|开发工程师|フロントエンド|エンジニアリング|開発者|frontend|front-end)/iu.test(
        text,
      )
    ) {
      signals.identities.push(
        /AI|Agent|Memory|用户画像|长期记忆|ユーザープロファイル|長期記憶/iu.test(
          text,
        )
          ? 'ai_product_frontend'
          : 'frontend',
      );
      signals.evidence.push(evidence);
    } else if (
      /(产品|PRD|用户研究|用户画像|治理系统|可视化方案|プロダクト|ユーザー調査|ユーザープロファイル|ガバナンス|可視化)/iu.test(
        text,
      ) &&
      /AI|mem9|Memory|Agent|长期记忆|長期記憶/iu.test(text)
    ) {
      signals.identities.push('ai_product');
      signals.evidence.push(evidence);
    }

    if (
      /(AI|Agent|Memory|长期记忆|用户画像|長期記憶|ユーザープロファイル|mem9)/iu.test(
        text,
      )
    ) {
      signals.domains.push('ai_memory_profile');
      signals.evidence.push(evidence);
    }
    if (/(TiDB|数据库|データベース|database)/iu.test(text)) {
      signals.domains.push('database');
      signals.evidence.push(evidence);
    }

    if (
      /(目标驱动|目标导向|成长驱动力|执行力|持续推进|长期目标|目標志向|成長意欲|実行力|継続的に推進|長期目標)/iu.test(
        text,
      )
    ) {
      signals.traits.push('goal_driven');
      signals.evidence.push(evidence);
    }
    if (
      /(系统化|结构化|拆解|可落地|工程化|模板|自动化|复用|体系的|構造化|分解|実行可能|エンジニアリング|テンプレート|自動化|再利用)/iu.test(
        text,
      )
    ) {
      signals.traits.push('systematic_thinking');
      signals.workStyles.push('actionable_breakdown');
      signals.evidence.push(evidence);
    }
    if (
      /(效率|直接给结论|简洁高效|少说教|可执行|効率|結論を先に|簡潔|説教を避ける|実行可能)/iu.test(
        text,
      )
    ) {
      signals.workStyles.push('efficient_actionable');
      signals.evidence.push(evidence);
    }

    this.collectPlanSignals(signals, text);
  }

  private collectPlanSignals(
    signals: PersonaSummarySignals,
    text: string,
  ): void {
    if (/(英语|KET|CET|六级|单词|备考|英語|単語|試験対策)/iu.test(text)) {
      signals.longTermPlans.push('english_learning');
    }
    if (/(健康|减脂|饮食|步数|运动|睡眠|減量|食事|歩数|運動)/iu.test(text)) {
      signals.longTermPlans.push('health_management');
    }
    if (/(家庭教育|孩子|女儿|亲子|子ども|娘|親子)/iu.test(text)) {
      signals.longTermPlans.push('family_education');
    }
    if (
      /(AI Agent|Agent|Memory|长期记忆|長期記憶)/iu.test(text) &&
      /(学习|深入|关注|推进|研究|学習|深める|関心|推進)/iu.test(text)
    ) {
      signals.longTermPlans.push('ai_memory_learning');
    }
    if (
      /(TiDB Cloud|项目开发|开发|プロジェクト開発|開発)/iu.test(text) &&
      /(推进|持续|长期|工作|推進|継続|長期|仕事)/iu.test(text)
    ) {
      signals.longTermPlans.push('project_development');
    }
  }

  private collectStyleSignals(
    signals: PersonaSummarySignals,
    text: string,
  ): void {
    if (
      /(直接|结论|结构化|可执行|完整|模板|风险|优化|跟进|规划|决策|結論|構造化|実行可能|完全|テンプレート|リスク|最適化|フォロー|計画|意思決定)/iu.test(
        text,
      )
    ) {
      signals.workStyles.push('structured_collaboration');
    }
  }

  private synthesizePersonaSummary(
    signals: PersonaSummarySignals,
    language: ProfileLanguage,
  ): string {
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

    const copy = PERSONA_TEXT[language];
    const hasFrontendIdentity = signals.identities.some(
      (value) => value === 'frontend' || value === 'ai_product_frontend',
    );
    const hasAiDomain = signals.domains.includes('ai_memory_profile');
    const identity =
      hasFrontendIdentity && hasAiDomain
        ? copy.identities.ai_product_frontend
        : signals.identities[0]
          ? copy.identities[signals.identities[0]]
          : copy.defaultIdentity;
    const clauses: string[] = [
      language === 'zh'
        ? `你是一位${identity}`
        : language === 'ja'
          ? `あなたは${identity}です`
          : `You are ${identity}`,
    ];
    if (signals.traits.length > 0) {
      clauses.push(
        signals.traits
          .slice(0, 2)
          .map((value) => copy.traits[value])
          .join(language === 'en' ? ' and ' : '、'),
      );
    }
    if (signals.domains.length > 0) {
      const domains = signals.domains
        .slice(0, 2)
        .map((value) => copy.domains[value]);
      clauses.push(
        language === 'zh'
          ? `关注${domains.join('、')}`
          : language === 'ja'
            ? `${domains.join('、')}に関心があります`
            : `focus on ${domains.join(' and ')}`,
      );
    }
    if (signals.workStyles.length > 0) {
      clauses.push(
        signals.workStyles.includes('actionable_breakdown')
          ? copy.systematicDelivery
          : copy.workStyles[signals.workStyles[0]!],
      );
    }
    if (signals.longTermPlans.length > 0) {
      const plans = signals.longTermPlans
        .slice(0, 3)
        .map((value) => copy.plans[value]);
      clauses.push(
        language === 'zh'
          ? `持续推进${plans.join('、')}`
          : language === 'ja'
            ? `${plans.join('、')}に継続して取り組んでいます`
            : `continue pursuing ${plans.join(', ')}`,
      );
    }

    return this.limitSummaryText(
      `${clauses.join(language === 'en' ? ', ' : language === 'ja' ? '、' : '，')}${language === 'en' ? '.' : '。'}`,
      this.localizedTextLimit(language, 100),
    );
  }

  private extractProfileDescriptions(
    memories: DeepAnalysisMemorySnapshot[],
  ): Array<{
    kind: UserProfileAttributeKind;
    value: string;
    evidence: UserProfileEvidence;
  }> {
    const descriptions = new Map<
      UserProfileAttributeKind,
      {
        kind: UserProfileAttributeKind;
        value: string;
        evidence: UserProfileEvidence;
      }
    >();

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

    return (
      Object.keys(ATTRIBUTE_KIND_LABELS) as UserProfileAttributeKind[]
    ).flatMap((kind) => descriptions.get(kind) ?? []);
  }

  private buildSummaryMessage(
    memories: DeepAnalysisMemorySnapshot[],
    facetCount: number,
    language: ProfileLanguage,
  ): string | undefined {
    const copy = PROFILE_TEXT[language];
    if (facetCount === 0) {
      return memories.length === 0 ? copy.emptySummary : copy.unstableSummary;
    }

    if (facetCount < STABLE_SUMMARY_FACET_COUNT) {
      return copy.sparseSummary;
    }

    return undefined;
  }

  private buildSummaryFacet(
    memories: DeepAnalysisMemorySnapshot[],
    pattern: RegExp,
    label: string,
    language: ProfileLanguage,
    excludePattern?: RegExp,
  ): { text: string; memory: DeepAnalysisMemorySnapshot } | null {
    const memory = memories
      .filter((item) => !this.isOperationalItemMemory(item))
      .filter((item) => !this.isTemporalPlanMemory(item))
      .filter(
        (item) =>
          pattern.test(item.content) ||
          this.matchesMetadataValue(item, pattern),
      )
      .filter(
        (item) =>
          !excludePattern ||
          (!excludePattern.test(item.content) &&
            !this.matchesMetadataValue(item, excludePattern)),
      )
      .sort(
        (left, right) => this.memoryScore(right) - this.memoryScore(left),
      )[0];

    if (!memory) {
      return null;
    }

    return {
      text: `${label}${language === 'en' ? ': ' : '：'}${this.extractSummaryClause(memory.content)}`,
      memory,
    };
  }

  private summaryFacetLabel(
    facet: 'persona' | 'preference' | 'dislike' | 'work_style' | 'long_term',
    language: ProfileLanguage,
  ): string {
    return PROFILE_TEXT[language].facets[facet];
  }

  private buildItems(
    memories: DeepAnalysisMemorySnapshot[],
    language: ProfileLanguage,
  ): UserProfileImageItem[] {
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

        const title = this.extractTitle(memory, kind, language);
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

      const synthesizedCandidates = this.synthesizeItemCandidates(
        kind,
        [...candidates.values()],
        memories,
        language,
      );
      const finalCandidates =
        synthesizedCandidates.length > 0
          ? synthesizedCandidates
          : [...candidates.values()];

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
    language: ProfileLanguage,
  ): ProfileCandidate[] {
    if (kind === 'companion_style') {
      return this.synthesizeCompanionStyleCandidates(
        candidates,
        memories,
        language,
      );
    }

    if (kind === 'robot_constraint') {
      return this.synthesizeRobotConstraintCandidates(
        candidates,
        memories,
        language,
      );
    }

    return [];
  }

  private synthesizeCompanionStyleCandidates(
    candidates: ProfileCandidate[],
    memories: DeepAnalysisMemorySnapshot[],
    language: ProfileLanguage,
  ): ProfileCandidate[] {
    const copy = PROFILE_TEXT[language].companion;
    const planCandidates = memories
      .filter(
        (memory) =>
          this.isProfileMemory(memory) && !this.isSummaryMemory(memory),
      )
      .filter(
        (memory) =>
          !this.isProductOrDocumentMemory(memory) &&
          !this.isFileOrDemoOperationMemory(memory),
      )
      .filter((memory) =>
        /(目标|计划|拆解|任务|进展|提醒|复盘|跟进|调整|KET|英语|健康|减脂|长期|目標|計画|分解|タスク|進捗|リマインド|振り返り|フォロー|調整|英語|減量|長期|goal|plan|progress|follow|review)/iu.test(
          memory.content,
        ),
      )
      .map((memory) => ({
        title: this.firstSentence(memory.content) ?? copy.signal,
        summary: this.cleanText(memory.content),
        importance: this.memoryScore(memory),
        evidence: [this.toEvidence(memory)],
      }));
    const sourceCandidates = [...candidates, ...planCandidates];
    if (sourceCandidates.length === 0) {
      return [];
    }

    const sourceText = sourceCandidates
      .map((candidate) => `${candidate.title} ${candidate.summary}`)
      .join(' ');
    const summaryParts: string[] = [];

    if (
      /(目标|计划|进展|跟进|复盘|提醒|调整|长期|目標|計画|進捗|フォロー|振り返り|リマインド|調整|長期|goal|plan|progress|follow|review)/iu.test(
        sourceText,
      )
    ) {
      summaryParts.push(copy.goalOriented);
    }
    if (
      /(制定计划|拆解|任务|步骤|清单|模板|可执行|具体|計画作成|分解|タスク|手順|リスト|テンプレート|実行可能|具体的|plan|step|task|actionable)/iu.test(
        sourceText,
      )
    ) {
      summaryParts.push(copy.planning);
    }
    if (
      /(直接|结论|简洁|高效|结构化|数据|反馈|少说教|結論|簡潔|効率|構造化|データ|フィードバック|説教|direct|concise|structured|data)/iu.test(
        sourceText,
      )
    ) {
      summaryParts.push(copy.communication);
    }
    if (
      /(记住|长期目标|历史|上下文|动态|调整|进度|記憶|長期目標|履歴|コンテキスト|動的|調整|進捗|memory|context|adjust)/iu.test(
        sourceText,
      )
    ) {
      summaryParts.push(copy.continuity);
    }

    if (summaryParts.length === 0) {
      return [];
    }

    return [
      this.toSyntheticCandidate(
        copy.title,
        this.limitSummaryText(
          summaryParts.join(
            language === 'en' ? '; ' : language === 'ja' ? '。' : '；',
          ),
          this.localizedTextLimit(language, 150),
        ),
        sourceCandidates,
      ),
    ];
  }

  private synthesizeRobotConstraintCandidates(
    candidates: ProfileCandidate[],
    memories: DeepAnalysisMemorySnapshot[],
    language: ProfileLanguage,
  ): ProfileCandidate[] {
    const copy = PROFILE_TEXT[language].constraints;
    const memoryCandidates = memories
      .filter(
        (memory) =>
          this.isProfileMemory(memory) && !this.isSummaryMemory(memory),
      )
      .map((memory) => ({
        title: this.firstSentence(memory.content) ?? copy.signal,
        summary: this.cleanText(memory.content),
        importance: this.memoryScore(memory),
        evidence: [this.toEvidence(memory)],
      }));
    const sourceCandidates = [...candidates, ...memoryCandidates];
    const sourceText = sourceCandidates
      .map((candidate) => `${candidate.title} ${candidate.summary}`)
      .join(' ');
    const results: ProfileCandidate[] = [];

    if (
      /(空泛|说教|重复背景|绕太多|冗长|直接|结论|结构化|可执行|曖昧|説教|背景の繰り返し|冗長|直接|結論|構造化|実行可能|vague|verbose|direct|structured)/iu.test(
        sourceText,
      )
    ) {
      results.push(
        this.toSyntheticCandidate(
          copy.vagueTitle,
          copy.vagueSummary,
          sourceCandidates,
        ),
      );
    }

    if (
      /(facts|insights|证据|基于|不要编造|无依据|确认|纠错|根拠|基づく|捏造しない|根拠のない|確認|訂正|evidence|grounded)/iu.test(
        sourceText,
      )
    ) {
      results.push(
        this.toSyntheticCandidate(
          copy.evidenceTitle,
          copy.evidenceSummary,
          sourceCandidates,
        ),
      );
    }

    if (
      /(React|TypeScript|TiDB Cloud|TiDB|PRD|AI Agent|Agent|Memory|长期记忆|mem9|英文 PRD)/iu.test(
        sourceText,
      )
    ) {
      results.push(
        this.toSyntheticCandidate(
          copy.contextTitle,
          copy.contextSummary,
          sourceCandidates,
        ),
      );
    }

    if (
      /(英语|KET|CET|六级|健康|减脂|饮食|家庭教育|长期目标|持续推进|英語|減量|食事|家庭教育|長期目標|継続)/iu.test(
        sourceText,
      )
    ) {
      results.push(
        this.toSyntheticCandidate(
          copy.goalsTitle,
          copy.goalsSummary,
          sourceCandidates,
        ),
      );
    }

    return results;
  }

  private toSyntheticCandidate(
    title: string,
    summary: string,
    candidates: ProfileCandidate[],
  ): ProfileCandidate {
    const evidence = this.uniqueEvidence(
      candidates.flatMap((candidate) => candidate.evidence),
    ).slice(0, ITEM_EVIDENCE_LIMIT);
    const importance = candidates.reduce(
      (total, candidate) => total + candidate.importance,
      0,
    );
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

  private matchesKind(
    memory: DeepAnalysisMemorySnapshot,
    kind: UserProfileItemKind,
  ): boolean {
    const explicitKind = this.explicitItemKind(memory);
    if (explicitKind) {
      return explicitKind === kind;
    }

    if (
      (kind === 'companion_style' || kind === 'robot_constraint') &&
      (this.isProductOrDocumentMemory(memory) ||
        this.isFileOrDemoOperationMemory(memory))
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
    const hasPreference =
      PREFERENCE_SUMMARY_KEYWORDS.test(text) ||
      /prefer|preference|likes?|喜欢|偏好|希望|更希望/iu.test(text);
    return hasPreference && COMPANION_TARGET_KEYWORDS.test(text);
  }

  private matchesRobotConstraint(memory: DeepAnalysisMemorySnapshot): boolean {
    const text = memory.content;
    const hasConstraint = CONSTRAINT_KEYWORDS.test(text);
    if (!hasConstraint) {
      return false;
    }

    return (
      ROBOT_TARGET_KEYWORDS.test(text) || ROBOT_BEHAVIOR_KEYWORDS.test(text)
    );
  }

  private explicitItemKind(
    memory: DeepAnalysisMemorySnapshot,
  ): UserProfileItemKind | null {
    for (const kind of Object.keys(ITEM_KIND_LABELS) as UserProfileItemKind[]) {
      if (this.hasAnyToken(memory, [kind, ITEM_KIND_LABELS[kind]])) {
        return kind;
      }
    }

    return null;
  }

  private isSummaryMemory(memory: DeepAnalysisMemorySnapshot): boolean {
    const content = this.cleanText(memory.content);
    if (
      /^(profile_summary|persona_summary|summary|用户画像总结|画像总结)\s*[:：]/iu.test(
        content,
      )
    ) {
      return true;
    }

    const metadataAndTags = [
      ...(memory.tags ?? []),
      ...Object.entries(memory.metadata ?? {}).flatMap(([key, value]) => [
        key,
        String(value),
      ]),
    ]
      .join(' ')
      .toLowerCase();
    return ['profile_summary', 'persona_summary', '画像总结'].some((token) =>
      metadataAndTags.includes(token.toLowerCase()),
    );
  }

  private isOperationalItemMemory(memory: DeepAnalysisMemorySnapshot): boolean {
    return (
      Boolean(this.explicitItemKind(memory)) ||
      this.matchesRobotConstraint(memory)
    );
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

    if (
      this.isTemporalPlanMemory(memory) ||
      EPHEMERAL_SUMMARY_KEYWORDS.test(memory.content)
    ) {
      return false;
    }

    return this.hasStablePersonaSignal(memory);
  }

  private isProductOrDocumentMemory(
    memory: DeepAnalysisMemorySnapshot,
  ): boolean {
    return (
      PRODUCT_OR_DOC_MEMORY_KEYWORDS.test(memory.content) &&
      !/(用户|你|user)\s*(经常|常用|长期|偏好|不喜欢|喜欢|习惯|擅长|从事|使用|uses?|prefers?|likes?|dislikes?|often|usually)/iu.test(
        memory.content,
      )
    );
  }

  private isFileOrDemoOperationMemory(
    memory: DeepAnalysisMemorySnapshot,
  ): boolean {
    return FILE_OR_DEMO_OPERATION_KEYWORDS.test(memory.content);
  }

  private isProfileFactOnlyMemory(memory: DeepAnalysisMemorySnapshot): boolean {
    return PROFILE_FACT_ONLY_KEYWORDS.test(memory.content);
  }

  private hasStablePersonaSignal(memory: DeepAnalysisMemorySnapshot): boolean {
    return (
      STABLE_PERSONA_KEYWORDS.test(memory.content) ||
      this.matchesMetadataValue(memory, STABLE_PERSONA_KEYWORDS) ||
      Object.values(ATTRIBUTE_KEYWORDS).some(
        (pattern) =>
          pattern.test(memory.content) ||
          this.matchesMetadataValue(memory, pattern),
      ) ||
      [
        PERSONA_SUMMARY_KEYWORDS,
        PREFERENCE_SUMMARY_KEYWORDS,
        DISLIKE_SUMMARY_KEYWORDS,
        WORK_STYLE_SUMMARY_KEYWORDS,
      ].some(
        (pattern) =>
          pattern.test(memory.content) ||
          this.matchesMetadataValue(memory, pattern),
      )
    );
  }

  private extractTitle(
    memory: DeepAnalysisMemorySnapshot,
    kind: UserProfileItemKind,
    language: ProfileLanguage,
  ): string {
    return (
      this.extractMetadataString(memory, [
        'title',
        'label',
        'name',
        'summary',
      ]) ??
      this.firstSentence(this.stripLeadingLabel(memory.content)) ??
      this.itemKindLabel(kind, language)
    );
  }

  private itemKindLabel(
    kind: UserProfileItemKind,
    language: ProfileLanguage,
  ): string {
    return PROFILE_TEXT[language].itemLabels[kind];
  }

  private extractSummary(memory: DeepAnalysisMemorySnapshot): string {
    return (
      this.extractMetadataString(memory, [
        'summary',
        'description',
        'content',
      ]) ?? this.cleanText(memory.content)
    );
  }

  private memoryScore(memory: DeepAnalysisMemorySnapshot): number {
    const confidence = this.extractMetadataNumber(memory, [
      'confidence',
      'score',
      'importance',
    ]);
    const evidenceCount =
      this.extractMetadataNumber(memory, ['evidenceCount', 'evidence_count']) ??
      1;
    const typeWeight = memory.memoryType === 'fact' ? 1.2 : 1;
    const tagWeight = (memory.tags?.length ?? 0) > 0 ? 0.2 : 0;
    return (
      ((confidence ?? 0.7) * 10 + Math.min(evidenceCount, 5)) * typeWeight +
      tagWeight
    );
  }

  private toEvidence(memory: DeepAnalysisMemorySnapshot): UserProfileEvidence {
    return {
      memoryId: memory.id,
      memoryType: memory.memoryType,
      quote: this.cleanText(memory.content).slice(0, 180),
      createdAt: memory.createdAt,
    };
  }

  private hasAnyToken(
    memory: DeepAnalysisMemorySnapshot,
    tokens: string[],
  ): boolean {
    const haystack = [
      memory.content,
      ...(memory.tags ?? []),
      ...Object.entries(memory.metadata ?? {}).flatMap(([key, value]) => [
        key,
        String(value),
      ]),
    ]
      .join(' ')
      .toLowerCase();

    return tokens.some((token) => haystack.includes(token.toLowerCase()));
  }

  private matchesMetadataValue(
    memory: DeepAnalysisMemorySnapshot,
    pattern: RegExp,
  ): boolean {
    return Object.entries(memory.metadata ?? {}).some(
      ([key, value]) => pattern.test(key) || pattern.test(String(value)),
    );
  }

  private matchAttributeKind(
    memory: DeepAnalysisMemorySnapshot,
  ): UserProfileAttributeKind | null {
    const explicitAttributeKind = this.matchExplicitAttributeKind(memory);
    if (explicitAttributeKind) {
      return explicitAttributeKind;
    }

    if (DISLIKE_SUMMARY_KEYWORDS.test(memory.content)) {
      return null;
    }

    for (const kind of Object.keys(
      ATTRIBUTE_KIND_LABELS,
    ) as UserProfileAttributeKind[]) {
      if (
        ATTRIBUTE_KEYWORDS[kind].test(memory.content) ||
        this.matchesMetadataValue(memory, ATTRIBUTE_KEYWORDS[kind])
      ) {
        return kind;
      }
    }

    return null;
  }

  private matchExplicitAttributeKind(
    memory: DeepAnalysisMemorySnapshot,
  ): UserProfileAttributeKind | null {
    const explicitKind = this.extractMetadataString(memory, [
      'attributeKind',
      'profileKind',
      'profile_attribute',
      'category',
      'kind',
    ]);

    if (explicitKind) {
      const normalizedKind = this.normalizeKey(explicitKind).replace(
        /[\s-]+/gu,
        '_',
      );
      for (const kind of Object.keys(
        ATTRIBUTE_KIND_LABELS,
      ) as UserProfileAttributeKind[]) {
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
    return (
      this.extractMetadataString(memory, [
        'value',
        'summary',
        'description',
        'content',
      ]) ??
      this.firstSentence(this.stripLeadingLabel(memory.content)) ??
      ATTRIBUTE_KIND_LABELS[kind]
    );
  }

  private uniqueEvidence(
    evidence: UserProfileEvidence[],
  ): UserProfileEvidence[] {
    const seen = new Set<string>();
    return evidence.filter((item) => {
      if (seen.has(item.memoryId)) {
        return false;
      }
      seen.add(item.memoryId);
      return true;
    });
  }

  private uniqueStrings<T extends string>(values: T[]): T[] {
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

  private extractMetadataString(
    memory: DeepAnalysisMemorySnapshot,
    keys: string[],
  ): string | null {
    const metadata = memory.metadata ?? {};
    for (const key of keys) {
      const value = metadata[key];
      if (typeof value === 'string' && value.trim()) {
        return this.cleanText(value);
      }
    }
    return null;
  }

  private extractMetadataNumber(
    memory: DeepAnalysisMemorySnapshot,
    keys: string[],
  ): number | null {
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
    const sentence = this.cleanText(value)
      .split(/[。.!?\n]/u)[0]
      ?.trim();
    return sentence || null;
  }

  private extractSummaryClause(value: string): string {
    const text =
      this.firstSentence(this.stripLeadingLabel(value)) ??
      this.cleanText(value);
    return text
      .replace(
        /^(用户|这个用户|ユーザー|このユーザー|TA|ta)?\s*(做事风格|工作风格|仕事の進め方|働き方)(是|为|は|です)?\s*/u,
        '',
      )
      .replace(
        /^(用户|这个用户|ユーザー|このユーザー|TA|ta)\s*(是|偏好|喜欢|不喜欢|讨厌|倾向于|重视|看重|は|好む|好まない|重視する)?\s*/u,
        '',
      )
      .trim();
  }

  private toInlineClause(value: string): string {
    return this.cleanText(value)
      .replace(/[。.!?？！]+$/u, '')
      .replace(/^(用户|这个用户|ユーザー|このユーザー|TA|ta)\s*/u, '')
      .replace(
        /^(目标是|长期目标是|当前重心是|当前重心在|偏好|喜欢|更喜欢|希望|想要|目標は|長期目標は|現在の重点は|好みは|好む|希望する)\s*/u,
        '',
      )
      .trim();
  }

  private localizedTextLimit(
    language: ProfileLanguage,
    chineseCharacterLimit: number,
  ): number {
    return language === 'en'
      ? chineseCharacterLimit * 4
      : chineseCharacterLimit;
  }

  private limitSummaryText(value: string, maxLength = 100): string {
    const text = this.cleanText(value).replace(/[；，、。,.，:：;]+$/u, '');
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
    const shortened = (
      sentenceBoundary > 0 ? head.slice(0, sentenceBoundary + 1) : head
    )
      .replace(/[；，、。,.，:：;]+$/u, '')
      .trim();
    return shortened || text.slice(0, maxLength).trim();
  }

  private uniqueMemories(
    memories: DeepAnalysisMemorySnapshot[],
  ): DeepAnalysisMemorySnapshot[] {
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
    return value.replace(
      /^\s*[\w\s\u3040-\u30ff\u4e00-\u9fff-]{1,24}\s*[:：]\s*/u,
      '',
    );
  }

  private cleanText(value: string): string {
    return value.replace(/\s+/gu, ' ').trim();
  }

  private normalizeKey(value: string): string {
    return this.cleanText(value).toLowerCase();
  }
}
