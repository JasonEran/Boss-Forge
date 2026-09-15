'use client';

import { cachedApiJson } from '../workspace-utils';

import { useEffect, useState } from 'react';
import { AuthGate } from '../auth-gate';
import { hrStatusLabel } from '../hr-display';
import { WorkspaceShell } from '../workspace-shell';
import { Empty, LoadingState, Notice, Panel } from '../workspace-ui';
import { apiJson, type Row, rows, stringValue } from '../workspace-utils';

function Content() {
  const [data, setData] = useState<Row | null>(() =>
    cachedApiJson<Row>('/api/analytics'),
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void apiJson<Row>('/api/analytics')
      .then(setData)
      .catch((loadError) =>
        setError(
          loadError instanceof Error ? loadError.message : String(loadError),
        ),
      );
  }, []);

  const reviews = (data?.reviews ?? {}) as Row;
  return (
    <WorkspaceShell
      current="/analytics"
      title="招聘数据分析"
      description="按当前用户可见岗位汇总漏斗、候选人来源和人工审核；日常操作仍回到候选人页完成。"
    >
      <Notice error={error} />
      {!data && !error ? <LoadingState label="正在统计招聘数据…" /> : null}
      {data ? (
        <div className="grid gap-5 lg:grid-cols-3">
          <Panel title="招聘漏斗">
            {rows(data.funnel).length ? (
              rows(data.funnel).map((item) => (
                <div
                  key={stringValue(item.stage)}
                  className="flex justify-between rounded-lg border p-3"
                >
                  <span>{hrStatusLabel(item.stage, '其他阶段')}</span>
                  <b className="tabular-nums">{String(item.count)}</b>
                </div>
              ))
            ) : (
              <Empty>暂无招聘漏斗数据</Empty>
            )}
          </Panel>
          <Panel title="候选人来源">
            {rows(data.sources).length ? (
              rows(data.sources).map((item) => (
                <div
                  key={stringValue(item.source)}
                  className="flex justify-between rounded-lg border p-3"
                >
                  <span>{hrStatusLabel(item.source, '其他来源')}</span>
                  <b className="tabular-nums">{String(item.count)}</b>
                </div>
              ))
            ) : (
              <Empty>暂无候选人来源数据</Empty>
            )}
          </Panel>
          <Panel title="人工审核">
            <div className="grid grid-cols-3 gap-2 text-center">
              {[
                ['approved', '已通过'],
                ['pending', '待审核'],
                ['rejected', '未通过'],
              ].map(([key, label]) => (
                <div key={key} className="rounded-lg bg-muted p-4">
                  <p className="text-2xl font-semibold tabular-nums">
                    {typeof reviews[key] === 'number' ? reviews[key] : 0}
                  </p>
                  <small>{label}</small>
                </div>
              ))}
            </div>
          </Panel>
        </div>
      ) : null}
    </WorkspaceShell>
  );
}

export function AnalyticsClient() {
  return (
    <AuthGate allowedRoles={['admin', 'recruiting_lead', 'recruiter']}>
      <Content />
    </AuthGate>
  );
}
