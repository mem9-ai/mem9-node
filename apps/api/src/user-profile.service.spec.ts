import type { DeepAnalysisMemorySnapshot } from '@mem9/contracts';

import type { Mem9RequestContext } from './common/request-context';
import type { Mem9SourceService } from './mem9-source.service';
import { UserProfileService } from './user-profile.service';

function memory(
  id: string,
  content: string,
  memoryType: string,
  metadata: Record<string, unknown> = {},
  tags: string[] = [],
  createdAt = '2026-06-26T00:00:00.000Z',
): DeepAnalysisMemorySnapshot {
  return {
    id,
    content,
    createdAt,
    memoryType,
    metadata,
    tags,
  };
}

function createContext(): Mem9RequestContext {
  return {
    requestId: 'request-1',
    rawApiKey: 'test-api-key',
    apiKeyFingerprint: Buffer.from('fingerprint'),
    apiKeyFingerprintHex: '66696e6765727072696e74',
  };
}

describe('user profile service', () => {
  it('builds the profile page model only from fact, insight, and pinned memories', async () => {
    const source = {
      fetchProfileMemories: jest.fn(async () => [
        memory('trait', '用户是一个理性、好奇心强且有成长驱动力的人。', 'pinned'),
        memory('preference', '用户偏好直接、具体、可执行的建议。', 'insight'),
        memory('dislike', '用户不喜欢空泛建议和说教式表达。', 'fact'),
        memory('work-style', '用户做事风格偏结构化，重视顺序推进和可持续。', 'insight'),
        memory('priority', '当前优先事项：KET 备考与健康管理', 'fact', {
          title: 'KET 备考与健康管理',
          confidence: 0.95,
        }),
        memory('style', '喜欢的陪伴方式：直接、具体、少说教', 'insight', {
          title: '直接、具体、少说教',
        }),
        memory('constraint', '对机器人的约束：不要给空泛建议，必须基于 facts 和 insights。', 'fact', {
          title: '避免空泛建议',
        }),
        memory('session', '当前对话里随口提到的内容不应该进入画像。', 'session', {
          title: '不应出现',
        }),
      ]),
    } satisfies Pick<Mem9SourceService, 'fetchProfileMemories'>;
    const service = new UserProfileService(source as unknown as Mem9SourceService);

    const result = await service.getProfile(createContext());

    expect(result.source).toEqual({
      memoryTypes: ['fact', 'insight', 'pinned'],
      memoryCount: 7,
    });
    expect(result.summary.text.length).toBeLessThanOrEqual(100);
    expect(result.summary.text).toContain('你是一位');
    expect(result.summary.text).toContain('目标驱动');
    expect(result.summary.text).toContain('落地');
    expect(result.summary.message).toBeUndefined();
    expect(result.summary.text).not.toContain('整体画像');
    expect(result.summary.text).not.toContain('不喜欢：');
    expect(result.summary.text).not.toContain('当前优先事项');
    expect(result.summary.text).not.toContain('喜欢的陪伴方式');
    expect(result.summary.text).not.toContain('对机器人的约束');
    expect(result.attributes).toEqual([]);
    expect(result.changes).toEqual([]);
    expect(result).not.toHaveProperty('relationships');
    expect(result.items.map((item) => item.kind)).toEqual(
      expect.arrayContaining([
        'current_priority',
        'companion_style',
        'robot_constraint',
      ]),
    );
    expect(JSON.stringify(result)).not.toContain('不应出现');
  });

  it('limits each profile item kind to top 10', async () => {
    const sourceMemories: DeepAnalysisMemorySnapshot[] = [];

    for (let index = 0; index < 12; index += 1) {
      sourceMemories.push(memory(`p-${index}`, `当前优先事项：任务 ${index}`, 'fact', {
        title: `任务 ${index}`,
        importance: 1 + index,
      }));
      sourceMemories.push(memory(`s-${index}`, `喜欢的陪伴方式：方式 ${index}`, 'insight', {
        title: `方式 ${index}`,
        importance: 1 + index,
      }));
      sourceMemories.push(memory(`c-${index}`, `对机器人的约束：约束 ${index}`, 'fact', {
        title: `约束 ${index}`,
        importance: 1 + index,
      }));
    }

    const source = {
      fetchProfileMemories: jest.fn(async () => sourceMemories),
    } satisfies Pick<Mem9SourceService, 'fetchProfileMemories'>;
    const service = new UserProfileService(source as unknown as Mem9SourceService);

    const result = await service.getProfile(createContext());

    expect(result.items.filter((item) => item.kind === 'current_priority')).toHaveLength(10);
    expect(result.items.filter((item) => item.kind === 'companion_style')).toHaveLength(1);
    expect(result.items.filter((item) => item.kind === 'robot_constraint')).toHaveLength(10);
  });

  it('does not classify career planning requirements as robot constraints', async () => {
    const source = {
      fetchProfileMemories: jest.fn(async () => [
        memory(
          'career-plan',
          '如果明年想换一个更偏法务方向的岗位，律师资格证可能是必须补上的能力',
          'insight',
        ),
      ]),
    } satisfies Pick<Mem9SourceService, 'fetchProfileMemories'>;
    const service = new UserProfileService(source as unknown as Mem9SourceService);

    const result = await service.getProfile(createContext());

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      kind: 'current_priority',
    });
    expect(result.items.filter((item) => item.kind === 'robot_constraint')).toHaveLength(0);
  });

  it('does not classify project facts or competitor references as companion styles', async () => {
    const source = {
      fetchProfileMemories: jest.fn(async () => [
        memory('prd', "User is working on a PRD for mem9, specifically the 'Long-term Memory Governance and User Understanding Visualization' scheme", 'insight'),
        memory('boost', 'mem9 implements Tag boost and Topic boost as recall weighting strategies', 'insight'),
        memory('mem0', "Mem0 is considered a direct competitor/reference for mem9's long-term memory extraction, update, recall, and CRUD APIs", 'insight'),
        memory('style', '用户偏好助手直接给结论，建议具体、少说教。', 'insight'),
      ]),
    } satisfies Pick<Mem9SourceService, 'fetchProfileMemories'>;
    const service = new UserProfileService(source as unknown as Mem9SourceService);

    const result = await service.getProfile(createContext());
    const companionItems = result.items.filter((item) => item.kind === 'companion_style');

    expect(companionItems).toHaveLength(1);
    expect(companionItems[0]!.title).toBe('目标导向陪伴');
    expect(companionItems[0]!.summary).toContain('简洁直接');
    expect(companionItems[0]!.summary).toContain('可执行建议');
    expect(companionItems.map((item) => `${item.title} ${item.summary}`).join(' ')).not.toContain('用户偏好助手直接给结论');
    expect(JSON.stringify(companionItems)).not.toContain('PRD');
    expect(JSON.stringify(companionItems)).not.toContain('Tag boost');
    expect(JSON.stringify(companionItems)).not.toContain('Mem0');
  });

  it('does not classify demo folder or file operation memories as companion styles', async () => {
    const source = {
      fetchProfileMemories: jest.fn(async () => [
        memory(
          'demo-folder',
          'User created a demo folder zep-graph-demo at /Users/yj/pingcap/mem9/zep-graph-demo containing README.md, .env.example, requirements.txt, seed_zep_graph_demo.py. The demo script creates a demo user and thread, writes KET exam prep data, companion style preferences, and focus changes to Zep via the Zep Cloud SDK.',
          'insight',
        ),
        memory('style', '用户偏好助手直接给结论，建议具体、少说教。', 'insight'),
      ]),
    } satisfies Pick<Mem9SourceService, 'fetchProfileMemories'>;
    const service = new UserProfileService(source as unknown as Mem9SourceService);

    const result = await service.getProfile(createContext());
    const companionItems = result.items.filter((item) => item.kind === 'companion_style');

    expect(companionItems).toHaveLength(1);
    expect(companionItems[0]!.title).toBe('目标导向陪伴');
    expect(companionItems[0]!.summary).toContain('简洁直接');
    expect(JSON.stringify(companionItems)).not.toContain('zep-graph-demo');
    expect(JSON.stringify(companionItems)).not.toContain('README.md');
    expect(JSON.stringify(companionItems)).not.toContain('/Users/yj');
  });

  it('summarizes companion style as a goal-oriented support strategy', async () => {
    const source = {
      fetchProfileMemories: jest.fn(async () => [
        memory('goal-style', '用户偏好目标导向、主动跟进型陪伴，而非情绪安慰型。', 'insight'),
        memory('planning', '希望 AI 帮助制定计划、拆解任务、记录进展、定期提醒和复盘。', 'fact'),
        memory('communication', '交流风格简洁直接，重视可执行建议、数据反馈和长期陪伴。', 'insight'),
        memory('adjustment', '期待 AI 能记住目标并根据进度动态调整计划。', 'pinned'),
      ]),
    } satisfies Pick<Mem9SourceService, 'fetchProfileMemories'>;
    const service = new UserProfileService(source as unknown as Mem9SourceService);

    const result = await service.getProfile(createContext());
    const companionItems = result.items.filter((item) => item.kind === 'companion_style');

    expect(companionItems).toHaveLength(1);
    expect(companionItems[0]).toMatchObject({
      title: '目标导向陪伴',
    });
    expect(companionItems[0]!.summary.length).toBeLessThanOrEqual(150);
    expect(companionItems[0]!.summary).toContain('目标导向');
    expect(companionItems[0]!.summary).toContain('主动跟进');
    expect(companionItems[0]!.summary).toContain('制定计划、拆解任务、记录进展、定期提醒和复盘');
    expect(companionItems[0]!.summary).toContain('动态调整计划');
  });

  it('abstracts important constraints from long-term preferences and background', async () => {
    const source = {
      fetchProfileMemories: jest.fn(async () => [
        memory('style', '用户偏好直接给结论，结构化输出，避免空泛建议和重复背景。', 'insight'),
        memory('evidence', '对机器人的约束：重要判断必须基于 facts 和 insights，不要编造。', 'fact'),
        memory('background', '用户长期关注 AI Agent、Memory、React 和 TypeScript 工程实践。', 'pinned'),
        memory('goal', '用户持续推进英语学习、健康减脂和家庭教育计划。', 'insight'),
      ]),
    } satisfies Pick<Mem9SourceService, 'fetchProfileMemories'>;
    const service = new UserProfileService(source as unknown as Mem9SourceService);

    const result = await service.getProfile(createContext());
    const constraintItems = result.items.filter((item) => item.kind === 'robot_constraint');

    expect(constraintItems.map((item) => item.title)).toEqual(expect.arrayContaining([
      '避免空泛冗长',
      '基于证据回答',
      '结合长期背景',
      '衔接长期目标',
    ]));
    expect(constraintItems.map((item) => `${item.title} ${item.summary}`).join(' ')).not.toContain('对机器人的约束：');
    expect(constraintItems.map((item) => `${item.title} ${item.summary}`).join(' ')).not.toContain('用户长期关注 AI Agent');
  });

  it('does not use current priority style memories as the persona summary', async () => {
    const source = {
      fetchProfileMemories: jest.fn(async () => [
        memory('bad-summary', '用户画像总结：用户当前重视 KET 备考和健康管理。', 'insight'),
        memory('trait', '用户是一个偏理性、重视稳定成长的人。', 'pinned'),
      ]),
    } satisfies Pick<Mem9SourceService, 'fetchProfileMemories'>;
    const service = new UserProfileService(source as unknown as Mem9SourceService);

    const result = await service.getProfile(createContext());

    expect(result.summary.text).toContain('偏理性、重视稳定成长的人');
    expect(result.summary.text).not.toContain('KET 备考');
  });

  it('abstracts sustained priorities instead of listing current priorities in the persona summary', async () => {
    const source = {
      fetchProfileMemories: jest.fn(async () => [
        memory('priority', '当前优先事项：KET 备考与健康管理', 'fact'),
      ]),
    } satisfies Pick<Mem9SourceService, 'fetchProfileMemories'>;
    const service = new UserProfileService(source as unknown as Mem9SourceService);

    const result = await service.getProfile(createContext());

    expect(result.summary.text).toBe('你是一位目标驱动的长期成长型用户，持续推进英语学习、健康管理');
    expect(result.summary.message).toBe('当前可用画像信息较少，已根据现有 facts、insights 和 pinned 生成初步总结，但画像可能不稳定。');
    expect(result.summary.evidence).toHaveLength(1);
  });

  it('summarizes sparse profile signals and warns that the profile may be unstable', async () => {
    const source = {
      fetchProfileMemories: jest.fn(async () => [
        memory('trait', '用户是一个偏理性、重视稳定成长的人。', 'pinned'),
      ]),
    } satisfies Pick<Mem9SourceService, 'fetchProfileMemories'>;
    const service = new UserProfileService(source as unknown as Mem9SourceService);

    const result = await service.getProfile(createContext());

    expect(result.summary.text).toContain('整体画像：一个偏理性、重视稳定成长的人');
    expect(result.summary.message).toBe('当前可用画像信息较少，已根据现有 facts、insights 和 pinned 生成初步总结，但画像可能不稳定。');
    expect(result.summary.evidence).toHaveLength(1);
  });

  it('synthesizes profile attributes into a natural language summary', async () => {
    const source = {
      fetchProfileMemories: jest.fn(async () => [
        memory('interest', '长期兴趣：对五月天演唱会有点兴趣，但还没到非去不可的程度', 'fact', {
          attributeKind: 'long_term_interest',
          value: '对五月天演唱会有点兴趣，但还没到非去不可的程度',
        }),
        memory('skill', '专业技能：用户长期从事法务相关工作，持续补充法律与合规能力', 'insight', {
          attributeKind: 'professional_skill',
          value: '长期从事法务相关工作，持续补充法律与合规能力',
        }),
        memory('goal', '长期目标：目标是今年下半年通过英语六级考试', 'pinned', {
          attributeKind: 'long_term_goal',
          value: '今年下半年通过英语六级考试',
        }),
        memory('communication', '沟通风格：用户更喜欢直接给结论，回答尽量简洁高效，不要绕太多背景', 'fact', {
          attributeKind: 'communication_style',
          value: '直接给结论，回答尽量简洁高效，不要绕太多背景',
        }),
      ]),
    } satisfies Pick<Mem9SourceService, 'fetchProfileMemories'>;
    const service = new UserProfileService(source as unknown as Mem9SourceService);

    const result = await service.getProfile(createContext());

    expect(result.summary.text.length).toBeLessThanOrEqual(100);
    expect(result.summary.text).toBe('你是一位目标驱动的长期成长型用户，目标驱动，偏好结构化、直接且可执行的协作方式，持续推进英语学习');
    expect(result.summary.text).not.toContain('长期兴趣：');
    expect(result.summary.text).not.toContain('专业技能：');
  });

  it('builds an abstract persona summary from work domains, style, and sustained plans', async () => {
    const source = {
      fetchProfileMemories: jest.fn(async () => [
        memory('frontend', '用户是前端开发工程师，长期使用 React + TypeScript 做工程实践。', 'pinned'),
        memory('ai-product', '用户长期关注 AI、用户画像、Memory、Agent 等方向，并推进 mem9 产品设计。', 'insight'),
        memory('work-style', '用户习惯系统化思考，会把复杂问题拆解成可落地方案。', 'insight'),
        memory('efficiency', '用户重视效率、自动化和可复用性，偏好直接结论和可执行建议。', 'fact'),
        memory('english', '当前优先事项：持续推进英语学习和 KET 备考计划。', 'fact'),
        memory('health', '当前优先事项：健康减脂、饮食控制和步数目标。', 'fact'),
        memory('family', '当前优先事项：家庭教育相关计划。', 'fact'),
      ]),
    } satisfies Pick<Mem9SourceService, 'fetchProfileMemories'>;
    const service = new UserProfileService(source as unknown as Mem9SourceService);

    const result = await service.getProfile(createContext());

    expect(result.summary.text.length).toBeLessThanOrEqual(100);
    expect(result.summary.text).toContain('AI 产品与前端工程实践者');
    expect(result.summary.text).toContain('AI、用户画像、Memory、Agent');
    expect(result.summary.text).toContain('系统化');
    expect(result.summary.text).toContain('英语学习');
    expect(result.summary.text).not.toContain('当前优先事项');
    expect(result.summary.text).not.toContain('整体画像');
  });

  it('keeps one-off facts out of the persona summary but keeps stable tool habits', async () => {
    const source = {
      fetchProfileMemories: jest.fn(async () => [
        memory('docker-today', '今天安装 Docker。', 'fact'),
        memory('docker-habit', '用户经常使用 Docker 进行开发。', 'insight'),
      ]),
    } satisfies Pick<Mem9SourceService, 'fetchProfileMemories'>;
    const service = new UserProfileService(source as unknown as Mem9SourceService);

    const result = await service.getProfile(createContext());

    expect(result.summary.text).toContain('Docker 进行开发');
    expect(result.summary.text).not.toContain('今天安装');
    expect(result.summary.text.length).toBeLessThanOrEqual(100);
  });

  it('does not summarize product PRD module lists as the user persona', async () => {
    const source = {
      fetchProfileMemories: jest.fn(async () => [
        memory(
          'prd',
          'The mem9 PRD covers modules including profile projection, memory map, confirmation/correction, memory governance, report templates, and periodic observation reports.',
          'insight',
        ),
      ]),
    } satisfies Pick<Mem9SourceService, 'fetchProfileMemories'>;
    const service = new UserProfileService(source as unknown as Mem9SourceService);

    const result = await service.getProfile(createContext());

    expect(result.summary.text).toBe('');
    expect(result.summary.evidence).toHaveLength(0);
  });

  it('does not treat profile product design notes as the overall persona', async () => {
    const source = {
      fetchProfileMemories: jest.fn(async () => [
        memory(
          'profile-design',
          'User designed an interaction mechanism for initializing profiles and clarifying facts, involving progressive confirmation and trust authorization after fact verification within Codex.',
          'insight',
        ),
        memory('diet', 'User follows a diet principle of protein plus large amounts of vegetables and moderate carbohydrates per meal.', 'insight', {}, ['diet', 'habit']),
        memory('avoid-drinks', 'User avoids sugary drinks, alcohol, and milk tea.', 'insight', {}, ['diet', 'preference']),
      ]),
    } satisfies Pick<Mem9SourceService, 'fetchProfileMemories'>;
    const service = new UserProfileService(source as unknown as Mem9SourceService);

    const result = await service.getProfile(createContext());

    expect(result.summary.text).toContain('不喜欢');
    expect(result.summary.text).toContain('sugary drinks');
    expect(result.summary.text).not.toContain('User designed');
    expect(result.summary.text).not.toContain('initializing profiles');
    expect(result.summary.text.length).toBeLessThanOrEqual(100);
  });

  it('does not summarize memory framework references as the user persona', async () => {
    const source = {
      fetchProfileMemories: jest.fn(async () => [
        memory(
          'letta',
          'Letta/MemGPT is referenced for agent memory partitioning concepts (persona, human, archival, recall).',
          'insight',
        ),
      ]),
    } satisfies Pick<Mem9SourceService, 'fetchProfileMemories'>;
    const service = new UserProfileService(source as unknown as Mem9SourceService);

    const result = await service.getProfile(createContext());

    expect(result.summary.text).toBe('');
    expect(result.summary.evidence).toHaveLength(0);
    expect(JSON.stringify(result.summary)).not.toContain('整体画像');
    expect(JSON.stringify(result.summary)).not.toContain('Letta/MemGPT');
  });
});
