'use client';

import { BossDynamicFilters } from './boss-dynamic-filters';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import type {
  BossRecommendationFilterConfig,
  BossFilterOptionsSnapshot,
} from '../../../packages/contracts/src/boss-recommendation-filters';

export function BossFiltersEditor({
  value,
  onChange,
  legacyMode = false,
  positionId,
  bossJobId,
  controlApi,
  snapshot,
  onOptionsChange,
}: {
  value: BossRecommendationFilterConfig;
  onChange: (value: BossRecommendationFilterConfig) => void;
  legacyMode?: boolean;
  positionId: string;
  bossJobId?: string | null;
  controlApi: string;
  snapshot: BossFilterOptionsSnapshot | null;
  onOptionsChange: (snapshot: BossFilterOptionsSnapshot) => void;
}) {
  return (
    <fieldset className="space-y-4 rounded-xl border border-primary/20 bg-primary/5 p-4">
      <legend className="px-1 text-sm font-semibold">
        第一步 · BOSS VIP 筛选
      </legend>
      <p className="text-xs leading-5 text-muted-foreground">
        {legacyMode
          ? '此规则保留原有筛选方式和简历核验条件。'
          : '一键获取此岗位的 BOSS VIP 和普通筛选，在这里直接配置。任务运行时会将整套条件应用到绑定岗位。'}
      </p>
      {legacyMode ? (
        <label
          className="block space-y-1.5 text-sm font-medium"
          htmlFor="boss-filter-mode"
        >
          <span>官方筛选方式</span>
          <NativeSelect
            id="boss-filter-mode"
            className="w-full"
            value={value.mode}
            onChange={(event) =>
              onChange({
                ...value,
                mode: event.target
                  .value as BossRecommendationFilterConfig['mode'],
              })
            }
          >
            <NativeSelectOption value="auto">
              自动对应岗位规则（推荐）
            </NativeSelectOption>
            <NativeSelectOption value="custom">
              自行设置官方筛选
            </NativeSelectOption>
            <NativeSelectOption value="off">
              不限，使用该岗位的推荐
            </NativeSelectOption>
          </NativeSelect>
        </label>
      ) : null}
      {legacyMode && value.mode === 'auto' ? (
        <p className="text-xs leading-5 text-muted-foreground">
          自动对应必须满足的学历、工作经验条件（经验包含在校/应届时保留到简历核验）。例如“本科及以上”会选择本科、硕士、博士。任一满足（OR）、证书、关键词等条件留到完整简历核验，避免过早漏选。
        </p>
      ) : null}
      {!legacyMode || value.mode === 'custom' ? (
        <BossDynamicFilters
          key={`${positionId}:${bossJobId}`}
          positionId={positionId}
          bossJobId={bossJobId}
          controlApi={controlApi}
          value={value}
          onChange={onChange}
          snapshot={snapshot}
          onOptionsChange={onOptionsChange}
        />
      ) : null}
    </fieldset>
  );
}
