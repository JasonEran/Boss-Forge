import { ensureBossMajorOptions, type BossMajorCatalog } from "./boss-major-catalog.js";
import type { Frame, Page } from "puppeteer-core";
import { waitForRecommendationUpdate, waitForRenderedRecommendation } from "./boss-recommendation-readiness.js";
import { bossMajorLabelAliases, bossFilterFields, bossFilterLabels, type BossFilterDefinition, type BossFilterOptionsSnapshot, bossFilterOptionsSnapshotSchema, bossRecommendationFilterPlanSchema, type BossRecommendationFilterPlan } from "@boss-forge/contracts";

export type FilterPanelState = {
  groups: Array<{ key: string; definition?: BossFilterDefinition; rangeValue?: number[]; options: Array<{ label: string; active: boolean; disabled: boolean; isDefault: boolean }> }>;
  conflicts?: BossFilterOptionsSnapshot['conflicts'];
  unmanagedActive: boolean;
  applied: boolean;
};

export function readBossVipFilterOptions(state: FilterPanelState, bossJobId: string, bossJobName: string, catalog?: BossMajorCatalog) {
  const aliases = catalog ? {
    ...Object.fromEntries(Object.entries(bossMajorLabelAliases).filter(([, canonical]) => catalog.majors.some(item => item.name === canonical))),
    ...Object.fromEntries(catalog.configured.flatMap(item => {
      const canonical = catalog.majors.find(major => major.code === item.code);
      return canonical && canonical.name !== item.name ? [[item.name, canonical.name]] : [];
    })),
  } : {};
  return bossFilterOptionsSnapshotSchema.parse({ bossJobId, bossJobName, fetchedAt: new Date().toISOString(),
    ...(state.conflicts ? { conflicts: state.conflicts } : {}),
    ...(catalog ? {
      majorGroups: [...new Set(catalog.majors.map(item => item.category))].map(label => ({label, options: catalog.majors.filter(item => item.category === label).map(item => item.name)})),
      majorAliases: aliases,
    } : {}),
    ...(state.groups.some(group => group.definition) ? { definitions: state.groups.flatMap(group => group.definition ? [group.definition] : []) } : {}),
    fields: Object.fromEntries(bossFilterFields.flatMap(key => {
      if (key === 'major' && catalog) return [[key, [...new Set([...catalog.majors.map(item => item.name), ...catalog.configured.map(item => item.name), ...Object.keys(aliases)])]]];
      const group = state.groups.find(item => item.key === key);
      return group ? [[key, [...new Set(group.options.filter(option => !option.isDefault).map(option => option.label))]]] : [];
    })),
  });
}

