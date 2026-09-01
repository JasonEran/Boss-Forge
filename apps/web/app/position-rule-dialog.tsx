'use client';

import { useEffect, useState } from 'react';
import { LoaderCircle, Plus, SlidersHorizontal, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';

const academicTags = ['985', '211', '双一流'] as const;
type AcademicTag = (typeof academicTags)[number];
type RuleMode = 'any' | 'all';
type RootOperator = 'AND' | 'OR';
type MissingPolicy = 'manual_review' | 'fail' | 'ignore';
type SemanticExecutionMode = 'normalized_entity' | 'semantic_rubric';

type SemanticDraft = {
  criterionId: string;
  label: string;
  executionMode: SemanticExecutionMode;
  factType: string;
  expectedValues: string;
  aliases: string;
  valueMode: RuleMode;
  rubric: string;
  minimumConfidence: string;
};

type PositionInput = {
  id: string;
  name: string;
  bossJobKeyword?: string | null;
  ownerName?: string;
};

type ActiveRuleInput = {
  id: string;
  version: number;
  dictionaryVersion: string;
  config: unknown;
};

type PositionRuleDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  controlApi: string;
  position?: PositionInput | null;
  activeRule?: ActiveRuleInput | null;
  onCreated: (positionId: string) => Promise<void> | void;
};

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function collectLeaves(value: unknown): JsonRecord[] {
  const node = record(value);
  if (!node) return [];
  const children = Array.isArray(node.children) ? node.children : null;
  if (!children) return [node];
  return children.flatMap(collectLeaves);
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function splitValues(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[,，;；/|、\n]/u)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function joinedValues(node: JsonRecord | undefined): string {
  return strings(node?.values).join('、');
}

function semanticAliasesText(value: unknown): string {
  const aliases = record(value);
  if (!aliases) return '';
  return Object.entries(aliases)
    .map(([canonical, values]) => `${canonical}=${strings(values).join('|')}`)
    .join('\n');
}

function parseSemanticAliases(value: string): Record<string, string[]> {
  return Object.fromEntries(
    value
      .split(/\n|;/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [canonical, aliases = ''] = line.split('=', 2);
        return [canonical.trim(), splitValues(aliases.replaceAll('|', '、'))];
      })
      .filter(([canonical, aliases]) => canonical && aliases.length > 0),
  );
}

function emptySemanticDraft(criterionId: string): SemanticDraft {
  return {
    criterionId,
    label: '',
    executionMode: 'normalized_entity',
    factType: 'skill',
    expectedValues: '',
    aliases: '',
    valueMode: 'any',
    rubric: '',
    minimumConfidence: '0.8',
  };
}

async function responseJson<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as T & { message?: string };
  if (!response.ok)
    throw new Error(payload.message ?? `HTTP ${response.status}`);
  return payload;
}

