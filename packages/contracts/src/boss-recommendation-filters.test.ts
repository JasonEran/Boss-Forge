import { describe, expect, it } from 'vitest';
import { bossRecommendationFilterConfigSchema, planBossRecommendationFilters, sameBossFilterFields, describeBossFilters, unavailableBossSelections } from './boss-recommendation-filters.js';
const degree = (minimum: string) => ({ type: 'education_level', minimum, unknownPolicy: 'manual_review' });
const plan = (...children: unknown[]) => planBossRecommendationFilters({ root: { operator: 'AND', children } });
describe('official recommendation filter planning', () => {
  it('includes every higher degree and intersects mandatory education conditions', () => {
    expect(plan(degree('high_school')).fields.degree).toContain('中专/中技');
    expect(plan(degree('bachelor')).fields.degree).toEqual(['本科', '硕士', '博士']);
    expect(plan(degree('bachelor'), { type: 'all', children: [degree('master')] }).fields.degree).toEqual(['硕士', '博士']);
  });
  it('does not narrow OR/NOT branches or conditions that explicitly allow unknowns', () => {
    expect(plan({ operator: 'OR', children: [degree('doctor'), { type: 'keyword' }] }, { operator: 'NOT', children: [degree('master')] }, { ...degree('bachelor'), unknownPolicy: 'ignore' }).fields).toEqual({});
  });
  it('includes overlapping experience bands but leaves mixed student/worker cases local', () => {
    expect(plan({ type: 'range', field: 'yearsOfExperience', minimum: 2, maximum: 4 }).fields.experience).toEqual(['1-3年', '3-5年']);
    expect(plan({ type: 'range', field: 'yearsOfExperience', maximum: 2 }).fields).toEqual({});
    expect(plan({ type: 'range', field: 'yearsOfExperience', minimum: 10 }).fields.experience).toEqual(['5-10年', '10年以上']);
  });
  it('leaves certificates and sensitive personal traits out of automatic filters', () => {
    expect(plan({ type: 'english_credential', accepted: ['tem8'] }, { type: 'enum', field: 'gender', values: ['female'] }, { type: 'range', field: 'age', maximum: 30 }).fields).toEqual({});
  });
  it('honors explicit custom and unlimited modes without deriving extra constraints', () => {
    expect(planBossRecommendationFilters({ root: { operator: 'AND', children: [degree('doctor')] }, bossRecommendationFilters: { mode: 'custom', fields: { degree: ['本科'], activation: ['今日活跃'] } } }).fields).toEqual({ degree: ['本科'], activation: ['今日活跃'] });
    expect(planBossRecommendationFilters({ bossRecommendationFilters: { mode: 'off', fields: { degree: ['博士'] } } }).fields).toEqual({});
  });
  it('rejects unsupported fields, duplicate choices and multiple single-choice values', () => {
    for (const fields of [{ unknownFilter: ['未知'] }, { age: ['25'] }, { degree: ['本科', '本科'] }, { activation: ['今日活跃', '本周活跃'] }]) expect(bossRecommendationFilterConfigSchema.safeParse({ mode: 'custom', fields }).success).toBe(false);
  });
});

describe('complete VIP filter configuration', () => {
  it('saves every new field and preserves it in the immutable task plan', () => {
    const fields = { age: ['22', '35'], gender: ['男'], intention: ['离职-随时到岗'], salary: ['5-10K'], switchJobFrequency: ['5年少于3份'], exchangeResumeWithColleague: ['近一个月没有'], firstDegree: ['仅看第一学历'] };
    const config = bossRecommendationFilterConfigSchema.parse({mode:'custom', fields});
    expect(planBossRecommendationFilters({bossRecommendationFilters:config}).fields).toEqual(fields);
    expect(describeBossFilters({version:1, ...config})).toContain('年龄：22～35');
    expect(sameBossFilterFields({age:['22','35']}, {age:['22','不限']})).toBe(false);
    expect(sameBossFilterFields({salary:['5-10K']}, {})).toBe(false);
  });
  it('rejects inverted ranges, malformed bounds and multiple native single-choice values', () => {
    for (const fields of [{age:['35','22']}, {age:['22','NaN']}, {age:['22']}, {salary:['5-10K','10-20K']}, {firstDegree:['A','B']}]) {
      expect(bossRecommendationFilterConfigSchema.safeParse({mode:'custom',fields}).success).toBe(false);
    }
    expect(bossRecommendationFilterConfigSchema.safeParse({mode:'custom',fields:{age:['22','不限']}}).success).toBe(true);
  });
  it('validates every field against complete snapshots and surfaces native conflicts', () => {
    const snapshot = {bossJobId:'job',bossJobName:'岗位',fetchedAt:new Date().toISOString(), fields:{salary:['5-10K'],experience:['在校/应届','1-3年']}, definitions:[
      {key:'salary' as const,label:'薪资待遇',kind:'single' as const,source:'normal' as const,available:true,maxSelected:1},
      {key:'experience' as const,label:'经验',kind:'multiple' as const,source:'normal' as const,available:true,maxSelected:2},
    ],conflicts:[{field:'experience' as const,option:'在校/应届',targets:[{field:'experience' as const,options:['1-3年']}]}]};
    expect(unavailableBossSelections({salary:['20-50K'],school:['985']}, snapshot)).toHaveLength(2);
    expect(unavailableBossSelections({experience:['在校/应届','1-3年']}, snapshot)[0]).toContain('不能同时选择');
    const config = bossRecommendationFilterConfigSchema.parse({mode:'custom',fields:{salary:['5-10K']},optionsSnapshot:snapshot});
    expect(config.optionsSnapshot).toEqual(snapshot);
    expect(planBossRecommendationFilters({bossRecommendationFilters:config})).not.toHaveProperty('optionsSnapshot');
  });
});
