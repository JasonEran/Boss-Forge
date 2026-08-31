'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  CalendarClock,
  CheckCircle2,
  CircleGauge,
  FileSearch,
  ListChecks,
  LoaderCircle,
  MessageSquareText,
  Play,
  RefreshCw,
  SearchCheck,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  UsersRound,
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
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

type Position = { id: string; name: string };
type Task = {
  id: string;
  positionName: string;
  status:
    | 'queued'
    | 'running'
    | 'waiting_review'
    | 'completed'
    | 'failed'
    | 'cancelled';
  source: 'recommend' | 'search';
  candidateCount: number;
  errorMessage: string | null;
};
type Candidate = {
  stateId: string;
  name: string;
  positionName: string;
  ruleDecision: 'matched' | 'not_matched' | 'ambiguous' | 'insufficient';
  ruleConfidence: number;
  evidence: string[];
  fields: Record<string, string>;
};
type DashboardData = {
  metrics: {
    totalCandidates: number;
    matchedCandidates: number;
    pendingReview: number;
    contactedToday: number;
  };
  positions: Position[];
  tasks: Task[];
  candidates: Candidate[];
};

const controlApi =
  process.env.NEXT_PUBLIC_CONTROL_API_URL ?? 'http://127.0.0.1:3100';
const navigation = [
  { label: '总览', icon: CircleGauge, href: '#overview', active: true },
  { label: '岗位与规则', icon: SlidersHorizontal, href: '#rules' },
  { label: '任务中心', icon: ListChecks, href: '#tasks' },
  { label: '候选人审核', icon: UsersRound, href: '#candidates' },
  { label: '自动化控制', icon: ShieldCheck, href: '#automation' },
  { label: '审计日志', icon: FileSearch },
];
const taskStatus: Record<Task['status'], string> = {
  queued: '等待 Worker',
  running: '读取候选人',
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

export function DashboardClient() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creatingTask, setCreatingTask] = useState(false);

  const loadDashboard = useCallback(async () => {
    try {
      const response = await fetch(`${controlApi}/api/dashboard`, {
        cache: 'no-store',
      });
      setData(await responseJson<DashboardData>(response));
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

  const latestTask = data?.tasks[0];
  const position = data?.positions[0];
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

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-20 flex h-16 items-center border-b bg-card/95 px-4 backdrop-blur sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <LogoMark />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold tracking-tight">
              Boss Forge
            </p>
            <p className="truncate text-xs text-muted-foreground">
              HR 招聘工作台
            </p>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2 sm:gap-3">
          <Badge
            variant="secondary"
            className="hidden border border-border sm:inline-flex"
          >
            M1 · 数据闭环
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

      <div className="mx-auto grid w-full max-w-[1600px] grid-cols-1 lg:grid-cols-[220px_minmax(0,1fr)]">
        <aside className="hidden min-h-[calc(100vh-4rem)] border-r bg-card px-3 py-5 lg:block">
          <nav aria-label="主导航" className="space-y-1">
            {navigation.map((item) => {
              const Icon = item.icon;
              const content = (
                <>
                  <Icon className="size-4" aria-hidden="true" />
                  <span>{item.label}</span>
                </>
              );
              const className = `flex min-h-10 items-center gap-3 rounded-lg px-3 text-sm font-medium ${item.active ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`;
              return item.href ? (
                <a
                  key={item.label}
                  href={item.href}
                  aria-current={item.active ? 'page' : undefined}
                  className={className}
                >
                  {content}
                </a>
              ) : (
                <span
                  key={item.label}
                  aria-disabled="true"
                  className={`${className} cursor-not-allowed opacity-50`}
                >
                  {content}
                </span>
              );
            })}
          </nav>
          <div className="mt-8 rounded-xl border bg-muted/45 p-3">
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold">
              <ShieldCheck className="size-4 text-success" aria-hidden="true" />
              安全模式
            </div>
            <p className="text-xs leading-5 text-muted-foreground">
              当前只采集和评估候选人，不会自动发送消息。
            </p>
          </div>
        </aside>

        <main
          id="overview"
          className="min-w-0 scroll-mt-20 px-4 py-5 sm:px-6 sm:py-7 xl:px-8"
        >
          <div
            id="rules"
            className="mb-6 scroll-mt-20 flex flex-col gap-4 md:flex-row md:items-center md:justify-between"
          >
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">
                岗位与规则 · {position?.name ?? '正在连接控制面'}
              </p>
              <h1 className="text-2xl font-semibold tracking-tight">
                候选人筛选与审核
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                当前规则：TEM-8（英语专业八级）· 词典 2026.08.1
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="lg" disabled>
                <CalendarClock data-icon="inline-start" aria-hidden="true" />
                定时任务·M2
              </Button>
              <Button
                size="lg"
                disabled={!position || creatingTask}
                onClick={() => void createImmediateTask()}
              >
                {creatingTask ? (
                  <LoaderCircle
                    className="animate-spin"
                    data-icon="inline-start"
                    aria-hidden="true"
                  />
                ) : (
                  <Play data-icon="inline-start" aria-hidden="true" />
                )}
                {creatingTask ? '正在创建任务' : '立即执行筛选'}
              </Button>
            </div>
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
                <RefreshCw aria-hidden="true" />
                重试
              </Button>
            </section>
          ) : null}

          <section
            aria-label="自动化状态"
            className="mb-5 flex flex-col gap-3 rounded-xl border border-warning/30 bg-warning/8 px-4 py-3 sm:flex-row sm:items-center"
          >
            <ShieldCheck
              className="size-5 shrink-0 text-warning-foreground"
              aria-hidden="true"
            />
            <div className="min-w-0">
              <p className="text-sm font-semibold">自动打招呼总开关已关闭</p>
              <p className="text-xs leading-5 text-muted-foreground">
                M1 只会读取候选人并写入待审核列表。
              </p>
            </div>
            <Badge variant="outline" className="sm:ml-auto">
              安全默认值
            </Badge>
          </section>

          <section
            aria-label="招聘指标"
            className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
          >
            {metrics.map((metric) => {
              const Icon = metric.icon;
              return (
                <Card key={metric.label} size="sm">
                  <CardHeader>
                    <CardDescription>{metric.label}</CardDescription>
                    <CardAction>
                      <Icon
                        className="size-4 text-muted-foreground"
                        aria-hidden="true"
                      />
                    </CardAction>
                    <CardTitle className="text-2xl font-semibold tabular-nums">
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

          <section
            id="tasks"
            className="mt-4 grid scroll-mt-20 gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(320px,.6fr)]"
          >
            <Card>
              <CardHeader>
                <CardTitle>最新任务</CardTitle>
                <CardDescription>
                  {latestTask
                    ? `${latestTask.positionName} · 推荐候选人`
                    : '尚未创建筛选任务'}
                </CardDescription>
                <CardAction>
                  <Badge variant="secondary">
                    {latestTask ? taskStatus[latestTask.status] : '等待任务'}
                  </Badge>
                </CardAction>
              </CardHeader>
              <CardContent className="space-y-3">
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
                  aria-label="最新任务进度"
                />
                <div className="grid grid-cols-3 gap-2 text-xs">
                  <div>
                    <p className="text-muted-foreground">执行方式</p>
                    <p className="mt-1 font-medium">立即执行</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">已采集</p>
                    <p className="mt-1 font-medium tabular-nums">
                      {latestTask?.candidateCount ?? 0} 人
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">规则版本</p>
                    <p className="mt-1 font-medium">TEM8 · 2026.08.1</p>
                  </div>
                </div>
                {latestTask?.errorMessage ? (
                  <p className="text-xs text-destructive">
                    {latestTask.errorMessage}
                  </p>
                ) : null}
              </CardContent>
            </Card>
            <Card id="automation" className="scroll-mt-20">
              <CardHeader>
                <CardTitle>自动化控制</CardTitle>
                <CardDescription>第二阶段能力已预留，默认关闭</CardDescription>
                <CardAction>
                  <Settings2
                    className="size-4 text-muted-foreground"
                    aria-hidden="true"
                  />
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

          <section id="candidates" className="mt-4 scroll-mt-20">
            <Card>
              <CardHeader className="border-b">
                <CardTitle>待审核候选人</CardTitle>
                <CardDescription>
                  实际采集结果，保留原文证据和规则结论
                </CardDescription>
                <CardAction>
                  <Badge variant="outline">
                    {data?.metrics.pendingReview ?? 0} 人
                  </Badge>
                </CardAction>
              </CardHeader>
              <CardContent className="px-0">
                {data && data.candidates.length === 0 ? (
                  <div className="px-4 py-12 text-center">
                    <p className="text-sm font-medium">暂无待审核候选人</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      创建任务后由 Worker 执行采集。
                    </p>
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="pl-4">候选人</TableHead>
                        <TableHead>匹配岗位</TableHead>
                        <TableHead>原文证据</TableHead>
                        <TableHead>置信度</TableHead>
                        <TableHead className="pr-4">结论</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data?.candidates.slice(0, 12).map((candidate) => (
                        <TableRow key={candidate.stateId}>
                          <TableCell className="pl-4">
                            <p className="font-medium">{candidate.name}</p>
                            <p className="mt-0.5 max-w-[260px] truncate text-xs text-muted-foreground">
                              {candidateSummary(candidate) || '候选人列表数据'}
                            </p>
                          </TableCell>
                          <TableCell>{candidate.positionName}</TableCell>
                          <TableCell className="max-w-[420px] whitespace-normal">
                            <span className="line-clamp-3 text-xs leading-5">
                              {candidate.evidence[0] ?? '未发现 TEM8 相关原文'}
                            </span>
                          </TableCell>
                          <TableCell className="font-medium tabular-nums">
                            {Math.round(candidate.ruleConfidence * 100)}%
                          </TableCell>
                          <TableCell className="pr-4">
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
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </section>
        </main>
      </div>
    </div>
  );
}
