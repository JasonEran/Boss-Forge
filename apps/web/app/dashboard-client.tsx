'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Activity,
  ArrowRight,
  BriefcaseBusiness,
  CalendarClock,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleGauge,
  Clock3,
  Eye,
  FileSearch,
  ListChecks,
  LoaderCircle,
  MessageSquareText,
  Play,
  Plus,
  RefreshCw,
  SearchCheck,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  UsersRound,
  XCircle,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { CandidateReviewDialog } from './candidate-review-dialog';
import { ContactPreviewDialog } from './contact-preview-dialog';
import { PositionRuleDialog } from './position-rule-dialog';
import { ScheduleDialog } from './schedule-dialog';

export type DashboardPage =
  | 'overview'
  | 'positions'
  | 'tasks'
  | 'candidates'
  | 'contacts'
  | 'audit';

type Position = {
  id: string;
  name: string;
  bossJobKeyword?: string | null;
  ownerName?: string;
};
type ActiveRule = {
  positionId: string;
  id: string;
  version: number;
  config: unknown;
  dictionaryVersion: string;
  createdAt: string;
};
type Task = {
  id: string;
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
  candidateCount: number;
  errorMessage: string | null;
};
type Candidate = {
  stateId: string;
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
};
type Schedule = {
  id: string;
  positionName: string;
  frequency: 'once' | 'daily' | 'weekdays' | 'weekly';
  nextRunAt: string;
  enabled: boolean;
  version: number;
};
type ContactIntent = {
  id: string;
  candidateStateId: string;
  candidateName: string;
  positionName: string;
  status:
    | 'ready'
    | 'processing'
    | 'sent'
    | 'simulated'
    | 'failed'
    | 'uncertain'
    | 'cancelled';
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
type DashboardData = {
  metrics: {
    totalCandidates: number;
    matchedCandidates: number;
    pendingReview: number;
    contactedToday: number;
  };
  positions: Position[];
  activeRules: ActiveRule[];
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
  return ruleLeaves(root).map((node) => {
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
    if (node.type === 'enum' && node.field === 'bossPlatformTags') {
      return `BOSS 院校标签：${stringValues(node.values).join('、')}（${node.mode === 'all' ? '全部' : '任一'}）`;
    }
    if (node.type === 'range' && node.field === 'yearsOfExperience') {
      return `工作经验：${scalarLabel(node.minimum, '不限')}–${scalarLabel(node.maximum, '不限')} 年`;
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
    if (node.type === 'keyword' && node.field === 'all') {
      return `全文关键词：${stringValues(node.values).join('、')}（${node.mode === 'all' ? '全部' : '任一'}）`;
    }
    return `自定义条件：${scalarLabel(node.field, scalarLabel(node.type, '未命名'))}`;
  });
}

function activeRuleOperator(rule: ActiveRule | undefined): string {
  const config = jsonRecord(rule?.config);
  if (Array.isArray(config?.requiredCapabilities)) return '全部条件（AND）';
  const root = jsonRecord(config?.root);
  return root?.operator === 'OR' ? '任一条件（OR）' : '全部条件（AND）';
}

const controlApi =
  process.env.NEXT_PUBLIC_CONTROL_API_URL ?? 'http://127.0.0.1:3100';

const navigation: Array<{
  page: DashboardPage;
  label: string;
  shortLabel: string;
  icon: typeof CircleGauge;
  href: string;
}> = [
  {
    page: 'overview',
    label: '工作台总览',
    shortLabel: '总览',
    icon: CircleGauge,
    href: '/',
  },
  {
    page: 'positions',
    label: '岗位与规则',
    shortLabel: '岗位',
    icon: SlidersHorizontal,
    href: '/positions',
  },
  {
    page: 'tasks',
    label: '任务与计划',
    shortLabel: '任务',
    icon: ListChecks,
    href: '/tasks',
  },
  {
    page: 'candidates',
    label: '候选人审核',
    shortLabel: '审核',
    icon: UsersRound,
    href: '/candidates',
  },
  {
    page: 'contacts',
    label: '联系执行',
    shortLabel: '联系',
    icon: MessageSquareText,
    href: '/contacts',
  },
  {
    page: 'audit',
    label: '审计与安全',
    shortLabel: '审计',
    icon: FileSearch,
    href: '/audit',
  },
];

const pageCopy: Record<
  DashboardPage,
  { eyebrow: string; title: string; description: string }
> = {
  overview: {
    eyebrow: '今日招聘运营',
    title: '工作台总览',
    description: '集中查看筛选进度、待办事项和联系安全状态。',
  },
  positions: {
    eyebrow: '招聘配置',
    title: '岗位与筛选规则',
    description: '管理岗位、BOSS 岗位关键词和版本化 TEM8 规则。',
  },
  tasks: {
    eyebrow: '执行中心',
    title: '筛选任务与计划',
    description: '立即执行筛选，或安排一次、每日、工作日和每周任务。',
  },
  candidates: {
    eyebrow: '人工决策',
    title: '候选人审核',
    description: '依据原文证据和规则结论逐位审核候选人。',
  },
  contacts: {
    eyebrow: '受控联系',
    title: '联系执行',
    description: '审核消息预览、创建联系意图并跟踪执行结果。',
  },
  audit: {
    eyebrow: '风险与追溯',
    title: '审计与安全',
    description: '查看关键动作记录和当前自动化安全边界。',
  },
};

const taskStatus: Record<Task['status'], string> = {
  queued: '等待 Worker',
  running: '读取候选人',
  screening: '完整简历精筛',
  waiting_review: '待人工审核',
  completed: '已完成',
  failed: '执行失败',
  cancelled: '已取消',
};
const decisionLabel: Record<Candidate['ruleDecision'], string> = {
  matched: '符合',
  not_matched: '不符合',
  ambiguous: '有歧义',
  insufficient: '信息不足',
};
const resumeScreeningLabel: Record<Candidate['resumeScreeningStatus'], string> = {
  not_requested: '未安排',
  queued: '等待预览',
  processing: '精筛中',
  screened: '已精筛',
  no_text: 'OCR 无正文',
  failed: '精筛失败',
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
const auditActionLabel: Record<string, string> = {
  'rule.version.created': '创建规则版本',
  'task.immediate.requested': '创建立即筛选任务',
  'task.collection.completed': '完成候选人采集',
  'candidate.review.approved': '审核通过候选人',
  'candidate.review.rejected': '审核拒绝候选人',
  'schedule.created': '创建定时计划',
  'schedule.cancelled': '停用定时计划',
  'contact.intent.created': '创建联系意图',
  'contact.sent': '联系成功',
  'contact.simulated': '模拟联系完成',
  'contact.failed': '联系失败',
  'contact.uncertain': '联系结果待核验',
};

async function responseJson<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as T & { message?: string };
  if (!response.ok)
    throw new Error(payload.message ?? `HTTP ${response.status}`);
  return payload;
}

function LogoMark() {
  return (
    <div className="grid size-9 place-items-center rounded-xl bg-primary text-primary-foreground shadow-sm">
      <Activity className="size-[18px]" aria-hidden="true" />
    </div>
  );
}

function candidateSummary(candidate: Candidate): string {
  return ['信息', '期望', '薪资']
    .map((key) => candidate.fields[key])
    .filter(Boolean)
    .join(' · ');
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

export function DashboardClient({ page }: { page: DashboardPage }) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creatingTask, setCreatingTask] = useState(false);
  const [selectedPositionId, setSelectedPositionId] = useState('');
  const [candidatePositionFilter, setCandidatePositionFilter] = useState('all');
  const [pendingCandidatePage, setPendingCandidatePage] = useState(1);
  const [screenedOutCandidatePage, setScreenedOutCandidatePage] = useState(1);
  const [approvedCandidatePage, setApprovedCandidatePage] = useState(1);
  const [positionDialogOpen, setPositionDialogOpen] = useState(false);
  const [editingPositionId, setEditingPositionId] = useState<string | null>(null);
  const [scheduleDialogOpen, setScheduleDialogOpen] = useState(false);
  const [reviewDialogOpen, setReviewDialogOpen] = useState(false);
  const [contactDialogOpen, setContactDialogOpen] = useState(false);
  const [selectedCandidateStateId, setSelectedCandidateStateId] = useState<
    string | null
  >(null);

  const loadDashboard = useCallback(async () => {
    try {
      const response = await fetch(`${controlApi}/api/dashboard`, {
        cache: 'no-store',
      });
      const nextData = await responseJson<DashboardData>(response);
      setData(nextData);
      setSelectedPositionId((current) =>
        current && nextData.positions.some((item) => item.id === current)
          ? current
          : (nextData.positions[0]?.id ?? ''),
      );
      setError(null);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : String(loadError),
      );
    }
  }, []);

  useEffect(() => {
    const firstLoad = window.setTimeout(() => void loadDashboard(), 0);
    const timer = window.setInterval(() => void loadDashboard(), 5000);
    return () => {
      window.clearTimeout(firstLoad);
      window.clearInterval(timer);
    };
  }, [loadDashboard]);

  const position =
    data?.positions.find((item) => item.id === selectedPositionId) ??
    data?.positions[0];
  const activeRule = data?.activeRules.find(
    (item) => item.positionId === position?.id,
  );
  const activeRuleDescriptions = describeActiveRule(activeRule);
  const editingPosition = editingPositionId
    ? data?.positions.find((item) => item.id === editingPositionId)
    : null;
  const editingActiveRule = editingPositionId
    ? data?.activeRules.find((item) => item.positionId === editingPositionId)
    : null;
  const latestTask = data?.tasks[0];
  const pendingCandidates =
    data?.candidates.filter(
      (candidate) =>
        candidate.reviewStatus === 'pending' &&
        (candidatePositionFilter === 'all' ||
          candidate.positionName === candidatePositionFilter),
    ) ?? [];
  const approvedCandidates =
    data?.candidates.filter(
      (candidate) => candidate.reviewStatus === 'approved',
    ) ?? [];
  const screenedOutCandidates =
    data?.candidates.filter(
      (candidate) =>
        candidate.reviewStatus === 'not_required' &&
        (candidatePositionFilter === 'all' ||
          candidate.positionName === candidatePositionFilter),
    ) ?? [];
  const visiblePendingCandidates = pendingCandidates.slice(
    (pendingCandidatePage - 1) * candidatePageSize,
    pendingCandidatePage * candidatePageSize,
  );
  const visibleScreenedOutCandidates = screenedOutCandidates.slice(
    (screenedOutCandidatePage - 1) * candidatePageSize,
    screenedOutCandidatePage * candidatePageSize,
  );
  const visibleApprovedCandidates = approvedCandidates.slice(
    (approvedCandidatePage - 1) * candidatePageSize,
    approvedCandidatePage * candidatePageSize,
  );
  const activeSchedules = data?.schedules.filter((item) => item.enabled) ?? [];
  const pageInfo = pageCopy[page];
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
        note: 'TEM8',
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

  async function createImmediateTask() {
    if (!position || creatingTask) return;
    setCreatingTask(true);
    setError(null);
    try {
      const response = await fetch(`${controlApi}/api/tasks`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': crypto.randomUUID(),
        },
        body: JSON.stringify({
          positionId: position.id,
          source: 'recommend',
          createdBy: 'hr:dashboard',
        }),
      });
      await responseJson(response);
      await loadDashboard();
    } catch (taskError) {
      setError(
        taskError instanceof Error ? taskError.message : String(taskError),
      );
    } finally {
      setCreatingTask(false);
    }
  }

  async function positionCreated(positionId: string) {
    setSelectedPositionId(positionId);
    await loadDashboard();
  }
  function openCandidateReview(stateId: string) {
    setSelectedCandidateStateId(stateId);
    setReviewDialogOpen(true);
  }
  function openContactPreview(stateId: string) {
    setSelectedCandidateStateId(stateId);
    setContactDialogOpen(true);
  }

  async function cancelSchedule(schedule: Schedule) {
    try {
      const response = await fetch(
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
        onValueChange={(value) => setSelectedPositionId(value ?? '')}
      >
        <SelectTrigger className="h-9 min-w-44">
          <SelectValue placeholder="选择岗位" />
        </SelectTrigger>
        <SelectContent>
          {data?.positions.map((item) => (
            <SelectItem key={item.id} value={item.id}>
              {item.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  function taskActions() {
    return (
      <div className="flex flex-wrap gap-2">
        {positionSelect()}
        <Button
          variant="outline"
          size="lg"
          disabled={!position}
          onClick={() => setScheduleDialogOpen(true)}
        >
          <CalendarClock data-icon="inline-start" />
          定时筛选
        </Button>
        <Button
          size="lg"
          disabled={!position || creatingTask}
          onClick={() => void createImmediateTask()}
        >
          {creatingTask ? <LoaderCircle className="animate-spin" /> : <Play />}
          {creatingTask ? '正在创建' : '立即执行'}
        </Button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-30 flex h-16 items-center border-b bg-card/95 px-4 backdrop-blur sm:px-6">
        <Link
          href="/"
          className="flex min-w-0 items-center gap-3"
          aria-label="返回工作台总览"
        >
          <LogoMark />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold tracking-tight">
              Boss Forge
            </p>
            <p className="truncate text-xs text-muted-foreground">
              HR 招聘工作台
            </p>
          </div>
        </Link>
        <div className="ml-auto flex items-center gap-2 sm:gap-3">
          <Badge
            variant="secondary"
            className="hidden border border-border sm:inline-flex"
          >
            M1 + M2 · 受控闭环
          </Badge>
          <div className="hidden text-right md:block">
            <p className="text-xs font-medium">招聘账号 01</p>
            <p className="text-[11px] text-success">自动打招呼已关闭</p>
          </div>
          <div className="grid size-8 place-items-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
            HR
          </div>
        </div>
      </header>

      <nav
        aria-label="移动端主导航"
        className="sticky top-16 z-20 flex gap-1 overflow-x-auto border-b bg-card px-3 py-2 lg:hidden"
      >
        {navigation.map((item) => {
          const Icon = item.icon;
          return (
            <Link
              key={item.page}
              href={item.href}
              aria-current={page === item.page ? 'page' : undefined}
              className={`flex min-h-9 shrink-0 items-center gap-2 rounded-lg px-3 text-xs font-medium ${page === item.page ? 'bg-primary/10 text-primary' : 'text-muted-foreground'}`}
            >
              <Icon className="size-3.5" />
              {item.shortLabel}
            </Link>
          );
        })}
      </nav>

      <div className="mx-auto grid w-full max-w-[1600px] grid-cols-1 lg:grid-cols-[228px_minmax(0,1fr)]">
        <aside className="hidden min-h-[calc(100vh-4rem)] border-r bg-card px-3 py-5 lg:block">
          <nav aria-label="主导航" className="space-y-1">
            {navigation.map((item) => {
              const Icon = item.icon;
              return (
                <Link
                  key={item.page}
                  href={item.href}
                  aria-current={page === item.page ? 'page' : undefined}
                  className={`flex min-h-10 items-center gap-3 rounded-lg px-3 text-sm font-medium ${page === item.page ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
                >
                  <Icon className="size-4" />
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </nav>
          <div className="mt-8 rounded-xl border bg-muted/45 p-3">
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold">
              <ShieldCheck className="size-4 text-success" />
              安全模式
            </div>
            <p className="text-xs leading-5 text-muted-foreground">
              可预览并创建联系任务；真实发送总开关关闭。
            </p>
          </div>
        </aside>

        <main className="min-w-0 px-4 py-5 sm:px-6 sm:py-7 xl:px-8">
          <div className="mb-6 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="mb-1 text-xs font-medium text-primary">
                {pageInfo.eyebrow}
              </p>
              <h1 className="text-2xl font-semibold tracking-tight">
                {pageInfo.title}
              </h1>
              <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                {pageInfo.description}
              </p>
            </div>
            {page === 'positions' ? (
              <div className="flex flex-wrap gap-2">
                {positionSelect()}
                <Button
                  size="lg"
                  onClick={() => {
                    setEditingPositionId(null);
                    setPositionDialogOpen(true);
                  }}
                >
                  <Plus />
                  新建岗位
                </Button>
              </div>
            ) : null}
            {page === 'tasks' ? taskActions() : null}
            {page === 'candidates' ? (
              <Select
                value={candidatePositionFilter}
                onValueChange={(value) => {
                  setCandidatePositionFilter(value ?? 'all');
                  setPendingCandidatePage(1);
                  setScreenedOutCandidatePage(1);
                }}
              >
                <SelectTrigger className="h-9 min-w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部岗位</SelectItem>
                  {data?.positions.map((item) => (
                    <SelectItem key={item.id} value={item.name}>
                      {item.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            {page === 'audit' ? (
              <Button
                variant="outline"
                size="lg"
                onClick={() => void loadDashboard()}
              >
                <RefreshCw />
                刷新日志
              </Button>
            ) : null}
          </div>

          {error ? (
            <section
              role="alert"
              className="mb-5 flex items-center gap-3 rounded-xl border border-destructive/30 bg-destructive/8 px-4 py-3"
            >
              <p className="min-w-0 flex-1 text-sm">控制面连接失败：{error}</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void loadDashboard()}
              >
                <RefreshCw />
                重试
              </Button>
            </section>
          ) : null}

          {page === 'overview' ? (
            <>
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
                      {position?.name ?? '尚未创建岗位'} · TEM8 规则
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
                    <Progress
                      value={
                        latestTask?.status === 'waiting_review' ||
                        latestTask?.status === 'completed'
                          ? 100
                          : latestTask?.status === 'running'
                            ? 55
                            : latestTask
                              ? 15
                              : 0
                      }
                    />
                    <div className="grid grid-cols-3 gap-3 text-xs">
                      <div>
                        <p className="text-muted-foreground">最新任务</p>
                        <p className="mt-1 font-medium">
                          {latestTask
                            ? taskStatus[latestTask.status]
                            : '暂无任务'}
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
                      href="/tasks"
                      className="flex items-center gap-3 rounded-lg border px-3 py-2.5 text-sm font-medium hover:bg-muted"
                    >
                      <Play className="size-4 text-primary" />
                      执行候选人筛选
                      <ArrowRight className="ml-auto size-4 text-muted-foreground" />
                    </Link>
                    <Link
                      href="/candidates"
                      className="flex items-center gap-3 rounded-lg border px-3 py-2.5 text-sm font-medium hover:bg-muted"
                    >
                      <UsersRound className="size-4 text-primary" />
                      处理 {data?.metrics.pendingReview ?? 0} 位待审核
                      <ArrowRight className="ml-auto size-4 text-muted-foreground" />
                    </Link>
                    <Link
                      href="/contacts"
                      className="flex items-center gap-3 rounded-lg border px-3 py-2.5 text-sm font-medium hover:bg-muted"
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
                    <CardDescription>按规则结论和置信度排序</CardDescription>
                    <CardAction>
                      <Link
                        href="/candidates"
                        className="text-xs font-medium text-primary"
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
                              置信度
                            </TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {data?.candidates
                            .filter((item) => item.reviewStatus === 'pending')
                            .slice(0, 5)
                            .map((candidate) => (
                              <TableRow key={candidate.stateId}>
                                <TableCell className="pl-4 font-medium">
                                  {candidate.name}
                                </TableCell>
                                <TableCell>{candidate.positionName}</TableCell>
                                <TableCell>
                                  <Badge variant="outline">
                                    {decisionLabel[candidate.ruleDecision]}
                                  </Badge>
                                </TableCell>
                                <TableCell className="pr-4 text-right tabular-nums">
                                  {Math.round(candidate.ruleConfidence * 100)}%
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
                    <CardTitle>联系安全状态</CardTitle>
                    <CardDescription>所有真实外部操作默认关闭</CardDescription>
                    <CardAction>
                      <ShieldCheck className="size-4 text-success" />
                    </CardAction>
                  </CardHeader>
                  <CardContent className="space-y-3 text-sm">
                    <div className="flex items-center justify-between">
                      <span>真实打招呼总开关</span>
                      <Badge variant="outline">关闭</Badge>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>待执行联系意图</span>
                      <span className="font-medium">
                        {data?.contactIntents.filter(
                          (item) => item.status === 'ready',
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
                      href="/audit"
                      className="flex items-center text-xs font-medium text-primary"
                    >
                      查看安全与审计
                      <ArrowRight className="ml-1 size-3.5" />
                    </Link>
                  </CardContent>
                </Card>
              </section>
            </>
          ) : null}

          {page === 'positions' ? (
            <section className="grid gap-4 xl:grid-cols-[1fr_.72fr]">
              <Card>
                <CardHeader className="border-b">
                  <CardTitle>岗位列表</CardTitle>
                  <CardDescription>当前 BOSS 账号下的招聘岗位</CardDescription>
                  <CardAction>
                    <Badge variant="outline">
                      {data?.positions.length ?? 0} 个
                    </Badge>
                  </CardAction>
                </CardHeader>
                <CardContent className="space-y-3 pt-4">
                  {data?.positions.length ? (
                    data.positions.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => setSelectedPositionId(item.id)}
                        className={`flex w-full items-center gap-3 rounded-xl border p-4 text-left transition-colors ${position?.id === item.id ? 'border-primary/40 bg-primary/5' : 'hover:bg-muted/60'}`}
                      >
                        <div className="grid size-10 place-items-center rounded-lg bg-primary/10 text-primary">
                          <BriefcaseBusiness className="size-5" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-semibold">
                            {item.name}
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {item.bossJobKeyword || '使用当前 BOSS 岗位'} ·{' '}
                            {item.ownerName || 'HR 管理员'}
                          </p>
                        </div>
                        <Badge variant="outline">启用</Badge>
                      </button>
                    ))
                  ) : (
                    <SectionEmpty
                      title="暂无岗位"
                      description="创建第一个岗位和筛选规则后即可开始。"
                    />
                  )}
                </CardContent>
              </Card>
              <div className="space-y-4">
                <Card>
                  <CardHeader>
                    <CardTitle>当前规则</CardTitle>
                    <CardDescription>
                      {position?.name ?? '请选择岗位'}
                    </CardDescription>
                    <CardAction>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!position}
                        onClick={() => {
                          setEditingPositionId(position?.id ?? null);
                          setPositionDialogOpen(true);
                        }}
                      >
                        <Settings2 />
                        编辑规则
                      </Button>
                    </CardAction>
                  </CardHeader>
                  <CardContent className="space-y-3 text-sm">
                    {activeRule ? (
                      <>
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="secondary">规则 v{activeRule.version}</Badge>
                          <Badge variant="outline">{activeRuleOperator(activeRule)}</Badge>
                        </div>
                        <div className="space-y-2">
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
                            <p className="text-xs text-muted-foreground">词典版本</p>
                            <p className="mt-1 font-medium">{activeRule.dictionaryVersion}</p>
                          </div>
                          <div>
                            <p className="text-xs text-muted-foreground">规则条件数</p>
                            <p className="mt-1 font-medium">{activeRuleDescriptions.length} 条</p>
                          </div>
                        </div>
                      </>
                    ) : (
                      <SectionEmpty
                        title="尚未配置规则"
                        description="点击“编辑规则”创建第一个规则版本。"
                      />
                    )}
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader>
                    <CardTitle>表达适配</CardTitle>
                    <CardDescription>同义表达与风险上下文</CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-wrap gap-2">
                    {[
                      '英语专业八级',
                      'TEM8',
                      'TEM-8',
                      '英语8级',
                      '专八',
                      '否定检测',
                      '备考识别',
                      'CET 混淆',
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

          {page === 'tasks' ? (
            <>
              <section className="grid gap-4 xl:grid-cols-[1.1fr_.9fr]">
                <Card>
                  <CardHeader>
                    <CardTitle>最新筛选任务</CardTitle>
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
                    <Progress
                      value={
                        latestTask?.status === 'waiting_review' ||
                        latestTask?.status === 'completed'
                          ? 100
                          : latestTask?.status === 'running'
                            ? 55
                            : latestTask
                              ? 15
                              : 0
                      }
                    />
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
                        <p className="mt-1 font-medium">TEM8 · 2026.08.2</p>
                      </div>
                    </div>
                    {latestTask?.errorMessage ? (
                      <p className="text-xs text-destructive">
                        {latestTask.errorMessage}
                      </p>
                    ) : null}
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="border-b">
                    <CardTitle>定时计划</CardTitle>
                    <CardDescription>
                      统一使用 Asia/Shanghai 时区
                    </CardDescription>
                    <CardAction>
                      <Badge variant="outline">
                        {activeSchedules.length} 个启用
                      </Badge>
                    </CardAction>
                  </CardHeader>
                  <CardContent className="space-y-2 pt-4">
                    {data?.schedules.length ? (
                      data.schedules.slice(0, 6).map((schedule) => (
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
                              {frequencyLabel[schedule.frequency]} ·{' '}
                              {new Date(schedule.nextRunAt).toLocaleString(
                                'zh-CN',
                              )}
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
                    <CardDescription>
                      立即与定时筛选任务统一追踪
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="px-0">
                    {data?.tasks.length ? (
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="pl-4">岗位</TableHead>
                            <TableHead>来源</TableHead>
                            <TableHead>执行方式</TableHead>
                            <TableHead>候选人</TableHead>
                            <TableHead className="pr-4 text-right">
                              状态
                            </TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {data.tasks.map((task) => (
                            <TableRow key={task.id}>
                              <TableCell className="pl-4 font-medium">
                                {task.positionName}
                              </TableCell>
                              <TableCell>
                                {task.source === 'search' ? '搜索' : '推荐'}
                              </TableCell>
                              <TableCell>
                                {task.executionMode === 'scheduled'
                                  ? '定时'
                                  : '立即'}
                              </TableCell>
                              <TableCell>{task.candidateCount} 人</TableCell>
                              <TableCell className="pr-4 text-right">
                                <Badge variant="outline">
                                  {taskStatus[task.status]}
                                </Badge>
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

          {page === 'candidates' ? (
            <>
            <Card>
              <CardHeader className="border-b">
                <CardTitle>待审核候选人</CardTitle>
                <CardDescription>完整简历精筛完成后查看原文证据并作出决定</CardDescription>
                <CardAction>
                  <Badge variant="outline">{pendingCandidates.length} 人</Badge>
                </CardAction>
              </CardHeader>
              <CardContent className="px-0">
                {data && pendingCandidates.length === 0 ? (
                  <SectionEmpty
                    title="暂无待审核候选人"
                    description="创建筛选任务后由 Worker 采集候选人。"
                  />
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="pl-4">候选人</TableHead>
                        <TableHead>匹配岗位</TableHead>
                        <TableHead>识别英语等级</TableHead>
                        <TableHead>简历精筛</TableHead>
                        <TableHead>置信度</TableHead>
                        <TableHead>结论</TableHead>
                        <TableHead className="pr-4 text-right">操作</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {visiblePendingCandidates.map((candidate) => (
                        <TableRow key={candidate.stateId}>
                          <TableCell className="pl-4">
                            <p className="font-medium">{candidate.name}</p>
                            <p className="mt-0.5 max-w-[250px] truncate text-xs text-muted-foreground">
                              {candidateSummary(candidate) || '候选人列表数据'}
                            </p>
                          </TableCell>
                          <TableCell>{candidate.positionName}</TableCell>
                          <TableCell className="max-w-[300px] whitespace-normal text-xs">
                            {candidate.currentEnglishLevel ?? '未识别到明确等级'}
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline">
                              {resumeScreeningLabel[candidate.resumeScreeningStatus]}
                            </Badge>
                          </TableCell>
                          <TableCell className="font-medium tabular-nums">
                            {Math.round(candidate.ruleConfidence * 100)}%
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant={
                                candidate.ruleDecision === 'matched'
                                  ? 'secondary'
                                  : 'outline'
                              }
                            >
                              {decisionLabel[candidate.ruleDecision]}
                            </Badge>
                          </TableCell>
                          <TableCell className="pr-4 text-right">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() =>
                                openCandidateReview(candidate.stateId)
                              }
                            >
                              <Eye />
                              审核
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
                <PaginationFooter
                  page={pendingCandidatePage}
                  totalItems={pendingCandidates.length}
                  onPageChange={setPendingCandidatePage}
                />
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="border-b">
                <CardTitle>未达到 TEM8</CardTitle>
                <CardDescription>
                  保留完整简历精筛结论，并标出简历中明确写出的当前英语等级
                </CardDescription>
                <CardAction>
                  <Badge variant="outline">{screenedOutCandidates.length} 人</Badge>
                </CardAction>
              </CardHeader>
              <CardContent className="px-0">
                {screenedOutCandidates.length === 0 ? (
                  <SectionEmpty
                    title="暂无未达标候选人"
                    description="完整简历精筛后，不符合 TEM8 的候选人会显示在这里。"
                  />
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="pl-4">候选人</TableHead>
                        <TableHead>匹配岗位</TableHead>
                        <TableHead>识别英语等级</TableHead>
                        <TableHead>结论</TableHead>
                        <TableHead className="pr-4 text-right">操作</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {visibleScreenedOutCandidates.map((candidate) => (
                        <TableRow key={candidate.stateId}>
                          <TableCell className="pl-4 font-medium">
                            {candidate.name}
                          </TableCell>
                          <TableCell>{candidate.positionName}</TableCell>
                          <TableCell>
                            {candidate.currentEnglishLevel ?? '未识别到明确等级'}
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline">
                              {decisionLabel[candidate.ruleDecision]}
                            </Badge>
                          </TableCell>
                          <TableCell className="pr-4 text-right">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => openCandidateReview(candidate.stateId)}
                            >
                              <Eye />
                              查看证据
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
                <PaginationFooter
                  page={screenedOutCandidatePage}
                  totalItems={screenedOutCandidates.length}
                  onPageChange={setScreenedOutCandidatePage}
                />
              </CardContent>
            </Card>
            </>
          ) : null}

          {page === 'contacts' ? (
            <>
              <section className="mb-4 flex flex-col gap-3 rounded-xl border border-warning/30 bg-warning/8 px-4 py-3 sm:flex-row sm:items-center">
                <ShieldCheck className="size-5 shrink-0" />
                <div className="min-w-0">
                  <p className="text-sm font-semibold">
                    真实打招呼总开关已关闭
                  </p>
                  <p className="text-xs text-muted-foreground">
                    可以预览并创建联系意图，当前不会调用 BOSS 打招呼命令。
                  </p>
                </div>
                <Badge variant="outline" className="sm:ml-auto">
                  安全默认值
                </Badge>
              </section>
              <section className="grid gap-4 xl:grid-cols-[1.25fr_.75fr]">
                <Card>
                  <CardHeader className="border-b">
                    <CardTitle>已通过人工审核</CardTitle>
                    <CardDescription>
                      先预览消息，再显式创建联系任务
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
                            <TableHead>联系状态</TableHead>
                            <TableHead className="pr-4 text-right">
                              操作
                            </TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {visibleApprovedCandidates.map((candidate) => (
                            <TableRow key={candidate.stateId}>
                              <TableCell className="pl-4 font-medium">
                                {candidate.name}
                              </TableCell>
                              <TableCell>{candidate.positionName}</TableCell>
                              <TableCell>
                                <Badge variant="outline">
                                  {contactStatusLabel[candidate.contactStatus]}
                                </Badge>
                              </TableCell>
                              <TableCell className="pr-4 text-right">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={
                                    candidate.contactStatus !==
                                      'not_contacted' &&
                                    candidate.contactStatus !== 'failed'
                                  }
                                  onClick={() =>
                                    openContactPreview(candidate.stateId)
                                  }
                                >
                                  <MessageSquareText />
                                  消息预览
                                </Button>
                              </TableCell>
                            </TableRow>
                          ))}
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
                <Card>
                  <CardHeader>
                    <CardTitle>自动化控制</CardTitle>
                    <CardDescription>M4 能力预留，当前全部关闭</CardDescription>
                    <CardAction>
                      <Settings2 className="size-4 text-muted-foreground" />
                    </CardAction>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {['全局自动开关', '岗位自动开关', '本任务自动开关'].map(
                      (label) => (
                        <div
                          key={label}
                          className="flex min-h-9 items-center justify-between gap-3"
                        >
                          <span className="text-sm">{label}</span>
                          <Switch disabled aria-label={`${label}，当前关闭`} />
                        </div>
                      ),
                    )}
                  </CardContent>
                </Card>
              </section>
              <section className="mt-4">
                <Card>
                  <CardHeader className="border-b">
                    <CardTitle>联系执行记录</CardTitle>
                    <CardDescription>
                      跟踪等待、成功、失败与不确定结果
                    </CardDescription>
                    <CardAction>
                      <Badge variant="outline">
                        {data?.contactIntents.length ?? 0} 条
                      </Badge>
                    </CardAction>
                  </CardHeader>
                  <CardContent className="px-0">
                    {data?.contactIntents.length ? (
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="pl-4">候选人</TableHead>
                            <TableHead>岗位</TableHead>
                            <TableHead>创建时间</TableHead>
                            <TableHead>错误信息</TableHead>
                            <TableHead className="pr-4 text-right">
                              状态
                            </TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {data.contactIntents.map((intent) => (
                            <TableRow key={intent.id}>
                              <TableCell className="pl-4 font-medium">
                                {intent.candidateName}
                              </TableCell>
                              <TableCell>{intent.positionName}</TableCell>
                              <TableCell>
                                {new Date(intent.createdAt).toLocaleString(
                                  'zh-CN',
                                )}
                              </TableCell>
                              <TableCell className="max-w-[320px] truncate text-xs text-muted-foreground">
                                {intent.lastError ?? '—'}
                              </TableCell>
                              <TableCell className="pr-4 text-right">
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
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    ) : (
                      <SectionEmpty
                        title="暂无联系记录"
                        description="确认消息预览后会生成联系意图。"
                      />
                    )}
                  </CardContent>
                </Card>
              </section>
            </>
          ) : null}

          {page === 'audit' ? (
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
                          <Clock3 className="size-4 text-muted-foreground" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium">
                            {auditActionLabel[log.action] ?? log.action}
                          </p>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {log.actorId} ·{' '}
                            {new Date(log.createdAt).toLocaleString('zh-CN')}
                          </p>
                        </div>
                        <Badge variant="outline">
                          {log.resourceType ?? '业务记录'}
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
                      <ShieldCheck className="size-4 text-success" />
                    </CardAction>
                  </CardHeader>
                  <CardContent className="space-y-3 text-sm">
                    <div className="flex items-center justify-between">
                      <span>环境总开关</span>
                      <Badge variant="outline">关闭</Badge>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>命令行显式批准</span>
                      <Badge variant="outline">未提供</Badge>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>真实 greet/send</span>
                      <Badge variant="outline">禁止</Badge>
                    </div>
                    <p className="rounded-lg border bg-muted/40 p-3 text-xs leading-5 text-muted-foreground">
                      必须同时开启环境总开关并提供命令行批准参数，联系 Worker
                      才可能执行真实打招呼。
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
        </main>
      </div>

      <PositionRuleDialog
        open={positionDialogOpen}
        onOpenChange={setPositionDialogOpen}
        controlApi={controlApi}
        position={editingPosition}
        activeRule={editingActiveRule}
        onCreated={positionCreated}
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
      />
      <ContactPreviewDialog
        open={contactDialogOpen}
        stateId={selectedCandidateStateId}
        controlApi={controlApi}
        onOpenChange={setContactDialogOpen}
        onCreated={loadDashboard}
      />
    </div>
  );
}
