'use client';

import { useDashboardState } from './dashboard-state';
import {
  describeBossFilters,
  planBossRecommendationFilters,
} from '../../../packages/contracts/src/boss-recommendation-filters';
import { TaskProgress } from './task-progress';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  BriefcaseBusiness,
  CalendarClock,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Hand,
  LoaderCircle,
  MessageSquareText,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  SearchCheck,
  Send,
  Settings2,
  ShieldCheck,
  UsersRound,
  XCircle,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { CandidateInbox } from './candidate-inbox';
import { CandidateReviewDialog } from './candidate-review-dialog';
import { candidateRuleConfidenceLabel } from './candidate-confidence';
import { candidateScreeningPresentation } from './candidate-screening-presentation';
import {
  ContactPreviewDialog,
  type ContactActionKind,
} from './contact-preview-dialog';
import { BatchContactWorkspace } from './batch-contact-workspace';
import { recruitmentConfigSchema } from '../../../packages/contracts/src/recruitment';
import { PositionEditDialog } from './position-edit-dialog';
import { PositionRuleDialog } from './position-rule-dialog';
import { canRetryResumeScreening } from './resume-screening-error';
import {
  ScreeningCountField,
  validScreeningCount,
} from './screening-count-field';
import { DEFAULT_SCREENING_LIMIT } from '../../../packages/contracts/src/screening-limit';
import { ScheduleDialog } from './schedule-dialog';
import {
  semanticProviderDisplayStatus,
  type SemanticProviderReadiness,
  type SemanticSummary,
} from './semantic-status';
import { AuthGate, useCurrentUser } from './auth-gate';
import { apiFetch, controlApi } from './api-client';
import { WorkspaceShell } from './workspace-shell';
import {
  readWorkspaceScope,
  resolveWorkspaceScope,
  saveWorkspaceScope,
  taskWorkspaceHref,
} from './workspace-scope';
import { NativeLink as Link } from './native-link';
import { LoadingState } from './workspace-ui';
import {
  contactRuntimePresentation,
  safeIdentifierLabel,
  taskNextAction,
  taskNeedsFilterUpdate,
} from './hr-display';
import {
  type DepartmentRole,
  type DashboardPage,
} from './workspace-navigation';

export type { DashboardPage } from './workspace-navigation';

type Position = {
  id: string;
  name: string;
  bossJobKeyword?: string | null;
  bossJobId?: string | null;
  bossJobStatus?: string | null;
  bossSyncedAt?: string | null;
  status?: 'active' | 'paused' | 'closed';
  ownerName?: string;
  semanticMode: 'off' | 'shadow' | 'active';
};
type ActiveRule = {
  positionId: string;
  id: string;
  version: number;
  config: unknown;
  dictionaryVersion: string;
  createdAt: string;
};
type LatestRule = ActiveRule & {
  status: 'draft' | 'pending_approval' | 'published' | 'retired';
  active: boolean;
};
type Task = {
  id: string;
  version: number;
  positionId: string;
  positionName: string;
  status:
    | 'queued'
    | 'running'
    | 'screening'
    | 'waiting_review'
    | 'completed'
    | 'failed'
    | 'cancelled';
  source: 'recommend' | 'search';
  executionMode?: 'immediate' | 'scheduled';
  ruleVersion: number;
  dictionaryVersion: string;
  candidateCount: number;
  candidateLimit?: number;
  errorMessage: string | null;
  createdAt: string;
  waitReasonCode?: string | null;
  waitReason?: string | null;
  nextRunAt?: string | null;
  nextAction?: string | null;
  newCandidateCount?: number;
  repeatCandidateCount?: number;
};
export type Candidate = {
  assessment?:
    | import('../../../packages/contracts/src/recruitment').CandidateAssessmentView
    | null;
  salaryScreening?:
    | import('../../../packages/contracts/src/recruitment').SalaryScreening
    | null;
  stateId: string;
  taskId: string;
  positionId: string;
  name: string;
  positionName: string;
  ruleDecision: 'matched' | 'not_matched' | 'ambiguous' | 'insufficient';
  ruleConfidence: number;
  stateVersion: number;
  resumeScreeningStatus:
    | 'not_requested'
    | 'queued'
    | 'processing'
    | 'screened'
    | 'no_text'
    | 'failed';
  currentEnglishLevel: string | null;
  resumeScreenedAt: string | null;
  resumeScreeningError: string | null;
  failedRuleLabels: string[];
  missingRuleLabels?: string[];
  semanticSummary: SemanticSummary;
  evidence: string[];
  fields: Record<string, string>;
  reviewStatus: 'pending' | 'approved' | 'rejected' | 'not_required';
  contactStatus:
    | 'not_contacted'
    | 'queued'
    | 'sent'
    | 'simulated'
    | 'failed'
    | 'uncertain';
  isRepeat?: boolean;
  firstSeenAt?: string | null;
  resumeScreeningErrorCode?: string | null;
  resumeScreeningNextAttemptAt?: string | null;
  nextAction?: string | null;
};
type Schedule = {
  candidateLimit?: number;
  id: string;
  positionName: string;
  frequency: 'once' | 'daily' | 'weekdays' | 'weekly';
  nextRunAt: string;
  enabled: boolean;
  version: number;
};
type ContactIntent = {
  id: string;
  actionKind: ContactActionKind;
  taskId: string;
  candidateStateId: string;
  candidateId: string;
  candidateName: string;
  positionName: string;
  bossAccountId: string;
  templateVersionId: string | null;
  providerJobId: string | null;
  providerGreetingId: string | null;
  renderedMessage: string;
  renderedMessageSha256: string;
  sourceLocatorSha256: string | null;
  transportMode: 'fake' | 'real';
  status:
    | 'ready'
    | 'processing'
    | 'sent'
    | 'simulated'
    | 'failed'
    | 'uncertain'
    | 'cancelled';
  version: number;
  createdAt: string;
  lastError: string | null;
};
type AuditLog = {
  id: string;
  actorId: string;
  action: string;
  resourceType?: string;
  createdAt: string;
};
export type DashboardData = {
  runtime?: {
    state: string;
    updatedAt: string | null;
    workerHeartbeatFresh: boolean;
    browserAuthenticated: boolean;
    consistent: boolean;
  };
  currentUser: {
    role: 'admin' | 'recruiting_lead' | 'recruiter' | 'interviewer';
  };
  realGreetingEnabled: boolean;
  contactDispatchMode: 'disabled' | 'fake' | 'real';
  sideEffectsMode:
    | 'preview_only'
    | 'fake_only'
    | 'real_greet_enabled'
    | 'real_enabled';
  semanticProviderReadiness: SemanticProviderReadiness;
  metrics: {
    totalCandidates: number;
    matchedCandidates: number;
    pendingReview: number;
    contactedToday: number;
  };
  positions: Position[];
  activeRules: ActiveRule[];
  latestRules: LatestRule[];
  tasks: Task[];
  candidates: Candidate[];
  schedules: Schedule[];
  contactIntents: ContactIntent[];
  auditLogs: AuditLog[];
};

type JsonRecord = Record<string, unknown>;

function jsonRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function stringValues(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function ruleLeaves(value: unknown): JsonRecord[] {
  const node = jsonRecord(value);
  if (!node) return [];
  if (!Array.isArray(node.children)) return [node];
  return node.children.flatMap(ruleLeaves);
}

const educationLabels: Record<string, string> = {
  high_school: '高中/中专',
  associate: '专科',
  bachelor: '本科',
  master: '硕士',
  doctor: '博士',
};

function scalarLabel(value: unknown, fallback: string): string {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : fallback;
}

function describeActiveRule(rule: ActiveRule | undefined): string[] {
  const config = jsonRecord(rule?.config);
  if (!config) return [];
  if (Array.isArray(config.requiredCapabilities)) {
    const capability = jsonRecord(config.requiredCapabilities[0]);
    const confidence =
      typeof capability?.minimumConfidence === 'number'
        ? ` · 置信度 ${Math.round(capability.minimumConfidence * 100)}%`
        : '';
    return [`TEM8 英语专业八级${confidence}`];
  }
  const root = jsonRecord(config.root);
  const supplementary = ruleLeaves(root).map((node) => {
    if (
      node.type === 'tem8' ||
      (node.type === 'capability' && node.capability === 'tem8')
    ) {
      const confidence =
        typeof node.minimumConfidence === 'number'
          ? ` · 置信度 ${Math.round(node.minimumConfidence * 100)}%`
          : '';
      return `TEM8 英语专业八级${confidence}`;
    }
    if (node.type === 'english_credential') {
      const labels: Record<string, string> = {
        cet6: 'CET6 大学英语六级',
        tem8: 'TEM8 英语专业八级',
      };
      const accepted = stringValues(node.accepted).map(
        (value) => labels[value] ?? value,
      );
      return `英语证书：${accepted.join(node.mode === 'all' ? ' 且 ' : ' 或 ')}`;
    }
    if (node.type === 'enum' && node.field === 'bossPlatformTags') {
      return `BOSS 院校标签：${stringValues(node.values).join('、')}（${node.mode === 'all' ? '全部' : '任一'}）`;
    }
    if (node.type === 'range' && node.field === 'yearsOfExperience') {
      return `工作经验：${scalarLabel(node.minimum, '不限')}–${scalarLabel(node.maximum, '不限')} 年`;
    }
    if (node.type === 'range' && node.field === 'age') {
      return `年龄：${scalarLabel(node.minimum, '不限')}–${scalarLabel(node.maximum, '不限')} 岁`;
    }
    if (node.type === 'range' && node.field === 'graduationYear') {
      return `毕业年份：${scalarLabel(node.minimum, '不限')}–${scalarLabel(node.maximum, '不限')}`;
    }
    if (node.type === 'graduate_status') {
      const values = stringValues(node.values);
      if (values.includes('current_or_upcoming_graduate'))
        return '应届要求：仅应届或即将毕业';
      if (values.includes('experienced')) return '应届要求：仅往届或有工作经历';
      return '应届要求：不限';
    }
    if (node.type === 'education_level') {
      return `最低学历：${educationLabels[String(node.minimum)] ?? String(node.minimum)}`;
    }
    if (node.type === 'keyword' && node.field === 'skills') {
      return `技能：${stringValues(node.values).join('、')}（${node.mode === 'all' ? '全部' : '任一'}）`;
    }
    if (node.type === 'enum' && node.field === 'location') {
      return `地点：${stringValues(node.values).join('、')}（${node.mode === 'all' ? '全部' : '任一'}）`;
    }
    if (node.type === 'enum' && node.field === 'gender') {
      return `性别：${stringValues(node.values).join('、')}`;
    }
    if (node.type === 'keyword' && node.field === 'all') {
      return `全文关键词：${stringValues(node.values).join('、')}（${node.mode === 'all' ? '全部' : '任一'}）`;
    }
    if (node.type === 'semantic') {
      const expected = stringValues(node.expectedValues);
      const aliases = jsonRecord(node.aliases);
      const aliasCount = aliases
        ? Object.values(aliases).flatMap(stringValues).length
        : 0;
      if (node.executionMode === 'semantic_rubric') {
        return `智能判断：${scalarLabel(node.label, '复杂经历条件')}`;
      }
      return `智能同义词：${expected.join('、') || scalarLabel(node.label, '未命名条件')}${aliasCount > 0 ? `（已应用 ${aliasCount} 个同义词）` : ''}`;
    }
    return `自定义条件：${scalarLabel(node.field, scalarLabel(node.type, '未命名'))}`;
  });
  if (config.screeningFlow === 'boss_then_resume')
    return [
      `BOSS 官方筛选：${describeBossFilters(planBossRecommendationFilters(config))}`,
      ...supplementary.map((item) => `补充核验：${item}`),
      ...(supplementary.length ? [] : ['无额外要求，保留完整简历供人工审核']),
    ];
  return supplementary;
}

function activeRuleOperator(rule: ActiveRule | undefined): string {
  const config = jsonRecord(rule?.config);
  if (Array.isArray(config?.requiredCapabilities)) return '全部条件（AND）';
  const root = jsonRecord(config?.root);
  if (config?.screeningFlow === 'boss_then_resume')
    return 'BOSS 官方筛选 + 补充核验';
  return root?.operator === 'OR' ? '任一条件（OR）' : '全部条件（AND）';
}

function ruleContainsSemantic(rule: { config: unknown } | undefined): boolean {
  const config = jsonRecord(rule?.config);
  const root = jsonRecord(config?.root);
  return ruleLeaves(root).some((node) => node.type === 'semantic');
}

function semanticModeLabel(mode: Position['semanticMode']): string {
  if (mode === 'active') return '智能识别已生效';
  if (mode === 'shadow') return '智能识别试运行';
  return '智能识别未启用';
}

const pageCopy: Record<
  DashboardPage,
  { eyebrow: string; title: string; description: string }
> = {
  overview: {
    eyebrow: '今日招聘运营',
    title: '工作台总览',
    description: '查看正在推进的招聘，优先处理需要你决定的候选人。',
  },
  positions: {
    eyebrow: '招聘配置',
    title: '岗位设置',
    description: '在一个页面完成岗位信息、筛选规则和当前生效版本管理。',
  },
  tasks: {
    eyebrow: '执行中心',
    title: '筛选任务与计划',
    description: '立即执行筛选，或安排一次、每日、工作日和每周任务。',
  },
  candidates: {
    eyebrow: '人工决策',
    title: '候选人审核',
    description: '筛选名单、查看原文、连续审核，所有结果都保留在所属任务中。',
  },
  contacts: {
    eyebrow: '受控联系',
    title: '联系与消息模板',
    description: '维护岗位消息模板、审核预览并跟踪联系执行结果。',
  },
  audit: {
    eyebrow: '风险与追溯',
    title: '审计与安全',
    description: '查看关键动作记录和当前自动化安全边界。',
  },
};

const taskStatus: Record<Task['status'], string> = {
  queued: '等待处理',
  running: '读取候选人',
  screening: '完整简历精筛',
  waiting_review: '待人工审核',
  completed: '已完成',
  failed: '执行失败',
  cancelled: '已取消',
};
const ruleStatusLabel: Record<LatestRule['status'], string> = {
  draft: '草稿',
  pending_approval: '等待负责人发布',
  published: '已发布',
  retired: '已退役',
};

const frequencyLabel: Record<Schedule['frequency'], string> = {
  once: '仅一次',
  daily: '每天',
  weekdays: '工作日',
  weekly: '每周',
};
const contactStatusLabel: Record<
  ContactIntent['status'] | Candidate['contactStatus'],
  string
> = {
  not_contacted: '未联系',
  queued: '等待执行',
  ready: '等待执行',
  processing: '执行中',
  sent: '已联系',
  simulated: '模拟完成',
  failed: '失败',
  uncertain: '待人工核验',
  cancelled: '已取消',
};
const contactActionLabel: Record<ContactActionKind, string> = {
  greet: '打招呼',
  message: '发消息',
};
const activeContactIntentStatuses: ReadonlySet<ContactIntent['status']> =
  new Set(['ready', 'processing', 'sent', 'uncertain']);
const auditActionLabel: Record<string, string> = {
  'rule.version.created': '创建规则版本',
  'task.immediate.requested': '创建立即筛选任务',
  'task.collection.completed': '完成候选人采集',
  'candidate.review.approved': '审核通过候选人',
  'candidate.review.rejected': '审核拒绝候选人',
  'candidate.resume_viewed': '已安全查看简历',
  'candidate.resume_screened': '完成简历精筛',
  'candidate.resume_screening.no_text': '简历未识别到正文',
  'candidate.resume_screening.failed': '简历精筛失败',
  'candidate.resume_screening.deferred': '简历精筛已顺延',
  'candidate.resume_screening.retry_authorized': '允许重试简历精筛',
  'candidate.resume_screening.requeued': '重新加入简历精筛',
  'candidate.resume_view_quota.reset': '重置本轮简历查看软额度',
  'schedule.created': '创建定时计划',
  'schedule.cancelled': '停用定时计划',
  'contact.intent.created': '创建联系意图',
  'contact.sent': '联系成功',
  'contact.simulated': '模拟联系完成',
  'contact.failed': '联系失败',
  'contact.uncertain': '联系结果待核验',
  'contact.uncertain.resolved_not_sent': '核验确认未发送',
};
const auditResourceLabel: Record<string, string> = {
  position: '岗位',
  task: '筛选任务',
  schedule: '定时计划',
  candidate: '候选人',
  candidate_position_state: '候选人岗位申请',
  contact_intent: '联系任务',
  boss_account: 'BOSS 账号',
  department: '部门',
};

async function responseJson<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as T & { message?: string };
  if (!response.ok)
    throw new Error(payload.message ?? `HTTP ${response.status}`);
  return payload;
}

function SectionEmpty({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="px-4 py-12 text-center">
      <p className="text-sm font-medium">{title}</p>
      <p className="mt-1 text-xs text-muted-foreground">{description}</p>
    </div>
  );
}

const candidatePageSize = 25;

function PaginationFooter({
  page,
  totalItems,
  onPageChange,
}: {
  page: number;
  totalItems: number;
  onPageChange: (page: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(totalItems / candidatePageSize));
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-between border-t px-4 py-3">
      <p className="text-xs text-muted-foreground">
        共 {totalItems} 人 · 第 {page}/{totalPages} 页
      </p>
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          <ChevronLeft />
          上一页
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
        >
          下一页
          <ChevronRight />
        </Button>
      </div>
    </div>
  );
}

