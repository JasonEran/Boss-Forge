'use client';

import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import type { RecruitmentConfig } from '../../../packages/contracts/src/recruitment';
import { apiFetch } from './api-client';
import { Field, inputClass, textareaClass } from './workspace-ui';

export const emptyRecruitment: RecruitmentConfig = {
  background: '',
  purpose: '',
  goals: '',
  salaryCeilingYuan: null,
  salaryComparison: 'upper',
  aiEnabled: false,
  recommendationThreshold: 70,
};

export function RecruitmentBriefEditor({
  value,
  onChange,
  canSetSalary,
  controlApi,
}: {
  value: RecruitmentConfig;
  onChange: (value: RecruitmentConfig) => void;
  canSetSalary: boolean;
  controlApi: string;
}) {
  const [readiness, setReadiness] = useState<
    'loading' | 'ready' | 'unavailable'
  >('loading');
  useEffect(() => {
    let active = true;
    void apiFetch(`${controlApi}/api/recruitment/readiness`)
      .then(async (response) => {
        const body = (await response.json()) as { ready?: boolean };
        if (active)
          setReadiness(response.ok && body.ready ? 'ready' : 'unavailable');
      })
      .catch(() => {
        if (active) setReadiness('unavailable');
      });
    return () => {
      active = false;
    };
  }, [controlApi]);
  const update = (patch: Partial<RecruitmentConfig>) =>
    onChange({ ...value, ...patch });
  return (
    <fieldset className="space-y-4 rounded-xl border border-primary/25 bg-primary/3 p-4">
      <legend className="flex items-center gap-2 px-1 text-sm font-semibold">
        <Sparkles className="size-4" aria-hidden="true" />
        AI 打分
      </legend>
      <p className="text-xs leading-5 text-muted-foreground">
        把业务背景和希望达成的结果告诉
        AI。通过硬条件的完整简历会自动分析，按匹配分从高到低排列。
      </p>
      <Field
        label="岗位背景"
        hint="公司业务、产品、团队现状，以及这个岗位负责什么。"
      >
        <textarea
          className={`${textareaClass} bg-card font-sans`}
          value={value.background}
          maxLength={6000}
          required={value.aiEnabled}
          onChange={(event) => update({ background: event.target.value })}
          placeholder="例如：我们面向海外市场经营跨境电商，团队需要一位能独立负责英文内容与社媒增长的运营。"
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="招聘目的" hint="这次招聘要解决什么业务问题？">
          <textarea
            className={`${textareaClass} bg-card font-sans`}
            value={value.purpose}
            maxLength={2000}
            required={value.aiEnabled}
            onChange={(event) => update({ purpose: event.target.value })}
            placeholder="例如：补齐内容策划与英文输出能力，减少内容对外包的依赖。"
          />
        </Field>
        <Field label="期望目标" hint="入职后要完成的具体工作、成果与时间要求。">
          <textarea
            className={`${textareaClass} bg-card font-sans`}
            value={value.goals}
            maxLength={4000}
            required={value.aiEnabled}
            onChange={(event) => update({ goals: event.target.value })}
            placeholder="例如：三个月内建立内容日历，独立产出英文内容，并能复盘渠道转化。"
          />
        </Field>
      </div>
      <div className="grid gap-4 border-t pt-4 sm:grid-cols-2">
        <Field
          label="期望月薪上限（元）"
          hint="由管理员设置。按候选人薪资区间最高值比较，高于此值直接过滤；留空不限。面议、日薪等无法比较时标记待核实。"
        >
          <input
            className={`${inputClass} bg-card`}
            type="number"
            min={1}
            max={1000000}
            step={1}
            value={value.salaryCeilingYuan ?? ''}
            readOnly={!canSetSalary}
            onChange={(event) =>
              update({
                salaryCeilingYuan:
                  event.target.value === '' ? null : Number(event.target.value),
              })
            }
            placeholder="例如 12000"
          />
        </Field>
        <Field
          label="AI 推荐分界（0–100）"
          hint="达到分界进入 AI 推荐；低于分界移入低分复核，保留证据，可人工调整结论。"
        >
          <input
            className={`${inputClass} bg-card`}
            type="number"
            min={0}
            max={100}
            step={1}
            value={value.recommendationThreshold}
            required
            onChange={(event) =>
              update({ recommendationThreshold: Number(event.target.value) })
            }
          />
        </Field>
      </div>
      <label
        aria-label="启用以上条件以让 AI 进行打分"
        className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border bg-card p-3 text-sm"
      >
        <input
          type="checkbox"
          className="mt-1 size-4 accent-primary"
          checked={value.aiEnabled}
          onChange={(event) => update({ aiEnabled: event.target.checked })}
        />
        <span>
          <span className="font-medium">启用以上条件以让 AI 进行打分</span>
          <span className="mt-1 block text-xs leading-5 text-muted-foreground">
            目标相关经历 40 分 · 岗位所需能力 35 分 · 成果与执行证据 25
            分。每项给分附简历原文，最终由 HR 复核。
          </span>
        </span>
      </label>
      <p aria-live="polite" className="text-xs text-muted-foreground">
        {readiness === 'ready'
          ? 'AI 服务已配置。保存规则后，新任务将使用这版岗位背景和评分分界。'
          : readiness === 'loading'
            ? '正在确认 AI 服务…'
            : 'AI 服务暂未就绪。规则可以保存，分析队列会等待服务恢复，不会用规则置信度代替 AI 分数。'}
      </p>
    </fieldset>
  );
}
