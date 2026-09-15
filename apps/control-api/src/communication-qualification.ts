import { parseRuleConfig, type RuleConfig, type RuleNode } from '@boss-forge/data';
import { evaluateCandidate } from '@boss-forge/m1-core';
import { bossFilterLabels, type CommunicationRequirement } from '@boss-forge/contracts';

const labels: Record<string, string> = {yearsOfExperience:'工作年限',age:'年龄',graduationYear:'毕业年份',education:'学历',degree:'学历',major:'专业',gender:'性别',all:'简历关键词',current_or_upcoming_graduate:'应届毕业生',experienced:'非应届',bachelor:'本科',master:'硕士',doctor:'博士',associate:'大专',high_school:'高中'};
const display = (value: string) => labels[value] ?? value;
export function requirementLabel(node: RuleNode): string {
  if ('children' in node) return '岗位条件';
  if (node.type === 'tem8' || node.type === 'capability') return '英语专业八级（TEM-8）';
  if (node.type === 'english_credential') return node.accepted.map(x => x === 'tem8' ? '英语专八' : '英语六级').join(node.mode === 'any' ? ' 或 ' : ' 且 ');
  if (node.type === 'range') return `${display(node.field)}：${node.minimum ?? '不限'}～${node.maximum ?? '不限'}`;
  if (node.type === 'education_level') return `学历至少${display(node.minimum)}`;
  if (node.type === 'graduate_status') return node.values.map(display).join('、');
  if (node.type === 'text') return `${display(node.field)}：${node.value}`;
  if (node.type === 'enum' || node.type === 'keyword') return `${display(node.field)}：${node.values.map(display).join(node.mode === 'all' ? ' 且 ' : ' 或 ')}`;
  if (node.type === 'semantic') return `${node.label}${node.expectedValues?.length ? '：'+node.expectedValues.join('、') : node.rubric ? '：'+node.rubric : ''}`;
  return `院校要求：${node.categories.join(node.mode === 'all' ? ' 且 ' : ' 或 ')}`;
}

/** Advisory evidence only: no decision, score, rejection or pipeline write. */
export function communicationQualifications(config: RuleConfig | null, resumeText: string): CommunicationRequirement[] {
  if (!config) return [];
  const parsed = parseRuleConfig(config);
  const items: CommunicationRequirement[] = [];
  const walk = (node: RuleNode, group: string, id: string) => {
    if ('children' in node) {
      const op = 'operator' in node ? node.operator : node.type === 'any' ? 'OR' : 'AND';
      node.children.forEach((child, index) => walk(child, `${group}${group ? ' / ' : ''}${op === 'OR' ? '任一条件' : op === 'NOT' ? '排除条件' : '全部条件'}`, `${id}.${index + 1}`));
      return;
    }
    // Personal attributes are never inferred from names, photos or the résumé.
    if (('field' in node && ['age','gender','sex','性别','年龄'].includes(node.field))) return;
    const label = requirementLabel(node);
    const check: CommunicationRequirement = {id,label,group,status:'unknown',evidence:[],explanation:resumeText ? '此条件需要结合原简历人工核对。' : '尚未读取可核对的简历文字。',question:`你好，想进一步了解你在「${label}」方面的情况，方便补充相关经历或证明吗？`};
    if (['tem8','capability','english_credential'].includes(node.type) && resumeText.trim()) {
      const result = evaluateCandidate({source:'recommend',index:1,name:'',fields:{},evidence:[],raw:resumeText}, {schemaVersion:'1.0',root:{operator:'AND',children:[{...node,unknownPolicy:'manual_review'} as RuleNode]}});
      check.status = result.decision === 'matched' ? 'positive' : result.decision === 'not_matched' && result.evidence.some(e => e.status === 'negative') ? 'negative' : 'unknown';
      check.evidence = [...new Set(result.evidence.filter(e => e.normalizedAlias !== 'missing_accepted_english_credential' && !e.sourceText.startsWith('未提取到')).map(e => e.sourceText))].slice(0,5);
      check.explanation = check.status === 'positive' ? '简历中有符合条件的表述，证书真实性仍需核验。' : check.status === 'negative' ? '简历中有未通过或未取得的表述，请确认是否已更新。' : '未提到、备考、水平相当或表述冲突，都需要进一步确认。';
    }
    if (['tem8','capability','english_credential'].includes(node.type)) check.question = `你好，想确认一下你的英语证书情况：是否已通过${label}？方便补充取得时间或证书信息吗？`;
    items.push(check);
  };
  if ('root' in parsed) walk(parsed.root,'','rule');
  else parsed.requiredCapabilities.forEach((c,i) => walk({type:'tem8',minimumConfidence:c.minimumConfidence},'全部条件',`rule.${i}`));
  if ('bossRecommendationFilters' in parsed && parsed.bossRecommendationFilters?.mode === 'custom') {
    for (const [field, values] of Object.entries(parsed.bossRecommendationFilters.fields)) {
      if (!['degree','firstDegree','experience','school','major','keyword1'].includes(field) || !values?.length) continue;
      const label = `${bossFilterLabels[field as keyof typeof bossFilterLabels]}：${values.join('、')}`;
      items.push({id:`boss.${field}`,label,group:'BOSS 岗位筛选',status:'unknown',evidence:[],explanation:'主动联系不代表已通过 BOSS 推荐筛选，请核对在线简历。',question:`你好，方便补充与「${label}」相关的学历或工作经历吗？`});
    }
  }
  return items;
}

/** Summarize the displayed checks without changing screening or pipeline state.
 * Keep unknown distinct internally; the HR-facing badge intentionally marks it red.
 */
export function communicationQualificationSummary(config: RuleConfig | null, checks: CommunicationRequirement[]): {status: CommunicationRequirement['status'] | 'unconfigured'; reason: string} {
  if (!config || !checks.length) return {status:'unconfigured',reason:'尚无可核对的岗位条件。'};
  type State = CommunicationRequirement['status'];
  const combine = (states: State[], operator: 'AND' | 'OR' | 'NOT'): State | null => {
    if (!states.length) return null;
    if (operator === 'NOT') return states[0] === 'unknown' ? 'unknown' : states[0] === 'positive' ? 'negative' : 'positive';
    if (operator === 'OR') return states.includes('positive') ? 'positive' : states.includes('unknown') ? 'unknown' : 'negative';
    return states.includes('negative') ? 'negative' : states.includes('unknown') ? 'unknown' : 'positive';
  };
  const walk = (node: RuleNode, id: string): State | null => {
    if ('children' in node) {
      const operator = 'operator' in node ? node.operator : node.type === 'any' ? 'OR' : 'AND';
      return combine(node.children.map((child,index)=>walk(child,`${id}.${index+1}`)).filter((state):state is State=>state!==null),operator);
    }
    return checks.find(check=>check.id===id)?.status ?? null;
  };
  const parsed = parseRuleConfig(config);
  const root = 'root' in parsed ? walk(parsed.root,'rule') : combine(checks.filter(check=>check.id.startsWith('rule.')).map(check=>check.status),'AND');
  const status = combine([...(root ? [root] : []), ...checks.filter(check=>check.id.startsWith('boss.')).map(check=>check.status)],'AND') ?? 'unconfigured';
  return {status,reason:status==='negative'?'有要求未满足，请查看岗位要求中的具体证据。':status==='unknown'?'尚未识别出满足岗位要求的完整证据，请查看具体条件。':status==='positive'?'已识别到符合岗位条件的证据。':'尚无可核对的岗位条件。'};
}
