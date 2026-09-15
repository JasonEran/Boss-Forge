'use client';

import { useEffect, useState } from 'react';
import {
  RecruitmentBriefEditor,
  emptyRecruitment,
} from './recruitment-brief-editor';
import {
  recruitmentConfigSchema,
  type RecruitmentConfig,
} from '../../../packages/contracts/src/recruitment';
import { BossFiltersEditor } from './boss-filters-editor';
import {
  bossRecommendationFilterConfigSchema,
  hasBossFilters,
  unavailableBossSelections,
  type BossFilterOptionsSnapshot,
  type BossRecommendationFilterConfig,
} from '../../../packages/contracts/src/boss-recommendation-filters';
import {
  Check,
  LoaderCircle,
  Plus,
  Sparkles,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react';

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
import { apiFetch } from './api-client';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';

const academicTags = ['985', '211', '双一流'] as const;
type AcademicTag = (typeof academicTags)[number];
const englishCredentials = [
  { code: 'cet6', label: '大学英语六级（CET6）' },
  { code: 'tem8', label: '英语专业八级（TEM8）' },
] as const;
type EnglishCredential = (typeof englishCredentials)[number]['code'];
type RuleMode = 'any' | 'all';
type RootOperator = 'AND' | 'OR';
type MissingPolicy = 'manual_review' | 'fail' | 'ignore';
type SemanticExecutionMode = 'normalized_entity' | 'semantic_rubric';
type GraduateStatus = 'any' | 'current_or_upcoming_graduate' | 'experienced';

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
  bossJobId?: string | null;
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
  canPublish: boolean;
  canSetSalary?: boolean;
  onCreated: (positionId: string) => Promise<void> | void;
};

