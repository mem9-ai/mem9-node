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
        memory('relationship', '重要关系：女儿对用户很重要', 'fact', {
          person: '女儿',
          relation: '家人',
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
      memoryCount: 8,
    });
    expect(result.summary.text).toContain('做事上更偏向做事风格偏结构化，重视顺序推进和可持续。');
    expect(result.summary.text).toContain('沟通偏效率型，更希望直接、具体、可执行的建议。');
    expect(result.summary.message).toBe('当前可用画像信息较少，已根据现有 facts、insights 和 pinned 生成初步总结，但画像可能不稳定。');
    expect(result.summary.text).not.toContain('当前优先事项');
    expect(result.summary.text).not.toContain('对机器人的约束');
    expect(result.attributes).toEqual([]);
    expect(result.changes).toEqual([]);
    expect(result.items.map((item) => item.kind)).toEqual(
      expect.arrayContaining([
        'current_priority',
        'companion_style',
        'robot_constraint',
      ]),
    );
    expect(result.relationships).toHaveLength(1);
    expect(result.relationships[0]).toMatchObject({
      name: '女儿',
      relation: '家人',
    });
    expect(JSON.stringify(result)).not.toContain('不应出现');
  });

  it('limits relationships and each profile item kind to top 10', async () => {
    const sourceMemories: DeepAnalysisMemorySnapshot[] = [];

    for (let index = 0; index < 12; index += 1) {
      sourceMemories.push(memory(`r-${index}`, `重要关系：朋友 ${index} 与用户联系密切`, 'fact', {
        person: `朋友 ${index}`,
        relation: '朋友',
        importance: 1 + index,
      }));
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

    expect(result.relationships).toHaveLength(10);
    expect(result.items.filter((item) => item.kind === 'current_priority')).toHaveLength(10);
    expect(result.items.filter((item) => item.kind === 'companion_style')).toHaveLength(10);
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

  it('builds a simple fallback summary and keeps instability notices in summary.message', async () => {
    const source = {
      fetchProfileMemories: jest.fn(async () => [
        memory('priority', '当前优先事项：KET 备考与健康管理', 'fact'),
      ]),
    } satisfies Pick<Mem9SourceService, 'fetchProfileMemories'>;
    const service = new UserProfileService(source as unknown as Mem9SourceService);

    const result = await service.getProfile(createContext());

    expect(result.summary.text).toBe('基于现有信息，用户目前体现出：KET 备考与健康管理');
    expect(result.summary.message).toBe('当前 facts、insights 和 pinned 中稳定画像信号较少，已根据现有信息生成初步总结，但画像可能不稳定。');
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
        memory('skill', '专业技能：用户目前只是先了解律师资格证考试科目', 'insight', {
          attributeKind: 'professional_skill',
          value: '目前只是先了解律师资格证考试科目',
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

    expect(result.summary.text).toBe(
      '用户目标导向较明确，长期目标是今年下半年通过英语六级考试。用户会主动关注或补充专业能力，当前涉及目前只是先了解律师资格证考试科目。兴趣上，用户关注对五月天演唱会有点兴趣，但还没到非去不可的程度，整体投入方式较为理性。沟通偏效率型，更希望直接给结论，回答尽量简洁高效，不要绕太多背景。',
    );
    expect(result.summary.text).not.toContain('长期兴趣：');
    expect(result.summary.text).not.toContain('专业技能：');
  });
});
