import {
  Activity,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  CircleGauge,
  FileSearch,
  ListChecks,
  MessageSquareText,
  Play,
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

const navigation = [
  { label: '总览', icon: CircleGauge, active: true, href: '#overview' },
  { label: '岗位与规则', icon: SlidersHorizontal, href: '#rules' },
  { label: '任务中心', icon: ListChecks, count: 2, href: '#tasks' },
  { label: '候选人审核', icon: UsersRound, count: 12, href: '#candidates' },
  { label: '自动化控制', icon: ShieldCheck, href: '#automation' },
  { label: '审计日志', icon: FileSearch },
];

const metrics = [
  { label: '今日获取', value: '46', delta: '+12', icon: SearchCheck },
  { label: '规则通过', value: '18', delta: '39.1%', icon: CheckCircle2 },
  { label: '待人工审核', value: '12', delta: '需处理', icon: UsersRound },
  {
    label: '今日已联系',
    value: '6',
    delta: '人工确认',
    icon: MessageSquareText,
  },
];

const candidates = [
  {
    name: '陈雨欣',
    profile: '4年 · 本科 · 珠海',
    role: '海外运营专员',
    evidence: '“已取得 TEM-8 证书”',
    score: 94,
    status: '待审核',
  },
  {
    name: '林泽宇',
    profile: '3年 · 本科 · 广州',
    role: '亚马逊运营',
    evidence: '“英语专业八级”',
    score: 91,
    status: '待审核',
  },
  {
    name: '周清妍',
    profile: '5年 · 硕士 · 深圳',
    role: '海外内容运营',
    evidence: '“TEM8 / 海外社媒 3年”',
    score: 89,
    status: '信息复核',
  },
  {
    name: '许嘉诚',
    profile: '2年 · 本科 · 珠海',
    role: '跨境电商运营',
    evidence: '“备考专八” → 不作为已取得',
    score: 62,
    status: '有歧义',
  },
];

function LogoMark() {
  return (
    <div className="grid size-9 place-items-center rounded-xl bg-primary text-primary-foreground shadow-sm">
      <Activity className="size-[18px]" aria-hidden="true" />
    </div>
  );
}

export default function Home() {
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
            第一阶段 · 人工审核
          </Badge>
          <div className="hidden text-right md:block">
            <p className="text-xs font-medium">招聘账号 01</p>
            <p className="text-[11px] text-success">登录态正常</p>
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
              const navigationContent = (
                <>
                  <Icon className="size-4" aria-hidden="true" />
                  <span>{item.label}</span>
                  {item.count ? (
                    <span className="ml-auto rounded-full bg-muted px-1.5 py-0.5 text-[11px] tabular-nums text-foreground">
                      {item.count}
                    </span>
                  ) : null}
                </>
              );
              const navigationClassName = `flex min-h-10 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                item.active
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              }`;

              return item.href ? (
                <a
                  key={item.label}
                  href={item.href}
                  aria-current={item.active ? 'page' : undefined}
                  className={navigationClassName}
                >
                  {navigationContent}
                </a>
              ) : (
                <span
                  key={item.label}
                  aria-disabled="true"
                  className={`${navigationClassName} cursor-not-allowed opacity-55 hover:bg-transparent hover:text-muted-foreground`}
                  title="该模块将在数据闭环接入后开放"
                >
                  {navigationContent}
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
              自动打招呼保持关闭。所有联系动作均需 HR 人工确认。
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
              <div className="mb-1 flex items-center gap-2 text-xs font-medium text-muted-foreground">
                招聘运营
                <ChevronRight className="size-3" aria-hidden="true" />
                今日总览
              </div>
              <h1 className="text-2xl font-semibold tracking-tight">
                候选人筛选与审核
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                当前规则：海外运营 v3 · 英语专业八级为硬性条件
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="lg">
                <CalendarClock data-icon="inline-start" aria-hidden="true" />
                新建定时任务
              </Button>
              <Button size="lg">
                <Play data-icon="inline-start" aria-hidden="true" />
                立即执行筛选
              </Button>
            </div>
          </div>

          <section
            aria-label="自动化状态"
            className="mb-5 flex flex-col gap-3 rounded-xl border border-warning/30 bg-warning/8 px-4 py-3 sm:flex-row sm:items-center"
          >
            <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-warning/15 text-warning-foreground">
              <ShieldCheck className="size-[18px]" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold">自动打招呼总开关已关闭</p>
              <p className="text-xs leading-5 text-muted-foreground">
                系统只列出符合条件的候选人。审核通过后仍需人工点击打招呼。
              </p>
            </div>
            <Badge variant="outline" className="sm:ml-auto">
              安全默认值
            </Badge>
          </section>

          <section
            aria-label="今日指标"
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
                      {metric.delta}
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
                <CardTitle>正在运行</CardTitle>
                <CardDescription>
                  任务 BF-20260831-018 · 海外运营专员
                </CardDescription>
                <CardAction>
                  <Badge variant="secondary" className="text-primary">
                    读取候选人
                  </Badge>
                </CardAction>
              </CardHeader>
              <CardContent className="space-y-3">
                <Progress value={68} aria-label="任务进度 68%" />
                <div className="grid grid-cols-3 gap-2 text-xs">
                  <div>
                    <p className="text-muted-foreground">执行方式</p>
                    <p className="mt-1 font-medium">立即执行</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">已读取</p>
                    <p className="mt-1 font-medium tabular-nums">30 / 45</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">规则版本</p>
                    <p className="mt-1 font-medium">v3 · TEM8</p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card id="automation" className="scroll-mt-20">
              <CardHeader>
                <CardTitle>自动化控制</CardTitle>
                <CardDescription>
                  第二阶段能力已预留，默认全部关闭
                </CardDescription>
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
                  按规则得分排序，所有结论均展示原文证据
                </CardDescription>
                <CardAction>
                  <Button variant="outline" size="sm">
                    查看全部 12 人
                  </Button>
                </CardAction>
              </CardHeader>
              <CardContent className="px-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-4">候选人</TableHead>
                      <TableHead>匹配岗位</TableHead>
                      <TableHead>规则证据</TableHead>
                      <TableHead>得分</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead className="pr-4 text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {candidates.map((candidate) => (
                      <TableRow key={candidate.name}>
                        <TableCell className="pl-4">
                          <p className="font-medium">{candidate.name}</p>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {candidate.profile}
                          </p>
                        </TableCell>
                        <TableCell>{candidate.role}</TableCell>
                        <TableCell className="max-w-[320px] whitespace-normal">
                          <span className="text-xs leading-5">
                            {candidate.evidence}
                          </span>
                        </TableCell>
                        <TableCell>
                          <span className="font-medium tabular-nums">
                            {candidate.score}
                          </span>
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              candidate.status === '待审核'
                                ? 'secondary'
                                : 'outline'
                            }
                            className={
                              candidate.status === '有歧义'
                                ? 'text-warning-foreground'
                                : undefined
                            }
                          >
                            {candidate.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="pr-4 text-right">
                          <Button variant="outline" size="sm">
                            审核
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </section>
        </main>
      </div>
    </div>
  );
}
