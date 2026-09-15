import { describe,it,expect } from 'vitest';
import type { RuleConfig, RuleNode } from '@boss-forge/data';
import { communicationQualifications, communicationQualificationSummary } from './communication-qualification.js';
const config:RuleConfig = {schemaVersion:'1.0',root:{operator:'AND',children:[{type:'tem8',minimumConfidence:0.85,unknownPolicy:'fail'}]}};
describe('chat résumé evidence is advisory',()=>{
  it.each([
    ['英语证书：已取得 TEM-8 证书','positive'],
    ['英语专八未通过','negative'],
    ['正在备考专八','unknown'],
    ['英语六级 560 分，英语专业四级','unknown'],
    ['英语能力相当于专八水平','unknown'],
    ['', 'unknown'],
  ])('%s → %s',(text,status)=>{
    const [item]=communicationQualifications(config,text);expect(item!.status).toBe(status);expect(item!.question).toContain('英语');
  });
  it('shows the original excerpt for confirmed certificates',()=>{
    expect(communicationQualifications(config,'已取得 TEM-8 证书')[0]!.evidence.join('')).toContain('TEM-8');
  });
  it('retains OR groups and does not demand every option',()=>{
    const rule:RuleConfig={schemaVersion:'1.0',root:{operator:'OR',children:[{type:'tem8',minimumConfidence:0.85},{type:'english_credential',accepted:['cet6'],mode:'any',minimumConfidence:0.85,unknownPolicy:'fail'}]}};
    const items=communicationQualifications(rule,'CET-6 580分');expect(items.map(i=>i.status)).toEqual(['unknown','positive']);expect(items.every(i=>i.group==='任一条件')).toBe(true);
  });
  it('does not infer protected attributes or present untested VIP filters as passed',()=>{
    const rule:RuleConfig={schemaVersion:'1.0',root:{operator:'AND',children:[{type:'range',field:'age',minimum:20,maximum:30,unknownPolicy:'fail'}]},bossRecommendationFilters:{mode:'custom',fields:{degree:['本科'],gender:['女']}}};
    const items=communicationQualifications(rule,'本科');expect(items).toHaveLength(1);expect(items[0]!.status).toBe('unknown');expect(items[0]!.label).toContain('本科');
  });
  it('handles no configured position without inventing requirements',()=>expect(communicationQualifications(null,'已通过专八')).toEqual([]));
});


describe('personal chat qualification badge summary', () => {
  const summary = (rule: RuleConfig | null, text: string) => communicationQualificationSummary(rule, communicationQualifications(rule,text));
  it('marks both absent evidence and explicit failure while preserving their reasons', () => {
    expect(summary(config,'').status).toBe('unknown');
    expect(summary(config,'英语专八未通过').status).toBe('negative');
    expect(summary(config,'已取得 TEM-8 证书').status).toBe('positive');
    expect(summary(null,'').status).toBe('unconfigured');
  });
  it('does not mark an OR group when one accepted certificate is confirmed', () => {
    const or:RuleConfig={schemaVersion:'1.0',root:{operator:'OR',children:[{type:'tem8',minimumConfidence:0.85},{type:'english_credential',accepted:['cet6'],mode:'any',minimumConfidence:0.85,unknownPolicy:'fail'}]}};
    expect(summary(or,'CET-6 580分').status).toBe('positive');
    expect(summary(or,'CET-4 580分').status).toBe('unknown');
  });
  it('keeps nested AND conditions and NOT exclusions when summarizing', () => {
    const tem8={type:'tem8',minimumConfidence:0.85} as const;
    const or:RuleNode={operator:'OR',children:[tem8,{type:'english_credential',accepted:['cet6'],mode:'any',minimumConfidence:0.85,unknownPolicy:'fail'}]};
    const nested:RuleConfig={schemaVersion:'1.0',root:{operator:'AND',children:[or,{operator:'NOT',children:[tem8]}]}};
    expect(summary(nested,'已通过英语专八').status).toBe('negative');
    const explicit = communicationQualifications(nested,'').map(check=>({...check,status:check.id==='rule.1.2'?'positive' as const:'negative' as const}));
    expect(communicationQualificationSummary(nested,explicit).status).toBe('positive');
    expect(summary(nested,'CET-6 580分').status).toBe('unknown');
  });
});
