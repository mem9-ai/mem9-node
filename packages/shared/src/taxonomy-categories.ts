import { ANALYSIS_CATEGORIES, type AnalysisCategory, type TaxonomyRuleDefinition } from '@mem9/contracts';

const CATEGORY_PRIORITY_ORDER = [
  'policy',
  'privacy_safety',
  'incident_risk',
  'status_metric',
  'system_config',
  'environment_runtime',
  'artifact',
  'command_tool',
  'deployment',
  'debugging',
  'coding',
  'automation',
  'communication',
  'collaboration',
  'plan',
  'decision',
  'project',
  'learning',
  'task',
  'activity',
  'schedule',
  'relationship',
  'profile',
  'identity',
  'preference',
  'emotion',
  'health_wellbeing',
  'life_log',
  'experience',
] as const satisfies readonly AnalysisCategory[];

const CATEGORY_PRIORITY_INDEX = new Map<AnalysisCategory, number>(
  CATEGORY_PRIORITY_ORDER.map((category, index) => [category, index]),
);

const DEFAULT_FALLBACK_CATEGORIES = ['task', 'activity', 'project', 'experience'] as const;

function firstAvailableCategory(
  categories: readonly AnalysisCategory[],
  candidates: readonly AnalysisCategory[],
): AnalysisCategory | undefined {
  return candidates.find((candidate) => categories.includes(candidate));
}

function categoryPriority(category: AnalysisCategory, positions?: Map<AnalysisCategory, number>): number {
  return CATEGORY_PRIORITY_INDEX.get(category) ?? (CATEGORY_PRIORITY_ORDER.length + (positions?.get(category) ?? 0));
}

export function compareCategoryPriority(
  left: AnalysisCategory,
  right: AnalysisCategory,
  positions?: Map<AnalysisCategory, number>,
): number {
  return categoryPriority(left, positions) - categoryPriority(right, positions) || left.localeCompare(right);
}

export function sortTaxonomyCategories(categories: readonly AnalysisCategory[]): AnalysisCategory[] {
  const uniqueCategories = [...new Set(categories)];
  const positions = new Map(uniqueCategories.map((category, index) => [category, index] as const));

  return [...uniqueCategories].sort((left, right) => compareCategoryPriority(left, right, positions));
}

export function deriveTaxonomyCategories(
  rules: readonly Pick<TaxonomyRuleDefinition, 'category'>[],
): AnalysisCategory[] {
  const categories = rules.map((rule) => rule.category);
  return categories.length > 0 ? sortTaxonomyCategories(categories) : [...ANALYSIS_CATEGORIES];
}

export function selectDefaultCategory(categories: readonly AnalysisCategory[]): AnalysisCategory {
  return firstAvailableCategory(categories, DEFAULT_FALLBACK_CATEGORIES) ?? categories[0] ?? 'task';
}

