'use client';

import { useEffect, useState } from 'react';
import { LoaderCircle, SlidersHorizontal } from 'lucide-react';

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
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';

const academicTags = ['985', '211', '双一流'] as const;
type AcademicTag = (typeof academicTags)[number];
type RuleMode = 'any' | 'all';
type RootOperator = 'AND' | 'OR';
type MissingPolicy = 'manual_review' | 'fail' | 'ignore';

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
              schemaVersion: '1.0',
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
