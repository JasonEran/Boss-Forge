'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowLeft,
  Check,
  CircleAlert,
  ChevronDown,
  Clock3,
  FileUser,
  ListChecks,
  LoaderCircle,
  MessageCircle,
  MessagesSquare,
  RefreshCw,
  Search,
  Send,
  BookOpenText,
  ContactRound,
  Wifi,
  WifiOff,
} from 'lucide-react';
import type {
  CommunicationCandidateContext,
  CommunicationConversation,
  CommunicationMessage,
  CommunicationThread,
} from '../../../../packages/contracts/src/communication';
import { COMMUNICATION_REFRESH_MS } from '../../../../packages/contracts/src/communication';
import { createCommunicationRefreshLoop } from './refresh-loop';
import { AttachmentResumeDialog } from './attachment-resume-dialog';
import { CandidateContextPanel } from './candidate-context-panel';
import { QuickRepliesDialog } from './quick-replies-dialog';
import { MessageAssets } from './message-assets';
import {
  LifecycleDialog,
  lifecycleDraftKey,
  type LifecycleDraft,
} from '../lifecycle/lifecycle-dialog';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { AuthGate, useCurrentUser } from '../auth-gate';
import { useCommunicationActivity } from './use-communication-activity';
import { apiFetch, controlApi, userFacingRequestError } from '../api-client';
import { WorkspaceShell } from '../workspace-shell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

type Connection = { connected: boolean; canSend: boolean; message: string };
const disconnected: Connection = {
  connected: false,
  canSend: false,
  message: '正在连接…',
};
const time = (value: string, full = false) =>
  new Date(value).toLocaleString(
    'zh-CN',
    full
      ? { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }
      : { hour: '2-digit', minute: '2-digit' },
  );
const day = (value: string) =>
  new Date(value).toLocaleDateString('zh-CN', {
    month: 'long',
    day: 'numeric',
  });

async function chatRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await apiFetch(
    `${controlApi}/api/communication${path}`,
    init,
    path.endsWith('/online-resume') && init.method === 'POST'
      ? 250000
      : undefined,
  );
  const body = (await response.json()) as { message?: string };
  if (!response.ok)
    throw new Error(body.message ?? '暂时无法连接，请稍后重试。');
  return body as T;
}

export function CommunicationPage() {
  return (
    <AuthGate allowedRoles={['admin', 'recruiting_lead', 'recruiter']}>
      <CommunicationClient />
    </AuthGate>
  );
}

