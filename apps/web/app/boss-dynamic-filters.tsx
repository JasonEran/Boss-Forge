'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Check, LoaderCircle, RefreshCw } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { apiFetch, userFacingRequestError } from './api-client';
import {
  bossFilterFields,
  type BossFilterDefinition,
  bossFilterLabels,
  bossFilterOptionsSnapshotSchema,
  type BossFilterOptionsSnapshot,
  type BossRecommendationFilterConfig,
} from '../../../packages/contracts/src/boss-recommendation-filters';

export function BossDynamicFilters({
  positionId,
  bossJobId,
  controlApi,
  value,
  onChange,
  snapshot,
  onOptionsChange,
}: {
  positionId: string;
  bossJobId?: string | null;
  controlApi: string;
  value: BossRecommendationFilterConfig;
  onChange: (value: BossRecommendationFilterConfig) => void;
  snapshot: BossFilterOptionsSnapshot | null;
  onOptionsChange: (snapshot: BossFilterOptionsSnapshot) => void;
}) {
  const searchId = useId();
  const [majorSearch, setMajorSearch] = useState('');
  const [majorCategory, setMajorCategory] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), [positionId, bossJobId]);

  async function refresh() {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError(null);
    try {
      const response = await apiFetch(
        `${controlApi}/api/positions/${positionId}/boss-filter-options`,
        {
          method: 'POST',
          signal: controller.signal,
        },
      );
      const body = (await response.json()) as {
        message?: string;
        positionId?: string;
      };
      if (!response.ok)
        throw new Error(body.message ?? '获取 BOSS VIP 筛选失败。');
      const updated = bossFilterOptionsSnapshotSchema.parse(body);
      if (
        body.positionId !== positionId ||
        (bossJobId && updated.bossJobId !== bossJobId)
      ) {
        throw new Error('岗位已变化，请重新打开规则后获取选项。');
      }
      if (!controller.signal.aborted) onOptionsChange(updated);
    } catch (failure) {
      if (!controller.signal.aborted) setError(userFacingRequestError(failure));
    } finally {
      if (request.current === controller) request.current = null;
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  return (
    <section
      aria-label="BOSS VIP 筛选配置"
      aria-busy={loading}
      className="space-y-4 rounded-lg border bg-background/70 p-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-60 space-y-1">
          <h4 className="text-sm font-medium">BOSS 完整筛选</h4>
          <p className="text-xs leading-5 text-muted-foreground">
            同步当前岗位的全部筛选项、完整专业目录及选择方式。
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          className="min-h-11 max-w-full shrink-0 whitespace-normal"
          disabled={loading || !positionId}
          onClick={() => void refresh()}
        >
          {loading ? (
            <LoaderCircle
              aria-hidden="true"
              className="size-4 animate-spin motion-reduce:animate-none"
            />
          ) : (
            <RefreshCw aria-hidden="true" className="size-4" />
          )}
          {loading ? '正在获取…' : '一键获取 BOSS VIP 筛选'}
        </Button>
      </div>
      <output className="block text-xs leading-5 text-muted-foreground">
        {loading
          ? '正在获取此岗位的 BOSS VIP 和普通筛选，已选条件会保留。'
          : snapshot
            ? `已更新 · ${snapshot.bossJobName} · ${snapshot.definitions?.length ?? Object.keys(snapshot.fields).length} 项筛选 · ${new Date(snapshot.fetchedAt).toLocaleString('zh-CN', { hour12: false })}`
            : '点击“一键获取 BOSS VIP 筛选”，即可在平台配置这套筛选；已有条件会保留。'}
      </output>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {[
        ...(snapshot?.definitions ?? []),
        ...bossFilterFields
          .filter(
            (key) =>
              !snapshot?.definitions?.some((item) => item.key === key) &&
              (value.fields[key]?.length ||
                (!snapshot?.definitions && snapshot?.fields[key]?.length)),
          )
          .map(
            (key) =>
              ({
                key,
                label: bossFilterLabels[key],
                kind: key === 'age' ? 'range' : 'multiple',
                source: 'vip',
                available: !snapshot?.definitions,
              }) as BossFilterDefinition,
          ),
      ].map((definition) => {
        const { key } = definition;
        if (key === 'age') {
          const range = definition.range;
          const selected = value.fields.age;
          const min = selected?.[0] ?? String(range?.min ?? '');
          const max = selected?.[1] ?? '不限';
          const setAge = (low: string, high: string) =>
            onChange({
              ...value,
              fields: {
                ...value.fields,
                age:
                  low === String(range?.min) && high === '不限'
                    ? []
                    : [low, high],
              },
            });
          return (
            <fieldset
              key={key}
              className="space-y-2 rounded-lg border bg-background p-3"
            >
              <legend className="px-1 text-sm font-medium">
                {definition.label}{' '}
                <span className="text-xs text-muted-foreground">
                  {definition.source === 'vip' ? 'VIP' : '普通'}
                </span>
              </legend>
              {range && definition.available ? (
                <div className="grid grid-cols-2 gap-3">
                  <label className="space-y-1 text-xs">
                    <span>最低年龄</span>
                    <select
                      aria-label="最低年龄"
                      className="min-h-11 w-full rounded-md border bg-background px-3 text-sm focus-visible:outline-2 focus-visible:outline-ring"
                      value={min}
                      onChange={(event) => setAge(event.target.value, max)}
                    >
                      {Number(min) < range.min || Number(min) > range.max ? (
                        <option value={min}>{min} 岁（已失效）</option>
                      ) : null}
                      {Array.from(
                        { length: range.max - range.min + 1 },
                        (_, index) => String(range.min + index),
                      ).map((item) => (
                        <option key={item} value={item}>
                          {item} 岁
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1 text-xs">
                    <span>最高年龄</span>
                    <select
                      aria-label="最高年龄"
                      className="min-h-11 w-full rounded-md border bg-background px-3 text-sm focus-visible:outline-2 focus-visible:outline-ring"
                      value={max}
                      onChange={(event) => setAge(min, event.target.value)}
                    >
                      <option value="不限">不限</option>
                      {max !== '不限' &&
                      (Number(max) < range.min || Number(max) > range.max) ? (
                        <option value={max}>{max} 岁（已失效）</option>
                      ) : null}
                      {Array.from(
                        { length: range.max - range.min + 1 },
                        (_, index) => String(range.min + index),
                      ).map((item) => (
                        <option key={item} value={item}>
                          {item} 岁
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {selected?.length ? `已保存：${min}～${max}。` : ''}
                  请获取此岗位当前可用的年龄范围。
                </p>
              )}
              {selected?.length ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                    onChange({ ...value, fields: { ...value.fields, age: [] } })
                  }
                >
                  清除年龄条件
                </Button>
              ) : null}
              {max !== '不限' && Number(min) > Number(max) ? (
                <p role="alert" className="text-xs text-destructive">
                  年龄下限不能大于上限。
                </p>
              ) : null}
            </fieldset>
          );
        }
        const selected = value.fields[key] ?? [];
        const available = snapshot?.fields[key];
        const limit =
          definition.kind === 'single'
            ? 1
            : (definition.maxSelected ?? (key === 'major' ? 5 : 200));
        const canonical = (label: string) =>
          key === 'major' ? (snapshot?.majorAliases?.[label] ?? label) : label;
        const query = majorSearch.trim().toLocaleLowerCase();
        const groups = snapshot?.majorGroups ?? [];
        const category = groups.find((group) => group.label === majorCategory);
        const choices = [
          ...new Set([...(available ?? []), ...selected]),
        ].filter((label) => {
          if (key !== 'major') return true;
          if (snapshot?.majorAliases?.[label]) return false;
          if (query)
            return [
              label,
              ...Object.entries(snapshot?.majorAliases ?? {})
                .filter(([, target]) => target === label)
                .map(([alias]) => alias),
            ].some((name) => name.toLocaleLowerCase().includes(query));
          return !category || category.options.includes(label);
        });
        const toggle = (label: string) => {
          const existing = selected.find(
            (item) => canonical(item) === canonical(label),
          );
          onChange({
            ...value,
            fields: {
              ...value.fields,
              [key]: existing
                ? selected.filter((item) => item !== existing)
                : definition.kind === 'single'
                  ? [label]
                  : [...selected, label],
            },
          });
        };
        const unlimitedChoice = (
          <Button
            type="button"
            variant={selected.length ? 'outline' : 'default'}
            aria-pressed={!selected.length}
            className="min-h-11"
            onClick={() =>
              onChange({ ...value, fields: { ...value.fields, [key]: [] } })
            }
          >
            不限
          </Button>
        );
        return (
          <fieldset key={key} className="min-w-0 space-y-3">
            <legend className="text-sm font-medium">
              {definition.label}{' '}
              <span className="text-xs text-muted-foreground">
                {definition.source === 'vip' ? 'VIP' : '普通'} ·{' '}
                {definition.kind === 'single' ? '单选' : '多选'} · 已选{' '}
                {selected.length}
                {key === 'major' ? '/5' : ''}
              </span>
            </legend>
            {definition.tip ? (
              <p className="text-xs leading-5 text-muted-foreground">
                {definition.tip}
              </p>
            ) : null}
            {!definition.available ? (
              <p className="text-xs text-muted-foreground">
                当前 BOSS 账号或岗位暂不可用。
              </p>
            ) : null}
            {key === 'major' ? (
              <>
                {unlimitedChoice}
                <p className="text-xs leading-5 text-muted-foreground">
                  BOSS
                  按简历专业筛选；“英语”是专业要求。英语水平、证书等要求可在第二步补充。
                </p>
                {selected.length ? (
                  <div aria-label="已选专业" className="flex flex-wrap gap-2">
                    {selected.map((label) => (
                      <Button
                        key={label}
                        type="button"
                        variant="default"
                        aria-label={`移除专业 ${label}`}
                        className="h-auto min-h-11 max-w-full whitespace-normal"
                        onClick={() => toggle(label)}
                      >
                        <Check className="size-4 shrink-0" />
                        {label}
                        {snapshot && !(available ?? []).includes(label)
                          ? '（已失效）'
                          : ''}{' '}
                        ×
                      </Button>
                    ))}
                  </div>
                ) : null}
                {available?.length ? (
                  <>
                    <label
                      htmlFor={searchId}
                      className="block space-y-2 text-xs font-medium"
                    >
                      <span>搜索专业</span>
                      <Input
                        id={searchId}
                        type="search"
                        value={majorSearch}
                        onChange={(event) => setMajorSearch(event.target.value)}
                        placeholder="例如：英语、电子商务"
                        className="min-h-11"
                      />
                    </label>
                    {groups.length ? (
                      <label className="block space-y-2 text-xs font-medium">
                        <span>专业分类</span>
                        <select
                          value={query ? '' : (category?.label ?? '')}
                          onChange={(event) =>
                            setMajorCategory(event.target.value)
                          }
                          disabled={Boolean(query)}
                          className="min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-2 focus-visible:outline-ring"
                        >
                          <option value="">全部分类</option>
                          {groups.map((group) => (
                            <option key={group.label} value={group.label}>
                              {group.label}（{group.options.length}）
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                    <output className="block text-xs text-muted-foreground">
                      {query ? '已搜索全部分类 · ' : ''}
                      {choices.length} 个专业
                      {selected.length >= limit
                        ? ' · 已达 5 个上限，移除已选项后可继续选择'
                        : ''}
                    </output>
                  </>
                ) : null}
              </>
            ) : null}
            {choices.length || key !== 'major' ? (
              <div
                aria-label={`${bossFilterLabels[key]}选项`}
                className={`flex flex-wrap gap-2 ${key === 'major' ? 'max-h-60 overflow-y-auto rounded-md border p-2' : ''}`}
              >
                {key !== 'major' ? unlimitedChoice : null}
                {choices.map((label) => {
                  const checked = selected.some(
                    (item) => canonical(item) === canonical(label),
                  );
                  const missing = Boolean(
                    snapshot && !(available ?? []).includes(label),
                  );
                  return (
                    <Button
                      key={label}
                      type="button"
                      variant={checked ? 'default' : 'outline'}
                      aria-pressed={checked}
                      disabled={
                        !checked &&
                        (!definition.available ||
                          (definition.kind !== 'single' &&
                            selected.length >= limit))
                      }
                      className="h-auto min-h-11 max-w-full whitespace-normal text-left leading-5"
                      onClick={() => toggle(label)}
                    >
                      {checked ? <Check className="size-4 shrink-0" /> : null}
                      {label}
                      {missing ? '（已失效，点击移除）' : ''}
                    </Button>
                  );
                })}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                {key === 'major' && query
                  ? '未找到匹配专业，请更换搜索词。'
                  : snapshot
                    ? '当前 BOSS 岗位未提供可选项。'
                    : '尚未获取此岗位的选项。'}
              </p>
            )}
          </fieldset>
        );
      })}
      <p className="text-xs leading-5 text-muted-foreground">
        未选择的条件不限；专业最多选 5 个，其余遵循 BOSS
        提供的选择方式。保存规则后，任务运行时应用整套筛选，并核对生效结果。
      </p>
    </section>
  );
}