type SynonymPreview = {
  index: number;
  term: string;
  aliases: string[];
  model: string;
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
  canPublish,
  canSetSalary = false,
  onCreated,
}: PositionRuleDialogProps) {
  const [recruitment, setRecruitment] =
    useState<RecruitmentConfig>(emptyRecruitment);
  const name = position?.name ?? '';
  const legacyMode = Boolean(
    activeRule &&
    record(activeRule.config)?.screeningFlow !== 'boss_then_resume',
  );
  const [rootOperator, setRootOperator] = useState<RootOperator>('AND');
  const [minimumConfidence, setMinimumConfidence] = useState('0.86');
  const [selectedEnglishCredentials, setSelectedEnglishCredentials] = useState<
    EnglishCredential[]
  >([]);
  const [selectedAcademicTags, setSelectedAcademicTags] = useState<
    AcademicTag[]
  >([]);
  const [academicTagMode, setAcademicTagMode] = useState<RuleMode>('any');
  const [minimumExperience, setMinimumExperience] = useState('');
  const [maximumExperience, setMaximumExperience] = useState('');
  const [minimumAge, setMinimumAge] = useState('');
  const [maximumAge, setMaximumAge] = useState('');
  const [maximumGraduationYear, setMaximumGraduationYear] = useState('');
  const [graduateStatus, setGraduateStatus] = useState<GraduateStatus>('any');
  const [minimumEducation, setMinimumEducation] = useState('none');
  const [skills, setSkills] = useState('');
  const [skillsMode, setSkillsMode] = useState<RuleMode>('any');
  const [locations, setLocations] = useState('');
  const [locationMode, setLocationMode] = useState<RuleMode>('any');
  const [resumeKeywords, setResumeKeywords] = useState('');
  const [keywordMode, setKeywordMode] = useState<RuleMode>('any');
  const [missingPolicy, setMissingPolicy] = useState<MissingPolicy>('fail');
  const [semanticRules, setSemanticRules] = useState<SemanticDraft[]>([]);
  const [generatingSynonymsFor, setGeneratingSynonymsFor] = useState<
    number | null
  >(null);
  const [synonymPreview, setSynonymPreview] = useState<SynonymPreview | null>(
    null,
  );
  const [synonymError, setSynonymError] = useState<{
    index: number;
    message: string;
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [bossFilters, setBossFilters] =
    useState<BossRecommendationFilterConfig>({ mode: 'custom', fields: {} });
  const [bossFilterOptions, setBossFilterOptions] =
    useState<BossFilterOptionsSnapshot | null>(null);
  const unavailableBossOptions =
    bossFilters.mode === 'custom' && bossFilterOptions
      ? unavailableBossSelections(bossFilters.fields, bossFilterOptions)
      : [];
  const [error, setError] = useState<string | null>(null);
  const activeRuleConfigJson = JSON.stringify(activeRule?.config ?? null);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      setError(null);
      setRecruitment(emptyRecruitment);
      setBossFilters({ mode: legacyMode ? 'auto' : 'custom', fields: {} });
      setBossFilterOptions(null);
      setRootOperator('AND');
      setMinimumConfidence('0.86');
      setSelectedEnglishCredentials([]);
      setSelectedAcademicTags([]);
      setAcademicTagMode('any');
      setMinimumExperience('');
      setMaximumExperience('');
      setMinimumAge('');
      setMaximumAge('');
      setMaximumGraduationYear('');
      setGraduateStatus('any');
      setMinimumEducation('none');
      setSkills('');
      setSkillsMode('any');
      setLocations('');
      setLocationMode('any');
      setResumeKeywords('');
      setKeywordMode('any');
      setMissingPolicy(legacyMode ? 'manual_review' : 'fail');
      setSemanticRules([]);
      setGeneratingSynonymsFor(null);
      setSynonymPreview(null);
      setSynonymError(null);

      const config = record(JSON.parse(activeRuleConfigJson) as unknown);
      if (!config) return;
      const brief = recruitmentConfigSchema.safeParse(config.recruitment);
      if (brief.success) setRecruitment(brief.data);
      const officialFilters = bossRecommendationFilterConfigSchema.safeParse(
        config.bossRecommendationFilters,
      );
      if (officialFilters.success) {
        setBossFilters(officialFilters.data);
        const savedOptions = officialFilters.data.optionsSnapshot;
        if (savedOptions && savedOptions.bossJobId === position?.bossJobId)
          setBossFilterOptions(savedOptions);
      }
      if (Array.isArray(config.requiredCapabilities)) {
        const capability = record(config.requiredCapabilities[0]);
        setSelectedEnglishCredentials(capability ? ['tem8'] : []);
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
      const englishCredential = leaves.find(
        (node) => node.type === 'english_credential',
      );
      const configuredEnglishCredentials = strings(
        englishCredential?.accepted,
      ).filter((value): value is EnglishCredential =>
        englishCredentials.some((item) => item.code === value),
      );
      setSelectedEnglishCredentials(
        configuredEnglishCredentials.length > 0
          ? configuredEnglishCredentials
          : tem8
            ? ['tem8']
            : [],
      );
      const englishConfidence = englishCredential ?? tem8;
      if (typeof englishConfidence?.minimumConfidence === 'number') {
        setMinimumConfidence(String(englishConfidence.minimumConfidence));
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
        (node) => node.type === 'range' && node.field === 'yearsOfExperience',
      );
      if (typeof experience?.minimum === 'number') {
        setMinimumExperience(String(experience.minimum));
      }
      if (typeof experience?.maximum === 'number') {
        setMaximumExperience(String(experience.maximum));
      }
      const age = leaves.find(
        (node) => node.type === 'range' && node.field === 'age',
      );
      if (typeof age?.minimum === 'number') setMinimumAge(String(age.minimum));
      if (typeof age?.maximum === 'number') setMaximumAge(String(age.maximum));
      const graduationYear = leaves.find(
        (node) => node.type === 'range' && node.field === 'graduationYear',
      );
      if (typeof graduationYear?.maximum === 'number') {
        setMaximumGraduationYear(String(graduationYear.maximum));
      }
      const graduateStatusRule = leaves.find(
        (node) => node.type === 'graduate_status',
      );
      const configuredGraduateStatus = strings(graduateStatusRule?.values)[0];
      if (
        configuredGraduateStatus === 'current_or_upcoming_graduate' ||
        configuredGraduateStatus === 'experienced'
      ) {
        setGraduateStatus(configuredGraduateStatus);
      }
      const education = leaves.find((node) => node.type === 'education_level');
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
        if (legacyMode) setMissingPolicy(configuredPolicy);
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
    position?.bossJobId,
    position?.name,
    position?.bossJobKeyword,
    position?.ownerName,
    activeRule?.id,
    activeRuleConfigJson,
    legacyMode,
  ]);

  async function submit(event: { preventDefault: () => void }) {
    event.preventDefault();
    if (submitting) return;
    const confidence = Number(minimumConfidence);
    if (
      selectedEnglishCredentials.length > 0 &&
      (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)
    ) {
      setError('英语证书最低置信度必须在 0 到 1 之间。');
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
    const minimumAgeValue = minimumAge ? Number(minimumAge) : undefined;
    const maximumAgeValue = maximumAge ? Number(maximumAge) : undefined;
    if (
      (minimumAgeValue !== undefined &&
        (!Number.isInteger(minimumAgeValue) ||
          minimumAgeValue < 16 ||
          minimumAgeValue > 100)) ||
      (maximumAgeValue !== undefined &&
        (!Number.isInteger(maximumAgeValue) ||
          maximumAgeValue < 16 ||
          maximumAgeValue > 100)) ||
      (minimumAgeValue !== undefined &&
        maximumAgeValue !== undefined &&
        minimumAgeValue > maximumAgeValue)
    ) {
      setError(
        '年龄范围无效，请填写 16–100 的整数，并确认最小值不大于最大值。',
      );
      return;
    }
    const graduationYearValue = maximumGraduationYear
      ? Number(maximumGraduationYear)
      : undefined;
    if (
      graduationYearValue !== undefined &&
      (!Number.isInteger(graduationYearValue) ||
        graduationYearValue < 1900 ||
        graduationYearValue > 2100)
    ) {
      setError('最晚毕业年份必须是 1900–2100 的四位年份。');
      return;
    }

    for (const [index, semanticRule] of semanticRules.entries()) {
      const semanticConfidence = Number(semanticRule.minimumConfidence);
      if (!semanticRule.factType.trim()) {
        setError(`智能条件 ${index + 1} 缺少内容类别。`);
        return;
      }
      if (!/^[a-z][a-z0-9._-]{1,99}$/u.test(semanticRule.factType.trim())) {
        setError(`智能条件 ${index + 1} 的内容类别格式无效。`);
        return;
      }
      if (
        !Number.isFinite(semanticConfidence) ||
        semanticConfidence < 0 ||
        semanticConfidence > 1
      ) {
        setError(`智能条件 ${index + 1} 的最低置信度必须在 0 到 1 之间。`);
        return;
      }
      if (
        semanticRule.executionMode === 'normalized_entity' &&
        splitValues(semanticRule.expectedValues).length === 0
      ) {
        setError(`智能条件 ${index + 1} 必须填写要识别的内容。`);
        return;
      }
      if (
        semanticRule.executionMode === 'semantic_rubric' &&
        !semanticRule.rubric.trim()
      ) {
        setError(`智能条件 ${index + 1} 必须填写判断说明。`);
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
        setError(
          `智能条件 ${index + 1} 的同义词“${unsupportedAlias}”没有对应识别内容。`,
        );
        return;
      }
    }

    const skillValues = splitValues(skills);
    const locationValues = splitValues(locations);
    const generalKeywordValues = splitValues(resumeKeywords);
    const children: JsonRecord[] = [];
    if (selectedEnglishCredentials.length > 0) {
      children.push({
        type: 'english_credential',
        accepted: selectedEnglishCredentials,
        mode: 'any',
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
    if (minimumAgeValue !== undefined || maximumAgeValue !== undefined) {
      children.push({
        type: 'range',
        field: 'age',
        ...(minimumAgeValue === undefined ? {} : { minimum: minimumAgeValue }),
        ...(maximumAgeValue === undefined ? {} : { maximum: maximumAgeValue }),
        unknownPolicy: missingPolicy,
      });
    }
    if (graduationYearValue !== undefined) {
      children.push({
        type: 'range',
        field: 'graduationYear',
        maximum: graduationYearValue,
        unknownPolicy: missingPolicy,
      });
    }
    if (graduateStatus !== 'any') {
      children.push({
        type: 'graduate_status',
        values: [graduateStatus],
        mode: 'any',
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
        label:
          semanticRule.label.trim() ||
          `识别${splitValues(semanticRule.expectedValues).join('、') || '目标条件'}`,
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
    if (
      children.length === 0 &&
      (legacyMode || !hasBossFilters(bossFilters.fields)) &&
      !recruitment.aiEnabled &&
      recruitment.salaryCeilingYuan === null
    ) {
      setError('请在第一步选择 BOSS 条件，或在第二步添加补充核验要求。');
      return;
    }

    const validatedBrief = recruitmentConfigSchema.safeParse(recruitment);
    if (!validatedBrief.success) {
      setError(
        validatedBrief.error.issues.map((issue) => issue.message).join('；'),
      );
      return;
    }
    if (unavailableBossOptions.length) {
      setError(
        `请调整 BOSS 筛选条件后保存：${unavailableBossOptions.join('；')}`,
      );
      return;
    }
    setSubmitting(true);
    setError(null);
    const positionId = position?.id;
    try {
      if (!positionId)
        throw new Error('请先同步并选择 BOSS 岗位，再配置规则。');
      const ruleResponse = await apiFetch(
        `${controlApi}/api/positions/${positionId}/rules`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: `${name} · 筛选规则`,
            config: {
              recruitment: validatedBrief.data,
              schemaVersion: semanticRules.length > 0 ? '1.1' : '1.0',
              name: `${name} · 筛选规则`,
              root: {
                operator: children.length ? rootOperator : 'AND',
                children,
              },
              bossRecommendationFilters: bossFilters,
              ...(!legacyMode ? { screeningFlow: 'boss_then_resume' } : {}),
            },
            dictionaryVersion: '2026.09.1',
            lifecycleStatus: canPublish ? 'published' : 'pending_approval',
          }),
        },
      );
      await responseJson(ruleResponse);
      if (canPublish && semanticRules.length > 0) {
        const semanticModeResponse = await apiFetch(
          `${controlApi}/api/semantic/mode`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              positionId,
              mode: 'shadow',
              catalogVersionId: null,
            }),
          },
        );
        await responseJson(semanticModeResponse);
      }
      await onCreated(positionId);
      onOpenChange(false);
    } catch (submitError) {
      const message =
        submitError instanceof Error
          ? submitError.message
          : String(submitError);
      setError(message);
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
        aria-label="匹配方式"
        size="sm"
        value={value}
        onChange={(event) => onChange(event.target.value as RuleMode)}
      >
        <NativeSelectOption value="any">满足任一</NativeSelectOption>
        <NativeSelectOption value="all">必须全部</NativeSelectOption>
      </NativeSelect>
    );
  }

  function updateSemanticRule(index: number, patch: Partial<SemanticDraft>) {
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

  async function generateSynonymPreview(index: number) {
    const semanticRule = semanticRules[index];
    if (!semanticRule || generatingSynonymsFor !== null) return;
    const values = splitValues(semanticRule.expectedValues);
    if (values.length !== 1) {
      setSynonymError({
        index,
        message: '请先填写一个要识别的词语；多个条件请分别添加。',
      });
      return;
    }
    setGeneratingSynonymsFor(index);
    setSynonymPreview(null);
    setSynonymError(null);
    try {
      const response = await apiFetch(
        `${controlApi}/api/semantic/synonyms`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            term: values[0],
            positionName: position?.name || name,
            criterionLabel: semanticRule.label,
          }),
        },
        285000,
      );
      const payload = await responseJson<{
        preview: Omit<SynonymPreview, 'index'>;
      }>(response);
      setSynonymPreview({ index, ...payload.preview });
    } catch (generateError) {
      setSynonymError({
        index,
        message:
          generateError instanceof Error
            ? generateError.message
            : String(generateError),
      });
    } finally {
      setGeneratingSynonymsFor(null);
    }
  }

  function applySynonymPreview() {
    if (!synonymPreview) return;
    const semanticRule = semanticRules[synonymPreview.index];
    if (!semanticRule) return;
    const aliases = parseSemanticAliases(semanticRule.aliases);
    aliases[synonymPreview.term] = synonymPreview.aliases;
    updateSemanticRule(synonymPreview.index, {
      aliases: semanticAliasesText(aliases),
    });
    setSynonymPreview(null);
    setSynonymError(null);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <SlidersHorizontal
              className="size-4 text-primary"
              aria-hidden="true"
            />
            {activeRule ? '编辑岗位规则' : '添加岗位规则'}
          </DialogTitle>
          <DialogDescription>
            正在配置“{name}
            ”的筛选规则。每个岗位独立保存版本，历史任务保留当时使用的规则。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void submit(event)} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-xl border bg-muted/30 p-4 text-sm sm:col-span-2">
              <p className="font-medium">{name}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                负责人：{position?.ownerName || '待设置'} ·
                规则仅用于这个岗位的候选人筛选
              </p>
            </div>
          </div>

          <RecruitmentBriefEditor
            value={recruitment}
            onChange={setRecruitment}
            canSetSalary={canSetSalary}
            controlApi={controlApi}
          />
          {legacyMode ? (
            <p className="rounded-lg border bg-muted/30 p-3 text-sm">
              这是清理前的旧版规则，继续保留原来的判断方式。新建规则使用“BOSS
              筛选 + 补充核验”，历史任务不受影响。
            </p>
          ) : null}
          <BossFiltersEditor
            value={bossFilters}
            onChange={setBossFilters}
            positionId={position?.id ?? ''}
            bossJobId={position?.bossJobId}
            controlApi={controlApi}
            snapshot={bossFilterOptions}
            onOptionsChange={(snapshot) => {
              setBossFilterOptions(snapshot);
              setBossFilters((current) => ({
                ...current,
                optionsSnapshot: snapshot,
              }));
            }}
            legacyMode={legacyMode}
          />
          {unavailableBossOptions.length ? (
            <p role="alert" className="text-sm text-destructive">
              请调整以下 BOSS 筛选条件后再保存：
              {unavailableBossOptions.join('；')}
            </p>
          ) : null}
          <fieldset className="space-y-4 rounded-lg border p-4">
            <legend className="px-1 text-sm font-semibold">
              第二步 · 我们补充核验
            </legend>
            <p className="text-xs leading-5 text-muted-foreground">
              只填写 BOSS
              无法直接判断的证书、具体技能和经历。第一步已设置的条件无需重复填写。
              本步可留空，系统仍会保存完整简历供你审核。
            </p>
            <label
              htmlFor="root-operator"
              className="space-y-1.5 text-sm font-medium"
            >
              <span>补充要求之间的关系</span>
              <NativeSelect
                id="root-operator"
                className="w-full"
                value={rootOperator}
                onChange={(event) =>
                  setRootOperator(event.target.value as RootOperator)
                }
              >
                <NativeSelectOption value="AND">
                  全部条件都满足（AND）
                </NativeSelectOption>
                <NativeSelectOption value="OR">
                  任一条件满足（OR）
                </NativeSelectOption>
              </NativeSelect>
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-3 rounded-lg bg-muted/35 p-3 sm:col-span-2">
                <div>
                  <p className="text-sm font-medium">英语证书</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    可多选。选择两项时，六级或专八满足任意一项即可，不要求同时具备。
                  </p>
                </div>
                <div className="flex flex-wrap gap-x-5 gap-y-3">
                  {englishCredentials.map((credential) => (
                    <label
                      key={credential.code}
                      htmlFor={`english-credential-${credential.code}`}
                      className="flex min-h-11 items-center gap-2 text-sm"
                    >
                      <Checkbox
                        id={`english-credential-${credential.code}`}
                        checked={selectedEnglishCredentials.includes(
                          credential.code,
                        )}
                        onCheckedChange={(checked) =>
                          setSelectedEnglishCredentials((current) =>
                            checked === true
                              ? [...new Set([...current, credential.code])]
                              : current.filter(
                                  (value) => value !== credential.code,
                                ),
                          )
                        }
                      />
                      {credential.label}
                    </label>
                  ))}
                </div>
                {selectedEnglishCredentials.length > 0 ? (
                  <p className="rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-xs font-medium text-primary">
                    当前关系：满足任一即可（或）
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    当前不限制英语证书。
                  </p>
                )}
                <label
                  htmlFor="minimum-confidence"
                  className="grid max-w-48 gap-1 text-xs text-muted-foreground"
                >
                  最低识别置信度
                  <Input
                    id="minimum-confidence"
                    disabled={selectedEnglishCredentials.length === 0}
                    type="number"
                    min="0"
                    max="1"
                    step="0.01"
                    value={minimumConfidence}
                    onChange={(event) =>
                      setMinimumConfidence(event.target.value)
                    }
                  />
                </label>
              </div>

              {legacyMode ? (
                <>
                  <div className="space-y-2 rounded-lg bg-muted/35 p-3">
                    <p className="text-sm font-medium">年龄（岁）</p>
                    <div className="grid grid-cols-2 gap-2">
                      <label
                        htmlFor="minimum-age"
                        className="grid gap-1 text-xs text-muted-foreground"
                      >
                        最小年龄
                        <Input
                          id="minimum-age"
                          type="number"
                          min="16"
                          max="100"
                          step="1"
                          placeholder="不限"
                          value={minimumAge}
                          onChange={(event) =>
                            setMinimumAge(event.target.value)
                          }
                        />
                      </label>
                      <label
                        htmlFor="maximum-age"
                        className="grid gap-1 text-xs text-muted-foreground"
                      >
                        最大年龄
                        <Input
                          id="maximum-age"
                          type="number"
                          min="16"
                          max="100"
                          step="1"
                          placeholder="不限"
                          value={maximumAge}
                          onChange={(event) =>
                            setMaximumAge(event.target.value)
                          }
                        />
                      </label>
                    </div>
                  </div>
                </>
              ) : null}

              <label
                htmlFor="maximum-graduation-year"
                className="space-y-2 rounded-lg bg-muted/35 p-3 text-sm font-medium"
              >
                最晚毕业年份
                <Input
                  id="maximum-graduation-year"
                  type="number"
                  min="1900"
                  max="2100"
                  step="1"
                  inputMode="numeric"
                  placeholder="例如 2026"
                  value={maximumGraduationYear}
                  onChange={(event) =>
                    setMaximumGraduationYear(event.target.value)
                  }
                />
                <span className="block text-xs font-normal leading-5 text-muted-foreground">
                  填 2026：接受明确为 2026
                  及更早的毕业年份。未识别年份且无在读或应届标记时，不因此淘汰，年份保留为未知。
                </span>
              </label>

              <label
                htmlFor="graduate-status"
                className="space-y-2 rounded-lg bg-muted/35 p-3 text-sm font-medium"
              >
                应届要求
                <NativeSelect
                  id="graduate-status"
                  className="w-full"
                  value={graduateStatus}
                  onChange={(event) =>
                    setGraduateStatus(event.target.value as GraduateStatus)
                  }
                >
                  <NativeSelectOption value="any">不限</NativeSelectOption>
                  <NativeSelectOption value="current_or_upcoming_graduate">
                    仅应届或即将毕业
                  </NativeSelectOption>
                  <NativeSelectOption value="experienced">
                    仅往届 / 有工作经历
                  </NativeSelectOption>
                </NativeSelect>
                <span className="block text-xs font-normal leading-5 text-muted-foreground">
                  明确在读或应届的按实际信息判断。“仅往届”遇到毕业信息缺失时默认不因此淘汰；不会补写虚构的毕业年份。
                </span>
              </label>

              {legacyMode ? (
                <>
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
                        onChange={(event) =>
                          setMinimumExperience(event.target.value)
                        }
                      />
                      <Input
                        aria-label="最多工作年限"
                        type="number"
                        min="0"
                        step="0.5"
                        placeholder="最多"
                        value={maximumExperience}
                        onChange={(event) =>
                          setMaximumExperience(event.target.value)
                        }
                      />
                    </div>
                  </div>

                  <label
                    htmlFor="minimum-education"
                    className="space-y-2 rounded-lg bg-muted/35 p-3 text-sm font-medium"
                  >
                    最低学历
                    <NativeSelect
                      id="minimum-education"
                      className="w-full"
                      value={minimumEducation}
                      onChange={(event) =>
                        setMinimumEducation(event.target.value)
                      }
                    >
                      <NativeSelectOption value="none">
                        不限制
                      </NativeSelectOption>
                      <NativeSelectOption value="high_school">
                        高中/中专
                      </NativeSelectOption>
                      <NativeSelectOption value="associate">
                        专科
                      </NativeSelectOption>
                      <NativeSelectOption value="bachelor">
                        本科
                      </NativeSelectOption>
                      <NativeSelectOption value="master">
                        硕士
                      </NativeSelectOption>
                      <NativeSelectOption value="doctor">
                        博士
                      </NativeSelectOption>
                    </NativeSelect>
                  </label>
                </>
              ) : null}

              <p className="rounded-lg bg-muted/35 p-3 text-sm leading-6 text-muted-foreground">
                第二步按简历核验岗位资格，性别不参与通过或淘汰判断；BOSS
                官方条件统一在第一步配置。
              </p>

              <label
                htmlFor="skills"
                className="space-y-2 rounded-lg bg-muted/35 p-3 text-sm font-medium"
              >
                技能关键词
                <Input
                  id="skills"
                  value={skills}
                  onChange={(event) => setSkills(event.target.value)}
                  placeholder="Python、SQL、招聘运营"
                />
                {modeSelect('skills-mode', skillsMode, setSkillsMode)}
              </label>
            </div>
            <details className="rounded-lg border bg-card p-3">
              <summary className="cursor-pointer text-sm font-medium">
                更多补充要求（地点、简历原文）
              </summary>
              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                {legacyMode ? (
                  <>
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
                      {modeSelect(
                        'academic-tag-mode',
                        academicTagMode,
                        setAcademicTagMode,
                      )}
                    </div>
                  </>
                ) : null}
                <label
                  htmlFor="locations"
                  className="space-y-2 rounded-lg bg-muted/35 p-3 text-sm font-medium"
                >
                  地点
                  <Input
                    id="locations"
                    value={locations}
                    onChange={(event) => setLocations(event.target.value)}
                    placeholder="上海、苏州"
                  />
                  {modeSelect('location-mode', locationMode, setLocationMode)}
                </label>
                <label
                  htmlFor="resume-keywords"
                  className="space-y-2 rounded-lg bg-muted/35 p-3 text-sm font-medium sm:col-span-2"
                >
                  简历原文补充要求
                  <Input
                    id="resume-keywords"
                    value={resumeKeywords}
                    onChange={(event) => setResumeKeywords(event.target.value)}
                    placeholder="跨境电商、海外市场、B2B；支持逗号或顿号分隔"
                  />
                  {modeSelect('keyword-mode', keywordMode, setKeywordMode)}
                </label>
              </div>
            </details>
          </fieldset>

          <fieldset className="space-y-4 rounded-lg border p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <legend className="text-sm font-semibold">
                  智能同义词（可选）
                </legend>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  只需填写一个要识别的词语，大语言模型会生成候选同义词；预览确认后才会写入规则。
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={addSemanticRule}
              >
                <Plus aria-hidden="true" />
                添加智能条件
              </Button>
            </div>

            {semanticRules.length === 0 ? (
              <p className="rounded-lg bg-muted/35 p-3 text-xs text-muted-foreground">
                用于识别 BOSS
                选项无法表达的具体经历或同义说法；当前为观察模式，不改变通过或淘汰结论。
              </p>
            ) : (
              <div className="space-y-3">
                {semanticRules.map((semanticRule, index) => {
                  const appliedAliases = Object.values(
                    parseSemanticAliases(semanticRule.aliases),
                  ).flat();
                  const preview =
                    synonymPreview?.index === index ? synonymPreview : null;
                  return (
                    <div
                      key={semanticRule.criterionId}
                      className="space-y-3 rounded-lg border bg-muted/20 p-3"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold">
                          智能条件 {index + 1}
                        </span>
                        <Button
                          type="button"
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`删除智能条件 ${index + 1}`}
                          onClick={() => {
                            setSemanticRules((current) =>
                              current.filter(
                                (_, itemIndex) => itemIndex !== index,
                              ),
                            );
                            if (synonymPreview?.index === index)
                              setSynonymPreview(null);
                          }}
                        >
                          <Trash2 aria-hidden="true" />
                        </Button>
                      </div>

                      {semanticRule.executionMode === 'normalized_entity' ? (
                        <>
                          <label
                            htmlFor={`semantic-values-${index}`}
                            className="grid gap-1.5 text-sm font-medium"
                          >
                            要识别的内容
                            <Input
                              id={`semantic-values-${index}`}
                              value={semanticRule.expectedValues}
                              onChange={(event) => {
                                updateSemanticRule(index, {
                                  expectedValues: event.target.value,
                                });
                                setSynonymPreview(null);
                                setSynonymError(null);
                              }}
                              placeholder="例如：跨境电商"
                            />
                            <span className="text-xs font-normal text-muted-foreground">
                              一次填写一个；需要识别多个内容时，再添加一个智能条件。
                            </span>
                          </label>
                          <label
                            htmlFor={`semantic-label-${index}`}
                            className="grid gap-1.5 text-sm font-medium"
                          >
                            筛选说明（可选）
                            <Input
                              id={`semantic-label-${index}`}
                              value={semanticRule.label}
                              onChange={(event) =>
                                updateSemanticRule(index, {
                                  label: event.target.value,
                                })
                              }
                              placeholder="例如：具有跨境电商工作经历"
                            />
                          </label>

                          <Button
                            type="button"
                            variant="secondary"
                            className="w-full sm:w-auto"
                            disabled={generatingSynonymsFor !== null}
                            onClick={() => void generateSynonymPreview(index)}
                          >
                            {generatingSynonymsFor === index ? (
                              <LoaderCircle
                                className="animate-spin"
                                aria-hidden="true"
                              />
                            ) : (
                              <Sparkles aria-hidden="true" />
                            )}
                            {generatingSynonymsFor === index
                              ? '正在生成同义词'
                              : appliedAliases.length > 0
                                ? '重新生成同义词'
                                : '一键用大语言模型生成同义词'}
                          </Button>

                          {appliedAliases.length > 0 ? (
                            <div className="rounded-lg border border-success/25 bg-accent/45 p-3">
                              <p className="flex items-center gap-2 text-xs font-semibold text-accent-foreground">
                                <Check className="size-4" aria-hidden="true" />
                                已应用到规则
                              </p>
                              <div className="mt-2 flex flex-wrap gap-2">
                                {appliedAliases.map((alias) => (
                                  <span
                                    key={alias}
                                    className="rounded-full border bg-card px-2.5 py-1 text-xs"
                                  >
                                    {alias}
                                  </span>
                                ))}
                              </div>
                            </div>
                          ) : null}

                          {preview ? (
                            <section
                              aria-label="AI 生成同义词预览"
                              className="rounded-lg border border-primary/30 bg-primary/5 p-3"
                            >
                              <p className="text-sm font-semibold">
                                AI 生成预览
                              </p>
                              <p className="mt-1 text-xs text-muted-foreground">
                                目标词：{preview.term} · 模型：{preview.model}
                              </p>
                              <div className="mt-3 flex flex-wrap gap-2">
                                {preview.aliases.map((alias) => (
                                  <span
                                    key={alias}
                                    className="rounded-full border bg-card px-2.5 py-1 text-xs"
                                  >
                                    {alias}
                                  </span>
                                ))}
                              </div>
                              <p className="mt-3 text-xs leading-5 text-muted-foreground">
                                以上内容由 AI
                                生成，应用前请确认它们与目标词含义一致。
                              </p>
                              <div className="mt-3 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                                <Button
                                  type="button"
                                  variant="outline"
                                  onClick={() => setSynonymPreview(null)}
                                >
                                  取消
                                </Button>
                                <Button
                                  type="button"
                                  onClick={applySynonymPreview}
                                >
                                  应用这些同义词
                                </Button>
                              </div>
                            </section>
                          ) : null}

                          {synonymError?.index === index && !preview ? (
                            <p
                              role="alert"
                              className="rounded-lg bg-destructive/8 p-3 text-sm text-destructive"
                            >
                              {synonymError.message}
                            </p>
                          ) : null}

                          <details className="rounded-lg border bg-card p-3">
                            <summary className="cursor-pointer text-sm font-medium">
                              高级设置
                            </summary>
                            <div className="mt-3 grid gap-3 sm:grid-cols-2">
                              <label
                                htmlFor={`semantic-value-mode-${index}`}
                                className="grid gap-1.5 text-xs font-medium"
                              >
                                多词匹配方式
                                <NativeSelect
                                  id={`semantic-value-mode-${index}`}
                                  value={semanticRule.valueMode}
                                  onChange={(event) =>
                                    updateSemanticRule(index, {
                                      valueMode: event.target.value as RuleMode,
                                    })
                                  }
                                >
                                  <NativeSelectOption value="any">
                                    满足任一
                                  </NativeSelectOption>
                                  <NativeSelectOption value="all">
                                    必须全部
                                  </NativeSelectOption>
                                </NativeSelect>
                              </label>
                              <label
                                htmlFor={`semantic-confidence-${index}`}
                                className="grid gap-1.5 text-xs font-medium"
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
                              <label
                                htmlFor={`semantic-aliases-${index}`}
                                className="grid gap-1.5 text-xs font-medium sm:col-span-2"
                              >
                                手动调整同义词
                                <Textarea
                                  id={`semantic-aliases-${index}`}
                                  value={semanticRule.aliases}
                                  onChange={(event) =>
                                    updateSemanticRule(index, {
                                      aliases: event.target.value,
                                    })
                                  }
                                  placeholder="跨境电商=海外电商|出海电商"
                                />
                                <span className="font-normal text-muted-foreground">
                                  每行格式：目标词=同义词1|同义词2。一般不需要手动修改。
                                </span>
                              </label>
                            </div>
                          </details>
                        </>
                      ) : (
                        <div className="space-y-3">
                          <p className="rounded-lg bg-warning/10 p-3 text-xs text-muted-foreground">
                            这是已有的复杂经历判断条件，将原样保留。建议由负责人核对后再修改。
                          </p>
                          <label
                            htmlFor={`semantic-label-${index}`}
                            className="grid gap-1.5 text-sm font-medium"
                          >
                            条件名称
                            <Input
                              id={`semantic-label-${index}`}
                              value={semanticRule.label}
                              onChange={(event) =>
                                updateSemanticRule(index, {
                                  label: event.target.value,
                                })
                              }
                            />
                          </label>
                          <label
                            htmlFor={`semantic-rubric-${index}`}
                            className="grid gap-1.5 text-sm font-medium"
                          >
                            判断说明
                            <Textarea
                              id={`semantic-rubric-${index}`}
                              value={semanticRule.rubric}
                              onChange={(event) =>
                                updateSemanticRule(index, {
                                  rubric: event.target.value,
                                })
                              }
                            />
                          </label>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </fieldset>

          {legacyMode ? (
            <label
              htmlFor="missing-policy"
              className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/35 p-3 text-sm font-medium"
            >
              信息缺失时
              <NativeSelect
                id="missing-policy"
                value={missingPolicy}
                onChange={(event) =>
                  setMissingPolicy(event.target.value as MissingPolicy)
                }
              >
                <NativeSelectOption value="manual_review">
                  进入人工复核
                </NativeSelectOption>
                <NativeSelectOption value="fail">视为不符合</NativeSelectOption>
                <NativeSelectOption value="ignore">
                  忽略该条件
                </NativeSelectOption>
              </NativeSelect>
              <span className="text-xs font-normal text-muted-foreground">
                BOSS 院校标签缺失始终视为不匹配，不从学校名称推断。
              </span>
            </label>
          ) : (
            <p className="rounded-lg border bg-muted/35 p-3 text-sm leading-6">
              完整简历中未找到符合要求的明确证据，或识别结果不足以确认符合时，判为未通过。简历读取异常会先重试。
            </p>
          )}

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter className="sticky -bottom-6 z-10 -mx-6 border-t bg-card px-6 py-4">
            <Button
              type="button"
              variant="outline"
              disabled={submitting}
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? (
                <LoaderCircle className="animate-spin" aria-hidden="true" />
              ) : null}
              {submitting
                ? '正在保存'
                : canPublish
                  ? '保存并立即生效'
                  : '提交负责人发布'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
