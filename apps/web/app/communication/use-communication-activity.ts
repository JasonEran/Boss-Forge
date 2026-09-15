'use client';

import { useEffect, useRef, useState } from 'react';
import { apiFetch, controlApi, userFacingRequestError } from '../api-client';

type LeaseState = { active: boolean; ready: boolean };

export function useCommunicationActivity() {
  const current = useRef<{ leaseId: string | null; ready: boolean }>({
    leaseId: null,
    ready: false,
  });
  const [status, setStatus] = useState('正在切换到实时沟通，等待当前简历保存…');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let stopped = false;
    let generation = 0;
    let timer: ReturnType<typeof setTimeout>;
    const update = async (
      leaseId: string,
      action: 'enter' | 'renew' | 'leave',
    ) => {
      const response = await apiFetch(
        `${controlApi}/api/workspace/activity`,
        {
          method: 'POST',
          keepalive: action === 'leave',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ leaseId, action }),
        },
        10000,
      );
      const body = (await response.json()) as LeaseState & { message?: string };
      if (!response.ok) throw new Error(body.message ?? '工作模式切换失败');
      return body;
    };
    const leave = () => {
      generation++;
      clearTimeout(timer);
      const leaseId = current.current.leaseId;
      current.current = { leaseId: null, ready: false };
      if (leaseId) void update(leaseId, 'leave').catch(() => {});
    };
    const enter = () => {
      if (stopped || document.hidden || current.current.leaseId) return;
      const leaseId = crypto.randomUUID();
      const run = ++generation;
      current.current = { leaseId, ready: false };
      setReady(false);
      setStatus('正在切换到实时沟通，等待当前简历保存…');
      async function pulse(action: 'enter' | 'renew') {
        try {
          const result = await update(leaseId, action);
          if (stopped || run !== generation) return;
          if (!result.active) {
            leave();
            setReady(false);
            setStatus('实时沟通暂已暂停，正在重新连接…');
            timer = setTimeout(enter, 2000);
            return;
          }
          // Once handed over, our own chat request may hold the lock during a
          // renewal. Do not flicker back to waiting while it finishes.
          current.current.ready ||= result.ready;
          setReady(current.current.ready);
          setStatus(
            current.current.ready
              ? '实时沟通中 · 简历筛选已暂停，切回其他页面后继续'
              : '正在切换到实时沟通，等待当前简历保存…',
          );
          timer = setTimeout(
            () => void pulse('renew'),
            current.current.ready ? 10000 : 2000,
          );
        } catch (error) {
          if (stopped || run !== generation) return;
          current.current.ready = false;
          setReady(false);
          setStatus(
            `实时沟通已暂停：${userFacingRequestError(error)}，正在重连…`,
          );
          timer = setTimeout(() => void pulse(action), 2000);
        }
      }
      void pulse('enter');
    };
    const visibility = () => {
      if (document.hidden) {
        leave();
        setReady(false);
        setStatus('页面暂不可见，实时沟通已暂停');
      } else enter();
    };
    enter();
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', leave);
    return () => {
      stopped = true;
      leave();
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', leave);
    };
  }, []);
  return { leaseRef: current, ready, status };
}
