'use client';

import { useCurrentUser } from './auth-gate';
import { NativeLink as Link } from './native-link';
import { canAccess, moduleNavigation } from './workspace-navigation';

export function ModuleTabs({ current }: { current: string }) {
  const user = useCurrentUser();
  const group = moduleNavigation.find((items) =>
    items.some((item) => item.href === current),
  );
  const visibleItems =
    group?.filter((item) => canAccess(item.roles, user.role)) ?? [];

  if (visibleItems.length < 2) return null;

  return (
    <nav
      data-spotlight="module-tabs"
      aria-label="当前模块"
      className="flex gap-5 overflow-x-auto border-b"
    >
      {visibleItems.map((item) => {
        const active = item.href === current;
        return (
          <Link
            key={item.href}
            href={item.href}
            scroll={false}
            aria-current={active ? 'page' : undefined}
            className={`flex min-h-11 shrink-0 items-center border-b-2 px-1 text-sm font-medium transition-colors ${
              active
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:border-border hover:text-foreground'
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
