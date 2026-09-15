import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  new URL('./candidate-review-dialog.tsx', import.meta.url),
  'utf8',
);

describe('candidate screening criterion labels', () => {
  it('renders evidence through the HR-facing label formatter', () => {
    expect(source).toContain('candidateRuleEvidenceLabel(item)');
    expect(source).toContain('candidateRuleEvidenceSourceText(item)');
    expect(source).toContain('candidateRuleEvidenceRecognitionLabel(');
    expect(source).not.toContain(
      "{item.canonicalLabel || '岗位条件'}",
    );
    expect(source).not.toMatch(
      /<p[^>]*>\s*\{item\.sourceText\}\s*<\/p>/u,
    );
  });
});
