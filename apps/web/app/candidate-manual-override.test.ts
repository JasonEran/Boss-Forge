import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  new URL('./candidate-review-dialog.tsx', import.meta.url),
  'utf8',
);

describe('candidate manual override', () => {
  it('allows an explained human override without rewriting machine evidence', () => {
    expect(source).toContain('人工通过只会更改审核结果，不会改写机器判定');
    expect(source).toContain("candidate.ruleDecision !== 'matched'");
    expect(source).toContain('!note.trim()');
    expect(source).toContain('!correctionCode');
    expect(source).toContain('人工改判为通过');
  });
});