/** Native BOSS v6429 Filters/CheckBox/FirstDegree definitions and committed state. */
export async function readFilterPanel(frame: Frame, expectedJobId?: string): Promise<FilterPanelState> {
  return frame.evaluate(String.raw`(() => {
    const panel = document.querySelector('.filter-panel');
    if (!panel) throw new Error('BOSS_FILTER_UNAVAILABLE：未找到官方筛选面板。');
    let vm = panel.parentElement?.__vue__;
    for (let i = 0; i < 6 && vm && !vm.checkedFilters; i++) vm = vm.$parent;
    if (!vm?.checkedFilters || !vm.checked$) throw new Error('BOSS_FILTER_UNVERIFIED：无法确认官方筛选状态，请重新登录后重试。');
    if (${JSON.stringify(expectedJobId ?? null)} && vm.jobId !== ${JSON.stringify(expectedJobId ?? null)}) throw new Error('BOSS_FILTER_JOB_CHANGED：BOSS 岗位已变化，请重新获取筛选。');
    const normalized = value => JSON.stringify(Array.isArray(value) ? [...value].sort() : value);
    const managed = ${JSON.stringify(bossFilterFields)};
    const labels = ${JSON.stringify(bossFilterLabels)};
    const definitions = [...(vm.vipFilter$ ?? []).map(item => ({...item, source:'vip'})), ...(vm.normalFilter$ ?? []).map(item => ({...item, source:'normal'}))];
    const groups = definitions.flatMap(def => {
      const key = def.paramName;
      if (!managed.includes(key)) throw new Error('BOSS_FILTER_UNSUPPORTED：BOSS 新增筛选「' + (def.name || key) + '」，请更新映射后重试。');
      const fallback = def.options?.some(option => option.code === 0) ? 0 : -1;
      const kind = def.type === 2 ? 'range' : def.radio === 1 ? 'single' : 'multiple';
      const available = def.type !== 3 && !(def.source === 'vip' && vm.showVipFilters === false);
      const definition = {key, label: def.name || labels[key], kind, source: def.source, available,
        ...(def.tip ? {tip:String(def.tip)} : {}),
        ...(kind === 'range' ? {range:{min:def.start, max:def.end, step:1}} : {maxSelected:kind === 'single' ? 1 : key === 'major' ? 5 : Math.max(1,(def.options ?? []).filter(option => option.code !== fallback && option.code !== -1).length)})};
      const nodes = Array.from(panel.querySelectorAll('.check-box.' + key + ' .option'));
      const selected = [vm.checkedFilters[key]].flat();
      const options = (def.options ?? []).filter(option => option.code !== -1 || option.code === fallback).map(option => {
        const node = nodes.find(node => (node.__vue__?.optionItem?.name ?? (node.textContent ?? '').replace(/\s+/gu,' ').trim()) === option.name);
        return {label:option.name, active:selected.includes(option.code), isDefault:option.code === fallback,
          disabled:!available || !!node?.classList.contains('disable') || !!vm.linkageDisableInfo?.[key]?.codes?.includes(option.code)};
      });
      const result = [{key, definition, options, ...(kind === 'range' ? {rangeValue:vm.checkedFilters[key]} : {})}];
      if (def.firstDegreeOption) {
        const first = def.firstDegreeOption;
        if (first.paramName !== 'firstDegree') throw new Error('BOSS_FILTER_UNSUPPORTED：第一学历筛选字段已变化。');
        const node = panel.querySelector('.first-degree-wrap');
        const active = [vm.checkedFilters.firstDegree].flat().some(value => value != null && value !== 0 && value !== false);
        result.push({key:'firstDegree', definition:{key:'firstDegree', label:first.name || labels.firstDegree, kind:'single', source:def.source, available, maxSelected:1, ...(first.tip ? {tip:String(first.tip)} : {})},
          options:[{label:first.name || labels.firstDegree, active, isDefault:false, disabled:!available || !node || node.classList.contains('disable')}]});
      }
      return result;
    });
    const conflicts = definitions.flatMap(def => (def.options ?? []).flatMap(option => {
      // Same-field exclusive choices and hidden first-degree choices are
      // unconditional. Cross-field enable/disable ordering stays with native BOSS.
      const targets = (option.disableType === 1 ? option.disableInfos ?? [] : []).flatMap(info => {
        const target = definitions.find(item => item.paramName === info.paramName);
        if (!target || !managed.includes(info.paramName) || info.paramName !== def.paramName) return [];
        const excluded = (target.options ?? []).filter(item => info.codes?.includes(item.code) && item.code !== 0 && item.code !== -1).map(item => item.name);
        return excluded.length ? [{field:info.paramName, options:excluded}] : [];
      });
      if (option.hideFirstDegree && def.firstDegreeOption) targets.push({field:'firstDegree', options:[def.firstDegreeOption.name || labels.firstDegree]});
      return targets.length ? [{field:def.paramName, option:option.name, targets}] : [];
    }));
    const neutral = value => [value].flat().every(item => item == null || item === 0 || item === -1 || item === false);
    const unmanagedActive = Object.entries(vm.checkedFilters).some(([key,value]) => key !== 'action' && !groups.some(group => group.key === key) && !neutral(value));
    const keys = new Set([...Object.keys(vm.checkedFilters), ...Object.keys(vm.checked$)]);
    const applied = [...keys].filter(key => key !== 'action').every(key => normalized(vm.checkedFilters[key]) === normalized(vm.checked$[key]));
    return {groups, conflicts, unmanagedActive, applied};
  })()`) as Promise<FilterPanelState>;
}

