'use client';

import Link from 'next/link';
import { LogOut, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { clearSessionToken } from './api-client';

const links = [
  ['/', '总览'], ['/positions', '岗位规则'], ['/team', '团队'], ['/pipeline', '招聘流程'],
  ['/rules', '规则治理'], ['/semantic', '语义评估'], ['/operations', '招聘运营'],
  ['/automation', '自动联系'], ['/analytics', '数据分析'], ['/audit', '审计'],
] as const;

export function WorkspaceShell({ current, title, description, children }: {
  current: string; title: string; description: string; children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-[1500px] items-center gap-4 px-5 py-4">
          <Link href="/" className="flex items-center gap-2 font-semibold"><span className="grid size-9 place-items-center rounded-xl bg-primary text-primary-foreground"><ShieldCheck className="size-5" /></span>Boss Forge</Link>
          <nav className="flex flex-1 gap-1 overflow-x-auto" aria-label="招聘工作台导航">
            {links.map(([href, label]) => <Link key={href} href={href} className={`whitespace-nowrap rounded-lg px-3 py-2 text-sm ${current === href ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`}>{label}</Link>)}
          </nav>
          <Button variant="ghost" size="sm" onClick={() => { clearSessionToken(); window.location.assign('/'); }}><LogOut className="size-4" />退出</Button>
        </div>
      </header>
      <main className="mx-auto max-w-[1500px] space-y-6 p-5 md:p-8">
        <div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">部门级 ATS · 内网</p><h1 className="mt-2 text-3xl font-semibold tracking-tight">{title}</h1><p className="mt-2 text-sm text-muted-foreground">{description}</p></div>
        {children}
      </main>
    </div>
  );
}