export function CommunicationClient() {
  const user = useCurrentUser();
  const {
    leaseRef: activityRef,
    ready: communicationReady,
    status: communicationStatus,
  } = useCommunicationActivity();
  const request = useCallback(
    <T,>(path: string, init: RequestInit = {}): Promise<T> => {
      const live =
        init.method === 'POST' &&
        (path === '/sync' ||
          path.endsWith('/sync') ||
          path.endsWith('/messages') ||
          path.endsWith('/wechat') ||
          path.endsWith('/online-resume') ||
          path.endsWith('/request-resume') ||
          path.endsWith('/accept-resume'));
      if (!live) return chatRequest<T>(path, init);
      const lease = activityRef.current;
      if (!lease.leaseId || !lease.ready || document.hidden)
        return Promise.reject(new Error('实时沟通正在切换，请稍后操作。'));
      const headers = new Headers(init.headers);
      headers.set('x-boss-communication-lease', lease.leaseId);
      return chatRequest<T>(path, { ...init, headers });
    },
    [activityRef],
  );
  const draftKey = `boss-forge.chat-drafts:${user.departmentId}:${user.userId}`;
  const [lifecycleOpen, setLifecycleOpen] = useState(false);
  const [businessDraft, setBusinessDraft] = useState<LifecycleDraft | null>(
    null,
  );
  const directConversation = useRef<string | null>(null);
  const [conversations, setConversations] = useState<
    CommunicationConversation[]
  >([]);
  const [connection, setConnection] = useState(disconnected);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [positionFilter, setPositionFilter] = useState('all');
  const [contextTab, setContextTab] = useState<
    'resume' | 'requirements' | null
  >(null);
  const [resumeReading, setResumeReading] = useState(false);
  const [attachmentTarget, setAttachmentTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [thread, setThread] = useState<CommunicationThread | null>(null);
  const [candidateContext, setCandidateContext] =
    useState<CommunicationCandidateContext | null>(null);
  const [candidateContextError,setCandidateContextError]=useState('');
  const contextGeneration = useRef(0);
  const legacyAnalyses=useRef(new Set<string>());
  const [threadError, setThreadError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>(() => {
    try {
      const value: unknown = JSON.parse(
        sessionStorage.getItem(draftKey) ?? '{}',
      );
      return value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value).filter(
              ([, body]) => typeof body === 'string',
            ),
          )
        : {};
    } catch {
      return {};
    }
  });
  useEffect(() => {
    try {
      sessionStorage.setItem(draftKey, JSON.stringify(drafts));
    } catch {
      /* Keep the current in-memory draft. */
    }
  }, [draftKey, drafts]);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [newMessages, setNewMessages] = useState(false);
  const [polling, setPolling] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [coverageLimited, setCoverageLimited] = useState(false);
  const [quickRepliesOpen, setQuickRepliesOpen] = useState(false);
  const [wechatTarget, setWechatTarget] = useState<{
    id: string;
    name: string;
    position: string;
    kind?: 'wechat' | 'resume' | 'resume_accept';
    messageId?: string;
  } | null>(null);
  const [wechatError, setWechatError] = useState<string | null>(null);
  const [wechatSending, setWechatSending] = useState(false);
  const [wechatUncertain, setWechatUncertain] = useState(false);
  const [displayLimit, setDisplayLimit] = useState(100);
  const wechatAttempts = useRef<Record<string, string>>({});
  const refreshLoop = useRef<ReturnType<
    typeof createCommunicationRefreshLoop
  > | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const selectedRef = useRef(selected);
  const connectionRef = useRef(connection);
  const sendingRef = useRef<string | null>(null);
  const alive = useRef(true);
  const scroll = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const pinned = useRef(true);
  const messageCount = useRef(0);
  const attempt = useRef<
    Record<string, { body: string; key: string; context: string }>
  >({});
  const reads = useRef<Record<string, string>>({});

  const choose = useCallback((id: string | null) => {
    if(selectedRef.current===id)return;
    selectedRef.current = id;
    setCandidateContextError('');
    pinned.current = true;
    messageCount.current = 0;
    setSelected(id);
    setThread(null);
    setCandidateContext((previous) =>
      previous?.conversationId === id ? previous : null,
    );
    setNewMessages(false);
    setThreadError(null);
    setSendError(null);
    setSyncing(Boolean(id));
  }, []);

  const acceptCandidateContext = useCallback(
    (value: CommunicationCandidateContext) => {
      if (!alive.current || value.conversationId !== selectedRef.current)
        return;
      setCandidateContext((previous) => {
        if (
          previous?.conversationId === value.conversationId &&
          previous.resume &&
          (!value.resume ||
            previous.resume.capturedAt > value.resume.capturedAt)
        )
          return previous;
        if(previous?.resume && value.resume && previous.resume.captureId===value.resume.captureId &&
          (previous.resume.analysisVersion??0)>(value.resume.analysisVersion??0))return previous;
        return value;
      });
      setCandidateContextError('');
    },
    [],
  );
  useEffect(() => {
    if(!selected)return;
    const controller=new AbortController();
    const generation=++contextGeneration.current;
    let timer:ReturnType<typeof setTimeout>|undefined;
    const read=async()=>{
      if(document.hidden){timer=setTimeout(()=>void read(),2500);return;}
      try{
        const value=await request<CommunicationCandidateContext>(`/conversations/${selected}/online-resume`,{signal:controller.signal});
        if(controller.signal.aborted||generation!==contextGeneration.current)return;
        acceptCandidateContext(value);
        if(['pending','processing'].includes(value.resume?.textStatus??''))timer=setTimeout(()=>void read(),2500);
      }catch(error){
        if(!controller.signal.aborted && generation===contextGeneration.current){
          setCandidateContextError(userFacingRequestError(error));
          timer=setTimeout(()=>void read(),5000);
        }
      }
    };
    void read();
    return()=>{controller.abort();clearTimeout(timer);};
  },[selected,candidateContext?.resume?.textStatus,request,acceptCandidateContext]);

  useEffect(()=>{
    const resume=candidateContext?.conversationId===selected?candidateContext.resume:null;
    if(!selected||!contextTab||resume?.textStatus!=='skipped'||legacyAnalyses.current.has(resume.captureId))return;
    legacyAnalyses.current.add(resume.captureId);
    void request<CommunicationCandidateContext>(`/conversations/${selected}/online-resume/analyze`,{method:'POST'})
      .then(acceptCandidateContext)
      .catch(error=>{if(alive.current&&selectedRef.current===selected)setCandidateContextError(userFacingRequestError(error));});
  },[selected,contextTab,candidateContext,request,acceptCandidateContext]);

  const readVisible = useCallback(
    (value: CommunicationThread) => {
      if (
        document.hidden ||
        selectedRef.current !== value.conversation.id ||
        !pinned.current
      )
        return;
      const newest = [...value.messages].sort((a, b) =>
        b.receivedAt.localeCompare(a.receivedAt),
      )[0];
      if (!newest || reads.current[value.conversation.id] === newest.id) return;
      reads.current[value.conversation.id] = newest.id;
      void request(`/conversations/${value.conversation.id}/read`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ throughMessageId: newest.id }),
      })
        .then(() => {
          if (alive.current)
            setConversations((current) =>
              current.map((c) =>
                c.id === value.conversation.id ? { ...c, unreadCount: 0 } : c,
              ),
            );
        })
        .catch(() => {
          delete reads.current[value.conversation.id];
        });
    },
    [request],
  );

  const acceptThread = useCallback(
    (value: CommunicationThread, replace = false) => {
      if (!alive.current || selectedRef.current !== value.conversation.id)
        return;
      setThread((current) => {
        if (
          current?.conversation.id === value.conversation.id &&
          current.conversation.syncedAt &&
          value.conversation.syncedAt &&
          current.conversation.syncedAt > value.conversation.syncedAt
        )
          return current;
        if (
          replace ||
          !current ||
          current.conversation.id !== value.conversation.id
        )
          return value;
        const merged = new Map(
          current.messages.map((message) => [message.id, message]),
        );
        value.messages.forEach((message) => merged.set(message.id, message));
        return {
          ...value,
          hasOlder: current.hasOlder,
          before: current.before,
          messages: [...merged.values()].sort(
            (a, b) =>
              a.sentAt.localeCompare(b.sentAt) || a.id.localeCompare(b.id),
          ),
        };
      });
      setThreadError(null);
      readVisible(value);
    },
    [readVisible],
  );

  const refreshList = useCallback(
    async (sync: boolean) => {
      const value = await request<{
        conversations: CommunicationConversation[];
        connection: Connection;
        syncedAt?: string;
        coverageLimited?: boolean;
      }>(sync ? '/sync' : '/conversations', sync ? { method: 'POST' } : {});
      if (!alive.current) return;
      setConversations(value.conversations);
      if (sync && value.syncedAt) {
        setLastSyncAt(value.syncedAt);
        setCoverageLimited(value.coverageLimited ?? false);
      }
      connectionRef.current = value.connection;
      setConnection(value.connection);
      setListError(null);
      setLoading(false);
      if (
        selectedRef.current &&
        !value.conversations.some((c) => c.id === selectedRef.current) &&
        selectedRef.current !== directConversation.current
      ) {
        choose(null);
        // Preserve drafts if a conversation ages out of the seven-day list.
      }
    },
    [choose, request],
  );

  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    const loop = createCommunicationRefreshLoop({
      intervalMs: COMMUNICATION_REFRESH_MS,
      canRun: () => alive.current && !document.hidden && !sendingRef.current,
      readInbox: async () => {
        await refreshList(false);
        if (
          alive.current &&
          !document.hidden &&
          activityRef.current.ready &&
          !sendingRef.current &&
          connectionRef.current.connected
        )
          await refreshList(true);
      },
      readThread: async () => {
        const id = selectedRef.current;
        if (!id) return;
        const sync =
          activityRef.current.ready && connectionRef.current.connected;
        const value = await request<CommunicationThread>(
          `/conversations/${id}${sync ? '/sync' : ''}`,
          { ...(sync ? { method: 'POST' } : {}), signal: controller.signal },
        );
        acceptThread(value);
      },
      onError: (scope, error) => {
        if (!alive.current) return;
        if (scope === 'inbox') {
          setListError(userFacingRequestError(error));
          setLoading(false);
        } else setThreadError(userFacingRequestError(error));
      },
      onBusy: (value) => {
        if (alive.current) {
          setPolling(value);
          if (!value) setSyncing(false);
        }
      },
    });
    refreshLoop.current = loop;
    void loop.wake();
    const resume = () => {
      if (!document.hidden) void loop.wake();
    };
    document.addEventListener('visibilitychange', resume);
    return () => {
      alive.current = false;
      loop.stop();
      controller.abort();
      refreshLoop.current = null;
      document.removeEventListener('visibilitychange', resume);
    };
  }, [refreshList, acceptThread, activityRef, request]);

  useEffect(() => {
    if (communicationReady) void refreshLoop.current?.wake();
  }, [communicationReady]);

  useEffect(() => {
    const key = lifecycleDraftKey(user.departmentId, user.userId);
    const id = new URLSearchParams(window.location.search).get('conversation');
    let pending: LifecycleDraft | null = null;
    try {
      const raw = JSON.parse(sessionStorage.getItem(key) ?? 'null');
      if (
        raw &&
        typeof raw.body === 'string' &&
        typeof raw.conversationId === 'string' &&
        /^[0-9a-f-]{36}$/i.test(raw.conversationId) &&
        raw.delivery?.caseId
      )
        pending = raw as LifecycleDraft;
    } catch {
      /* Leave ordinary chat drafts intact. */
    }
    const selectedId = id ?? pending?.conversationId;
    if (selectedId && /^[0-9a-f-]{36}$/i.test(selectedId))
      queueMicrotask(() => {
        directConversation.current = selectedId;
        choose(selectedId);
        if (pending) setBusinessDraft(pending);
      });
  }, [choose, user.departmentId, user.userId]);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    const controller = new AbortController();
    void request<CommunicationThread>(`/conversations/${selected}`, {
      signal: controller.signal,
    })
      .then((value) => {
        if (!cancelled) acceptThread(value, true);
      })
      .catch((error) => {
        if (!cancelled) setThreadError(userFacingRequestError(error));
      })
      .finally(() => {
        if (!cancelled) {
          setSyncing(false);
          void refreshLoop.current?.wake();
        }
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [selected, acceptThread, request]);

  async function refreshNow() {
    if (sendingRef.current) return;
    await refreshLoop.current?.wake();
  }

  useEffect(() => {
    if (!thread) return;
    const node = scroll.current;
    if (node && pinned.current) node.scrollTop = node.scrollHeight;
    else if (thread.messages.length > messageCount.current)
      queueMicrotask(() => setNewMessages(true));
    messageCount.current = thread.messages.length;
  }, [thread]);

  useEffect(() => {
    const node = scroll.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      if (pinned.current) node.scrollTop = node.scrollHeight;
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [thread?.conversation.id]);

  async function loadOlder() {
    if (!selected || !thread?.before || loadingOlder) return;
    const id = selected;
    const node = scroll.current;
    const previousHeight = node?.scrollHeight ?? 0;
    setLoadingOlder(true);
    try {
      const older = await request<CommunicationThread>(
        `/conversations/${id}?before=${thread.before}`,
      );
      if (selectedRef.current !== id) return;
      pinned.current = false;
      setThread((current) =>
        current && current.conversation.id === id
          ? {
              ...current,
              hasOlder: older.hasOlder,
              before: older.before,
              messages: [
                ...older.messages.filter(
                  (m) =>
                    !current.messages.some((existing) => existing.id === m.id),
                ),
                ...current.messages,
              ],
            }
          : current,
      );
      requestAnimationFrame(() => {
        if (node) node.scrollTop += node.scrollHeight - previousHeight;
      });
    } catch (error) {
      if (selectedRef.current === id)
        setThreadError(userFacingRequestError(error));
    } finally {
      setLoadingOlder(false);
    }
  }

  async function sendMessage() {
    const id = selectedRef.current;
    const business =
      businessDraft?.conversationId === id ? businessDraft : null;
    const body = business?.body ?? (id ? (drafts[id] ?? '').trim() : '');
    if (
      !id ||
      !body ||
      body.length > 500 ||
      sendingRef.current ||
      !activityRef.current.ready ||
      !connection.canSend ||
      !thread?.conversation.canReply
    )
      return;
    sendingRef.current = id;
    setSendingId(id);
    setSendError(null);
    const previous = attempt.current[id];
    const currentAttempt =
      previous?.body === body &&
      previous.context === JSON.stringify(business?.delivery ?? null)
        ? previous
        : {
            body,
            context: JSON.stringify(business?.delivery ?? null),
            key: crypto.randomUUID(),
          };
    attempt.current[id] = currentAttempt;
    try {
      await refreshLoop.current?.idle();
      if (!alive.current || document.hidden || !activityRef.current.ready)
        return;
      const result = await request<
        CommunicationThread & { outgoingId: string }
      >(`/conversations/${id}/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': currentAttempt.key,
        },
        body: JSON.stringify({
          body,
          ...(business ? { delivery: business.delivery } : {}),
        }),
      });
      if (!alive.current) return;
      const outgoing = result.messages.find((m) => m.id === result.outgoingId);
      acceptThread(result);
      if (outgoing?.status === 'failed') {
        delete attempt.current[id];
        if (selectedRef.current === id)
          setSendError(outgoing.error ?? '本次未发送，草稿已保留。');
      } else {
        if (business) {
          setBusinessDraft(null);
          sessionStorage.removeItem(
            lifecycleDraftKey(user.departmentId, user.userId),
          );
        } else
          setDrafts((values) =>
            values[id]?.trim() === body ? { ...values, [id]: '' } : values,
          );
        delete attempt.current[id];
        pinned.current = true;
      }
    } catch (error) {
      if (alive.current && selectedRef.current === id)
        setSendError(userFacingRequestError(error));
    } finally {
      sendingRef.current = null;
      if (alive.current) {
        setSendingId(null);
        textarea.current?.focus();
        void refreshLoop.current?.wake();
      }
    }
  }

  const loadAttachment = useCallback(
    async (id: string): Promise<Blob> => {
      const lease = activityRef.current;
      if (
        !lease.ready ||
        !lease.leaseId ||
        document.hidden ||
        sendingRef.current
      )
        throw new Error('请等待当前操作完成后再查看附件。');
      sendingRef.current = id;
      setResumeReading(true);
      try {
        await refreshLoop.current?.idle();
        const response = await apiFetch(
          `${controlApi}/api/communication/conversations/${id}/attachment-resume`,
          {
            method: 'POST',
            headers: { 'x-boss-communication-lease': lease.leaseId },
          },
          70000,
        );
        if (!response.ok) {
          const result = (await response.json()) as { message?: string };
          throw new Error(result.message || '附件简历暂时无法打开。');
        }
        return await response.blob();
      } finally {
        sendingRef.current = null;
        if (alive.current) {
          setResumeReading(false);
          void refreshLoop.current?.wake();
        }
      }
    },
    [activityRef],
  );

  function insertQuickReply(body: string) {
    const id = selectedRef.current;
    if (!id || businessDraft?.conversationId === id) return;
    const existing = drafts[id] ?? '';
    const combined = existing ? `${existing}\n${body}` : body;
    if (combined.length > 500) {
      setSendError('加入常用语后超过 500 字，请先精简草稿。');
      setQuickRepliesOpen(false);
      return;
    }
    setDrafts((current) => ({ ...current, [id]: combined }));
    setQuickRepliesOpen(false);
    setSendError(null);
    requestAnimationFrame(() => textarea.current?.focus());
  }

  async function exchangeWechat() {
    const target = wechatTarget;
    if (
      !target ||
      wechatUncertain ||
      sendingRef.current ||
      !activityRef.current.ready
    )
      return;
    sendingRef.current = target.id;
    setWechatSending(true);
    setWechatError(null);
    const attemptKey = `${target.id}:${target.kind ?? 'wechat'}:${target.messageId ?? ''}`;
    const key = wechatAttempts.current[attemptKey] ?? crypto.randomUUID();
    wechatAttempts.current[attemptKey] = key;
    try {
      await refreshLoop.current?.idle();
      if (!alive.current || document.hidden || !activityRef.current.ready)
        return;
      const value = await request<CommunicationThread>(
        `/conversations/${target.id}/${target.kind === 'resume_accept' ? 'accept-resume' : target.kind === 'resume' ? 'request-resume' : 'wechat'}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': key,
          },
          body: JSON.stringify({
            confirmed: true,
            ...(target.messageId ? { messageId: target.messageId } : {}),
          }),
        },
      );
      if (!alive.current) return;
      acceptThread(value);
      const action =
        target.kind === 'resume_accept'
          ? value.messages.find((m) => m.id === target.messageId)?.resumeOffer
              ?.action
          : target.kind === 'resume'
            ? value.resumeAction
            : value.wechatAction;
      if (action?.status === 'failed') {
        delete wechatAttempts.current[attemptKey];
        setWechatError(action.error || '本次未发起申请。');
      } else if (action?.status === 'uncertain') {
        setWechatUncertain(true);
        setWechatError(action.error || '请核对最新消息与原生按钮状态。');
      } else setWechatTarget(null);
    } catch (error) {
      if (alive.current) setWechatError(userFacingRequestError(error));
    } finally {
      sendingRef.current = null;
      if (alive.current) {
        setWechatSending(false);
        void refreshLoop.current?.wake();
      }
    }
  }

  const visible = conversations.filter(
    (c) =>
      (!unreadOnly || c.unreadCount > 0) &&
      (positionFilter === 'all' ||
        (c.positionId ?? 'unbound') === positionFilter) &&
      c.candidateName
        .toLocaleLowerCase()
        .includes(search.trim().toLocaleLowerCase()),
  );
  const unread = conversations.filter((c) => c.unreadCount > 0).length;
  const current = thread?.conversation.id === selected ? thread : null;
  const selectedConversation =
    current?.conversation ?? conversations.find((c) => c.id === selected);
  const qualification =
    candidateContext?.conversationId === selected
      ? candidateContext.qualification
      : null;
  const notQualified =
    qualification?.status === 'negative' || qualification?.status === 'unknown';
  const businessSelected =
    businessDraft?.conversationId === selected ? businessDraft : null;
  const draft =
    businessSelected?.body ?? (selected ? (drafts[selected] ?? '') : '');
  const canSend = Boolean(
    communicationReady && connection.canSend && current?.conversation.canReply,
  );

  const wechatPending =
    current?.wechatAction &&
    ['queued', 'sending', 'sent', 'uncertain'].includes(
      current.wechatAction.status,
    );
  const wechatState = current?.wechat?.state;
  const wechatLabel =
    wechatState === 'exchanged'
      ? '已交换微信'
      : current?.wechatAction?.status === 'uncertain'
        ? '微信结果待确认'
        : wechatState === 'pending' || wechatPending
          ? '微信已申请'
          : '交换微信';
  const wechatReason =
    current?.wechatAction?.status === 'uncertain'
      ? current.wechatAction.error
      : wechatPending && wechatState !== 'exchanged'
        ? '微信交换已申请，等待 BOSS 和对方确认。'
        : current?.wechat?.reason;

  return (
    <WorkspaceShell
      conversationLayout
      current="/communication"
      title="实时沟通"
      description="BOSS 沟通栏 · 最近 7 天有消息的会话。新回复自动更新，无需逐个点开。"
      actions={
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center gap-2 text-xs ${connection.connected ? 'text-emerald-700 dark:text-emerald-300' : 'text-muted-foreground'}`}
          >
            {connection.connected ? (
              <Wifi className="size-4" aria-hidden="true" />
            ) : (
              <WifiOff className="size-4" aria-hidden="true" />
            )}
            <span className="hidden sm:inline" title={connection.message}>
              {connection.connected ? 'BOSS 已连接' : 'BOSS 未连接'}
            </span>
          </span>
          <Button
            variant="outline"
            className="min-h-11"
            disabled={
              polling || Boolean(sendingId) || wechatSending || resumeReading
            }
            onClick={() => void refreshNow()}
          >
            <RefreshCw
              className={`size-4 ${polling ? 'animate-spin motion-reduce:animate-none' : ''}`}
              aria-hidden="true"
            />
            刷新
          </Button>
        </div>
      }
    >
      <div className="flex shrink-0 items-center justify-between gap-2 px-2 text-xs text-muted-foreground">
        <output title={communicationStatus} className="min-w-0 truncate">
          {resumeReading
            ? '正在读取在线简历，消息同步稍后继续…'
            : communicationReady
              ? connection.connected
                ? '自动更新 · 筛选已暂停'
                : '等待 BOSS 重新连接'
              : communicationStatus}
          <span className="hidden sm:inline">
            {lastSyncAt
              ? ` · ${new Date(lastSyncAt).toLocaleTimeString('zh-CN')} 同步`
              : ''}
          </span>
        </output>
        <span className="shrink-0">
          {unread ? `${unread} 个未读会话` : '消息已读'}
        </span>
      </div>
      {coverageLimited ? (
        <output className="block text-xs text-muted-foreground">
          BOSS 近 7
          天的会话尚未全部加载，已显示当前读取到的内容，将继续尝试更新。
        </output>
      ) : null}
      <div
        className="relative flex min-h-0 flex-1 overflow-hidden rounded-xl border bg-card shadow-sm"
        aria-label="实时沟通工作区"
      >
        <aside
          className={`${selected ? 'hidden md:flex' : 'flex'} w-full shrink-0 flex-col border-r md:w-[268px] xl:w-[280px]`}
          aria-label="会话列表"
        >
          <div className="shrink-0 space-y-2 border-b p-3">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold">
                沟通中{' '}
                <span className="ml-1 text-sm font-normal text-muted-foreground">
                  {conversations.length}
                </span>
              </h2>
              <MessagesSquare
                className="size-5 text-muted-foreground"
                aria-hidden="true"
              />
            </div>
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                aria-label="搜索姓名"
                placeholder="搜索姓名"
                className="min-h-11 bg-muted/35 pl-9"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setDisplayLimit(100);
                }}
              />
            </div>
            <details
              className="rounded-lg border bg-muted/20"
              key="position-filter"
            >
              <summary className="flex min-h-11 cursor-pointer items-center px-3 text-sm font-medium">
                岗位：
                {positionFilter === 'all'
                  ? '全部岗位'
                  : positionFilter === 'unbound'
                    ? '未关联岗位'
                    : (conversations.find(
                        (c) => c.positionId === positionFilter,
                      )?.positionName ?? '所选岗位')}
                <ChevronDown
                  className="ml-auto size-4 shrink-0"
                  aria-hidden="true"
                />
              </summary>
              <div
                aria-label="筛选岗位"
                className="flex max-h-44 flex-wrap gap-1 overflow-y-auto border-t p-2"
              >
                {[
                  { id: 'all', name: '全部岗位' },
                  ...Array.from(
                    new Map(
                      conversations.map((c) => [
                        c.positionId ?? 'unbound',
                        {
                          id: c.positionId ?? 'unbound',
                          name: c.positionId ? c.positionName : '未关联岗位',
                        },
                      ]),
                    ).values(),
                  ),
                ].map((p) => (
                  <Button
                    key={p.id}
                    type="button"
                    variant={positionFilter === p.id ? 'secondary' : 'ghost'}
                    aria-pressed={positionFilter === p.id}
                    className="min-h-11 h-auto max-w-full whitespace-normal text-left text-xs"
                    onClick={() => {
                      setPositionFilter(p.id);
                      setDisplayLimit(100);
                    }}
                  >
                    {p.name}
                  </Button>
                ))}
              </div>
            </details>
            <div className="flex gap-2">
              <Button
                variant={unreadOnly ? 'ghost' : 'secondary'}
                className="min-h-11"
                aria-pressed={!unreadOnly}
                onClick={() => setUnreadOnly(false)}
              >
                全部
              </Button>
              <Button
                variant={unreadOnly ? 'secondary' : 'ghost'}
                className="min-h-11"
                aria-pressed={unreadOnly}
                onClick={() => setUnreadOnly(true)}
              >
                未读{unread ? ` · ${unread}` : ''}
              </Button>
            </div>
          </div>
          {listError ? (
            <output className="block border-b bg-muted/40 px-4 py-3 text-xs leading-5 text-muted-foreground">
              {listError}
            </output>
          ) : null}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {loading ? (
              <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
                <LoaderCircle className="size-4 animate-spin" />
                正在读取会话…
              </div>
            ) : visible.length ? (
              visible.slice(0, displayLimit).map((c) => (
                <button
                  key={c.id}
                  type="button"
                  aria-label={`与${c.candidateName}沟通`}
                  aria-pressed={selected === c.id}
                  onClick={() => choose(c.id)}
                  className={`flex min-h-24 w-full gap-3 border-b border-border/50 p-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-primary ${selected === c.id ? 'bg-primary/7' : ''}`}
                >
                  <span
                    className={`grid size-11 shrink-0 place-items-center rounded-full text-base font-semibold ${selected === c.id ? 'bg-primary text-primary-foreground' : 'bg-secondary text-primary'}`}
                  >
                    {c.candidateName.slice(0, 1)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-semibold">
                        {c.candidateName}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {time(c.lastMessageAt, true)}
                      </span>
                    </span>
                    <span className="mt-1 block truncate text-xs text-muted-foreground">
                      {c.positionName}
                    </span>
                    <span className="mt-2 flex items-center justify-between gap-3">
                      <span className="truncate text-sm text-muted-foreground">
                        {c.lastMessage || '联系已建立，开始沟通吧'}
                      </span>
                      {c.unreadCount > 0 ? (
                        <span
                          className="grid min-w-5 shrink-0 place-items-center rounded-full bg-primary px-1.5 text-xs leading-5 text-primary-foreground"
                          aria-label={`${c.unreadCount} 条未读`}
                        >
                          {c.unreadCount > 99 ? '99+' : c.unreadCount}
                        </span>
                      ) : null}
                    </span>
                  </span>
                </button>
              ))
            ) : (
              <div className="space-y-2 px-6 py-12 text-center">
                <MessageCircle
                  className="mx-auto mb-4 size-8 text-muted-foreground/60"
                  aria-hidden="true"
                />
                <p className="text-sm font-medium">
                  {search
                    ? '没有找到匹配会话'
                    : unreadOnly
                      ? '暂时没有未读消息'
                      : '最近 7 天暂无会话'}
                </p>
                <p className="text-xs leading-5 text-muted-foreground">
                  {!search && !unreadOnly
                    ? '连接 BOSS 后，这里会自动显示最近一周的沟通。'
                    : '试试其他关键词，或查看全部会话。'}
                </p>
              </div>
            )}
          </div>
          <div className="shrink-0 border-t px-3 py-2 text-xs text-muted-foreground">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>最近 7 天 · 按最新消息排序</span>
              {visible.length > displayLimit ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="min-h-11"
                  onClick={() => setDisplayLimit((n) => n + 100)}
                >
                  查看更多会话（{Math.min(displayLimit, visible.length)}/
                  {visible.length}）
                </Button>
              ) : null}
            </div>
          </div>
        </aside>
        <section
          className={`${selected ? 'flex' : 'hidden md:flex'} min-w-0 flex-1 flex-col`}
          aria-label="聊天内容"
        >
          {!selected ? (
            <div className="grid flex-1 place-items-center bg-muted/20 p-8 text-center">
              <div className="max-w-sm">
                <span className="mx-auto mb-5 grid size-16 place-items-center rounded-2xl border bg-card">
                  <MessagesSquare
                    className="size-8 text-primary"
                    aria-hidden="true"
                  />
                </span>
                <h2 className="text-lg font-semibold">从一句回复开始</h2>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  选择左侧的会话，查看聊天记录并继续沟通。
                </p>
              </div>
            </div>
          ) : (
            <>
              <header className="flex min-h-16 shrink-0 items-center justify-between gap-2 border-b px-3 py-2">
                <div className="flex min-w-0 items-center gap-3">
                  <Button
                    variant="ghost"
                    className="min-h-11 min-w-11 md:hidden"
                    aria-label="返回会话列表"
                    onClick={() => choose(null)}
                  >
                    <ArrowLeft className="size-5" />
                  </Button>
                  <div className="min-w-0">
                    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                      <h2 className="truncate font-semibold">
                        {selectedConversation?.candidateName ?? '正在读取…'}
                      </h2>
                      {notQualified ? (
                        <output
                          aria-label="岗位条件：不符合"
                          title={qualification?.reason}
                          className="shrink-0 rounded bg-red-50 px-1.5 py-0.5 text-xs font-semibold text-red-700 dark:bg-red-950/50 dark:text-red-300"
                        >
                          不符合
                        </output>
                      ) : null}
                    </div>
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      {selectedConversation?.positionName}
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button
                    type="button"
                    variant={contextTab === 'resume' ? 'secondary' : 'ghost'}
                    className="min-h-11 px-2 text-xs"
                    aria-expanded={contextTab === 'resume'}
                    onClick={() =>
                      setContextTab(contextTab === 'resume' ? null : 'resume')
                    }
                  >
                    <FileUser className="size-4" aria-hidden="true" />
                    在线简历
                  </Button>
                  <Button
                    type="button"
                    variant={
                      contextTab === 'requirements' ? 'secondary' : 'ghost'
                    }
                    className="min-h-11 px-2 text-xs"
                    aria-expanded={contextTab === 'requirements'}
                    onClick={() =>
                      setContextTab(
                        contextTab === 'requirements' ? null : 'requirements',
                      )
                    }
                  >
                    <ListChecks className="size-4" aria-hidden="true" />
                    <span className="hidden sm:inline">岗位</span>要求
                  </Button>
                </div>
              </header>
              {threadError ? (
                <output className="block border-b bg-muted/40 px-5 py-3 text-xs leading-5">
                  {threadError}
                </output>
              ) : null}
              <div className="relative flex min-h-0 flex-1 flex-col bg-muted/25">
                <div
                  ref={scroll}
                  className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 sm:px-6"
                  role="log"
                  aria-label="消息记录"
                  aria-live="polite"
                  aria-relevant="additions text"
                  onScroll={() => {
                    const node = scroll.current!;
                    pinned.current =
                      node.scrollHeight - node.scrollTop - node.clientHeight <
                      70;
                    if (pinned.current) {
                      setNewMessages(false);
                      if (current) readVisible(current);
                    }
                  }}
                >
                  {current?.hasOlder ? (
                    <div className="mb-4 text-center">
                      <Button
                        variant="ghost"
                        className="min-h-11 text-xs"
                        disabled={loadingOlder}
                        onClick={() => void loadOlder()}
                      >
                        {loadingOlder ? '正在读取…' : '加载更早消息'}
                      </Button>
                    </div>
                  ) : current?.historyLimited ? (
                    <p className="mb-6 text-center text-xs leading-5 text-muted-foreground">
                      这里保留已同步的消息，更早记录可在 BOSS 查看
                    </p>
                  ) : null}
                  {!current || (!current.messages.length && syncing) ? (
                    <div className="flex justify-center gap-2 p-8 text-sm text-muted-foreground">
                      <LoaderCircle className="size-4 animate-spin" />
                      正在读取聊天记录…
                    </div>
                  ) : !current.messages.length ? (
                    <p className="py-12 text-center text-sm text-muted-foreground">
                      会话已建立，等待同步聊天消息。
                    </p>
                  ) : (
                    current.messages.map((message, index) => (
                      <Message
                        conversationId={selected!}
                        key={message.id}
                        message={message}
                        showDay={
                          index === 0 ||
                          day(current.messages[index - 1]!.sentAt) !==
                            day(message.sentAt)
                        }
                        canAccept={
                          canSend &&
                          !sendingId &&
                          !wechatSending &&
                          !resumeReading
                        }
                        attachmentAvailable={Boolean(
                          current.attachmentAvailable,
                        )}
                        onAttachment={() =>
                          setAttachmentTarget({
                            id: selected!,
                            name:
                              selectedConversation?.candidateName ?? '候选人',
                          })
                        }
                        onAccept={() => {
                          setWechatError(null);
                          setWechatUncertain(false);
                          setWechatTarget({
                            id: selected!,
                            name:
                              selectedConversation?.candidateName ?? '候选人',
                            position: selectedConversation?.positionName ?? '',
                            kind: 'resume_accept',
                            messageId: message.id,
                          });
                        }}
                        onRetry={() => {
                          setDrafts((values) => ({
                            ...values,
                            [selected]: message.body,
                          }));
                          delete attempt.current[selected];
                          textarea.current?.focus();
                        }}
                      />
                    ))
                  )}
                </div>
                {newMessages ? (
                  <Button
                    variant="secondary"
                    className="absolute bottom-3 left-1/2 min-h-11 -translate-x-1/2 rounded-full shadow-sm"
                    onClick={() => {
                      pinned.current = true;
                      setNewMessages(false);
                      if (scroll.current)
                        scroll.current.scrollTop = scroll.current.scrollHeight;
                      if (current) readVisible(current);
                    }}
                  >
                    <ArrowDown className="size-4" />
                    查看新消息
                  </Button>
                ) : null}
              </div>
              <form
                className="shrink-0 space-y-1 border-t bg-card px-3 pb-2 pt-1"
                onSubmit={(e) => {
                  e.preventDefault();
                  void sendMessage();
                }}
              >
                <div className="flex items-center gap-1 overflow-x-auto">
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    onClick={() => setLifecycleOpen(true)}
                  >
                    招聘跟进
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    disabled={Boolean(businessSelected)}
                    onClick={() => setQuickRepliesOpen(true)}
                  >
                    <BookOpenText className="size-4" aria-hidden="true" />
                    常用语
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    disabled={
                      !canSend ||
                      wechatState !== 'available' ||
                      Boolean(wechatPending) ||
                      wechatSending ||
                      Boolean(sendingId)
                    }
                    title={wechatReason || '通过 BOSS 发起微信交换'}
                    onClick={() => {
                      if (selectedConversation) {
                        setWechatError(null);
                        setWechatUncertain(false);
                        setWechatTarget({
                          id: selectedConversation.id,
                          name: selectedConversation.candidateName,
                          position: selectedConversation.positionName,
                        });
                      }
                    }}
                  >
                    <ContactRound className="size-4" aria-hidden="true" />
                    {wechatLabel}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    disabled={
                      (current?.attachmentAvailable
                        ? !communicationReady || !connection.connected
                        : !canSend) ||
                      Boolean(sendingId) ||
                      wechatSending ||
                      resumeReading ||
                      (!current?.attachmentAvailable &&
                        (current?.resume?.state !== 'available' ||
                          Boolean(
                            current.resumeAction &&
                            ['queued', 'sending', 'sent', 'uncertain'].includes(
                              current.resumeAction.status,
                            ),
                          )))
                    }
                    onClick={() => {
                      if (selectedConversation) {
                        if (current?.attachmentAvailable) {
                          setAttachmentTarget({
                            id: selectedConversation.id,
                            name: selectedConversation.candidateName,
                          });
                          return;
                        }
                        setWechatError(null);
                        setWechatUncertain(false);
                        setWechatTarget({
                          id: selectedConversation.id,
                          name: selectedConversation.candidateName,
                          position: selectedConversation.positionName,
                          kind: 'resume',
                        });
                      }
                    }}
                  >
                    {current?.attachmentAvailable
                      ? '查看附件简历'
                      : current?.resume?.state === 'exchanged'
                        ? '已收简历'
                        : current?.resumeAction?.status === 'uncertain'
                          ? '简历申请待核对'
                          : current?.resume?.state === 'pending' ||
                              current?.resumeAction?.status === 'sent'
                            ? '已申请简历'
                            : '求简历'}
                  </Button>
                </div>
                {!canSend && current ? (
                  <p className="text-xs leading-5 text-muted-foreground">
                    {current.conversation.replyBlockedReason ||
                      (!connection.connected
                        ? 'BOSS 暂未连接，可先编辑草稿。'
                        : '真实发送暂未开启，可先编辑草稿。')}
                  </p>
                ) : null}
                {sendError ? (
                  <p
                    role="alert"
                    className="text-xs leading-5 text-destructive"
                  >
                    {sendError}
                  </p>
                ) : null}
                <label className="sr-only" htmlFor="communication-draft">
                  消息内容
                </label>
                {businessSelected ? (
                  <div className="space-y-1 rounded-md bg-secondary p-3 text-xs leading-5">
                    <p>
                      {businessSelected.delivery.kind === 'offer'
                        ? '录用邀请'
                        : '面试邀请'}{' '}
                      · 按已确认的版本发送，原聊天草稿已保留。
                    </p>
                    <button
                      type="button"
                      className="min-h-11 text-primary underline"
                      disabled={Boolean(sendingId)}
                      onClick={() => {
                        setBusinessDraft(null);
                        sessionStorage.removeItem(
                          lifecycleDraftKey(user.departmentId, user.userId),
                        );
                      }}
                    >
                      取消邀请草稿，恢复原消息
                    </button>
                  </div>
                ) : null}
                <textarea
                  id="communication-draft"
                  ref={textarea}
                  value={draft}
                  readOnly={Boolean(businessSelected)}
                  maxLength={500}
                  rows={2}
                  placeholder="输入消息，继续沟通…"
                  className="max-h-28 min-h-12 w-full resize-none rounded-lg bg-transparent px-1 py-1 text-base sm:text-sm leading-6 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onChange={(e) =>
                    setDrafts((values) => ({
                      ...values,
                      [selected]: e.target.value,
                    }))
                  }
                  onKeyDown={(e) => {
                    if (
                      e.key === 'Enter' &&
                      !e.shiftKey &&
                      !e.nativeEvent.isComposing
                    ) {
                      e.preventDefault();
                      void sendMessage();
                    }
                  }}
                />
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs text-muted-foreground">
                    <span className="hidden sm:inline">
                      Enter 发送 · Shift + Enter 换行
                    </span>
                    <span className="sm:ml-3">{draft.length}/500</span>
                  </p>
                  <Button
                    type="submit"
                    className="min-h-11 min-w-24"
                    disabled={
                      !canSend ||
                      !draft.trim() ||
                      Boolean(sendingId) ||
                      wechatSending ||
                      resumeReading
                    }
                  >
                    {sendingId === selected ? (
                      <LoaderCircle
                        className="size-4 animate-spin"
                        aria-hidden="true"
                      />
                    ) : (
                      <Send className="size-4" aria-hidden="true" />
                    )}
                    {sendingId === selected ? '发送中' : '发送'}
                  </Button>
                </div>
              </form>
            </>
          )}
        </section>
        {selected && contextTab ? (
          <CandidateContextPanel
            key={selected}
            conversationId={selected}
            name={selectedConversation?.candidateName ?? '候选人'}
            tab={contextTab}
            onTab={setContextTab}
            onClose={() => setContextTab(null)}
            context={candidateContext}
            contextError={candidateContextError}
            onAnalyze={async()=>{
              const context=await request<CommunicationCandidateContext>(`/conversations/${selected}/online-resume/analyze`,{method:'POST'});
              acceptCandidateContext(context);
            }}
            contacts={current?.contacts ?? []}
            wechatReason={wechatReason}
            resumeReason={
              current?.resumeAction?.error || current?.resume?.reason
            }
            canRead={
              communicationReady &&
              connection.connected &&
              !sendingId &&
              !wechatSending &&
              !resumeReading
            }
            onRead={async () => {
              if (sendingRef.current) throw new Error('请等待当前操作完成。');
              sendingRef.current = selected;
              setResumeReading(true);
              try {
                await refreshLoop.current?.idle();
                ++contextGeneration.current;
                const context = await request<CommunicationCandidateContext>(
                  `/conversations/${selected}/online-resume`,
                  { method: 'POST' },
                );
                acceptCandidateContext(context);
                return context;
              } finally {
                sendingRef.current = null;
                if (alive.current) {
                  setResumeReading(false);
                  void refreshLoop.current?.wake();
                }
              }
            }}
            onInsert={(body) => {
              if (!businessSelected) {
                insertQuickReply(body);
                setContextTab(null);
              }
            }}
            canInsert={!businessSelected}
            onLifecycle={() => {
              setContextTab(null);
              setLifecycleOpen(true);
            }}
          />
        ) : null}
      </div>
      <QuickRepliesDialog
        open={quickRepliesOpen}
        onOpenChange={setQuickRepliesOpen}
        onInsert={insertQuickReply}
        request={request}
        canInsert={
          Boolean(selected) && !sendingId && !wechatSending && !businessSelected
        }
      />
      <LifecycleDialog
        open={lifecycleOpen}
        onOpenChange={setLifecycleOpen}
        {...(selected ? { conversationId: selected } : {})}
        onCompose={(value) => {
          setBusinessDraft(value);
          sessionStorage.setItem(
            lifecycleDraftKey(user.departmentId, user.userId),
            JSON.stringify(value),
          );
        }}
      />
      {attachmentTarget ? (
        <AttachmentResumeDialog
          key={attachmentTarget.id}
          conversationId={attachmentTarget.id}
          name={attachmentTarget.name}
          onClose={() => setAttachmentTarget(null)}
          loadFile={loadAttachment}
        />
      ) : null}
      <Dialog
        open={Boolean(wechatTarget)}
        onOpenChange={(open) => {
          if (!open && !wechatSending) setWechatTarget(null);
        }}
      >
        <DialogContent showCloseButton={!wechatSending}>
          <DialogHeader>
            <DialogTitle>
              向 {wechatTarget?.name}{' '}
              {wechatTarget?.kind === 'resume_accept'
                ? '同意接收附件简历'
                : wechatTarget?.kind === 'resume'
                  ? '索取简历'
                  : '申请交换微信'}
            </DialogTitle>
            <DialogDescription>
              {wechatTarget?.position} ·{' '}
              {wechatTarget?.kind === 'resume_accept'
                ? '将点击这条 BOSS 附件简历申请的“同意”按钮，接收对方分享的简历。'
                : `将点击 BOSS 的“${wechatTarget?.kind === 'resume' ? '求简历' : '换微信'}”按钮并确认申请，等待对方同意并分享。`}
            </DialogDescription>
          </DialogHeader>
          {wechatError ? (
            <p role="alert" className="text-sm leading-6 text-destructive">
              {wechatError}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={wechatSending}
              onClick={() => setWechatTarget(null)}
            >
              取消
            </Button>
            <Button
              type="button"
              className="min-h-11"
              disabled={
                wechatSending ||
                wechatUncertain ||
                !communicationReady ||
                !connection.canSend
              }
              onClick={() => void exchangeWechat()}
            >
              {wechatSending ? (
                <LoaderCircle
                  className="size-4 animate-spin"
                  aria-hidden="true"
                />
              ) : null}
              {wechatSending
                ? '正在处理…'
                : wechatTarget?.kind === 'resume_accept'
                  ? '通过 BOSS 同意接收'
                  : wechatTarget?.kind === 'resume'
                    ? '通过 BOSS 索取简历'
                    : '通过 BOSS 申请交换微信'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </WorkspaceShell>
  );
}

function Message({
  conversationId,
  message,
  showDay,
  onRetry,
  canAccept,
  onAccept,
  onAttachment,
  attachmentAvailable,
}: {
  conversationId: string;
  message: CommunicationMessage;
  showDay: boolean;
  onRetry: () => void;
  canAccept: boolean;
  onAccept: () => void;
  onAttachment: () => void;
  attachmentAvailable: boolean;
}) {
  const outgoing = message.direction === 'outbound';
  const pending = message.status === 'sending' || message.status === 'queued';
  return (
    <div>
      {showDay ? (
        <p className="my-5 text-center text-xs text-muted-foreground">
          {day(message.sentAt)}
        </p>
      ) : null}
      {message.direction === 'system' ? (
        <p className="mx-auto my-4 max-w-lg text-center text-xs leading-5 text-muted-foreground">
          {message.body}
        </p>
      ) : (
        <div
          className={`mb-5 flex ${outgoing ? 'justify-end' : 'justify-start'}`}
        >
          <div className="max-w-[88%] sm:max-w-[78%]">
            <div
              className={`whitespace-pre-wrap break-words rounded-2xl px-4 py-3 text-sm leading-6 [overflow-wrap:anywhere] ${outgoing ? 'rounded-tr-md bg-primary text-primary-foreground' : 'rounded-tl-md border bg-card text-card-foreground'}`}
            >
              {message.body}
              {message.assets?.length ? (
                <MessageAssets
                  conversationId={conversationId}
                  message={message}
                />
              ) : null}
              {message.resumeOffer ? (
                <div className="mt-3 space-y-2">
                  {message.resumeOffer.state === 'pending' &&
                  !['queued', 'sending', 'sent', 'uncertain'].includes(
                    message.resumeOffer.action?.status ?? '',
                  ) ? (
                    <Button
                      type="button"
                      className="min-h-11"
                      disabled={!canAccept}
                      onClick={onAccept}
                    >
                      同意接收简历
                    </Button>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      {message.resumeOffer.action?.status === 'uncertain'
                        ? '接收结果待确认，请刷新会话。'
                        : message.resumeOffer.action?.status === 'sent'
                          ? '已同意接收简历'
                          : '这条简历申请已处理'}
                    </p>
                  )}
                  {message.resumeOffer.action?.status === 'failed' ? (
                    <p role="alert" className="text-xs text-destructive">
                      {message.resumeOffer.action.error || '接收失败，请重试。'}
                    </p>
                  ) : null}
                  {attachmentAvailable ? (
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11"
                      onClick={onAttachment}
                    >
                      查看附件简历
                    </Button>
                  ) : null}
                </div>
              ) : null}
              {message.resumeAttachment && attachmentAvailable ? (
                <Button
                  type="button"
                  variant="outline"
                  className="mt-3 min-h-11"
                  onClick={onAttachment}
                >
                  查看附件简历
                </Button>
              ) : null}
              {message.kind !== 'text' &&
              !message.assets?.length &&
              !message.resumeOffer &&
              !message.resumeAttachment ? (
                <p className="mt-1 text-xs opacity-80">
                  此卡片的完整内容暂未同步
                </p>
              ) : null}
            </div>
            <div
              className={`mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground ${outgoing ? 'justify-end' : ''}`}
            >
              <span>{time(message.sentAt)}</span>
              {outgoing ? (
                <>
                  {pending ? (
                    <>
                      <Clock3 className="size-3" aria-hidden="true" />
                      <span>发送中</span>
                    </>
                  ) : message.status === 'sent' ? (
                    <>
                      <Check className="size-3" aria-hidden="true" />
                      <span>已发送</span>
                    </>
                  ) : (
                    <>
                      <CircleAlert
                        className="size-3 text-destructive"
                        aria-hidden="true"
                      />
                      <span className="text-destructive">
                        {message.status === 'uncertain'
                          ? '结果待确认'
                          : '未发送'}
                      </span>
                    </>
                  )}
                  {message.status === 'failed' ? (
                    <button
                      type="button"
                      onClick={onRetry}
                      className="min-h-11 px-2 text-primary underline underline-offset-2"
                    >
                      重新编辑
                    </button>
                  ) : null}
                </>
              ) : null}
            </div>
            {message.error ? (
              <p className="mt-1 max-w-sm text-xs leading-5 text-muted-foreground">
                {message.error}
              </p>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