export function inferFallbackCategory(tokens: string[], categories: readonly AnalysisCategory[]): AnalysisCategory {
  const joined = tokens.join(' ');

  if (/(feel|feeling|happy|sad|angry|anxious|upset|焦虑|开心|难过|生气|烦躁)/iu.test(joined)) {
    return firstAvailableCategory(categories, ['emotion']) ?? selectDefaultCategory(categories);
  }

  if (/(burnout|burned out|tired|sleep|rest|recover|累|疲惫|休息|恢复)/iu.test(joined)) {
    return firstAvailableCategory(categories, ['health_wellbeing', 'emotion']) ?? selectDefaultCategory(categories);
  }

  if (/(喜欢|偏好|prefer|favorite|like|dislike|style|format|language)/iu.test(joined)) {
    return firstAvailableCategory(categories, ['preference']) ?? selectDefaultCategory(categories);
  }

  if (/(规则|策略|必须|禁止|不要|rule|policy|must|should|do not|never|only if)/iu.test(joined)) {
    return firstAvailableCategory(categories, ['policy', 'privacy_safety']) ?? selectDefaultCategory(categories);
  }

  if (/(隐私|内部使用|团队可见|权限|privacy|internal-only|visibility|permission|safety)/iu.test(joined)) {
    return firstAvailableCategory(categories, ['privacy_safety', 'policy']) ?? selectDefaultCategory(categories);
  }

  if (/(计划|下一步|待做|roadmap|next step|todo|upcoming|plan)/iu.test(joined)) {
    return firstAvailableCategory(categories, ['plan']) ?? selectDefaultCategory(categories);
  }

  if (/(决定|选择|取舍|decision|tradeoff|option|choose)/iu.test(joined)) {
    return firstAvailableCategory(categories, ['decision', 'plan']) ?? selectDefaultCategory(categories);
  }

  if (/(今天|明天|weekly|daily|deadline|schedule|cron|每周|截止)/iu.test(joined)) {
    return firstAvailableCategory(categories, ['schedule', 'plan']) ?? selectDefaultCategory(categories);
  }

  if (/(发送|回复|消息|通知|message|reply|notify|preview)/iu.test(joined)) {
    return firstAvailableCategory(categories, ['communication', 'collaboration']) ?? selectDefaultCategory(categories);
  }

  if (/(协作|评审|交接|reviewer|handoff|group chat|同步团队)/iu.test(joined)) {
    return firstAvailableCategory(categories, ['collaboration', 'communication']) ?? selectDefaultCategory(categories);
  }

  if (/(我是|name is|姓名|角色|职业|timezone|utc\+8|working hours|北京时间)/iu.test(joined)) {
    return firstAvailableCategory(categories, ['profile', 'identity']) ?? selectDefaultCategory(categories);
  }

  if (/(主人|负责人|团队|群|员工|owner|maintainer|manager|team|group|employee)/iu.test(joined)) {
    return firstAvailableCategory(categories, ['relationship', 'profile']) ?? selectDefaultCategory(categories);
  }

  if (/(学习|阅读|研究|调研|文档|learn|study|read|research|docs)/iu.test(joined)) {
    return firstAvailableCategory(categories, ['learning']) ?? selectDefaultCategory(categories);
  }

  if (/(调试|修复|报错|错误|排查|故障|root cause|bug|issue|error|fix|debug|investigate|triage)/iu.test(joined)) {
    return firstAvailableCategory(categories, ['debugging', 'coding']) ?? selectDefaultCategory(categories);
  }

  if (/(部署|发布|上线|回滚|deploy|release|launch|rollback)/iu.test(joined)) {
    return firstAvailableCategory(categories, ['deployment']) ?? selectDefaultCategory(categories);
  }

  if (/(自动化|定时|备份|心跳|导入|导出|backup|heartbeat|sync|index|import|export)/iu.test(joined)) {
    return firstAvailableCategory(categories, ['automation']) ?? selectDefaultCategory(categories);
  }

  if (/(代码|开发|函数|接口|schema|typescript|sql|prisma|patch|api|worker|code)/iu.test(joined)) {
    return firstAvailableCategory(categories, ['coding', 'task']) ?? selectDefaultCategory(categories);
  }

  if (/(配置|参数|环境变量|密钥|dsn|allowlist|setting|config|env|secrets)/iu.test(joined)) {
    return firstAvailableCategory(categories, ['system_config', 'artifact']) ?? selectDefaultCategory(categories);
  }

  if (/(\.openclaw|\.clawhub|workspace-state|runtime|session|ec2|ssh|workspace|local state)/iu.test(joined)) {
    return firstAvailableCategory(categories, ['environment_runtime', 'artifact']) ?? selectDefaultCategory(categories);
  }

  if (/(python3|node|pnpm|mysql|git|command|cli|script runner)/iu.test(joined)) {
    return firstAvailableCategory(categories, ['command_tool', 'artifact']) ?? selectDefaultCategory(categories);
  }

  if (/(文件|路径|仓库|分支|提交|脚本|repo|branch|commit|file|path|\.json|\.sql|\.toml|skill\.md)/iu.test(joined)) {
    return firstAvailableCategory(categories, ['artifact']) ?? selectDefaultCategory(categories);
  }

  if (/(状态|结果|计数|快照|版本|流量|chart|pv|uv|count|status|result|snapshot|version)/iu.test(joined)) {
    return firstAvailableCategory(categories, ['status_metric']) ?? selectDefaultCategory(categories);
  }

  if (/(事故|风险|告警|异常|incident|risk|alert|outage|degraded)/iu.test(joined)) {
    return firstAvailableCategory(categories, ['incident_risk', 'status_metric']) ?? selectDefaultCategory(categories);
  }

  if (/(生活|旅行|餐厅|跑步|做饭|雍和宫|daily life|travel|restaurant|running|cooking)/iu.test(joined)) {
    return firstAvailableCategory(categories, ['life_log', 'experience']) ?? selectDefaultCategory(categories);
  }

  if (/(经历过|参加了|去过|第一次|tried|attended|went to|first time)/iu.test(joined)) {
    return firstAvailableCategory(categories, ['experience', 'life_log']) ?? selectDefaultCategory(categories);
  }

  return selectDefaultCategory(categories);
}
