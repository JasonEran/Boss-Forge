import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  new URL('./position-rule-dialog.tsx', import.meta.url),
  'utf8',
);

describe('position rule profile fields', () => {
  it('shows job qualification controls and explains the excluded gender condition', () => {
    expect(source).toContain('年龄（岁）');
    expect(source).toContain('最晚毕业年份');
    expect(source).toContain('应届要求');
    expect(source).toContain('仅应届或即将毕业');
    expect(source).toContain('满足任一即可（或）');
    expect(source).toContain('大学英语六级（CET6）');
    expect(source).toContain('英语专业八级（TEM8）');
    expect(source).toContain('性别不参与通过或淘汰判断');
  });

  it('serializes English alternatives as one any-mode requirement', () => {
    expect(source).toContain("type: 'english_credential'");
    expect(source).toContain('accepted: selectedEnglishCredentials');
    expect(source).toContain("mode: 'any'");
    expect(source).toContain("field: 'graduationYear'");
    expect(source).not.toContain("field: 'gender'");
    expect(source).toContain("type: 'graduate_status'");
  });
});
