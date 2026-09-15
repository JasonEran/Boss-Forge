import { bossMajorLabelAliases } from '@boss-forge/contracts';
import type { Frame } from 'puppeteer-core';

export type BossMajor = { code: number; name: string; category: string };
export type BossMajorCatalog = { jobId: string; majors: BossMajor[]; configured: Array<{ code: number; name: string }> };

// Read only the native filter component, never candidate content or guessed codes.
const filterVm = `let vm = document.querySelector('.filter-panel')?.parentElement?.__vue__;
  for (let i = 0; i < 6 && vm && !vm.checkedFilters; i++) vm = vm.$parent;
  if (!vm?.checkedFilters || !vm.vipFilter$) throw new Error('BOSS_MAJOR_UNAVAILABLE：无法读取专业配置。');`;

export async function readConfiguredMajors(frame: Frame, expectedJobId?: string): Promise<BossMajorCatalog['configured']> {
  return frame.evaluate(`(() => { ${filterVm}
    if (${JSON.stringify(expectedJobId ?? null)} && vm.jobId !== ${JSON.stringify(expectedJobId ?? null)}) throw new Error('BOSS_MAJOR_JOB_CHANGED：当前 BOSS 岗位已变化，请重试。');
    return (vm.vipFilter$.find(item => item.paramName === 'major')?.options ?? []).filter(item => item.code > 0).map(item => ({code:item.code,name:item.name}));
  })()`) as Promise<BossMajorCatalog['configured']>;
}

async function openCatalog(frame: Frame) {
  if (!await frame.$('.filter-subject-dialog')) await frame.$eval('.filter-panel .operate-btn.major', node => (node as HTMLElement).click());
  await frame.waitForSelector('.filter-subject-dialog .filter-major-names > div', { visible: true, timeout: 8000 });
}
async function cancelCatalog(frame: Frame) {
  if (await frame.$('.filter-subject-dialog')) {
    await frame.$eval('.filter-subject-dialog .btn-cancel', node => (node as HTMLElement).click());
    await frame.waitForSelector('.filter-subject-dialog', { hidden: true, timeout: 3000 });
  }
}

/** Opens and cancels the complete chooser; refreshing options never saves a shortlist. */
export async function readBossMajorCatalog(frame: Frame, expectedJobId?: string): Promise<BossMajorCatalog> {
  try {
    await openCatalog(frame);
    const catalog = await frame.evaluate(`(() => { ${filterVm}
      if (${JSON.stringify(expectedJobId ?? null)} && vm.jobId !== ${JSON.stringify(expectedJobId ?? null)}) throw new Error('BOSS_MAJOR_JOB_CHANGED：当前 BOSS 岗位已变化，请重试。');
      if (!Array.isArray(vm.subjectList) || !vm.subjectList.length) throw new Error('BOSS_MAJOR_UNAVAILABLE：完整专业目录尚未加载，请重试。');
      const majors = vm.subjectList.flatMap(group => (group.children ?? []).map(item => ({code:item.code,name:item.name,category:group.name})));
      return {jobId:vm.jobId,majors,configured:(vm.vipFilter$.find(item => item.paramName === 'major')?.options ?? []).filter(item => item.code > 0).map(item => ({code:item.code,name:item.name}))};
    })()`) as BossMajorCatalog;
    if (!catalog.majors.length || catalog.majors.some(item => !Number.isInteger(item.code) || item.code <= 0 || !item.name || !item.category)
      || new Set(catalog.majors.map(item => item.code)).size !== catalog.majors.length) {
      throw new Error('BOSS_MAJOR_UNAVAILABLE：专业目录结构已变化，请重新获取。');
    }
    return catalog;
  } finally { await cancelCatalog(frame); }
}

export function resolveBossMajors(catalog: BossMajorCatalog, labels: string[]): BossMajor[] {
  if (labels.length > 5) throw new Error('BOSS_MAJOR_LIMIT：BOSS 每个岗位最多选择 5 个专业。');
  const resolved = labels.map(label => {
    const codes = new Set([...catalog.majors, ...catalog.configured].filter(item => item.name === label || item.name === bossMajorLabelAliases[label]).map(item => item.code));
    if (codes.size !== 1) throw new Error(`BOSS_MAJOR_UNAVAILABLE：BOSS 完整目录中未找到「${label}」，请获取最新选项后调整。`);
    const item = catalog.majors.find(item => codes.has(item.code));
    if (!item) throw new Error(`BOSS_MAJOR_UNAVAILABLE：专业「${label}」已失效，请获取最新选项后调整。`);
    return item;
  });
  if (new Set(resolved.map(item => item.code)).size !== resolved.length) throw new Error('BOSS_MAJOR_DUPLICATE：选中的专业包含同一专业的新旧名称，请只保留一个。');
  return resolved;
}

