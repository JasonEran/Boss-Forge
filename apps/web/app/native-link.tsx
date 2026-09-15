'use client';
import type { ComponentProps } from 'react';
import { useWorkspaceRouter } from './workspace-router-context';
import {
  shouldHandleWorkspaceClick,
  workspaceDestination,
} from './workspace-route-model';

type NativeLinkProps = Omit<ComponentProps<'a'>, 'href'> & {
  href: string;
  scroll?: boolean;
};

/**
 * Keep real anchors as a fallback, while the authenticated workspace switches
 * known client pages without an RSC navigation or a document reload.
 */
export function NativeLink({
  href,
  scroll: _scroll,
  children,
  onClick,
  onPointerEnter,
  onFocus,
  ...props
}: NativeLinkProps) {
  const router = useWorkspaceRouter();
  return (
    <a
      href={href}
      {...props}
      onClick={(event) => {
        onClick?.(event);
        if (
          !router ||
          !shouldHandleWorkspaceClick(event, props.target, props.download) ||
          !workspaceDestination(href, window.location.href)
        )
          return;
        event.preventDefault();
        void router.navigate(href);
      }}
      onPointerEnter={(event) => {
        onPointerEnter?.(event);
        router?.prefetch(href);
      }}
      onFocus={(event) => {
        onFocus?.(event);
        router?.prefetch(href);
      }}
    >
      {children}
    </a>
  );
}
