import { describe, expect, it } from 'vitest';
import { readDynamicFilterOptions, type FilterPanelState } from './boss-filters-browser.js';
import { unavailableBossSelections } from '@boss-forge/contracts';

const option = (label: string, isDefault = false) => ({ label, isDefault, active: false, disabled: false });
describe('live BOSS job filter options', () => {
  it('reads every official choice group, retaining full labels and removing defaults/duplicates', () => {
    const state: FilterPanelState = { applied: true, unmanagedActive: false, groups: [
      { key: 'major', options: [option('不限', true), option('管理科学与工程类'), option('电子商务类'), option('电子商务类')] },
      { key: 'keyword1', options: [option('英语读写'), option('店铺运营')] },
      { key: 'degree', options: [option('本科')] },
    ] };
    const before = structuredClone(state);
    const snapshot = readDynamicFilterOptions(state, 'boss-amazon', '亚马逊运营');
    expect(snapshot).toMatchObject({ bossJobId: 'boss-amazon', fields: { major: ['管理科学与工程类', '电子商务类'], keyword1: ['英语读写', '店铺运营'], degree:['本科'] } });
    expect(state).toEqual(before);
  });
  it('does not carry a different job’s options or silently remove a previously selected option', () => {
    const snapshot = readDynamicFilterOptions({ applied: true, unmanagedActive: false, groups: [{ key: 'keyword1', options: [option('Python')] }] }, 'boss-ai', 'AI');
    const selected = { major: ['电子商务类'], keyword1: ['英语读写'] };
    expect(snapshot.fields.major).toBeUndefined();
    expect(unavailableBossSelections(selected, snapshot)).toEqual(['专业：电子商务类', '牛人关键词：英语读写']);
    expect(selected).toEqual({ major: ['电子商务类'], keyword1: ['英语读写'] });
  });
});

describe('complete major catalog', () => {
  const catalog = { jobId: 'boss-amazon', majors: [
    { code: 12014, name: '英语', category: '语言类' },
    { code: 10007, name: '新闻传播类', category: '文史哲类' },
  ], configured: [{ code: 10007, name: '新闻传播学类' }] };
  it('exposes unconfigured English, categories and native old-name aliases without changing keyword scope', () => {
    const snapshot = readDynamicFilterOptions({ applied: true, unmanagedActive: false, groups: [
      { key: 'major', options: [option('不限', true), option('新闻传播学类')] },
      { key: 'keyword1', options: [option('英语读写')] },
    ] }, catalog.jobId, '亚马逊运营', catalog);
    expect(snapshot.fields).toEqual({ major: ['英语', '新闻传播类', '新闻传播学类'], keyword1: ['英语读写'] });
    expect(snapshot.majorGroups).toContainEqual({ label: '语言类', options: ['英语'] });
    expect(snapshot.majorAliases).toEqual({ 新闻传播学类: '新闻传播类' });
    expect(unavailableBossSelections({ major: ['英语', '新闻传播学类'] }, snapshot)).toEqual([]);
  });
});
