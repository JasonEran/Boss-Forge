'use client';

import { useCallback, useEffect, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { AuthGate, useCurrentUser } from '../auth-gate';
import { WorkspaceShell } from '../workspace-shell';
import { Empty, Field, inputClass, Notice, Panel } from '../workspace-ui';
import {
  apiJson,
  postJson,
  type Row,
  rows,
  stringValue,
} from '../workspace-utils';
import {
  RuleTreeBuilder,
} from './rule-tree-builder';
import {
  configContainsSemantic,
  initialTree,
  serializeTree,
  treeContainsSemantic,
  type TreeNode,
} from './rule-tree-model';

function Content() {
  const user = useCurrentUser();
  const canManage = user.role === 'admin' || user.role === 'recruiting_lead';
  const [data, setData] = useState<Row>({});
  const [department, setDepartment] = useState<Row>({});
  const [tree, setTree] = useState<TreeNode>(initialTree);
  const [selectedPositionId, setSelectedPositionId] = useState('');
  const [startTrial, setStartTrial] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [rulesWorkspace, departmentWorkspace] = await Promise.all([
        apiJson<Row>('/api/rules/workspace'),
        apiJson<Row>('/api/department/workspace'),
      ]);
      setData(rulesWorkspace);
      setDepartment(departmentWorkspace);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function act(job: () => Promise<unknown>, successMessage: string) {
    try {
      await job();
      setMessage(successMessage);
      setError(null);
      await load();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError));
      setMessage(null);
    }
  }

  const versions = rows(data.versions);
  const templates = rows(data.templates);
  const replays = rows(data.replays);
  const positions = rows(department.positions);
  const hasSemanticCondition = treeContainsSemantic(tree);
  const config = {
    schemaVersion: '1.1',
    name: '岗位自定义规则',
    root: serializeTree(tree),
  };

  async function saveDraft(form: HTMLFormElement) {
    const values = new FormData(form);
    await postJson('/api/rules/drafts', {
      positionId: values.get('positionId'),
      name: values.get('name'),
      dictionaryVersion: 'visual-builder-1',
      config,
    });
    if (canManage && hasSemanticCondition && startTrial) {
      await postJson('/api/semantic/mode', {
        positionId: values.get('positionId'),
        mode: 'shadow',
        catalogVersionId: null,
      });
    }
  }

  async function publish(version: Row) {
    await postJson(`/api/rules/versions/${stringValue(version.id)}/lifecycle`, {
      status: 'published',
    });
    if (configContainsSemantic(version.config)) {
      await postJson('/api/semantic/mode', {
        positionId: version.positionId,
        mode: 'shadow',
        catalogVersionId: null,
      });
    }
  }

  return (
    <WorkspaceShell
      current="/rules"
      title="筛选规则"
      description="所有筛选条件都在这里完成；智能识别的常见表达也直接写在条件中，不需要切换页面。"
    >
      <Notice error={error} message={message} />
      <Panel
        title="新建筛选规则"
        description="添加条件、选择岗位并保存草稿；负责人发布含智能识别的规则时，系统会自动先进入试运行。"
      >
        <RuleTreeBuilder value={tree} onChange={setTree} />
        <form
          className="grid items-end gap-3 md:grid-cols-3"
          onSubmit={(event) => {
            event.preventDefault();
            void act(
              () => saveDraft(event.currentTarget),
              canManage && hasSemanticCondition && startTrial
                ? '规则草稿已保存，智能识别已进入试运行。'
                : '规则草稿已保存。',
            );
          }}
        >
          <Field label="适用岗位">
            <select
              className={inputClass}
              name="positionId"
              value={selectedPositionId}
              onChange={(event) => setSelectedPositionId(event.target.value)}
              required
            >
              <option value="">选择岗位</option>
              {positions.map((position) => (
                <option key={stringValue(position.id)} value={stringValue(position.id)}>
                  {stringValue(position.name)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="规则名称">
            <input
              className={inputClass}
              name="name"
              defaultValue="岗位筛选规则"
              required
            />
          </Field>
          <Button type="submit">保存规则草稿</Button>
          {canManage && hasSemanticCondition ? (
            <label className="flex min-h-11 items-center gap-3 rounded-lg bg-muted/35 px-3 text-sm md:col-span-3">
              <input
                type="checkbox"
                checked={startTrial}
                onChange={(event) => setStartTrial(event.target.checked)}
                className="size-4"
              />
              <span>
                保存后先试运行智能识别
                <span className="ml-1 text-muted-foreground">
                  （推荐；记录结果但不影响通过或淘汰）
                </span>
              </span>
            </label>
          ) : null}
        </form>
        {canManage ? (
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              void act(
                () =>
                  postJson('/api/rules/templates', {
                    name: `部门规则模板 ${new Date().toLocaleDateString()}`,
                    description: '由可视化规则树创建',
                    config,
                  }),
                '部门规则模板已创建。',
              )
            }
          >
            另存为部门模板
          </Button>
        ) : null}
      </Panel>

      <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
        <Panel title="岗位规则版本">
          {versions.length ? (
            versions.map((version) => {
              const containsSemantic = configContainsSemantic(version.config);
              return (
                <div className="rounded-lg border p-3" key={stringValue(version.id)}>
                  <div className="flex flex-wrap items-center gap-2">
                    <b>
                      {stringValue(version.positionName)} · v{String(version.version)}
                    </b>
                    <Badge>{stringValue(version.status)}</Badge>
                    {version.active ? <Badge variant="outline">当前生效</Badge> : null}
                    {containsSemantic ? <Badge variant="outline">智能识别</Badge> : null}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {version.status === 'draft' ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          void act(
                            () =>
                              postJson(
                                `/api/rules/versions/${stringValue(version.id)}/lifecycle`,
                                { status: 'pending_approval' },
                              ),
                            '已提交审批。',
                          )
                        }
                      >
                        提交审批
                      </Button>
                    ) : null}
                    {canManage && version.status === 'pending_approval' ? (
                      <Button
                        type="button"
                        size="sm"
                        onClick={() =>
                          void act(
                            () => publish(version),
                            containsSemantic
                              ? '版本已发布，智能识别已进入试运行。'
                              : '版本已发布。',
                          )
                        }
                      >
                        审批并发布
                      </Button>
                    ) : null}
                    {canManage && version.status === 'published' ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          void act(
                            () =>
                              postJson(
                                `/api/rules/versions/${stringValue(version.id)}/lifecycle`,
                                { status: 'retired' },
                              ),
                            '版本已退役。',
                          )
                        }
                      >
                        退役
                      </Button>
                    ) : null}
                    {canManage && version.status === 'retired' ? (
                      <Button
                        type="button"
                        size="sm"
                        onClick={() =>
                          void act(
                            () =>
                              postJson(
                                `/api/rules/versions/${stringValue(version.id)}/lifecycle`,
                                { status: 'published' },
                              ),
                            '已回滚至此版本。',
                          )
                        }
                      >
                        回滚发布
                      </Button>
                    ) : null}
                  </div>
                </div>
              );
            })
          ) : (
            <Empty />
          )}
        </Panel>
        <Panel title="部门模板">
          {templates.length ? (
            templates.map((template) => (
              <div key={stringValue(template.id)} className="rounded-lg border p-3">
                <b>{stringValue(template.name)}</b>
                <p className="text-xs text-muted-foreground">
                  {stringValue(template.description)}
                </p>
              </div>
            ))
          ) : (
            <Empty />
          )}
        </Panel>
      </div>

      <Panel
        title="历史候选人版本回放"
        description="用固定历史简历同时执行两个规则版本，展示命中变化。"
      >
        <form
          className="grid items-end gap-3 md:grid-cols-4"
          onSubmit={(event) => {
            event.preventDefault();
            const values = new FormData(event.currentTarget);
            void act(
              () =>
                postJson('/api/rules/replays', {
                  positionId: values.get('positionId'),
                  baselineVersionId: values.get('baseline'),
                  candidateVersionId: values.get('candidate'),
                }),
              '回放已完成。',
            );
          }}
        >
          <Field label="岗位">
            <select className={inputClass} name="positionId" required>
              <option value="">选择岗位</option>
              {positions.map((position) => (
                <option key={stringValue(position.id)} value={stringValue(position.id)}>
                  {stringValue(position.name)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="基准版本">
            <select className={inputClass} name="baseline" required>
              <option value="">选择基准版本</option>
              {versions.map((version) => (
                <option key={stringValue(version.id)} value={stringValue(version.id)}>
                  {stringValue(version.positionName)} v{String(version.version)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="候选版本">
            <select className={inputClass} name="candidate" required>
              <option value="">选择候选版本</option>
              {versions.map((version) => (
                <option key={stringValue(version.id)} value={stringValue(version.id)}>
                  {stringValue(version.positionName)} v{String(version.version)}
                </option>
              ))}
            </select>
          </Field>
          <Button type="submit">执行回放</Button>
        </form>
        {replays.map((replay) => (
          <div key={stringValue(replay.id)} className="rounded-lg border p-3 text-sm">
            {stringValue(replay.positionName)} · 样本 {String(replay.sampleSize)} · 变化{' '}
            <b>{String(replay.changedCount)}</b>
          </div>
        ))}
      </Panel>
    </WorkspaceShell>
  );
}

export function RulesClient() {
  return (
    <AuthGate allowedRoles={['admin', 'recruiting_lead', 'recruiter']}>
      <Content />
    </AuthGate>
  );
}