export function PositionRuleDialog({
  open,
  onOpenChange,
  controlApi,
  position = null,
  activeRule = null,
  onCreated,
}: PositionRuleDialogProps) {
  const editingExistingPosition = Boolean(position);
  const [name, setName] = useState('');
  const [bossJobKeyword, setBossJobKeyword] = useState('');
  const [ownerName, setOwnerName] = useState('HR 管理员');
  const [rootOperator, setRootOperator] = useState<RootOperator>('AND');
  const [minimumConfidence, setMinimumConfidence] = useState('0.86');
  const [requireTem8, setRequireTem8] = useState(true);
  const [selectedAcademicTags, setSelectedAcademicTags] = useState<
    AcademicTag[]
  >([]);
  const [academicTagMode, setAcademicTagMode] = useState<RuleMode>('any');
  const [minimumExperience, setMinimumExperience] = useState('');
  const [maximumExperience, setMaximumExperience] = useState('');
  const [minimumEducation, setMinimumEducation] = useState('none');
  const [skills, setSkills] = useState('');
  const [skillsMode, setSkillsMode] = useState<RuleMode>('any');
  const [locations, setLocations] = useState('');
  const [locationMode, setLocationMode] = useState<RuleMode>('any');
  const [resumeKeywords, setResumeKeywords] = useState('');
  const [keywordMode, setKeywordMode] = useState<RuleMode>('any');
  const [missingPolicy, setMissingPolicy] =
    useState<MissingPolicy>('manual_review');
  const [semanticRules, setSemanticRules] = useState<SemanticDraft[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeRuleConfigJson = JSON.stringify(activeRule?.config ?? null);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      setError(null);
      setName(position?.name ?? '');
      setBossJobKeyword(position?.bossJobKeyword ?? '');
      setOwnerName(position?.ownerName ?? 'HR 管理员');
      setRootOperator('AND');
      setMinimumConfidence('0.86');
      setRequireTem8(true);
      setSelectedAcademicTags([]);
      setAcademicTagMode('any');
      setMinimumExperience('');
      setMaximumExperience('');
      setMinimumEducation('none');
      setSkills('');
      setSkillsMode('any');
      setLocations('');
      setLocationMode('any');
      setResumeKeywords('');
      setKeywordMode('any');
      setMissingPolicy('manual_review');
      setSemanticRules([]);

      const config = record(JSON.parse(activeRuleConfigJson) as unknown);
      if (!config) return;
      if (Array.isArray(config.requiredCapabilities)) {
        const capability = record(config.requiredCapabilities[0]);
        setRequireTem8(Boolean(capability));
        if (typeof capability?.minimumConfidence === 'number') {
          setMinimumConfidence(String(capability.minimumConfidence));
        }
        return;
      }

      const root = record(config.root);
      if (root?.operator === 'OR') setRootOperator('OR');
      const leaves = collectLeaves(root);
      const tem8 = leaves.find(
        (node) =>
          node.type === 'tem8' ||
          (node.type === 'capability' && node.capability === 'tem8'),
      );
      setRequireTem8(Boolean(tem8));
      if (typeof tem8?.minimumConfidence === 'number') {
        setMinimumConfidence(String(tem8.minimumConfidence));
      }
      const platformTags = leaves.find(
        (node) =>
          node.type === 'enum' &&
          (typeof node.field === 'string'
            ? node.field.toLocaleLowerCase()
            : '') === 'bossplatformtags',
      );
      setSelectedAcademicTags(
        strings(platformTags?.values).filter((value): value is AcademicTag =>
          academicTags.includes(value as AcademicTag),
        ),
      );
      if (platformTags?.mode === 'all') setAcademicTagMode('all');

      const experience = leaves.find(
        (node) =>
          node.type === 'range' && node.field === 'yearsOfExperience',
      );
      if (typeof experience?.minimum === 'number') {
        setMinimumExperience(String(experience.minimum));
      }
      if (typeof experience?.maximum === 'number') {
        setMaximumExperience(String(experience.maximum));
      }
      const education = leaves.find(
        (node) => node.type === 'education_level',
      );
      if (typeof education?.minimum === 'string') {
        setMinimumEducation(education.minimum);
      }
      const skillRule = leaves.find(
        (node) => node.type === 'keyword' && node.field === 'skills',
      );
      setSkills(joinedValues(skillRule));
      if (skillRule?.mode === 'all') setSkillsMode('all');
      const locationRule = leaves.find(
        (node) => node.type === 'enum' && node.field === 'location',
      );
      setLocations(joinedValues(locationRule));
      if (locationRule?.mode === 'all') setLocationMode('all');
      const generalKeywords = leaves.find(
        (node) => node.type === 'keyword' && node.field === 'all',
      );
      setResumeKeywords(joinedValues(generalKeywords));
      if (generalKeywords?.mode === 'all') setKeywordMode('all');
      const configuredPolicy = leaves.find(
        (node) =>
          node.unknownPolicy === 'manual_review' ||
          node.unknownPolicy === 'fail' ||
          node.unknownPolicy === 'ignore',
      )?.unknownPolicy;
      if (
        configuredPolicy === 'manual_review' ||
        configuredPolicy === 'fail' ||
        configuredPolicy === 'ignore'
      ) {
        setMissingPolicy(configuredPolicy);
      }
      setSemanticRules(
        leaves
          .filter((node) => node.type === 'semantic')
          .map((node, index) => ({
            criterionId:
              typeof node.criterionId === 'string'
                ? node.criterionId
                : `semantic_custom_${index + 1}`,
            label: typeof node.label === 'string' ? node.label : '',
            executionMode:
              node.executionMode === 'semantic_rubric'
                ? 'semantic_rubric'
                : 'normalized_entity',
            factType:
              typeof node.factType === 'string' ? node.factType : 'skill',
            expectedValues: strings(node.expectedValues).join('、'),
            aliases: semanticAliasesText(node.aliases),
            valueMode: node.valueMode === 'all' ? 'all' : 'any',
            rubric: typeof node.rubric === 'string' ? node.rubric : '',
            minimumConfidence:
              typeof node.minimumConfidence === 'number'
                ? String(node.minimumConfidence)
                : '0.8',
          })),
      );
    }, 0);
    return () => window.clearTimeout(timer);
  }, [
    open,
    position?.id,
    position?.name,
    position?.bossJobKeyword,
    position?.ownerName,
    activeRule?.id,
    activeRuleConfigJson,
  ]);

  async function submit(event: { preventDefault: () => void }) {
    event.preventDefault();
    if (submitting) return;
    const confidence = Number(minimumConfidence);
    if (
      requireTem8 &&
      (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)
    ) {
      setError('TEM8 最低置信度必须在 0 到 1 之间。');
      return;
    }
    const minimumYears = minimumExperience
      ? Number(minimumExperience)
      : undefined;
    const maximumYears = maximumExperience
      ? Number(maximumExperience)
      : undefined;
    if (
      (minimumYears !== undefined &&
        (!Number.isFinite(minimumYears) || minimumYears < 0)) ||
      (maximumYears !== undefined &&
        (!Number.isFinite(maximumYears) || maximumYears < 0)) ||
      (minimumYears !== undefined &&
        maximumYears !== undefined &&
        minimumYears > maximumYears)
    ) {
      setError('工作年限范围无效，请确认最小值不大于最大值。');
      return;
    }

    for (const [index, semanticRule] of semanticRules.entries()) {
      const semanticConfidence = Number(semanticRule.minimumConfidence);
      if (!semanticRule.label.trim() || !semanticRule.factType.trim()) {
        setError(`语义条件 ${index + 1} 必须填写条件名称和事实类型。`);
        return;
      }
      if (!/^[a-z][a-z0-9._-]{1,99}$/u.test(semanticRule.factType.trim())) {
        setError(`语义条件 ${index + 1} 的事实类型必须是小写稳定标识，例如 project_leadership。`);
        return;
      }
      if (
        !Number.isFinite(semanticConfidence) ||
        semanticConfidence < 0 ||
        semanticConfidence > 1
      ) {
        setError(`语义条件 ${index + 1} 的最低置信度必须在 0 到 1 之间。`);
        return;
      }
      if (
        semanticRule.executionMode === 'normalized_entity' &&
        splitValues(semanticRule.expectedValues).length === 0
      ) {
        setError(`语义条件 ${index + 1} 至少需要一个规范值。`);
        return;
      }
      if (
        semanticRule.executionMode === 'semantic_rubric' &&
        !semanticRule.rubric.trim()
      ) {
        setError(`语义条件 ${index + 1} 必须填写可验证的评分标准。`);
        return;
      }
      const expected = new Set(splitValues(semanticRule.expectedValues));
      const unsupportedAlias = Object.keys(
        parseSemanticAliases(semanticRule.aliases),
      ).find((canonical) => !expected.has(canonical));
      if (
        semanticRule.executionMode === 'normalized_entity' &&
        unsupportedAlias
      ) {
        setError(`语义条件 ${index + 1} 的别名“${unsupportedAlias}”没有对应规范值。`);
        return;
      }
    }

    const skillValues = splitValues(skills);
    const locationValues = splitValues(locations);
    const generalKeywordValues = splitValues(resumeKeywords);
    const children: JsonRecord[] = [];
    if (requireTem8) {
      children.push({
        type: 'capability',
        capability: 'tem8',
        match: 'confirmed',
        minimumConfidence: confidence,
        unknownPolicy: missingPolicy,
      });
    }
    if (selectedAcademicTags.length > 0) {
      children.push({
        type: 'enum',
        field: 'bossPlatformTags',
        values: selectedAcademicTags,
        mode: academicTagMode,
        match: 'exact',
        unknownPolicy: 'fail',
      });
    }
    if (minimumYears !== undefined || maximumYears !== undefined) {
      children.push({
        type: 'range',
        field: 'yearsOfExperience',
        ...(minimumYears === undefined ? {} : { minimum: minimumYears }),
        ...(maximumYears === undefined ? {} : { maximum: maximumYears }),
        unknownPolicy: missingPolicy,
      });
    }
    if (minimumEducation !== 'none') {
      children.push({
        type: 'education_level',
        minimum: minimumEducation,
        unknownPolicy: missingPolicy,
      });
    }
    if (skillValues.length > 0) {
      children.push({
        type: 'keyword',
        field: 'skills',
        values: skillValues,
        mode: skillsMode,
        unknownPolicy: missingPolicy,
      });
    }
    if (locationValues.length > 0) {
      children.push({
        type: 'enum',
        field: 'location',
        values: locationValues,
        mode: locationMode,
        match: 'exact',
        unknownPolicy: missingPolicy,
      });
    }
    if (generalKeywordValues.length > 0) {
      children.push({
        type: 'keyword',
        field: 'all',
        values: generalKeywordValues,
        mode: keywordMode,
        unknownPolicy: missingPolicy,
      });
    }
    for (const semanticRule of semanticRules) {
      const common = {
        type: 'semantic',
        criterionId: semanticRule.criterionId,
        label: semanticRule.label.trim(),
        executionMode: semanticRule.executionMode,
        factType: semanticRule.factType.trim(),
        minimumConfidence: Number(semanticRule.minimumConfidence),
        unknownPolicy: missingPolicy,
      };
      if (semanticRule.executionMode === 'normalized_entity') {
        const aliases = parseSemanticAliases(semanticRule.aliases);
        children.push({
          ...common,
          expectedValues: splitValues(semanticRule.expectedValues),
          ...(Object.keys(aliases).length > 0 ? { aliases } : {}),
          valueMode: semanticRule.valueMode,
        });
      } else {
        children.push({
          ...common,
          rubric: semanticRule.rubric.trim(),
        });
      }
    }
    if (children.length === 0) {
      setError('请至少配置一个筛选条件。');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      let positionId = position?.id;
      if (!positionId) {
        const positionResponse = await fetch(`${controlApi}/api/positions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            bossAccountId: 'boss-account-01',
            name,
            bossJobKeyword,
            ownerName,
          }),
        });
        const payload = await responseJson<{ position: { id: string } }>(
          positionResponse,
        );
        positionId = payload.position.id;
      }
      const nextVersion = (activeRule?.version ?? 0) + 1;
      const ruleResponse = await fetch(
        `${controlApi}/api/positions/${positionId}/rules`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: `${name} · 筛选规则`,
            config: {
              schemaVersion: semanticRules.length > 0 ? '1.1' : '1.0',
              name: `${name} · 筛选规则 v${nextVersion}`,
              root: { operator: rootOperator, children },
            },
            dictionaryVersion: '2026.09.1',
            createdBy: 'hr:dashboard',
          }),
        },
      );
      await responseJson(ruleResponse);
      await onCreated(positionId);
      onOpenChange(false);
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : String(submitError),
      );
    } finally {
      setSubmitting(false);
    }
  }

  function modeSelect(
    id: string,
    value: RuleMode,
    onChange: (value: RuleMode) => void,
  ) {
    return (
      <NativeSelect
        id={id}
        size="sm"
        value={value}
        onChange={(event) => onChange(event.target.value as RuleMode)}
      >
        <NativeSelectOption value="any">满足任一</NativeSelectOption>
        <NativeSelectOption value="all">必须全部</NativeSelectOption>
      </NativeSelect>
    );
  }

  function updateSemanticRule(
    index: number,
    patch: Partial<SemanticDraft>,
  ) {
    setSemanticRules((current) =>
      current.map((item, itemIndex) =>
        itemIndex === index ? { ...item, ...patch } : item,
      ),
    );
  }

  function addSemanticRule() {
    setSemanticRules((current) => {
      let sequence = current.length + 1;
      while (
        current.some(
          (item) => item.criterionId === `semantic_custom_${sequence}`,
        )
      ) {
        sequence += 1;
      }
      return [...current, emptySemanticDraft(`semantic_custom_${sequence}`)];
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <SlidersHorizontal
              className="size-4 text-primary"
              aria-hidden="true"
            />
            {editingExistingPosition ? '新增岗位规则版本' : '新建岗位与规则'}
          </DialogTitle>
          <DialogDescription>
            {editingExistingPosition
              ? `正在编辑“${position?.name}”。保存后生成不可变的新版本，历史任务继续使用旧版本。`
              : '创建岗位并发布第一版筛选规则。后续修改会生成新版本。'}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void submit(event)} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <label htmlFor="position-name" className="space-y-1.5 text-sm font-medium">
              <span>内部岗位名称</span>
              <Input
                id="position-name"
                required
                disabled={editingExistingPosition}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="例：海外运营专员"
              />
            </label>
            <label htmlFor="boss-job-keyword" className="space-y-1.5 text-sm font-medium">
              <span>BOSS 岗位关键词</span>
              <Input
                id="boss-job-keyword"
                disabled={editingExistingPosition}
                value={bossJobKeyword}
                onChange={(event) => setBossJobKeyword(event.target.value)}
                placeholder="留空则使用当前岗位"
              />
            </label>
            <label htmlFor="position-owner" className="space-y-1.5 text-sm font-medium">
              <span>负责人</span>
              <Input
                id="position-owner"
                required
                disabled={editingExistingPosition}
                value={ownerName}
                onChange={(event) => setOwnerName(event.target.value)}
              />
            </label>
            <label htmlFor="root-operator" className="space-y-1.5 text-sm font-medium">
              <span>条件关系</span>
              <NativeSelect
                id="root-operator"
                className="w-full"
                value={rootOperator}
                onChange={(event) =>
                  setRootOperator(event.target.value as RootOperator)
                }
              >
                <NativeSelectOption value="AND">全部条件都满足（AND）</NativeSelectOption>
                <NativeSelectOption value="OR">任一条件满足（OR）</NativeSelectOption>
              </NativeSelect>
            </label>
          </div>

          <fieldset className="space-y-4 rounded-lg border p-4">
            <legend className="px-1 text-sm font-semibold">筛选条件</legend>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2 rounded-lg bg-muted/35 p-3">
                <label htmlFor="require-tem8" className="flex items-center gap-2 text-sm font-medium">
                  <Checkbox
                    id="require-tem8"
                    checked={requireTem8}
                    onCheckedChange={(checked) => setRequireTem8(checked === true)}
                  />
                  英语专业八级（TEM8）
                </label>
                <label htmlFor="minimum-confidence" className="space-y-1 text-xs text-muted-foreground">
                  最低置信度
                  <Input
                    id="minimum-confidence"
                    disabled={!requireTem8}
                    type="number"
                    min="0"
                    max="1"
                    step="0.01"
                    value={minimumConfidence}
                    onChange={(event) => setMinimumConfidence(event.target.value)}
                  />
                </label>
              </div>

              <div className="space-y-2 rounded-lg bg-muted/35 p-3">
                <p className="text-sm font-medium">BOSS 院校平台标签</p>
                <div className="flex flex-wrap gap-3">
                  {academicTags.map((tag) => (
                    <label
                      key={tag}
                      htmlFor={`academic-tag-${tag}`}
                      className="flex items-center gap-2 text-sm"
                    >
                      <Checkbox
                        id={`academic-tag-${tag}`}
                        checked={selectedAcademicTags.includes(tag)}
                        onCheckedChange={(checked) =>
                          setSelectedAcademicTags((current) =>
                            checked === true
                              ? [...new Set([...current, tag])]
                              : current.filter((value) => value !== tag),
                          )
                        }
                      />
                      {tag}
                    </label>
                  ))}
                </div>
                {modeSelect('academic-tag-mode', academicTagMode, setAcademicTagMode)}
              </div>

              <div className="space-y-2 rounded-lg bg-muted/35 p-3">
                <p className="text-sm font-medium">工作经验（年）</p>
                <div className="grid grid-cols-2 gap-2">
                  <Input
                    aria-label="最少工作年限"
                    type="number"
                    min="0"
                    step="0.5"
                    placeholder="最少"
                    value={minimumExperience}
                    onChange={(event) => setMinimumExperience(event.target.value)}
                  />
                  <Input
                    aria-label="最多工作年限"
                    type="number"
                    min="0"
                    step="0.5"
                    placeholder="最多"
                    value={maximumExperience}
                    onChange={(event) => setMaximumExperience(event.target.value)}
                  />
                </div>
              </div>

              <label htmlFor="minimum-education" className="space-y-2 rounded-lg bg-muted/35 p-3 text-sm font-medium">
                最低学历
                <NativeSelect
                  id="minimum-education"
                  className="w-full"
                  value={minimumEducation}
                  onChange={(event) => setMinimumEducation(event.target.value)}
                >
                  <NativeSelectOption value="none">不限制</NativeSelectOption>
                  <NativeSelectOption value="high_school">高中/中专</NativeSelectOption>
                  <NativeSelectOption value="associate">专科</NativeSelectOption>
                  <NativeSelectOption value="bachelor">本科</NativeSelectOption>
                  <NativeSelectOption value="master">硕士</NativeSelectOption>
                  <NativeSelectOption value="doctor">博士</NativeSelectOption>
                </NativeSelect>
              </label>

              <label htmlFor="skills" className="space-y-2 rounded-lg bg-muted/35 p-3 text-sm font-medium">
                技能关键词
                <Input
                  id="skills"
                  value={skills}
                  onChange={(event) => setSkills(event.target.value)}
                  placeholder="Python、SQL、招聘运营"
                />
                {modeSelect('skills-mode', skillsMode, setSkillsMode)}
              </label>

              <label htmlFor="locations" className="space-y-2 rounded-lg bg-muted/35 p-3 text-sm font-medium">
                地点
                <Input
                  id="locations"
                  value={locations}
                  onChange={(event) => setLocations(event.target.value)}
                  placeholder="上海、苏州"
                />
                {modeSelect('location-mode', locationMode, setLocationMode)}
              </label>

              <label htmlFor="resume-keywords" className="space-y-2 rounded-lg bg-muted/35 p-3 text-sm font-medium sm:col-span-2">
                其他简历关键词
                <Input
                  id="resume-keywords"
                  value={resumeKeywords}
                  onChange={(event) => setResumeKeywords(event.target.value)}
                  placeholder="跨境电商、海外市场、B2B；支持逗号或顿号分隔"
                />
                {modeSelect('keyword-mode', keywordMode, setKeywordMode)}
              </label>
            </div>
          </fieldset>

          <fieldset className="space-y-4 rounded-lg border p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <legend className="text-sm font-semibold">通用语义条件</legend>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  规范实体先查同义词；复杂经历由服务端模型按评分标准提取。模型默认影子运行，低置信度进入人工复核。
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={addSemanticRule}
              >
                <Plus aria-hidden="true" />
                添加条件
              </Button>
            </div>

            {semanticRules.length === 0 ? (
              <p className="rounded-lg bg-muted/35 p-3 text-xs text-muted-foreground">
                当前没有语义条件，现有确定性规则照常运行。
              </p>
            ) : (
              <div className="space-y-3">
                {semanticRules.map((semanticRule, index) => (
                  <div
                    key={semanticRule.criterionId}
                    className="space-y-3 rounded-lg border bg-muted/20 p-3"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium text-muted-foreground">
                        条件 {index + 1} · {semanticRule.criterionId}
                      </span>
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`删除语义条件 ${index + 1}`}
                        onClick={() =>
                          setSemanticRules((current) =>
                            current.filter((_, itemIndex) => itemIndex !== index),
                          )
                        }
                      >
                        <Trash2 aria-hidden="true" />
                      </Button>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-2">
                      <label
                        htmlFor={`semantic-label-${index}`}
                        className="space-y-1.5 text-xs font-medium"
                      >
                        条件名称
                        <Input
                          id={`semantic-label-${index}`}
                          value={semanticRule.label}
                          onChange={(event) =>
                            updateSemanticRule(index, { label: event.target.value })
                          }
                          placeholder="例：具有大客户销售经验"
                        />
                      </label>
                      <label
                        htmlFor={`semantic-mode-${index}`}
                        className="space-y-1.5 text-xs font-medium"
                      >
                        执行方式
                        <NativeSelect
                          id={`semantic-mode-${index}`}
                          value={semanticRule.executionMode}
                          onChange={(event) =>
                            updateSemanticRule(index, {
                              executionMode: event.target
                                .value as SemanticExecutionMode,
                            })
                          }
                        >
                          <NativeSelectOption value="normalized_entity">
                            同义词/实体归一化
                          </NativeSelectOption>
                          <NativeSelectOption value="semantic_rubric">
                            大模型语义评分
                          </NativeSelectOption>
                        </NativeSelect>
                      </label>
                      <label
                        htmlFor={`semantic-fact-type-${index}`}
                        className="space-y-1.5 text-xs font-medium"
                      >
                        事实类型
                        <Input
                          id={`semantic-fact-type-${index}`}
                          value={semanticRule.factType}
                          onChange={(event) =>
                            updateSemanticRule(index, {
                              factType: event.target.value,
                            })
                          }
                          placeholder="skill / industry_experience"
                        />
                      </label>
                      <label
                        htmlFor={`semantic-confidence-${index}`}
                        className="space-y-1.5 text-xs font-medium"
                      >
                        最低置信度
                        <Input
                          id={`semantic-confidence-${index}`}
                          type="number"
                          min="0"
                          max="1"
                          step="0.01"
                          value={semanticRule.minimumConfidence}
                          onChange={(event) =>
                            updateSemanticRule(index, {
                              minimumConfidence: event.target.value,
                            })
                          }
                        />
                      </label>
                    </div>

                    {semanticRule.executionMode === 'normalized_entity' ? (
                      <div className="grid gap-3 sm:grid-cols-2">
                        <label
                          htmlFor={`semantic-values-${index}`}
                          className="space-y-1.5 text-xs font-medium"
                        >
                          规范值
                          <Input
                            id={`semantic-values-${index}`}
                            value={semanticRule.expectedValues}
                            onChange={(event) =>
                              updateSemanticRule(index, {
                                expectedValues: event.target.value,
                              })
                            }
                            placeholder="Spring Cloud、Java"
                          />
                        </label>
                        <label
                          htmlFor={`semantic-value-mode-${index}`}
                          className="space-y-1.5 text-xs font-medium"
                        >
                          匹配方式
                          <NativeSelect
                            id={`semantic-value-mode-${index}`}
                            value={semanticRule.valueMode}
                            onChange={(event) =>
                              updateSemanticRule(index, {
                                valueMode: event.target.value as RuleMode,
                              })
                            }
                          >
                            <NativeSelectOption value="any">满足任一</NativeSelectOption>
                            <NativeSelectOption value="all">必须全部</NativeSelectOption>
                          </NativeSelect>
                        </label>
                        <label
                          htmlFor={`semantic-aliases-${index}`}
                          className="space-y-1.5 text-xs font-medium sm:col-span-2"
                        >
                          自定义别名（每行：规范值=别名1|别名2）
                          <Textarea
                            id={`semantic-aliases-${index}`}
                            value={semanticRule.aliases}
                            onChange={(event) =>
                              updateSemanticRule(index, {
                                aliases: event.target.value,
                              })
                            }
                            placeholder={'Spring Cloud=SpringCloud|Spring Cloud Alibaba\nJava=J2EE|Java 后端'}
                          />
                        </label>
                      </div>
                    ) : (
                      <label
                        htmlFor={`semantic-rubric-${index}`}
                        className="space-y-1.5 text-xs font-medium"
                      >
                        可验证评分标准
                        <Textarea
                          id={`semantic-rubric-${index}`}
                          value={semanticRule.rubric}
                          onChange={(event) =>
                            updateSemanticRule(index, {
                              rubric: event.target.value,
                            })
                          }
                          placeholder="仅当简历明确说明候选人负责团队排期、绩效或交付，并引用对应原文时判定符合；只有参与项目不得判定为管理经验。"
                        />
                      </label>
                    )}
                  </div>
                ))}
              </div>
            )}
          </fieldset>

          <label htmlFor="missing-policy" className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/35 p-3 text-sm font-medium">
            信息缺失时
            <NativeSelect
              id="missing-policy"
              value={missingPolicy}
              onChange={(event) =>
                setMissingPolicy(event.target.value as MissingPolicy)
              }
            >
              <NativeSelectOption value="manual_review">进入人工复核</NativeSelectOption>
              <NativeSelectOption value="fail">视为不符合</NativeSelectOption>
              <NativeSelectOption value="ignore">忽略该条件</NativeSelectOption>
            </NativeSelect>
            <span className="text-xs font-normal text-muted-foreground">
              BOSS 院校标签缺失始终视为不匹配，不从学校名称推断。
            </span>
          </label>

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
              {submitting
                ? '正在保存'
                : editingExistingPosition
                  ? '保存为新规则版本'
                  : '保存岗位与规则'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