async function selectedCodes(frame: Frame): Promise<number[]> {
  return frame.evaluate(`(() => { ${filterVm}
    const chooser = vm.$children.find(child => Array.isArray(child.selectSubjectList));
    if (!chooser) throw new Error('BOSS_MAJOR_UNAVAILABLE：专业选择面板已变化。');
    return chooser.selectSubjectList.map(item => item.code);
  })()`) as Promise<number[]>;
}

/** Configure the job's native shortcuts before applying the actual recommendation filter. */
export async function ensureBossMajorOptions(frame: Frame, labels: string[], expectedJobId?: string): Promise<string[]> {
  if (!labels.length) return [];
  if (labels.length > 5) throw new Error('BOSS_MAJOR_LIMIT：BOSS 每个岗位最多选择 5 个专业。');
  let configured = await readConfiguredMajors(frame, expectedJobId);
  if (labels.every(label => configured.some(item => item.name === label))) return labels;
  const catalog = await readBossMajorCatalog(frame, expectedJobId);
  const desired = resolveBossMajors(catalog, labels);
  const wanted = desired.map(item => item.code);
  if (!wanted.every(code => configured.some(item => item.code === code))) {
    try {
      await openCatalog(frame);
      await readConfiguredMajors(frame, expectedJobId);
      // The native remove button requires retaining one item. Make room, add the
      // requested choices, then remove the last old choice if necessary.
      const removeUnwanted = async () => {
        let selected = await selectedCodes(frame);
        while (selected.length > 1 && selected.some(code => !wanted.includes(code))) {
          const index = selected.findIndex(code => !wanted.includes(code));
          await frame.$eval(`.filter-subject-dialog .major-select-item:nth-child(${index + 1}) .iboss-close`, node => (node as HTMLElement).click());
          const after = await selectedCodes(frame);
          if (after.length !== selected.length - 1) throw new Error('BOSS_MAJOR_UNVERIFIED：未能移除旧专业配置。');
          selected = after;
        }
      };
      await removeUnwanted();
      for (const item of desired) {
        if ((await selectedCodes(frame)).includes(item.code)) continue;
        await frame.$$eval('.filter-subject-dialog .filter-major-cate > div', (nodes, label) => {
          const node = nodes.find(node => node.textContent?.trim() === label);
          if (!node) throw new Error('BOSS_MAJOR_UNAVAILABLE：专业分类已变化。');
          (node as HTMLElement).click();
        }, item.category);
        await frame.waitForFunction(label => Array.from(document.querySelectorAll('.filter-subject-dialog .filter-major-names > div')).some(node => node.textContent?.trim() === label), { timeout: 3000 }, item.name);
        await frame.$$eval('.filter-subject-dialog .filter-major-names > div', (nodes, label) => {
          const node = nodes.find(node => node.textContent?.trim() === label);
          if (!node) throw new Error('BOSS_MAJOR_UNAVAILABLE：专业选项已变化。');
          (node as HTMLElement).click();
        }, item.name);
        if (!(await selectedCodes(frame)).includes(item.code)) throw new Error(`BOSS_MAJOR_UNVERIFIED：未能选中「${item.name}」。`);
        await removeUnwanted();
      }
      if (JSON.stringify([...(await selectedCodes(frame))].sort()) !== JSON.stringify([...wanted].sort())) throw new Error('BOSS_MAJOR_UNVERIFIED：专业选择未完整应用。');
      await readConfiguredMajors(frame, expectedJobId);
      await frame.$eval('.filter-subject-dialog .major-footer-btns .btn:not(.btn-cancel)', node => (node as HTMLElement).click());
      // BOSS closes the dialog before its save request finishes. Read back the
      // server-success-updated options, not just the dialog's closed state.
      await frame.waitForFunction(`(() => { ${filterVm}
        const codes = (vm.vipFilter$.find(item => item.paramName === 'major')?.options ?? []).filter(item => item.code > 0).map(item => item.code).sort();
        return JSON.stringify(codes) === ${JSON.stringify(JSON.stringify([...wanted].sort()))};
      })()`, { timeout: 10000 });
    } finally { await cancelCatalog(frame); }
    configured = await readConfiguredMajors(frame, expectedJobId);
  }
  return desired.map(item => {
    const actual = configured.find(option => option.code === item.code);
    if (!actual) throw new Error(`BOSS_MAJOR_UNVERIFIED：BOSS 未保存「${item.name}」。`);
    return actual.name;
  });
}
