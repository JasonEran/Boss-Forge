import { describe, expect, it, vi } from 'vitest';
import { planBossRecommendationFilters, type ParsedCandidate } from '@boss-forge/contracts';
import { parseRuleConfig } from '@boss-forge/data';
import { evaluateCandidate } from './index.js';

const card: ParsedCandidate = { index: 1, source: 'recommend', name: '学历解析样本',
  fields: { 信息: '23岁 / 1年 / 本科 / 离职-随时到岗' }, evidence: [], raw: '候选人卡片' };
const rule = parseRuleConfig({ schemaVersion: '1.0', screeningFlow: 'boss_then_resume',
  bossRecommendationFilters: { mode: 'custom', fields: { degree: ['本科'], experience: ['在校/应届', '1-3年'] } },
  root: { operator: 'AND', children: [
    { type: 'english_credential', accepted: ['tem8'], mode: 'any', minimumConfidence: 0.86, unknownPolicy: 'fail' },
    { type: 'range', field: 'graduationYear', maximum: 2026, unknownPolicy: 'fail' }
  ] }
});
const evaluate = (text: string) => evaluateCandidate(card, rule, text, [], planBossRecommendationFilters(rule));

describe('graduation screening with historical campus descriptions', () => {
  it.each([
    ['教育经历\n示范农业大学商务英语本科\n2021-2025\n省部共建\n在校经历:\n我在学校热情开朗，活泼大方\n毕设/论文:\n商务谈判分析\n社团经历\n志愿服务 2022.09-至今', '2025'],
    ['教育经历\n示范大学英语本科\n2019-2023\n在校经历:\n大学生职业生涯发展中心部长\n2021-2022', '2023'],
    ['教育经历\n示范大学英语本科\n2017-2021\n985院校\nQS世界大学排名TOP500', '2021']
  ])('uses the school period and preserves other required conditions', (text, year) => {
    const result = evaluate(text + '\n资格证书\n英语专业八级');
    expect(result.decision).toBe('matched');
    expect(result.evidence.find(item => item.capabilityId === 'range.graduationYear'))
      .toMatchObject({ normalizedAlias: year, status: 'positive' });
    expect(evaluate(text).decision).toBe('not_matched');
  });

  it.each(['2023-2027', '2022-至今'])('keeps a future or ongoing degree unresolved or ineligible: %s', period => {
    expect(evaluate(`工作经历\n示例公司 2020-至今\n教育经历\n示范大学本科\n${period}\n在校经历:\n活动描述\n资格证书\n英语专业八级`).decision).toBe('not_matched');
  });

  it('does not treat historical campus headings as a current student status', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-11T12:00:00Z'));
    try {
      const experienced = parseRuleConfig({schemaVersion:'1.0',root:{operator:'AND',children:[
        {type:'graduate_status',values:['experienced'],mode:'any',unknownPolicy:'fail'}
      ]}});
      const result = evaluateCandidate(card, experienced,
        '教育经历\n示范大学本科\n2021-2025\n在校经历:\n我在学校热情开朗\n在校表现:\n在读期间参加比赛');
      expect(result.decision).toBe('matched');
      expect(result.evidence[0]).toMatchObject({normalizedAlias:'experienced'});
      expect(evaluateCandidate(card, experienced, '教育经历\n示范大学硕士\n2024-至今').decision).toBe('not_matched');
    } finally { vi.useRealTimers(); }
  });
});