export function filterPanelMatches(state: FilterPanelState, plan: BossRecommendationFilterPlan): boolean {
  if (state.unmanagedActive) return false;
  return bossFilterFields.every((key) => {
    if (key === 'age') {
      const group = state.groups.find(group => group.key === key);
      const range = group?.definition?.range;
      if (!range) return !plan.fields.age?.length;
      const expected = plan.fields.age?.length ? [Number(plan.fields.age[0]), plan.fields.age[1] === '不限' ? range.max + 1 : Number(plan.fields.age[1])] : [range.min, range.max + 1];
      return JSON.stringify(group.rangeValue) === JSON.stringify(expected);
    }
    const expected = [...(plan.fields[key] ?? [])].sort();
    const actual = state.groups.find((group) => group.key === key)?.options.filter((option) => option.active && !option.isDefault).map((option) => option.label).sort() ?? [];
    return JSON.stringify(expected) === JSON.stringify(actual);
  });
}

export function assertFilterOptionsAvailable(state: FilterPanelState, plan: BossRecommendationFilterPlan): void {
  for (const key of bossFilterFields) {
    const selected = plan.fields[key] ?? [];
    if (!selected.length) continue;
    const group = state.groups.find(group => group.key === key);
    if (!group || group.definition?.available === false) throw new Error(`BOSS_FILTER_UNAVAILABLE：当前岗位无法使用「${bossFilterLabels[key]}」。`);
    if (key === 'age') {
      const range = group.definition?.range;
      if (!range || Number(selected[0]) < range.min || Number(selected[0]) > range.max || (selected[1] !== '不限' && Number(selected[1]) > range.max)) throw new Error('BOSS_FILTER_UNAVAILABLE：年龄超出 BOSS 可选范围。');
      continue;
    }
    if (group.definition?.maxSelected && selected.length > group.definition.maxSelected) throw new Error(`BOSS_FILTER_CONFLICT：${bossFilterLabels[key]}最多选择 ${group.definition.maxSelected} 项。`);
    for (const label of selected) {
      const options = group.options.filter(option => option.label === label && !option.isDefault);
      if (options.length !== 1) throw new Error(`BOSS_FILTER_UNAVAILABLE：当前岗位无法使用「${bossFilterLabels[key]} · ${label}」，请获取最新 BOSS VIP 筛选后调整。`);
    }
  }
}

