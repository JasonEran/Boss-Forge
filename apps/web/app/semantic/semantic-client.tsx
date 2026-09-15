'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { BookOpenCheck, FlaskConical, ShieldCheck } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { AuthGate } from '../auth-gate';
import { WorkspaceShell } from '../workspace-shell';
import { Empty, Field, Notice, Panel, inputClass, textareaClass } from '../workspace-ui';
import { apiJson, postJson, type Row, rows, stringValue } from '../workspace-utils';
import {
  semanticProviderDisplayStatus,
  type SemanticProviderReadiness,
} from '../semantic-status';

const defaultPrompt = '仅根据原文证据判断规范事实；无法确定时返回 unknown。';

function statusLabel(status: unknown): string {
  if (status === 'published') return '已发布';
  if (status === 'retired') return '已停用';
  return '待审核';
}

function modeLabel(mode: unknown): string {
  if (mode === 'active') return '已生效';
  if (mode === 'shadow') return '试运行';
  return '未启用';
}

function percent(value: unknown): string {
  return typeof value === 'number' ? `${Math.round(value * 100)}%` : '—';
}

function Content() {
  const [data, setData] = useState<Row>({});
  const [selectedPositionId, setSelectedPositionId] = useState('');
  const [selectedVersionId, setSelectedVersionId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await apiJson<Row>('/api/semantic/workspace'));
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

  const catalogs = rows(data.catalogs);
  const sets = rows(data.sets);
  const runs = rows(data.runs);
  const positions = rows(data.positions);
  const versions = useMemo<Row[]>(
    () => catalogs.flatMap((catalog) => rows(catalog.versions).map((version) => ({ ...version, catalogName: catalog.name }))),
    [catalogs],
  );
  const publishedVersions = versions.filter((version) => version.status === 'published');

  const selectableVersions = publishedVersions.length > 0 ? publishedVersions : versions;
  const activePositionId = positions.some((position) => position.id === selectedPositionId)
    ? selectedPositionId
    : stringValue(positions[0]?.id);
  const activeVersionId = selectableVersions.some((version) => version.id === selectedVersionId)
    ? selectedVersionId
    : stringValue(selectableVersions[0]?.id);
  const selectedVersion = versions.find((version) => version.id === activeVersionId);
  const selectedRun = runs.find((run) => run.catalogVersionId === activeVersionId);
  const selectedMetrics = (selectedRun?.metrics ?? {}) as Row;
  const activeCapabilityAvailable = data.activeCapabilityAvailable === true;
  const providerReadiness = (data.providerReadiness ?? {
    enabled: false,
    ready: false,
    reason: 'disabled',
    endpointHost: null,
    model: null,
    credentialConfigured: false,
    timeoutMs: null,
  }) as SemanticProviderReadiness;
  const providerStatus = semanticProviderDisplayStatus(providerReadiness);
  const readyForActive = activeCapabilityAvailable && selectedVersion?.status === 'published' &&
    typeof selectedMetrics.accuracy === 'number' && selectedMetrics.accuracy >= 0.9;

  return (
    <WorkspaceShell
      current="/semantic"
      title="智能识别治理"
      description="日常识别条件和常见表达已经合并到筛选规则；本页只供负责人维护共享标准、验证准确率和正式启用。"
    >
      <Notice error={error} message={message} />

      <output
        className="mb-5 flex flex-col gap-2 rounded-xl border bg-card p-4 sm:flex-row sm:items-center"
      >
        <Badge variant={providerStatus.ready ? 'default' : 'outline'}>
          {providerStatus.label}
        </Badge>
        <p className="text-sm leading-6 text-muted-foreground">
          {providerStatus.detail}
        </p>
      </output>

      <p className="mb-5 rounded-xl border bg-card p-4 text-sm leading-6 text-muted-foreground">
        普通岗位不需要维护本页：在“筛选规则”添加智能识别条件、填写常见表达并保存即可自动试运行。只有需要跨岗位复用表达、用固定样本验证，或申请正式参与筛选时，才使用下面的治理工具。
      </p>

      <div className="grid gap-5 xl:grid-cols-[1.05fr_.95fr]">
        <Panel title="部门共享表达库（可选）" description="只维护需要在多个岗位复用的简称、别名与不同写法。">
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              const aliases = stringValue(form.get('aliases')).split(/[,，\n]/).map((item) => item.trim()).filter(Boolean);
              void act(
                () => postJson('/api/semantic/catalogs', {
                  name: form.get('name'),
                  promptTemplate: defaultPrompt,
                  modelName: null,
                  entries: [{ canonical: form.get('canonical'), aliases }],
                }),
                '识别规则草稿已保存，请继续完成审核发布。',
              );
            }}
          >
            <Field label="规则名称" hint="例如：英语证书常见写法">
              <input className={inputClass} name="name" defaultValue="部门共享表达" required />
            </Field>
            <Field label="标准名称" hint="系统统一展示的名称，例如 TEM8">
              <input className={inputClass} name="canonical" required />
            </Field>
            <Field label="常见写法" hint="用逗号或换行分隔，例如：英语专业八级、TEM8、专八">
              <textarea className={textareaClass} name="aliases" required />
            </Field>
            <p className="rounded-lg bg-muted/35 p-3 text-xs leading-5 text-muted-foreground">
              发布后，相同“标准名称”的常见写法会自动补充到岗位筛选规则。内网模型连接由系统管理员统一配置，HR 无需在这里填写参数。
            </p>
            <Button type="submit">保存共享表达草稿</Button>
          </form>
        </Panel>

        <Panel title="共享表达版本" description="负责人确认后发布，旧版本继续保留便于追溯。">
          {versions.length ? versions.map((version) => (
            <div key={stringValue(version.id)} className="flex flex-wrap items-center gap-3 rounded-lg border p-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">{stringValue(version.catalogName)}</p>
                <p className="mt-1 text-xs text-muted-foreground">版本 v{String(version.version)}</p>
              </div>
              <Badge variant={version.status === 'published' ? 'default' : 'outline'}>{statusLabel(version.status)}</Badge>
              {version.status === 'draft' ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void act(
                    () => postJson(`/api/semantic/versions/${stringValue(version.id)}/publish`, {}),
                    '识别规则已审核发布。',
                  )}
                >
                  审核并发布
                </Button>
              ) : null}
            </div>
          )) : <Empty>尚未建立部门共享表达</Empty>}
        </Panel>
      </div>

      <div className="mt-5">
        <Panel title="岗位识别安全控制" description="试运行只记录识别结果，不会改变候选人结论。">
          <div className="grid items-end gap-3 md:grid-cols-2 xl:grid-cols-[1fr_1fr_auto]">
            <Field label="适用岗位">
              <select className={inputClass} value={activePositionId} onChange={(event) => setSelectedPositionId(event.target.value)} required>
                <option value="">选择岗位</option>
                {positions.map((position) => (
                  <option key={stringValue(position.id)} value={stringValue(position.id)}>
                    {stringValue(position.name)}（{modeLabel(position.semanticMode)}）
                  </option>
                ))}
              </select>
            </Field>
            <Field label="识别规则版本">
              <select className={inputClass} value={activeVersionId} onChange={(event) => setSelectedVersionId(event.target.value)} required>
                <option value="">选择已发布版本</option>
                {selectableVersions.map((version) => (
                  <option key={stringValue(version.id)} value={stringValue(version.id)}>
                    {stringValue(version.catalogName)} v{String(version.version)} · {statusLabel(version.status)}
                  </option>
                ))}
              </select>
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                disabled={!activePositionId || !activeVersionId}
                onClick={() => void act(
                  () => postJson('/api/semantic/mode', {
                    positionId: activePositionId,
                    mode: 'shadow',
                    catalogVersionId: activeVersionId,
                  }),
                  '岗位已进入试运行，现有筛选结论不会改变。',
                )}
              >
                <FlaskConical aria-hidden="true" />
                开始试运行
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={!activePositionId}
                onClick={() => void act(
                  () => postJson('/api/semantic/mode', {
                    positionId: activePositionId,
                    mode: 'off',
                    catalogVersionId: null,
                  }),
                  '岗位智能识别已关闭。',
                )}
              >
                关闭
              </Button>
            </div>
          </div>
          <div className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-4 sm:flex-row sm:items-center">
            <ShieldCheck className="size-5 shrink-0 text-primary" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">
                {activeCapabilityAvailable ? '正式生效需要完成固定样本验证' : '当前版本仅开放安全试运行'}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {activeCapabilityAvailable
                  ? `当前版本最近准确率：${percent(selectedMetrics.accuracy)}。验证样本和详细指标在下方高级区域维护。`
                  : '现有准确率只用于观察表达库效果，尚不能证明真实模型判断安全，因此不会参与通过或未通过结论。'}
              </p>
            </div>
            <Button
              type="button"
              disabled={!activePositionId || !activeVersionId || !readyForActive}
              onClick={() => void act(
                () => postJson('/api/semantic/mode', {
                  positionId: activePositionId,
                  mode: 'active',
                  catalogVersionId: activeVersionId,
                }),
                '岗位智能识别已正式生效。',
              )}
            >
              {activeCapabilityAvailable ? '正式启用' : '正式决策未开放'}
            </Button>
          </div>
        </Panel>
      </div>

      <details className="mt-5 rounded-xl border bg-card">
        <summary className="flex min-h-12 cursor-pointer items-center gap-2 px-5 text-sm font-semibold">
          <BookOpenCheck className="size-4 text-primary" aria-hidden="true" />
          高级：验证样本与准确率
        </summary>
        <div className="space-y-5 border-t p-5">
          <p className="text-sm leading-6 text-muted-foreground">
            负责人可用已确认的历史简历建立固定验证集。普通 HR 不需要维护这里，日常只使用上面的三步流程。
          </p>
          <div className="grid gap-5 lg:grid-cols-2">
            <Panel title="建立验证集">
              <form
                className="space-y-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = new FormData(event.currentTarget);
                  void act(
                    () => postJson('/api/semantic/evaluation-sets', {
                      name: form.get('name'),
                      description: 'HR 审核的固定历史样本',
                    }),
                    '验证集已创建。',
                  );
                }}
              >
                <Field label="验证集名称" hint="例如：海外运营历史样本">
                  <input className={inputClass} name="name" required />
                </Field>
                <Button type="submit">创建验证集</Button>
              </form>
              {sets.map((set) => (
                <div key={stringValue(set.id)} className="rounded-lg border p-3 text-sm">
                  <b>{stringValue(set.name)}</b> · {String(set.caseCount)} 个样本
                </div>
              ))}
            </Panel>
            <Panel title="加入人工确认样本">
              <form
                className="space-y-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = new FormData(event.currentTarget);
                  void act(
                    () => postJson('/api/semantic/evaluation-cases', {
                      setId: form.get('setId'),
                      criterionId: form.get('criterionId'),
                      sourceText: form.get('sourceText'),
                      expectedResult: form.get('expectedResult'),
                    }),
                    '人工确认样本已加入验证集。',
                  );
                }}
              >
                <Field label="验证集">
                  <select className={inputClass} name="setId" required>
                    <option value="">选择验证集</option>
                    {sets.map((set) => <option key={stringValue(set.id)} value={stringValue(set.id)}>{stringValue(set.name)}</option>)}
                  </select>
                </Field>
                <Field label="规则标识" hint="高级字段；同一类条件使用同一个标识">
                  <input className={inputClass} name="criterionId" defaultValue="semantic.custom" required />
                </Field>
                <Field label="简历原文">
                  <textarea className={textareaClass} name="sourceText" required />
                </Field>
                <Field label="人工结论">
                  <select className={inputClass} name="expectedResult">
                    <option value="matched">符合</option>
                    <option value="not_matched">不符合</option>
                    <option value="unknown">无法确定</option>
                  </select>
                </Field>
                <Button type="submit">保存人工结论</Button>
              </form>
            </Panel>
          </div>
          <Panel title="运行固定验证" description="结果用于比较表达库版本；当前不会据此自动启用正式语义决策。">
            <form
              className="grid items-end gap-3 md:grid-cols-3"
              onSubmit={(event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                void act(
                  () => postJson('/api/semantic/evaluation-runs', {
                    setId: form.get('setId'),
                    catalogVersionId: form.get('versionId'),
                  }),
                  '固定验证已完成。',
                );
              }}
            >
              <Field label="验证集">
                <select className={inputClass} name="setId" required>
                  <option value="">选择验证集</option>
                  {sets.map((set) => <option key={stringValue(set.id)} value={stringValue(set.id)}>{stringValue(set.name)}</option>)}
                </select>
              </Field>
              <Field label="识别规则版本">
                <select className={inputClass} name="versionId" required>
                  <option value="">选择版本</option>
                  {versions.map((version) => (
                    <option key={stringValue(version.id)} value={stringValue(version.id)}>
                      {stringValue(version.catalogName)} v{String(version.version)}
                    </option>
                  ))}
                </select>
              </Field>
              <Button type="submit">运行验证</Button>
            </form>
            {runs.length ? runs.map((run) => {
              const metrics = (run.metrics ?? {}) as Row;
              return (
                <div key={stringValue(run.id)} className="flex flex-wrap items-center gap-3 rounded-lg border p-3 text-sm">
                  <b className="min-w-0 flex-1">{stringValue(run.setName)}</b>
                  <span>样本 {typeof metrics.sampleSize === 'number' ? metrics.sampleSize : 0}</span>
                  <Badge variant={typeof metrics.accuracy === 'number' && metrics.accuracy >= 0.9 ? 'default' : 'outline'}>
                    准确率 {percent(metrics.accuracy)}
                  </Badge>
                </div>
              );
            }) : <Empty>尚未运行验证</Empty>}
          </Panel>
        </div>
      </details>
    </WorkspaceShell>
  );
}

export function SemanticClient() {
  return <AuthGate allowedRoles={['admin', 'recruiting_lead']}><Content /></AuthGate>;
}
