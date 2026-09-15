'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { LoaderCircle, MessageSquareText, Sparkles } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { apiFetch } from './api-client';
import { Field, Notice, inputClass, textareaClass } from './workspace-ui';

export type MessageTemplate = {
  positionId: string;
  positionName: string;
  templateId: string | null;
  templateName: string | null;
  inherited: boolean;
  activeVersionId: string | null;
  version: number | null;
  body: string | null;
};

type Workspace = { templates: MessageTemplate[] };

const variables = [
  { label: '候选人姓名', value: '{{candidate_name}}' },
  { label: '岗位名称', value: '{{position_name}}' },
  { label: 'HR 称呼', value: '{{hr_name}}' },
];

async function responseJson<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as T & { message?: string };
  if (!response.ok)
    throw new Error(payload.message ?? `HTTP ${response.status}`);
  return payload;
}

function renderSample(body: string): string {
  return body
    .replaceAll('{{candidate_name}}', '王女士')
    .replaceAll('{{position_name}}', '海外运营专员')
    .replaceAll('{{hr_name}}', 'HR');
}

export function MessageTemplateEditor({
  controlApi,
  canManage,
  positionId,
  onSelected,
  compact = false,
}: {
  controlApi: string;
  canManage: boolean;
  compact?: boolean;
  positionId?: string;
  onSelected?: (template: MessageTemplate | null) => void;
}) {
  const [workspace, setWorkspace] = useState<Workspace>({ templates: [] });
  const [selectedPositionId, setSelectedPositionId] = useState('');
  const [body, setBody] = useState('');
  const [templateName, setTemplateName] = useState('');
  const [selectedVersionId, setSelectedVersionId] = useState('');
  const [isNew, setIsNew] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(
    async (preferredPositionId?: string, preferredName?: string) => {
      setLoading(true);
      try {
        const response = await apiFetch(`${controlApi}/api/message-templates`, {
          cache: 'no-store',
        });
        const next = await responseJson<Workspace>(response);
        setWorkspace(next);
        const preferred = preferredPositionId || positionId;
        const nextPositionId = preferred || next.templates[0]?.positionId || '';
        setSelectedPositionId(nextPositionId);
        const chosen =
          next.templates.find(
            (item) =>
              item.positionId === nextPositionId &&
              item.templateName === preferredName,
          ) ??
          next.templates.find((item) => item.positionId === nextPositionId);
        setSelectedVersionId(chosen?.activeVersionId ?? '');
        setTemplateName(chosen?.templateName ?? '常用招呼模板');
        setIsNew(!chosen?.activeVersionId);
        onSelected?.(chosen ?? null);
        setBody(chosen?.body ?? '');
        setError(null);
      } catch (loadError) {
        setError(
          loadError instanceof Error ? loadError.message : String(loadError),
        );
      } finally {
        setLoading(false);
      }
    },
    [controlApi, positionId, onSelected],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const selected = workspace.templates.find(
    (item) =>
      item.activeVersionId === selectedVersionId &&
      item.positionId === selectedPositionId,
  );
  const sample = useMemo(() => renderSample(body), [body]);

  function selectPosition(positionId: string) {
    setSelectedPositionId(positionId);
    const chosen = workspace.templates.find(
      (item) => item.positionId === positionId,
    );
    setSelectedVersionId(chosen?.activeVersionId ?? '');
    setTemplateName(chosen?.templateName ?? '常用招呼模板');
    setIsNew(false);
    onSelected?.(chosen ?? null);
    setBody(
      workspace.templates.find((item) => item.positionId === positionId)
        ?.body ?? '',
    );
    setMessage(null);
    setError(null);
  }

  function insertVariable(value: string) {
    onSelected?.(null);
    setBody(
      (current) =>
        `${current}${current && !/\s$/.test(current) ? ' ' : ''}${value}`,
    );
  }

  async function save(event: { preventDefault: () => void }) {
    event.preventDefault();
    if (!selectedPositionId || submitting) return;
    setSubmitting(true);
    setError(null);
    setMessage(null);
    try {
      const response = await apiFetch(
        `${controlApi}/api/positions/${selectedPositionId}/message-template`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ body, name: templateName }),
        },
      );
      const payload = await responseJson<{ template: { version: number } }>(
        response,
      );
      setMessage(
        `岗位模板 v${payload.template.version} 已保存并立即用于后续消息预览。`,
      );
      await load(selectedPositionId, templateName);
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : String(saveError),
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="mb-4">
      <CardHeader className="border-b">
        <CardTitle className="flex items-center gap-2">
          <MessageSquareText
            className="size-4 text-primary"
            aria-hidden="true"
          />
          快捷招呼 / 消息模板
        </CardTitle>
        <CardDescription>
          可保存多套文案。选中模板后，在左侧勾选候选人，预览每个人的最终内容。
        </CardDescription>
        <CardAction>
          <Badge variant="outline">
            {selected?.inherited
              ? '使用默认模板'
              : selected?.version
                ? `岗位模板 v${selected.version}`
                : '未配置'}
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="pt-4">
        <Notice error={error} message={message} />
        <form className="mt-4 grid gap-4" onSubmit={save}>
          <div className="space-y-4">
            {!positionId ? (
              <Field label="适用岗位">
                <select
                  className={inputClass}
                  value={selectedPositionId}
                  onChange={(event) => selectPosition(event.target.value)}
                  disabled={loading}
                  required
                >
                  {workspace.templates
                    .filter(
                      (item, index, all) =>
                        all.findIndex(
                          (other) => other.positionId === item.positionId,
                        ) === index,
                    )
                    .map((item) => (
                      <option key={item.positionId} value={item.positionId}>
                        {item.positionName}
                      </option>
                    ))}
                </select>
              </Field>
            ) : null}
            <Field label="选择已存模板">
              <select
                className={inputClass}
                value={isNew ? '__new' : selectedVersionId}
                disabled={loading}
                onChange={(event) => {
                  if (event.target.value === '__new') {
                    setIsNew(true);
                    setTemplateName('');
                    setBody('');
                    onSelected?.(null);
                    return;
                  }
                  const chosen = workspace.templates.find(
                    (item) =>
                      item.activeVersionId === event.target.value &&
                      item.positionId === selectedPositionId,
                  );
                  setIsNew(false);
                  setSelectedVersionId(chosen?.activeVersionId ?? '');
                  setTemplateName(chosen?.templateName ?? '');
                  setBody(chosen?.body ?? '');
                  onSelected?.(chosen ?? null);
                }}
              >
                {workspace.templates
                  .filter(
                    (item) =>
                      item.positionId === selectedPositionId &&
                      item.activeVersionId,
                  )
                  .map((item) => (
                    <option
                      key={item.activeVersionId}
                      value={item.activeVersionId!}
                    >
                      {item.templateName} · v{item.version}
                    </option>
                  ))}
                <option value="__new">＋ 新建模板</option>
              </select>
            </Field>
            <Field label="模板名称">
              <input
                className={inputClass}
                value={templateName}
                onChange={(event) => {
                  setTemplateName(event.target.value);
                  onSelected?.(null);
                }}
                maxLength={80}
                readOnly={!canManage}
                required
                placeholder="例如：初次招呼 / 面试邀请"
              />
            </Field>
            <Field
              label="消息内容"
              hint="发消息最多 500 字；应用为 BOSS 岗位招呼语需 2–100 字，且不能含候选人姓名变量。"
            >
              <textarea
                className={`${textareaClass} ${compact ? 'min-h-24' : 'min-h-32'} font-sans`}
                value={body}
                onChange={(event) => {
                  setBody(event.target.value);
                  onSelected?.(null);
                }}
                maxLength={500}
                disabled={loading}
                readOnly={!canManage}
                required
              />
            </Field>
            {canManage ? (
              <div>
                <p className="mb-2 text-xs font-medium text-muted-foreground">
                  插入变量
                </p>
                <div className="flex flex-wrap gap-2">
                  {variables.map((variable) => (
                    <Button
                      key={variable.value}
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => insertVariable(variable.value)}
                    >
                      {variable.label}
                    </Button>
                  ))}
                </div>
              </div>
            ) : (
              <p className="rounded-lg border bg-muted/35 p-3 text-xs text-muted-foreground">
                你可以查看当前模板；编辑和发布新版本需要招聘负责人权限。
              </p>
            )}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                {body.length}/500 字
              </p>
              <Button
                type="submit"
                disabled={
                  loading || submitting || !selectedPositionId || !canManage
                }
              >
                {submitting ? (
                  <LoaderCircle className="animate-spin" aria-hidden="true" />
                ) : null}
                {submitting ? '保存中' : '保存为新版本'}
              </Button>
            </div>
          </div>
          {!compact ? (
            <div className="rounded-xl border bg-muted/35 p-4">
              <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
                <Sparkles className="size-4 text-primary" aria-hidden="true" />
                示例预览
              </div>
              <p className="min-h-24 whitespace-pre-wrap rounded-lg bg-card p-3 text-sm leading-6">
                {sample || '输入消息后在这里查看效果。'}
              </p>
              <p className="mt-3 text-xs leading-5 text-muted-foreground">
                实际发送前仍需在联系名单中查看姓名和岗位替换后的最终消息。
              </p>
            </div>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}