export async function applyBossRecommendationFilters(page: Page, frame: Frame, input: BossRecommendationFilterPlan, expectedJobId?: string): Promise<void> {
  const plan = bossRecommendationFilterPlanSchema.parse(input);
  const open = async () => {
    const panel = await frame.$('.filter-panel');
    if (panel) await panel.dispose();
    else await frame.$eval('.filter-label-wrap', node => (node as HTMLElement).click());
    await frame.waitForSelector('.filter-panel .check-box .option', { visible: true, timeout: 8000 });
    if (await frame.$('.filter-panel .vip-folded')) await frame.$eval('.filter-panel .vip-folded', node => (node as HTMLElement).click());
  };
  await open();
  let state = await readFilterPanel(frame, expectedJobId);
  // Validate the rest before changing the job's native major shortlist.
  assertFilterOptionsAvailable(state, { ...plan, fields: { ...plan.fields, major: [] } });
  if (plan.fields.major?.length) {
    plan.fields.major = await ensureBossMajorOptions(frame, plan.fields.major, expectedJobId);
    state = await readFilterPanel(frame, expectedJobId);
  }
  assertFilterOptionsAvailable(state, plan);
  if (state.applied && filterPanelMatches(state, plan)) {
    // Merely close: confirming again would refresh recommendations and expire locators.
    await frame.$eval('.filter-label-wrap', node => (node as HTMLElement).click());
    return;
  }
  await frame.$eval('.filter-panel .btns > .default', node => (node as HTMLElement).click());
  for (const key of bossFilterFields) {
    if (key === 'age') {
      if (plan.fields.age?.length) {
        const range = state.groups.find(group => group.key === 'age')!.definition!.range!;
        const values = [Number(plan.fields.age[0]), plan.fields.age[1] === '不限' ? range.max + 1 : Number(plan.fields.age[1])];
        // VueSlider emits change to Filters.changeAge; use the native event chain
        // so linkage and committed-state verification remain owned by BOSS.
        await frame.$eval('.filter-panel .filter-item.age .vue-slider', (node, values) => {
          const slider = (node as HTMLElement & { __vue__?: { $emit: (name: string, value: number[]) => void } }).__vue__;
          if (!slider?.$emit) throw new Error('BOSS_FILTER_UNAVAILABLE：年龄控件已变化。');
          slider.$emit('change', values);
        }, values);
      }
      continue;
    }
    for (const label of plan.fields[key] ?? []) {
    // Resolve each option afresh because experience and school filters can have linked constraints.
    state = await readFilterPanel(frame, expectedJobId);
    const option = state.groups.find((group) => group.key === key)?.options.find((item) => item.label === label);
    if (!option || option.disabled) throw new Error(`BOSS_FILTER_CONFLICT：官方筛选「${label}」与已选条件冲突，请调整岗位规则。`);
    if (option.active) continue;
    if (key === 'firstDegree') {
      await frame.$eval('.filter-panel .first-degree-wrap', node => (node as HTMLElement).click());
      continue;
    }
    const handles = await frame.$$(`.filter-panel .check-box.${key} .option`);
    try {
      let clicked = false;
      for (const handle of handles) if (await handle.evaluate((node) => ((node as HTMLElement & { __vue__?: { optionItem?: { name?: string } } }).__vue__?.optionItem?.name ?? (node.textContent ?? '').replace(/\s+/gu, ' ').trim())) === label) {
        await handle.evaluate(node => (node as HTMLElement).click()); clicked = true; break;
      }
      if (!clicked) throw new Error(`BOSS_FILTER_UNAVAILABLE：官方筛选项「${label}」已变化，请重试。`);
    } finally { await Promise.all(handles.map((handle) => handle.dispose())); }
    await frame.waitForFunction(`(() => Array.from(document.querySelectorAll(${JSON.stringify(`.filter-panel .check-box.${key} .option.active`)})).some(node => (node.__vue__?.optionItem?.name ?? (node.textContent ?? '').trim()) === ${JSON.stringify(label)}))()`, { timeout: 3000 });
  }
  }
  if (!filterPanelMatches(await readFilterPanel(frame, expectedJobId), plan)) throw new Error('BOSS_FILTER_CONFLICT：官方筛选存在联动限制，未能完整应用配置。');
  const update = await waitForRecommendationUpdate(page, () => frame.$eval('.filter-panel .btns > .btn:not(.default)', node => (node as HTMLElement).click()), expectedJobId);
  await frame.waitForSelector('.filter-panel', { hidden: true, timeout: 8000 });
  await waitForRenderedRecommendation(frame, update);
  await open();
  state = await readFilterPanel(frame, expectedJobId);
  if (!state.applied || !filterPanelMatches(state, plan)) throw new Error('BOSS_FILTER_UNVERIFIED：官方筛选未确认生效，本次未采集候选人。');
  await frame.$eval('.filter-label-wrap', node => (node as HTMLElement).click());
}

export const readDynamicFilterOptions = readBossVipFilterOptions;
