import {
  BarChart3,
  BriefcaseBusiness,
  CircleGauge,
  ContactRound,
  GitPullRequestArrow,
  ListChecks,
  MessageSquareText,
  MessagesSquare,
  Settings,
  type LucideIcon,
} from 'lucide-react';

export type DepartmentRole =
  | 'admin'
  | 'recruiting_lead'
  | 'recruiter'
  | 'interviewer';

export type DashboardPage =
  | 'overview'
  | 'positions'
  | 'tasks'
  | 'candidates'
  | 'contacts'
  | 'audit';

export type WorkspaceNavigationItem = {
  href: string;
  label: string;
  shortLabel: string;
  icon: LucideIcon;
  page?: DashboardPage;
  relatedHrefs?: readonly string[];
  roles?: readonly DepartmentRole[];
  group?: 'core' | 'management';
};

const managers: readonly DepartmentRole[] = ['admin', 'recruiting_lead'];
const recruiters: readonly DepartmentRole[] = [
  'admin',
  'recruiting_lead',
  'recruiter',
];

export const primaryNavigation: readonly WorkspaceNavigationItem[] = [
  {
    page: 'overview',
    href: '/',
    label: '工作台',
    shortLabel: '工作台',
    icon: CircleGauge,
    group: 'core',
  },
  {
    page: 'positions',
    href: '/positions',
    label: '岗位设置',
    shortLabel: '岗位',
    icon: BriefcaseBusiness,
    roles: recruiters,
    group: 'core',
  },
  {
    page: 'tasks',
    href: '/tasks',
    label: '任务与计划',
    shortLabel: '任务',
    icon: ListChecks,
    roles: recruiters,
    group: 'core',
  },
  {
    page: 'candidates',
    href: '/candidates',
    label: '候选人',
    shortLabel: '候选人',
    icon: ContactRound,
    group: 'core',
  },
  {
    page: 'contacts',
    href: '/contacts',
    label: '联系',
    shortLabel: '联系',
    icon: MessageSquareText,
    roles: recruiters,
    group: 'core',
  },
  {
    href: '/communication',
    label: '实时沟通',
    shortLabel: '沟通',
    icon: MessagesSquare,
    roles: recruiters,
    group: 'core',
  },
  {
    href: '/pipeline',
    label: '招聘流程',
    shortLabel: '流程',
    icon: GitPullRequestArrow,
    group: 'core',
  },
  {
    href: '/operations',
    label: '招聘运营',
    shortLabel: '运营',
    icon: BarChart3,
    relatedHrefs: ['/analytics'],
    roles: recruiters,
    group: 'management',
  },
  {
    href: '/team',
    label: '系统设置',
    shortLabel: '设置',
    icon: Settings,
    relatedHrefs: ['/audit', '/boss-login', '/automation'],
    roles: managers,
    group: 'management',
  },
];

export const workspaceNavigation = primaryNavigation;

export type ModuleNavigationItem = {
  href: string;
  label: string;
  roles?: readonly DepartmentRole[];
};

export const moduleNavigation: readonly (readonly ModuleNavigationItem[])[] = [
  [{ href: '/positions', label: '岗位信息', roles: recruiters }],
  [
    { href: '/operations', label: '运营工作台', roles: recruiters },
    { href: '/analytics', label: '数据分析', roles: recruiters },
  ],
  [
    { href: '/team', label: '团队与权限', roles: managers },
    { href: '/boss-login', label: 'BOSS 扫码登录', roles: managers },
    { href: '/automation', label: '联系安全设置', roles: managers },
    { href: '/audit', label: '审计与安全', roles: managers },
  ],
];

export function canAccess(
  roles: readonly DepartmentRole[] | undefined,
  role: DepartmentRole,
): boolean {
  return !roles || roles.includes(role);
}

export function navigationForRole(role: DepartmentRole) {
  return primaryNavigation.filter((item) => canAccess(item.roles, role));
}

export function isNavigationActive(
  item: WorkspaceNavigationItem,
  currentHref: string,
): boolean {
  return (
    item.href === currentHref ||
    Boolean(item.relatedHrefs?.includes(currentHref))
  );
}