function AuthenticatedDashboardClient({ page }: { page: DashboardPage }) {
  const authUser = useCurrentUser();
  const currentHref = page === 'overview' ? '/' : `/${page}`;
  const {
    data,
    error: loadError,
    refresh: loadDashboard,
  } = useDashboardState();
  const dashboardLoadFailed = loadError !== null;
  const scope = useRef<{ positionId: string; taskId: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creatingTask, setCreatingTask] = useState(false);
  const [createdTask, setCreatedTask] = useState<Task | null>(null);
  const [taskActionId, setTaskActionId] = useState<string | null>(null);
  const [retryingCandidateId, setRetryingCandidateId] = useState<string | null>(
    null,
  );
  const [selectedPositionId, setSelectedPositionId] = useState('');
  const [candidateTaskId, setCandidateTaskId] = useState('');
  const [approvedCandidatePage, setApprovedCandidatePage] = useState(1);
  const [syncingPositions, setSyncingPositions] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [positionEditDialogOpen, setPositionEditDialogOpen] = useState(false);
  const [positionRuleEditDialogOpen, setPositionRuleEditDialogOpen] =
    useState(false);
  const [publishingRule, setPublishingRule] = useState(false);
  const [scheduleDialogOpen, setScheduleDialogOpen] = useState(false);
  const [screeningCount, setScreeningCount] = useState(
    String(DEFAULT_SCREENING_LIMIT),
  );
  const [reviewDialogOpen, setReviewDialogOpen] = useState(false);
  const [reviewQueue, setReviewQueue] = useState<string[]>([]);
  const [contactDialogOpen, setContactDialogOpen] = useState(false);
  const [contactActionKind, setContactActionKind] =
    useState<ContactActionKind>('message');
  const [verifyingContactIntentId, setVerifyingContactIntentId] = useState<
    string | null
  >(null);
  const [contactIntentToVerify, setContactIntentToVerify] =
    useState<ContactIntent | null>(null);
  const [contactVerificationAcknowledged, setContactVerificationAcknowledged] =
    useState(false);
  const [contactVerificationError, setContactVerificationError] = useState<
    string | null
  >(null);
  const [selectedCandidateStateId, setSelectedCandidateStateId] = useState<
    string | null
  >(null);

  useEffect(() => {
    if (!data) return;
    function applyScope(fromLink = false) {
      if (!data) return;
      const next = resolveWorkspaceScope(
        data,
        fromLink
          ? readWorkspaceScope(authUser.userId)
          : (scope.current ?? readWorkspaceScope(authUser.userId)),
        createdTask,
      );
      scope.current = next;
      setSelectedPositionId(next.positionId);
      setCandidateTaskId(next.taskId);
    }
    const timer = window.setTimeout(() => applyScope(), 0);
    const navigated = () => applyScope(true);
    window.addEventListener('boss-forge:workspace-navigated', navigated);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('boss-forge:workspace-navigated', navigated);
    };
  }, [data, authUser.userId, createdTask]);

  function selectPosition(positionId: string) {
    if (!data) return;
    setCreatedTask(null);
    const next = resolveWorkspaceScope(data, { positionId });
    scope.current = next;
    setSelectedPositionId(next.positionId);
    setCandidateTaskId(next.taskId);
    setApprovedCandidatePage(1);
  }

  function selectTask(taskId: string) {
    const task = data?.tasks.find((item) => item.id === taskId);
    if (!task) return;
    setCreatedTask(null);
    scope.current = { positionId: task.positionId, taskId };
    setSelectedPositionId(task.positionId);
    setCandidateTaskId(taskId);
    setApprovedCandidatePage(1);
  }

  useEffect(() => {
    if (data && selectedPositionId)
      saveWorkspaceScope(authUser.userId, {
        positionId: selectedPositionId,
        taskId: candidateTaskId,
      });
  }, [authUser.userId, data, selectedPositionId, candidateTaskId]);

  const position =
    data?.positions.find((item) => item.id === selectedPositionId) ??
    data?.positions[0];
  const activeRule = data?.activeRules.find(
    (item) => item.positionId === position?.id,
  );
  const latestRule = data?.latestRules.find(
    (item) => item.positionId === position?.id,
  );
  const activeRuleDescriptions = describeActiveRule(activeRule);
  const briefResult = recruitmentConfigSchema.safeParse(
    (activeRule?.config as { recruitment?: unknown } | null)?.recruitment,
  );
  const recruitmentBrief = briefResult.success ? briefResult.data : null;
  const latestTask =
    (page === 'tasks'
      ? data?.tasks.find(
          (item) =>
            item.id === candidateTaskId && item.positionId === position?.id,
        )
      : undefined) ??
    (createdTask?.id === candidateTaskId &&
    createdTask.positionId === position?.id
      ? createdTask
      : undefined) ??
    data?.tasks.find((item) => item.positionId === position?.id);
  const candidateTask = data?.tasks.find((item) => item.id === candidateTaskId);
  const selectedCandidate = data?.candidates.find(
    (candidate) => candidate.stateId === selectedCandidateStateId,
  );
  const latestTaskGuidance = latestTask
    ? taskNextAction({
        status: latestTask.status,
        waitingReason: latestTask.waitReasonCode ?? latestTask.waitReason,
        nextAction: latestTask.nextAction,
        retryAt: latestTask.nextRunAt,
        errorMessage: latestTask.errorMessage,
      })
    : null;
  const taskCandidates =
    data?.candidates.filter(
      (candidate) => candidate.taskId === candidateTaskId,
    ) ?? [];
  const approvedCandidates = taskCandidates.filter(
    (candidate) => candidate.reviewStatus === 'approved',
  );
  const taskContactIntents =
    data?.contactIntents.filter(
      (intent) => intent.taskId === candidateTaskId,
    ) ?? [];
  const visibleApprovedCandidates = approvedCandidates.slice(
    (approvedCandidatePage - 1) * candidatePageSize,
    approvedCandidatePage * candidatePageSize,
  );
  const activeSchedules = data?.schedules.filter((item) => item.enabled) ?? [];
  const pageInfo = pageCopy[page];
  const canManageSettings =
    data?.currentUser.role === 'admin' ||
    data?.currentUser.role === 'recruiting_lead';
  const auditActorLabel = (actorId: string) => {
    if (actorId === authUser.userId) return authUser.displayName;
    if (actorId.startsWith('hr:')) return 'HR 工作台';
    if (actorId.includes('worker') || actorId.startsWith('system:'))
      return '系统后台';
    return safeIdentifierLabel(actorId);
  };
  const contactMode = contactRuntimePresentation({
    loaded: data !== null,
    requestFailed: dashboardLoadFailed,
    realGreetingEnabled: data?.realGreetingEnabled,
    contactDispatchMode: data?.contactDispatchMode,
    sideEffectsMode: data?.sideEffectsMode,
  });
  const semanticProviderStatus = semanticProviderDisplayStatus(
    data?.semanticProviderReadiness ?? {
      enabled: false,
      ready: false,
      reason: 'disabled',
      endpointHost: null,
      model: null,
      credentialConfigured: false,
      timeoutMs: null,
    },
  );
  const metrics = useMemo(
    () => [
      {
        label: '已采集候选人',
        value: data?.metrics.totalCandidates ?? 0,
        note: '去重后',
        icon: SearchCheck,
      },
      {
        label: '规则通过',
        value: data?.metrics.matchedCandidates ?? 0,
        note: '按当前岗位规则',
        icon: CheckCircle2,
      },
      {
        label: '待人工审核',
        value: data?.metrics.pendingReview ?? 0,
        note: '需处理',
        icon: UsersRound,
      },
      {
        label: '今日已联系',
        value: data?.metrics.contactedToday ?? 0,
        note: '人工确认',
        icon: MessageSquareText,
      },
    ],
    [data],
  );

  async function syncBossPositions() {
    if (syncingPositions) return;
    setSyncingPositions(true);
    setSyncMessage(null);
    setError(null);
    try {
      const response = await apiFetch(`${controlApi}/api/boss/positions/sync`, {
        method: 'POST',
      });
      const result = await responseJson<{
        count: number;
        created: number;
        linked: number;
      }>(response);
      setSyncMessage(
        `已同步 ${result.count} 个 BOSS 岗位，新增 ${result.created} 个${result.linked ? `，已关联 ${result.linked} 个原有岗位并保留规则` : ''}。选择岗位后即可配置各自的筛选规则。`,
      );
      await loadDashboard();
    } catch (syncError) {
      setError(
        syncError instanceof Error ? syncError.message : String(syncError),
      );
    } finally {
      setSyncingPositions(false);
    }
  }

  async function createImmediateTask() {
    if (
      !position?.bossJobId ||
      position.status !== 'active' ||
      !activeRule ||
      creatingTask ||
      !validScreeningCount(screeningCount)
    )
      return;
    setCreatingTask(true);
    setError(null);
    try {
      const response = await apiFetch(`${controlApi}/api/tasks`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': crypto.randomUUID(),
        },
        body: JSON.stringify({
          positionId: position.id,
          candidateLimit: Number(screeningCount),
          source: 'recommend',
          createdBy: 'hr:dashboard',
        }),
      });
      const payload = await responseJson<{ task: Task }>(response);
      scope.current = {
        positionId: payload.task.positionId,
        taskId: payload.task.id,
      };
      setCreatedTask(payload.task);
      setSelectedPositionId(payload.task.positionId);
      setCandidateTaskId(payload.task.id);
      setApprovedCandidatePage(1);
      await loadDashboard();
    } catch (taskError) {
      setError(
        taskError instanceof Error ? taskError.message : String(taskError),
      );
    } finally {
      setCreatingTask(false);
    }
  }

  async function requeueCandidateScreening(candidate: Candidate) {
    if (retryingCandidateId) return;
    setRetryingCandidateId(candidate.stateId);
    setError(null);
    try {
      const response = await apiFetch(
        `${controlApi}/api/candidate-position-states/${candidate.stateId}/resume-screenings`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        },
      );
      await responseJson(response);
      await loadDashboard();
    } catch (screeningError) {
      setError(
        screeningError instanceof Error
          ? screeningError.message
          : String(screeningError),
      );
    } finally {
      setRetryingCandidateId(null);
    }
  }

  async function updateTask(task: Task, action: 'cancel' | 'retry') {
    if (taskActionId) return;
    if (
      action === 'cancel' &&
      !window.confirm(
        `确认取消“${task.positionName}”的本次筛选任务？已保存的候选人和审核记录不会被删除。`,
      )
    )
      return;
    setTaskActionId(task.id);
    setError(null);
    try {
      const response = await apiFetch(
        `${controlApi}/api/tasks/${task.id}/${action}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': crypto.randomUUID(),
          },
          body: JSON.stringify({ expectedVersion: task.version }),
        },
      );
      const payload = await responseJson<{ task: Task }>(response);
      scope.current = {
        positionId: payload.task.positionId,
        taskId: payload.task.id,
      };
      await loadDashboard();
    } catch (taskError) {
      setError(
        taskError instanceof Error ? taskError.message : String(taskError),
      );
    } finally {
      setTaskActionId(null);
    }
  }

  async function verifyContactNotSent(intent: ContactIntent) {
    if (
      verifyingContactIntentId ||
      !contactVerificationAcknowledged ||
      !intent.sourceLocatorSha256
    )
      return;
    setVerifyingContactIntentId(intent.id);
    setContactVerificationError(null);
    try {
      const response = await apiFetch(
        `${controlApi}/api/contact-intents/${intent.id}/verify-not-sent`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            expectedVersion: intent.version,
            actionKind: intent.actionKind,
            candidateStateId: intent.candidateStateId,
            candidateId: intent.candidateId,
            candidateName: intent.candidateName,
            taskId: intent.taskId,
            bossAccountId: intent.bossAccountId,
            templateVersionId: intent.templateVersionId,
            providerJobId: intent.providerJobId,
            providerGreetingId: intent.providerGreetingId,
            renderedMessageSha256: intent.renderedMessageSha256,
            sourceLocatorSha256: intent.sourceLocatorSha256,
          }),
        },
      );
      await responseJson(response);
      await loadDashboard();
      setContactIntentToVerify(null);
      setContactVerificationAcknowledged(false);
    } catch (verificationError) {
      setContactVerificationError(
        verificationError instanceof Error
          ? verificationError.message
          : String(verificationError),
      );
    } finally {
      setVerifyingContactIntentId(null);
    }
  }

  async function positionCreated(positionId: string) {
    scope.current = { positionId, taskId: '' };
    setSelectedPositionId(positionId);
    await loadDashboard();
  }

  async function publishLatestRule() {
    if (!latestRule || !canManageSettings || publishingRule) return;
    setPublishingRule(true);
    setError(null);
    try {
      const response = await apiFetch(
        `${controlApi}/api/rules/versions/${latestRule.id}/lifecycle`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ status: 'published' }),
        },
      );
      await responseJson(response);
      if (ruleContainsSemantic(latestRule)) {
        const semanticModeResponse = await apiFetch(
          `${controlApi}/api/semantic/mode`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              positionId: latestRule.positionId,
              mode: 'shadow',
              catalogVersionId: null,
            }),
          },
        );
        await responseJson(semanticModeResponse);
      }
      await loadDashboard();
    } catch (publishError) {
      setError(
        publishError instanceof Error
          ? publishError.message
          : String(publishError),
      );
    } finally {
      setPublishingRule(false);
    }
  }
  function openCandidateReview(stateId: string, queue: string[] = []) {
    setReviewQueue(queue);
    setSelectedCandidateStateId(stateId);
    setReviewDialogOpen(true);
  }
  function openContactPreview(stateId: string, actionKind: ContactActionKind) {
    setSelectedCandidateStateId(stateId);
    setContactActionKind(actionKind);
    setContactDialogOpen(true);
  }

  function openContactVerification(intent: ContactIntent) {
    setContactVerificationAcknowledged(false);
    setContactVerificationError(null);
    setContactIntentToVerify(intent);
  }

  function handleContactVerificationOpenChange(nextOpen: boolean) {
    if (!nextOpen && !verifyingContactIntentId) {
      setContactIntentToVerify(null);
      setContactVerificationAcknowledged(false);
      setContactVerificationError(null);
    }
  }

  async function cancelSchedule(schedule: Schedule) {
    try {
      const response = await apiFetch(
        `${controlApi}/api/schedules/${schedule.id}/cancel`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            expectedVersion: schedule.version,
            actorId: 'hr:dashboard',
          }),
        },
      );
      await responseJson(response);
      await loadDashboard();
    } catch (cancelError) {
      setError(
        cancelError instanceof Error
          ? cancelError.message
          : String(cancelError),
      );
    }
  }

  function positionSelect() {
    return (
      <Select
        value={position?.id ?? null}
        onValueChange={(value) => selectPosition(value ?? '')}
      >
        <SelectTrigger className="h-11 min-w-44 md:h-9" aria-label="选择岗位">
          <SelectValue placeholder="选择岗位">
            {position?.name ?? '选择岗位'}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {data?.positions.map((item) => (
            <SelectItem key={item.id} value={item.id}>
              {item.name}
              {item.bossJobId &&
              data!.positions.filter((other) => other.name === item.name)
                .length > 1
                ? ` · ${item.bossJobId.slice(-8)}`
                : ''}
              {!item.bossJobId
                ? '（待关联）'
                : item.status !== 'active'
                  ? '（未开放）'
                  : ''}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  function taskScopeSelect(ariaLabel: string) {
    return (
      <Select
        value={candidateTaskId}
        onValueChange={(value) => {
          selectTask(value ?? '');
          setApprovedCandidatePage(1);
        }}
        disabled={!data?.tasks.length}
      >
        <SelectTrigger
          className="h-11 w-full min-w-0 md:h-9 md:w-auto md:max-w-[360px]"
          aria-label={ariaLabel}
        >
          <SelectValue placeholder="选择筛选任务">
            {candidateTask
              ? `${new Date(candidateTask.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })} · ${candidateTask.positionName} · ${taskStatus[candidateTask.status]}`
              : '选择筛选任务'}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {data?.tasks
            .filter((item) => item.positionId === position?.id)
            .map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {new Date(item.createdAt).toLocaleString('zh-CN', {
                  month: '2-digit',
                  day: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                })}{' '}
                · {item.positionName} · {taskStatus[item.status]}
              </SelectItem>
            ))}
        </SelectContent>
      </Select>
    );
  }

  function stopCurrentTask() {
    if (latestTask) void updateTask(latestTask, 'cancel');
  }

  function taskActions() {
    return (
      <div className="flex flex-col gap-2 md:items-end">
        <ScreeningCountField
          id="screening-count"
          value={screeningCount}
          onChange={setScreeningCount}
          disabled={creatingTask}
        />
        <div className="flex flex-wrap gap-2">
          {positionSelect()}
          {latestTask &&
          ['queued', 'running', 'screening'].includes(latestTask.status) ? (
            <Button
              variant="outline"
              size="lg"
              disabled={taskActionId !== null}
              onClick={stopCurrentTask}
            >
              停止本次筛选
            </Button>
          ) : null}
          <Button
            variant="outline"
            size="lg"
            disabled={
              !position?.bossJobId ||
              position.status !== 'active' ||
              !activeRule
            }
            data-spotlight="schedule-screening"
            onClick={() => setScheduleDialogOpen(true)}
          >
            <CalendarClock data-icon="inline-start" />
            定时筛选
          </Button>
          <Button
            size="lg"
            disabled={
              !position?.bossJobId ||
              position.status !== 'active' ||
              !activeRule ||
              creatingTask ||
              !validScreeningCount(screeningCount)
            }
            data-spotlight="start-screening"
            onClick={() => void createImmediateTask()}
          >
            {creatingTask ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <Play />
            )}
            {creatingTask
              ? '正在创建'
              : `开始筛选${validScreeningCount(screeningCount) ? ` · ${Number(screeningCount)} 人` : ''}`}
          </Button>
        </div>
        <p
          className={`text-xs ${activeRule ? 'text-muted-foreground' : 'text-warning'}`}
        >
          {!position?.bossJobId
            ? '请先到“岗位设置”同步或关联 BOSS 岗位，再开始筛选。'
            : position.status !== 'active'
              ? '该岗位当前未开放，请在 BOSS 确认状态后重新同步。'
              : activeRule
                ? `将切换到 BOSS 的“${position.name}”推荐牛人，使用规则 v${activeRule.version}`
                : '该岗位还没有生效规则，请先到“岗位设置”完成规则。'}
        </p>
      </div>
    );
  }

  return (
    <WorkspaceShell
      current={currentHref}
      title={pageInfo.title}
      description={pageInfo.description}
      status={contactMode.label}
      actions={
        <>
          {data && page === 'overview' ? (
            <div className="flex flex-wrap gap-2">
              {positionSelect()}
              <Button
                size="lg"
                disabled={
                  !position?.bossJobId || authUser.role === 'interviewer'
                }
                onClick={() => setPositionRuleEditDialogOpen(true)}
              >
                <Plus aria-hidden="true" />
                {recruitmentBrief?.purpose
                  ? '编辑招聘目标与规则'
                  : '添加岗位招聘目标'}
              </Button>
              <Button
                nativeButton={false}
                variant="outline"
                render={<Link href="/positions" />}
              >
                同步 / 选择 BOSS 岗位
              </Button>
            </div>
          ) : null}
          {data && page === 'positions' ? (
            <div className="flex flex-wrap gap-2">
              {positionSelect()}
              {canManageSettings ? (
                <Button
                  size="lg"
                  onClick={() => void syncBossPositions()}
                  disabled={syncingPositions}
                  aria-busy={syncingPositions}
                  data-spotlight="create-position"
                >
                  {syncingPositions ? (
                    <LoaderCircle className="animate-spin" aria-hidden="true" />
                  ) : (
                    <RefreshCw aria-hidden="true" />
                  )}
                  {syncingPositions ? '正在读取 BOSS 岗位' : '同步 BOSS 岗位'}
                </Button>
              ) : (
                <span
                  className="self-center text-xs text-muted-foreground"
                  data-spotlight="create-position"
                >
                  岗位由管理员同步并分配
                </span>
              )}
            </div>
          ) : null}
          {data && page === 'tasks' ? taskActions() : null}
          {data && page === 'candidates' ? (
            <div className="flex flex-wrap gap-2">
              {positionSelect()}
              {taskScopeSelect('选择候选人所属任务')}
            </div>
          ) : null}
          {data && page === 'contacts' ? (
            <div className="flex flex-wrap gap-2">
              {positionSelect()}
              {taskScopeSelect('选择联系名单所属任务')}
            </div>
          ) : null}
          {data && page === 'audit' ? (
            <Button
              variant="outline"
              size="lg"
              onClick={() => void loadDashboard()}
            >
              <RefreshCw />
              刷新日志
            </Button>
          ) : null}
        </>
      }
    >
      {error || loadError ? (
        <section
          role="alert"
          className="mb-5 flex items-center gap-3 rounded-xl border border-destructive/30 bg-destructive/8 px-4 py-3"
        >
          <p className="min-w-0 flex-1 text-sm">
            {error ? '操作未完成：' : '数据同步失败：'}
            {error ?? loadError}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setError(null);
              void loadDashboard();
            }}
          >
            <RefreshCw />
            刷新数据
          </Button>
        </section>
      ) : null}

      {!data && !loadError ? (
        <LoadingState label="正在同步岗位、任务和候选人状态…" />
      ) : null}

      {data && page === 'overview' ? (
        <>
          <section className="mb-4 rounded-xl border bg-card p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold">
                  {position?.name ?? '选择 BOSS 岗位'} · 招聘目的与目标
                </h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  明确业务目标 → BOSS 官方筛选 → 薪资与补充核验 → AI 分析排名 →
                  HR 审核与联系
                </p>
              </div>
              {recruitmentBrief?.aiEnabled ? (
                <Badge variant="secondary">
                  AI 评分已启用 · 分界{' '}
                  {recruitmentBrief.recommendationThreshold}
                </Badge>
              ) : (
                <Badge variant="outline">待配置招聘目标</Badge>
              )}
            </div>
            {recruitmentBrief?.purpose ? (
              <div className="mt-4 grid gap-4 text-sm sm:grid-cols-2">
                <div>
                  <p className="mb-1 text-xs text-muted-foreground">招聘目的</p>
                  <p className="whitespace-pre-wrap leading-6">
                    {recruitmentBrief.purpose}
                  </p>
                </div>
                <div>
                  <p className="mb-1 text-xs text-muted-foreground">期望目标</p>
                  <p className="whitespace-pre-wrap leading-6">
                    {recruitmentBrief.goals}
                  </p>
                </div>
              </div>
            ) : (
              <p className="mt-3 text-sm text-muted-foreground">
                选择已在 BOSS
                招聘的岗位，点击右上方添加招聘目标，再设置预算与筛选规则。
              </p>
            )}
          </section>
          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {metrics.map((metric) => {
              const Icon = metric.icon;
              return (
                <Card key={metric.label} size="sm">
                  <CardHeader>
                    <CardDescription>{metric.label}</CardDescription>
                    <CardAction>
                      <Icon className="size-4 text-muted-foreground" />
                    </CardAction>
                    <CardTitle className="text-2xl tabular-nums">
                      {metric.value}
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <span className="text-xs font-medium text-primary">
                      {metric.note}
                    </span>
                  </CardContent>
                </Card>
              );
            })}
          </section>
          <section className="mt-4 grid gap-4 xl:grid-cols-[1.35fr_.65fr]">
            <Card>
              <CardHeader>
                <CardTitle>当前招聘进度</CardTitle>
                <CardDescription>
                  {position?.name ?? '尚未同步岗位'} ·{' '}
                  {latestTask
                    ? `规则 v${latestTask.ruleVersion}`
                    : activeRule
                      ? `规则 v${activeRule.version}`
                      : '尚未发布规则'}
                </CardDescription>
                <CardAction>
                  {latestTask ? (
                    <Badge variant="secondary">
                      {taskStatus[latestTask.status]}
                    </Badge>
                  ) : null}
                </CardAction>
              </CardHeader>
              <CardContent className="space-y-4">
                {latestTask ? (
                  <TaskProgress
                    task={latestTask}
                    candidates={data.candidates}
                  />
                ) : null}
                <div className="grid grid-cols-3 gap-3 text-xs">
                  <div>
                    <p className="text-muted-foreground">最新任务</p>
                    <p className="mt-1 font-medium">
                      {latestTask ? taskStatus[latestTask.status] : '暂无任务'}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">已采集</p>
                    <p className="mt-1 font-medium tabular-nums">
                      {latestTask?.candidateCount ?? 0} 人
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">启用计划</p>
                    <p className="mt-1 font-medium tabular-nums">
                      {activeSchedules.length} 个
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>快捷操作</CardTitle>
                <CardDescription>从最常用的工作开始</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                <Link
                  href="/positions"
                  className="flex min-h-11 items-center gap-3 rounded-lg border px-3 py-2.5 text-sm font-medium hover:bg-muted"
                >
                  <Settings2
                    className="size-4 text-primary"
                    aria-hidden="true"
                  />
                  添加或编辑岗位规则
                  <ArrowRight className="ml-auto size-4 text-muted-foreground" />
                </Link>
                <Link
                  href="/candidates"
                  className="flex min-h-11 items-center gap-3 rounded-lg border px-3 py-2.5 text-sm font-medium hover:bg-muted"
                >
                  <UsersRound className="size-4 text-primary" />
                  处理 {data?.metrics.pendingReview ?? 0} 位待审核
                  <ArrowRight className="ml-auto size-4 text-muted-foreground" />
                </Link>
                <Link
                  href="/contacts"
                  className="flex min-h-11 items-center gap-3 rounded-lg border px-3 py-2.5 text-sm font-medium hover:bg-muted"
                >
                  <MessageSquareText className="size-4 text-primary" />
                  查看联系执行
                  <ArrowRight className="ml-auto size-4 text-muted-foreground" />
                </Link>
              </CardContent>
            </Card>
          </section>
          <section className="mt-4 grid gap-4 xl:grid-cols-[1.2fr_.8fr]">
            <Card>
              <CardHeader className="border-b">
                <CardTitle>待审核优先队列</CardTitle>
                <CardDescription>
                  优先查看已完成精筛、可以作出决定的候选人
                </CardDescription>
                <CardAction>
                  <Link
                    href="/candidates"
                    className="inline-flex min-h-11 items-center text-xs font-medium text-primary"
                  >
                    查看全部
                  </Link>
                </CardAction>
              </CardHeader>
              <CardContent className="px-0">
                {data && data.metrics.pendingReview === 0 ? (
                  <SectionEmpty
                    title="暂无待审核候选人"
                    description="创建筛选任务后，候选人会出现在这里。"
                  />
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="pl-4">候选人</TableHead>
                        <TableHead>岗位</TableHead>
                        <TableHead>结论</TableHead>
                        <TableHead className="pr-4 text-right">
                          结论置信度
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data?.candidates
                        .filter((item) => item.reviewStatus === 'pending')
                        .sort(
                          (a, b) =>
                            Number(b.resumeScreeningStatus === 'screened') -
                              Number(a.resumeScreeningStatus === 'screened') ||
                            b.ruleConfidence - a.ruleConfidence,
                        )
                        .slice(0, 5)
                        .map((candidate) => (
                          <TableRow key={candidate.stateId}>
                            <TableCell className="pl-4 font-medium">
                              <button
                                type="button"
                                className="min-h-9 text-left text-primary hover:underline"
                                onClick={() =>
                                  openCandidateReview(candidate.stateId)
                                }
                              >
                                {candidate.name}
                              </button>
                            </TableCell>
                            <TableCell>{candidate.positionName}</TableCell>
                            <TableCell>
                              <Badge variant="outline">
                                {
                                  candidateScreeningPresentation(candidate)
                                    .label
                                }
                              </Badge>
                            </TableCell>
                            <TableCell className="pr-4 text-right tabular-nums">
                              {candidateRuleConfidenceLabel(
                                candidate.ruleDecision,
                                candidate.ruleConfidence,
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>联系进度</CardTitle>
                <CardDescription>{contactMode.detail}</CardDescription>
                <CardAction>
                  {contactMode.state === 'blocked' ? (
                    <XCircle
                      className="size-4 text-destructive"
                      aria-hidden="true"
                    />
                  ) : (
                    <ShieldCheck
                      className="size-4 text-success"
                      aria-hidden="true"
                    />
                  )}
                </CardAction>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className="flex items-center justify-between">
                  <span>真实联系总开关</span>
                  <Badge
                    variant={
                      contactMode.state === 'real'
                        ? 'default'
                        : contactMode.state === 'blocked'
                          ? 'destructive'
                          : 'outline'
                    }
                  >
                    {contactMode.label}
                  </Badge>
                </div>
                <div className="flex items-center justify-between">
                  <span>等待或执行中的联系</span>
                  <span className="font-medium">
                    {data?.contactIntents.filter(
                      (item) =>
                        item.status === 'ready' || item.status === 'processing',
                    ).length ?? 0}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span>待人工核验</span>
                  <span className="font-medium">
                    {data?.contactIntents.filter(
                      (item) => item.status === 'uncertain',
                    ).length ?? 0}
                  </span>
                </div>
                <Link
                  href="/contacts"
                  className="flex min-h-11 items-center text-xs font-medium text-primary"
                >
                  查看联系记录
                  <ArrowRight className="ml-1 size-3.5" />
                </Link>
              </CardContent>
            </Card>
          </section>
        </>
      ) : null}

      {data && page === 'positions' ? (
        <section className="grid gap-4 xl:grid-cols-[1fr_.72fr]">
          <Card>
            <CardHeader className="border-b">
              <CardTitle>岗位列表</CardTitle>
              <CardDescription>
                从 BOSS
                同步招聘岗位，为每个岗位独立配置规则。发布或修改招聘信息请在
                BOSS 操作。
              </CardDescription>
              <CardAction>
                <Badge variant="outline">
                  {data?.positions.length ?? 0} 个
                </Badge>
              </CardAction>
            </CardHeader>
            <CardContent className="space-y-3 pt-4">
              {syncingPositions ? (
                <output className="flex gap-3 rounded-xl border bg-primary/5 p-4 text-sm">
                  <LoaderCircle
                    className="mt-0.5 size-4 shrink-0 animate-spin text-primary"
                    aria-hidden="true"
                  />
                  <div>
                    <p className="font-medium">
                      正在连接 BOSS 并读取完整岗位列表
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      通常需要几十秒。同步完成后列表会自动更新。
                    </p>
                  </div>
                </output>
              ) : syncMessage ? (
                <output className="block rounded-xl bg-primary/5 p-4 text-sm">
                  {syncMessage}
                </output>
              ) : null}
              {!canManageSettings ? (
                <p className="text-xs leading-5 text-muted-foreground">
                  这里只显示分配给你的岗位。缺少岗位时，请联系管理员在“团队与权限”添加你为岗位协作者。
                </p>
              ) : null}
              {data?.positions.length ? (
                data.positions.map((item) => {
                  const itemRule = data.activeRules.find(
                    (rule) => rule.positionId === item.id,
                  );
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => selectPosition(item.id)}
                      className={`flex min-h-16 w-full items-center gap-3 rounded-xl border p-4 text-left transition-colors ${position?.id === item.id ? 'border-primary/40 bg-primary/5' : 'hover:bg-muted/60'}`}
                    >
                      <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                        <BriefcaseBusiness
                          className="size-5"
                          aria-hidden="true"
                        />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold">
                          {item.name}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {item.bossJobId
                            ? item.bossJobStatus || '已同步'
                            : '旧岗位 · 待关联 BOSS'}{' '}
                          · {item.ownerName || 'HR 管理员'}
                          {item.bossJobId &&
                          data.positions.filter(
                            (other) => other.name === item.name,
                          ).length > 1
                            ? ` · ${item.bossJobId.slice(-8)}`
                            : ''}
                        </p>
                        {item.bossSyncedAt ? (
                          <p className="mt-1 text-xs text-muted-foreground">
                            同步于{' '}
                            {new Date(item.bossSyncedAt).toLocaleString(
                              'zh-CN',
                            )}
                          </p>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1.5">
                        <Badge variant={itemRule ? 'secondary' : 'outline'}>
                          {itemRule
                            ? `规则 v${itemRule.version}`
                            : '未配置规则'}
                        </Badge>
                        {ruleContainsSemantic(itemRule) ? (
                          <Badge variant="outline">
                            {semanticModeLabel(item.semanticMode)}
                          </Badge>
                        ) : null}
                      </div>
                    </button>
                  );
                })
              ) : (
                <SectionEmpty
                  title="暂无岗位"
                  description={
                    canManageSettings
                      ? '先登录 BOSS，再点击“同步 BOSS 岗位”。同步后为岗位添加筛选规则。'
                      : '请管理员同步 BOSS 岗位，并在“团队与权限”把岗位分配给你。'
                  }
                />
              )}
            </CardContent>
          </Card>
          <div className="space-y-4">
            <Card>
              <CardHeader data-spotlight="position-rules">
                <CardTitle>当前规则</CardTitle>
                <CardDescription>
                  {position?.name ?? '请选择岗位'}
                </CardDescription>
                <CardAction className="flex flex-wrap gap-2">
                  {canManageSettings ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!position}
                      onClick={() => setPositionEditDialogOpen(true)}
                    >
                      <Pencil />
                      {position?.bossJobId ? '负责人设置' : '关联 BOSS 岗位'}
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    disabled={!position}
                    onClick={() => setPositionRuleEditDialogOpen(true)}
                  >
                    <Settings2 />
                    {activeRule ? '编辑岗位规则' : '添加岗位规则'}
                  </Button>
                </CardAction>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                {position && !position.bossJobId ? (
                  <p className="rounded-xl border border-warning/30 bg-warning/5 p-3 text-sm leading-6">
                    这个旧岗位的规则和历史已保留。请先同步 BOSS
                    岗位；同名岗位会自动关联，也可以手动选择“关联 BOSS
                    岗位”。关联后才能开始新的推荐筛选。
                  </p>
                ) : null}
                {canManageSettings ? (
                  <div className="rounded-xl border bg-muted/30 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge
                        variant={
                          semanticProviderStatus.ready ? 'secondary' : 'outline'
                        }
                      >
                        智能识别（可选）
                      </Badge>
                      <span className="font-medium">
                        {semanticProviderStatus.label}
                      </span>
                    </div>
                    <p className="mt-2 text-xs leading-5 text-muted-foreground">
                      {semanticProviderStatus.detail}
                    </p>
                  </div>
                ) : null}
                {activeRule ? (
                  <>
                    <div className="rounded-xl border border-success/25 bg-accent/40 p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="secondary">
                          当前生效 · v{activeRule.version}
                        </Badge>
                        <Badge variant="outline">
                          {activeRuleOperator(activeRule)}
                        </Badge>
                        {position && ruleContainsSemantic(activeRule) ? (
                          <Badge variant="outline">
                            {semanticModeLabel(position.semanticMode)}
                          </Badge>
                        ) : null}
                      </div>
                      <p className="mt-2 text-xs leading-5 text-muted-foreground">
                        新建任务现在会固定使用这个版本；已有任务仍使用创建时的版本。
                      </p>
                    </div>
                    <div className="space-y-2" aria-label="当前生效规则条件">
                      {activeRuleDescriptions.map((description) => (
                        <div
                          key={description}
                          className="rounded-lg border bg-muted/35 p-3 font-medium"
                        >
                          {description}
                        </div>
                      ))}
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <p className="text-xs text-muted-foreground">
                          词典版本
                        </p>
                        <p className="mt-1 font-medium">
                          {activeRule.dictionaryVersion}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">
                          实际条件数
                        </p>
                        <p className="mt-1 font-medium">
                          {activeRuleDescriptions.length} 条
                        </p>
                      </div>
                    </div>
                  </>
                ) : (
                  <SectionEmpty
                    title="当前没有生效规则"
                    description="点击“添加岗位规则”，保存后即可在任务栏使用。"
                  />
                )}
                {latestRule && !latestRule.active ? (
                  <div className="rounded-xl border border-warning/30 bg-warning/8 p-3">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <p className="text-sm font-semibold">
                          待处理版本 · v{latestRule.version}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {ruleStatusLabel[latestRule.status]}
                          ；它尚未用于任何新任务。
                        </p>
                      </div>
                      {canManageSettings &&
                      (latestRule.status === 'pending_approval' ||
                        latestRule.status === 'draft') ? (
                        <Button
                          size="sm"
                          disabled={publishingRule}
                          onClick={() => void publishLatestRule()}
                        >
                          {publishingRule ? (
                            <LoaderCircle
                              className="animate-spin"
                              aria-hidden="true"
                            />
                          ) : null}
                          {publishingRule
                            ? '正在发布'
                            : `发布 v${latestRule.version}`}
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          </div>
        </section>
      ) : null}

      {data && page === 'tasks' ? (
        <>
          <section className="grid gap-4 xl:grid-cols-[1.1fr_.9fr]">
            <Card>
              <CardHeader>
                <CardTitle>当前筛选任务</CardTitle>
                <CardDescription>
                  {latestTask
                    ? `${latestTask.positionName} · ${latestTask.source === 'search' ? '搜索' : '推荐'}候选人`
                    : '尚未创建任务'}
                </CardDescription>
                <CardAction>
                  {latestTask ? (
                    <Badge variant="secondary">
                      {taskStatus[latestTask.status]}
                    </Badge>
                  ) : null}
                </CardAction>
              </CardHeader>
              <CardContent className="space-y-4">
                {latestTask ? (
                  <TaskProgress
                    task={latestTask}
                    candidates={data.candidates}
                  />
                ) : null}
                <div className="grid grid-cols-3 gap-3 text-xs">
                  <div>
                    <p className="text-muted-foreground">执行方式</p>
                    <p className="mt-1 font-medium">
                      {latestTask?.executionMode === 'scheduled'
                        ? '定时'
                        : '立即'}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">已采集</p>
                    <p className="mt-1 font-medium">
                      {latestTask?.candidateCount ?? 0} 人
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">规则版本</p>
                    <p className="mt-1 font-medium">
                      {latestTask
                        ? `v${latestTask.ruleVersion} · ${latestTask.dictionaryVersion}`
                        : '暂无'}
                    </p>
                  </div>
                </div>
                {latestTask?.errorMessage ? (
                  <details className="rounded-lg border border-destructive/25 bg-destructive/5 p-3 text-xs">
                    <summary className="cursor-pointer font-medium text-destructive">
                      查看技术错误
                    </summary>
                    <p className="mt-2 break-words leading-5 text-muted-foreground">
                      {latestTask.errorMessage}
                    </p>
                  </details>
                ) : null}
                {latestTaskGuidance ? (
                  <p className="rounded-lg border bg-muted/35 p-3 text-sm leading-6">
                    <span className="font-medium">当前情况：</span>
                    {latestTaskGuidance}
                  </p>
                ) : null}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="border-b">
                <CardTitle>定时计划</CardTitle>
                <CardDescription>统一使用 Asia/Shanghai 时区</CardDescription>
                <CardAction>
                  <Badge variant="outline">
                    {activeSchedules.length} 个启用
                  </Badge>
                </CardAction>
              </CardHeader>
              <CardContent className="space-y-2 pt-4">
                {data?.schedules.length ? (
                  data.schedules.map((schedule) => (
                    <div
                      key={schedule.id}
                      className="flex items-center gap-3 rounded-lg border px-3 py-2.5"
                    >
                      <CalendarClock className="size-4 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">
                          {schedule.positionName}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {frequencyLabel[schedule.frequency]} · 每次最多{' '}
                          {schedule.candidateLimit ?? DEFAULT_SCREENING_LIMIT}{' '}
                          人 ·{' '}
                          {new Date(schedule.nextRunAt).toLocaleString('zh-CN')}
                        </p>
                      </div>
                      {schedule.enabled ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void cancelSchedule(schedule)}
                        >
                          <XCircle />
                          停用
                        </Button>
                      ) : (
                        <Badge variant="outline">已停用</Badge>
                      )}
                    </div>
                  ))
                ) : (
                  <SectionEmpty
                    title="暂无定时计划"
                    description="点击“定时筛选”创建计划。"
                  />
                )}
              </CardContent>
            </Card>
          </section>
          <section className="mt-4">
            <Card>
              <CardHeader className="border-b">
                <CardTitle>最近任务</CardTitle>
                <CardDescription>立即与定时筛选任务统一追踪</CardDescription>
              </CardHeader>
              <CardContent className="px-0">
                {data?.tasks.length ? (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="pl-4">岗位</TableHead>
                        <TableHead>实际规则版本</TableHead>
                        <TableHead>候选人</TableHead>
                        <TableHead>当前情况 / 下一步</TableHead>
                        <TableHead className="pr-4 text-right">状态</TableHead>
                        <TableHead className="pr-4 text-right">操作</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.tasks.map((task) => (
                        <TableRow
                          key={task.id}
                          data-state={
                            task.id === candidateTaskId ? 'selected' : undefined
                          }
                        >
                          <TableCell className="min-w-48 pl-4">
                            <button
                              type="button"
                              className="min-h-9 text-left font-medium text-primary hover:underline"
                              onClick={() => selectTask(task.id)}
                            >
                              {task.positionName}
                            </button>
                            <p className="mt-1 text-xs text-muted-foreground">
                              {new Date(task.createdAt).toLocaleString('zh-CN')}
                            </p>
                            <p className="mt-1 text-xs text-muted-foreground">
                              {task.source === 'search' ? '搜索' : '推荐'} ·{' '}
                              {task.executionMode === 'scheduled'
                                ? '定时任务'
                                : '立即任务'}
                            </p>
                          </TableCell>
                          <TableCell>
                            v{task.ruleVersion} · {task.dictionaryVersion}
                            <p className="mt-1 text-xs text-muted-foreground">
                              {task.candidateCount >
                              (task.candidateLimit ?? DEFAULT_SCREENING_LIMIT)
                                ? '历史任务：请设置人数新建筛选'
                                : `本次上限 ${task.candidateLimit ?? DEFAULT_SCREENING_LIMIT} 人`}
                            </p>
                          </TableCell>
                          <TableCell>
                            <TaskProgress
                              task={task}
                              candidates={data.candidates}
                              compact
                            />
                          </TableCell>
                          <TableCell className="max-w-[360px] whitespace-normal text-xs leading-5 text-muted-foreground">
                            {taskNextAction({
                              status: task.status,
                              waitingReason:
                                task.waitReasonCode ?? task.waitReason,
                              nextAction: task.nextAction,
                              retryAt: task.nextRunAt,
                              errorMessage: task.errorMessage,
                            }) ?? '无需处理'}
                            {typeof task.newCandidateCount === 'number' ||
                            typeof task.repeatCandidateCount === 'number' ? (
                              <span className="mt-1 block">
                                新候选人 {task.newCandidateCount ?? 0} 人 ·
                                已见过 {task.repeatCandidateCount ?? 0} 人
                              </span>
                            ) : null}
                          </TableCell>
                          <TableCell className="pr-4 text-right">
                            <Badge variant="outline">
                              {taskStatus[task.status]}
                            </Badge>
                          </TableCell>
                          <TableCell className="pr-4 text-right">
                            <div className="flex justify-end gap-2">
                              <Link
                                href={taskWorkspaceHref('/candidates', task)}
                                className="inline-flex min-h-9 items-center whitespace-nowrap rounded-md border px-3 text-xs font-medium text-primary hover:bg-secondary"
                              >
                                查看候选人
                              </Link>
                              {[
                                'queued',
                                'running',
                                'screening',
                                'waiting_review',
                              ].includes(task.status) ? (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={taskActionId !== null}
                                  onClick={() =>
                                    void updateTask(task, 'cancel')
                                  }
                                >
                                  {taskActionId === task.id ? (
                                    <LoaderCircle
                                      className="animate-spin"
                                      aria-hidden="true"
                                    />
                                  ) : null}
                                  取消任务
                                </Button>
                              ) : null}
                              {taskNeedsFilterUpdate(task) ? (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => {
                                    selectTask(task.id);
                                    setPositionRuleEditDialogOpen(true);
                                  }}
                                >
                                  调整岗位规则
                                </Button>
                              ) : task.candidateCount <=
                                  (task.candidateLimit ??
                                    DEFAULT_SCREENING_LIMIT) &&
                                (['failed', 'cancelled'].includes(
                                  task.status,
                                ) ||
                                  (task.status === 'waiting_review' &&
                                    data.candidates.some(
                                      (candidate) =>
                                        candidate.taskId === task.id &&
                                        canRetryResumeScreening(
                                          candidate.resumeScreeningStatus,
                                          candidate.resumeScreeningErrorCode ??
                                            candidate.resumeScreeningError,
                                        ),
                                    ))) ? (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={taskActionId !== null}
                                  onClick={() => void updateTask(task, 'retry')}
                                >
                                  {taskActionId === task.id ? (
                                    <LoaderCircle
                                      className="animate-spin"
                                      aria-hidden="true"
                                    />
                                  ) : (
                                    <RefreshCw aria-hidden="true" />
                                  )}
                                  重试未完成项
                                </Button>
                              ) : null}
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ) : (
                  <SectionEmpty
                    title="暂无任务"
                    description="从页面右上角开始第一次筛选。"
                  />
                )}
              </CardContent>
            </Card>
          </section>
        </>
      ) : null}

      {data && page === 'candidates' ? (
        <CandidateInbox
          key={candidateTaskId}
          candidates={taskCandidates}
          task={candidateTask}
          canReview={authUser.role !== 'interviewer'}
          retryingId={retryingCandidateId}
          onReview={openCandidateReview}
          onRetry={(candidate) => void requeueCandidateScreening(candidate)}
          contact={{
            controlApi,
            hrName: authUser.displayName,
            intents: taskContactIntents,
            onChanged: loadDashboard,
          }}
        />
      ) : null}

      {data && page === 'contacts' ? (
        <>
          <section className="mb-4 flex flex-col gap-3 rounded-xl border border-warning/30 bg-warning/8 px-4 py-3 sm:flex-row sm:items-center">
            <ShieldCheck className="size-5 shrink-0" />
            <div className="min-w-0">
              <p className="text-sm font-semibold">{contactMode.label}</p>
              <p className="text-xs text-muted-foreground">
                {contactMode.detail}
              </p>
            </div>
            <Badge variant="outline" className="sm:ml-auto">
              {contactMode.state === 'real'
                ? '受控真实模式'
                : contactMode.state === 'fake'
                  ? '模拟模式'
                  : contactMode.state === 'preview'
                    ? '仅预览，不会发送'
                    : contactMode.state === 'loading'
                      ? '正在读取状态'
                      : '已安全阻止'}
            </Badge>
          </section>
          {position ? (
            <BatchContactWorkspace
              key={`${position.id}:${candidateTaskId}`}
              candidates={approvedCandidates}
              positionId={position.id}
              positionName={position.name}
              hrName={authUser.displayName}
              controlApi={controlApi}
              intents={taskContactIntents}
              canManage={authUser.role !== 'interviewer'}
              onCreated={loadDashboard}
            />
          ) : null}
          <details className="rounded-xl border bg-card p-4">
            <summary className="cursor-pointer text-sm font-medium">
              单人联系与联系设置
            </summary>
            <section className="mt-4 grid gap-4 xl:grid-cols-[1.25fr_.75fr]">
              <Card>
                <CardHeader
                  className="border-b"
                  data-spotlight="contact-approved"
                >
                  <CardTitle>已通过人工审核</CardTitle>
                  <CardDescription>
                    “打招呼”和“发消息”分别预览、分别确认，不会连带执行另一项
                  </CardDescription>
                  <CardAction>
                    <Badge variant="outline">
                      {approvedCandidates.length} 人
                    </Badge>
                  </CardAction>
                </CardHeader>
                <CardContent className="px-0">
                  {approvedCandidates.length === 0 ? (
                    <SectionEmpty
                      title="暂无已通过候选人"
                      description="候选人审核通过后会进入这里。"
                    />
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="pl-4">候选人</TableHead>
                          <TableHead>岗位</TableHead>
                          <TableHead>动作状态</TableHead>
                          <TableHead className="sticky right-0 z-10 bg-card pr-4 text-right">
                            操作
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {visibleApprovedCandidates.map((candidate) => {
                          const greetIntent = data.contactIntents.find(
                            (intent) =>
                              intent.candidateStateId === candidate.stateId &&
                              intent.actionKind === 'greet',
                          );
                          const messageIntent = data.contactIntents.find(
                            (intent) =>
                              intent.candidateStateId === candidate.stateId &&
                              intent.actionKind === 'message',
                          );
                          const modeUnavailable =
                            contactMode.state === 'blocked' ||
                            contactMode.state === 'loading';
                          const greetUnavailable = Boolean(
                            greetIntent &&
                            activeContactIntentStatuses.has(greetIntent.status),
                          );
                          const messageUnavailable =
                            Boolean(
                              messageIntent &&
                              activeContactIntentStatuses.has(
                                messageIntent.status,
                              ),
                            ) ||
                            ['queued', 'sent', 'uncertain'].includes(
                              candidate.contactStatus,
                            );
                          return (
                            <TableRow key={candidate.stateId}>
                              <TableCell className="min-w-40 pl-4 font-medium">
                                {candidate.name}
                              </TableCell>
                              <TableCell>{candidate.positionName}</TableCell>
                              <TableCell>
                                <div className="grid min-w-28 gap-1.5 text-xs">
                                  <span>
                                    打招呼：
                                    {greetIntent
                                      ? contactStatusLabel[greetIntent.status]
                                      : '未创建'}
                                  </span>
                                  <span>
                                    发消息：
                                    {messageIntent
                                      ? contactStatusLabel[messageIntent.status]
                                      : contactStatusLabel[
                                          candidate.contactStatus
                                        ]}
                                  </span>
                                </div>
                              </TableCell>
                              <TableCell className="sticky right-0 z-10 bg-card pr-4 text-right">
                                <div className="flex flex-wrap justify-end gap-2">
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={
                                      modeUnavailable || greetUnavailable
                                    }
                                    onClick={() =>
                                      openContactPreview(
                                        candidate.stateId,
                                        'greet',
                                      )
                                    }
                                  >
                                    <Hand aria-hidden="true" />
                                    打招呼
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={
                                      modeUnavailable || messageUnavailable
                                    }
                                    onClick={() =>
                                      openContactPreview(
                                        candidate.stateId,
                                        'message',
                                      )
                                    }
                                  >
                                    <Send aria-hidden="true" />
                                    发消息
                                  </Button>
                                </div>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  )}
                  <PaginationFooter
                    page={approvedCandidatePage}
                    totalItems={approvedCandidates.length}
                    onPageChange={setApprovedCandidatePage}
                  />
                </CardContent>
              </Card>
              {canManageSettings ? (
                <Card>
                  <CardHeader>
                    <CardTitle>联系安全设置</CardTitle>
                    <CardDescription>
                      管理联系开关和只读安全检查，不在这里执行联系
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <Button
                      nativeButton={false}
                      variant="outline"
                      render={<Link href="/automation" />}
                    >
                      <Settings2 />
                      打开联系安全设置
                    </Button>
                  </CardContent>
                </Card>
              ) : null}
            </section>
          </details>
          <section className="mt-4">
            <Card>
              <CardHeader className="border-b">
                <CardTitle>联系执行记录</CardTitle>
                <CardDescription>
                  跟踪等待、成功、失败与不确定结果
                </CardDescription>
                <CardAction>
                  <Badge variant="outline">
                    {taskContactIntents.length} 条
                  </Badge>
                </CardAction>
              </CardHeader>
              <CardContent className="px-0">
                {taskContactIntents.length ? (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="pl-4">候选人</TableHead>
                        <TableHead>动作</TableHead>
                        <TableHead>岗位</TableHead>
                        <TableHead>创建时间</TableHead>
                        <TableHead>错误信息</TableHead>
                        <TableHead>状态</TableHead>
                        <TableHead className="pr-4 text-right">处理</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {taskContactIntents.map((intent) => (
                        <TableRow key={intent.id}>
                          <TableCell className="pl-4 font-medium">
                            {intent.candidateName}
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline">
                              {contactActionLabel[intent.actionKind]}
                            </Badge>
                          </TableCell>
                          <TableCell>{intent.positionName}</TableCell>
                          <TableCell>
                            {new Date(intent.createdAt).toLocaleString('zh-CN')}
                          </TableCell>
                          <TableCell className="max-w-[360px] text-xs leading-5 text-muted-foreground">
                            {intent.lastError ??
                              (intent.status === 'uncertain'
                                ? `${contactActionLabel[intent.actionKind]}结果尚未确认，需先到 BOSS 核验是否已经执行。`
                                : '—')}
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant={
                                intent.status === 'sent'
                                  ? 'secondary'
                                  : 'outline'
                              }
                            >
                              {contactStatusLabel[intent.status]}
                            </Badge>
                          </TableCell>
                          <TableCell className="pr-4 text-right">
                            {intent.status === 'uncertain' &&
                            canManageSettings ? (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={
                                  verifyingContactIntentId === intent.id
                                }
                                onClick={() => openContactVerification(intent)}
                              >
                                {verifyingContactIntentId === intent.id ? (
                                  <LoaderCircle
                                    className="animate-spin"
                                    aria-hidden="true"
                                  />
                                ) : null}
                                核验未执行
                              </Button>
                            ) : (
                              '—'
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ) : (
                  <SectionEmpty
                    title="暂无联系记录"
                    description="确认打招呼或消息预览后会生成对应的联系记录。"
                  />
                )}
              </CardContent>
            </Card>
          </section>
        </>
      ) : null}

      {data && page === 'audit' ? (
        <section className="grid gap-4 xl:grid-cols-[1.2fr_.8fr]">
          <Card>
            <CardHeader className="border-b">
              <CardTitle>审计日志</CardTitle>
              <CardDescription>最近 100 条关键业务动作</CardDescription>
              <CardAction>
                <Badge variant="outline">
                  {data?.auditLogs.length ?? 0} 条
                </Badge>
              </CardAction>
            </CardHeader>
            <CardContent className="space-y-2 pt-4">
              {data?.auditLogs.length ? (
                data.auditLogs.map((log) => (
                  <div
                    key={log.id}
                    className="flex items-center gap-3 rounded-lg border px-3 py-2.5"
                  >
                    <div className="grid size-8 place-items-center rounded-lg bg-muted">
                      <Clock3
                        className="size-4 text-muted-foreground"
                        aria-hidden="true"
                      />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">
                        {auditActionLabel[log.action] ?? '其他系统操作'}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {auditActorLabel(log.actorId)} ·{' '}
                        {new Date(log.createdAt).toLocaleString('zh-CN')}
                      </p>
                    </div>
                    <Badge variant="outline">
                      {auditResourceLabel[log.resourceType ?? ''] ?? '业务记录'}
                    </Badge>
                  </div>
                ))
              ) : (
                <SectionEmpty
                  title="暂无审计日志"
                  description="关键操作完成后会自动记录。"
                />
              )}
            </CardContent>
          </Card>
          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>安全边界</CardTitle>
                <CardDescription>当前运行时保护</CardDescription>
                <CardAction>
                  {contactMode.state === 'blocked' ? (
                    <XCircle
                      className="size-4 text-destructive"
                      aria-hidden="true"
                    />
                  ) : (
                    <ShieldCheck
                      className="size-4 text-success"
                      aria-hidden="true"
                    />
                  )}
                </CardAction>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className="flex items-center justify-between">
                  <span>环境总开关</span>
                  <Badge
                    variant={
                      contactMode.state === 'real'
                        ? 'default'
                        : contactMode.state === 'blocked'
                          ? 'destructive'
                          : 'outline'
                    }
                  >
                    {contactMode.label}
                  </Badge>
                </div>
                <div className="flex items-center justify-between">
                  <span>服务端运行模式</span>
                  <Badge
                    variant={
                      contactMode.state === 'real'
                        ? 'default'
                        : contactMode.state === 'blocked'
                          ? 'destructive'
                          : 'outline'
                    }
                  >
                    {contactMode.state === 'real'
                      ? '真实联系'
                      : contactMode.state === 'fake'
                        ? '仅模拟'
                        : contactMode.state === 'preview'
                          ? '仅预览'
                          : '已阻止'}
                  </Badge>
                </div>
                <div className="flex items-center justify-between">
                  <span>真实打招呼 / 发消息</span>
                  <Badge
                    variant={
                      contactMode.state === 'real'
                        ? 'default'
                        : contactMode.state === 'blocked'
                          ? 'destructive'
                          : 'outline'
                    }
                  >
                    {contactMode.allowsRealContact ? '受控允许' : '禁止'}
                  </Badge>
                </div>
                <p className="rounded-lg border bg-muted/40 p-3 text-xs leading-5 text-muted-foreground">
                  {contactMode.detail}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>策略保护</CardTitle>
                <CardDescription>每次执行前重新检查</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                {[
                  '人工审核',
                  '允许时段',
                  '账号限额',
                  '岗位限额',
                  '任务限额',
                  '跨岗位冷却',
                  '重复联系',
                  '结果不确定停止',
                ].map((item) => (
                  <Badge key={item} variant="outline">
                    {item}
                  </Badge>
                ))}
              </CardContent>
            </Card>
          </div>
        </section>
      ) : null}

      <PositionRuleDialog
        open={positionRuleEditDialogOpen}
        onOpenChange={setPositionRuleEditDialogOpen}
        controlApi={controlApi}
        position={position}
        activeRule={activeRule}
        canPublish={canManageSettings}
        canSetSalary={authUser.role === 'admin'}
        onCreated={positionCreated}
      />
      <PositionEditDialog
        open={positionEditDialogOpen}
        onOpenChange={setPositionEditDialogOpen}
        controlApi={controlApi}
        position={position}
        bossPositions={
          data?.positions.filter(
            (item) =>
              item.bossJobId &&
              !data.latestRules.some((rule) => rule.positionId === item.id) &&
              !data.tasks.some((task) => task.positionId === item.id),
          ) ?? []
        }
        onUpdated={positionCreated}
      />
      <ScheduleDialog
        open={scheduleDialogOpen}
        onOpenChange={setScheduleDialogOpen}
        controlApi={controlApi}
        positionId={position?.id ?? null}
        onCreated={loadDashboard}
      />
      <CandidateReviewDialog
        open={reviewDialogOpen}
        stateId={selectedCandidateStateId}
        controlApi={controlApi}
        onOpenChange={setReviewDialogOpen}
        onReviewed={loadDashboard}
        queueLabel={
          reviewQueue.length
            ? `${reviewQueue.indexOf(selectedCandidateStateId ?? '') + 1} / ${reviewQueue.length}`
            : undefined
        }
        onPrevious={
          reviewQueue.indexOf(selectedCandidateStateId ?? '') > 0
            ? () =>
                setSelectedCandidateStateId(
                  reviewQueue[
                    reviewQueue.indexOf(selectedCandidateStateId ?? '') - 1
                  ]!,
                )
            : undefined
        }
        onNext={
          reviewQueue.indexOf(selectedCandidateStateId ?? '') >= 0 &&
          reviewQueue.indexOf(selectedCandidateStateId ?? '') <
            reviewQueue.length - 1
            ? () =>
                setSelectedCandidateStateId(
                  reviewQueue[
                    reviewQueue.indexOf(selectedCandidateStateId ?? '') + 1
                  ]!,
                )
            : undefined
        }
        canReview={authUser.role !== 'interviewer'}
        canRetryScreening={Boolean(
          data?.tasks.some(
            (task) =>
              task.id === selectedCandidate?.taskId &&
              ['screening', 'waiting_review'].includes(task.status),
          ),
        )}
      />
      <ContactPreviewDialog
        open={contactDialogOpen}
        actionKind={contactActionKind}
        stateId={selectedCandidateStateId}
        positionId={selectedCandidate?.positionId ?? null}
        taskId={selectedCandidate?.taskId ?? null}
        controlApi={controlApi}
        realGreetingEnabled={contactMode.allowsRealContact}
        onOpenChange={setContactDialogOpen}
        onCreated={loadDashboard}
      />
      <AlertDialog
        open={contactIntentToVerify !== null}
        onOpenChange={handleContactVerificationOpenChange}
      >
        <AlertDialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
          {contactIntentToVerify ? (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  确认解除“
                  {contactActionLabel[contactIntentToVerify.actionKind]}
                  ”发送锁定？
                </AlertDialogTitle>
                <AlertDialogDescription>
                  此操作本身不会联系候选人，但会把“不确定”改为“确认未执行”，使同一动作今后可以重新创建。必须先在
                  BOSS 中核对真实记录。
                </AlertDialogDescription>
              </AlertDialogHeader>
              <dl className="grid gap-2 rounded-lg border bg-muted/30 p-3 text-xs leading-5 sm:grid-cols-2">
                <div>
                  <dt className="text-muted-foreground">候选人</dt>
                  <dd className="font-medium">
                    {contactIntentToVerify.candidateName}
                  </dd>
                  <dd className="text-muted-foreground">
                    候选人记录{' '}
                    {contactIntentToVerify.candidateStateId.slice(0, 8)}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">待核验动作</dt>
                  <dd className="font-medium">
                    {contactActionLabel[contactIntentToVerify.actionKind]}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">发件 BOSS 账号</dt>
                  <dd className="font-medium">
                    {contactIntentToVerify.bossAccountId}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">岗位</dt>
                  <dd className="font-medium">
                    {contactIntentToVerify.positionName}
                  </dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="text-muted-foreground">所属任务</dt>
                  <dd className="font-mono break-all">
                    {contactIntentToVerify.taskId}
                  </dd>
                </div>
                {contactIntentToVerify.actionKind === 'greet' ? (
                  <div className="sm:col-span-2">
                    <dt className="text-muted-foreground">
                      BOSS 岗位 / 招呼语标识
                    </dt>
                    <dd className="font-mono break-all">
                      {contactIntentToVerify.providerJobId} /{' '}
                      {contactIntentToVerify.providerGreetingId}
                    </dd>
                  </div>
                ) : (
                  <div className="sm:col-span-2">
                    <dt className="text-muted-foreground">消息模板版本</dt>
                    <dd className="font-mono break-all">
                      {contactIntentToVerify.templateVersionId}
                    </dd>
                  </div>
                )}
                <div className="sm:col-span-2">
                  <dt className="text-muted-foreground">当时确认的最终正文</dt>
                  <dd className="mt-1 max-h-28 overflow-y-auto whitespace-pre-wrap rounded-md border bg-background p-2 text-sm">
                    {contactIntentToVerify.renderedMessage}
                  </dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="text-muted-foreground">
                    正文指纹 / 候选人定位指纹
                  </dt>
                  <dd className="font-mono break-all">
                    {contactIntentToVerify.renderedMessageSha256}
                  </dd>
                  <dd className="font-mono break-all">
                    {contactIntentToVerify.sourceLocatorSha256 ?? '缺失'}
                  </dd>
                </div>
              </dl>
              {!contactIntentToVerify.sourceLocatorSha256 ? (
                <p role="alert" className="text-sm text-destructive">
                  缺少候选人定位指纹，系统已阻止解除锁定。请联系管理员核对历史记录。
                </p>
              ) : null}
              <label
                htmlFor="contact-verification-acknowledgement"
                className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs leading-5"
              >
                <Checkbox
                  id="contact-verification-acknowledgement"
                  checked={contactVerificationAcknowledged}
                  disabled={verifyingContactIntentId !== null}
                  onCheckedChange={(checked) =>
                    setContactVerificationAcknowledged(checked === true)
                  }
                />
                <span>
                  我已在 BOSS 中逐项核对以上候选人、账号、岗位和正文，确认这次“
                  {contactActionLabel[contactIntentToVerify.actionKind]}
                  ”没有执行；我理解解除锁定后系统将允许重新创建同一动作。
                </span>
              </label>
              {contactVerificationError ? (
                <p role="alert" className="text-sm text-destructive">
                  核验失败：{contactVerificationError}
                  。记录仍保持锁定，请重新加载数据后再次核对。
                </p>
              ) : null}
              <AlertDialogFooter>
                <AlertDialogCancel disabled={verifyingContactIntentId !== null}>
                  取消，保持锁定
                </AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  disabled={
                    verifyingContactIntentId !== null ||
                    !contactVerificationAcknowledged ||
                    !contactIntentToVerify.sourceLocatorSha256
                  }
                  onClick={() =>
                    void verifyContactNotSent(contactIntentToVerify)
                  }
                >
                  {verifyingContactIntentId ? (
                    <LoaderCircle className="animate-spin" aria-hidden="true" />
                  ) : null}
                  {verifyingContactIntentId
                    ? '正在核验'
                    : '确认已核验未执行并解除锁定'}
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          ) : null}
        </AlertDialogContent>
      </AlertDialog>
    </WorkspaceShell>
  );
}

export function DashboardClient({ page }: { page: DashboardPage }) {
  const managerRoles: readonly DepartmentRole[] = ['admin', 'recruiting_lead'];
  const recruiterRoles: readonly DepartmentRole[] = [
    'admin',
    'recruiting_lead',
    'recruiter',
  ];
  const allowedRoles =
    page === 'audit'
      ? managerRoles
      : page === 'positions' || page === 'tasks' || page === 'contacts'
        ? recruiterRoles
        : undefined;
  return (
    <AuthGate allowedRoles={allowedRoles}>
      <AuthenticatedDashboardClient page={page} />
    </AuthGate>
  );
}
