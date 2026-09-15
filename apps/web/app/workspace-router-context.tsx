'use client';
import { createContext, useContext } from 'react';

export type WorkspaceRouter = {
  href: string;
  pending: string | null;
  navigate: (href: string, mode?: 'push' | 'pop') => Promise<boolean>;
  prefetch: (href: string) => void;
  cancel: () => void;
};
export const WorkspaceRouterContext = createContext<WorkspaceRouter | null>(
  null,
);
export function useWorkspaceRouter() {
  return useContext(WorkspaceRouterContext);
}
